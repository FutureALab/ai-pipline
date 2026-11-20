import type Redis from "ioredis";
import { createLogger } from "../config/logger.js";
import {
  createBlockingRedisClient,
  getRedisClient,
  isRedisConnected,
} from "../db/redis.js";

const queueLog = createLogger("jenkins-queue");

const REDIS_QUEUE_KEY = "ai_pipeline:jenkins:dispatch_queue";
const REDIS_SEMAPHORE_KEY = "ai_pipeline:jenkins:semaphore";
const REDIS_ACTIVE_PERMITS_KEY = "ai_pipeline:jenkins:active_permits";
const REDIS_ABORTED_SET_KEY = "ai_pipeline:jenkins:aborted_tasks";

export interface JenkinsQueuedTask {
  taskId: string;
  skillName: string;
  repoId: string;
  repoName: string;
  repoUrl: string;
  repoBranch: string;
  apps: string[];
  jobName: string;
  taskPrompt: string;
  skillContent: string;
  binaryTarget?: string;
  buildWarn?: string | null;
  enqueuedAt: number;
}

export type JenkinsTaskExecutor = (task: JenkinsQueuedTask) => Promise<void>;

export function getJenkinsConcurrencyLimit(): number {
  const raw = Number(process.env.JENKINS_CONCURRENCY_SEMAPHORE || 5);
  if (!Number.isFinite(raw) || raw < 1) return 5;
  return Math.floor(raw);
}

export function buildJenkinsTaskKey(skillName: string, repoId: string): string {
  return `${skillName}::${repoId}`;
}

// In-memory fallback state (used when Redis is disabled or unavailable)
const memQueue: JenkinsQueuedTask[] = [];
const memPendingKeys = new Set<string>();
const memActivePermits = new Map<string, string>();
const memAbortedKeys = new Set<string>();
let memAvailablePermits = getJenkinsConcurrencyLimit();
let memWaiters: Array<() => void> = [];

let taskExecutor: JenkinsTaskExecutor | null = null;
let workerRunning = false;
let blockingClient: Redis | null = null;
let redisSemaphoreInitialized = false;

function notifyMemWorker(): void {
  const waiters = memWaiters;
  memWaiters = [];
  for (const resolve of waiters) {
    resolve();
  }
}

function waitForMemSignal(timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    memWaiters.push(done);
  });
}

async function initRedisSemaphorePool(): Promise<void> {
  if (!isRedisConnected() || redisSemaphoreInitialized) return;
  const redis = getRedisClient();
  const limit = getJenkinsConcurrencyLimit();

  // Reset permit pool & stale active permits on server boot to match current JENKINS_CONCURRENCY_SEMAPHORE
  const pipeline = redis.pipeline();
  pipeline.del(REDIS_SEMAPHORE_KEY);
  pipeline.del(REDIS_ACTIVE_PERMITS_KEY);
  pipeline.del(REDIS_ABORTED_SET_KEY);
  const permits = Array.from({ length: limit }, (_, idx) => `permit-${idx + 1}`);
  if (permits.length > 0) {
    pipeline.rpush(REDIS_SEMAPHORE_KEY, ...permits);
  }
  await pipeline.exec();
  redisSemaphoreInitialized = true;
  queueLog.info(
    { limit, queueKey: REDIS_QUEUE_KEY, semaphoreKey: REDIS_SEMAPHORE_KEY },
    "Initialized Redis blocking queue & semaphore pool for Jenkins dispatch"
  );
}

export function isTaskPendingInQueue(
  skillName: string,
  repoId: string
): boolean {
  return memPendingKeys.has(buildJenkinsTaskKey(skillName, repoId));
}

export async function enqueueJenkinsDispatchTasks(
  tasks: JenkinsQueuedTask[]
): Promise<{ mode: "redis" | "memory"; concurrencyLimit: number }> {
  const concurrencyLimit = getJenkinsConcurrencyLimit();
  if (tasks.length === 0) {
    return {
      mode: isRedisConnected() ? "redis" : "memory",
      concurrencyLimit,
    };
  }

  for (const task of tasks) {
    const key = buildJenkinsTaskKey(task.skillName, task.repoId);
    memAbortedKeys.delete(key);
    memPendingKeys.add(key);
  }

  if (isRedisConnected()) {
    await initRedisSemaphorePool();
    const redis = getRedisClient();
    const pipeline = redis.pipeline();
    for (const task of tasks) {
      const key = buildJenkinsTaskKey(task.skillName, task.repoId);
      pipeline.srem(REDIS_ABORTED_SET_KEY, key);
      pipeline.rpush(REDIS_QUEUE_KEY, JSON.stringify(task));
    }
    await pipeline.exec();
    queueLog.info(
      { count: tasks.length, concurrencyLimit },
      "Enqueued Jenkins tasks into Redis blocking queue"
    );
    return { mode: "redis", concurrencyLimit };
  }

  memQueue.push(...tasks);
  notifyMemWorker();
  queueLog.info(
    { count: tasks.length, concurrencyLimit },
    "Enqueued Jenkins tasks into in-memory blocking queue (Redis unavailable)"
  );
  return { mode: "memory", concurrencyLimit };
}

export async function markJenkinsTasksAborted(
  skillName: string,
  repoIds: string[]
): Promise<void> {
  const keys = repoIds.map((id) => buildJenkinsTaskKey(skillName, id));
  for (const key of keys) {
    memAbortedKeys.add(key);
    memPendingKeys.delete(key);
  }

  if (isRedisConnected() && keys.length > 0) {
    const redis = getRedisClient();
    await redis.sadd(REDIS_ABORTED_SET_KEY, ...keys).catch(() => {});
  }

  // Also release any semaphore permit held by these aborted tasks
  for (const repoId of repoIds) {
    await releaseJenkinsSemaphorePermit(skillName, repoId);
  }
}

export async function releaseJenkinsSemaphorePermit(
  skillName: string,
  repoId: string
): Promise<void> {
  const key = buildJenkinsTaskKey(skillName, repoId);

  if (isRedisConnected()) {
    try {
      const redis = getRedisClient();
      const permit = await redis.hget(REDIS_ACTIVE_PERMITS_KEY, key);
      if (permit) {
        const deleted = await redis.hdel(REDIS_ACTIVE_PERMITS_KEY, key);
        if (deleted > 0) {
          await redis.rpush(REDIS_SEMAPHORE_KEY, permit);
          queueLog.debug(
            { key, permit },
            "Released Redis semaphore permit back to pool"
          );
        }
      }
      return;
    } catch (err) {
      queueLog.warn({ err, key }, "Failed to release Redis semaphore permit");
    }
  }

  if (memActivePermits.has(key)) {
    memActivePermits.delete(key);
    const limit = getJenkinsConcurrencyLimit();
    memAvailablePermits = Math.min(limit, memAvailablePermits + 1);
    notifyMemWorker();
  }
}

async function runRedisWorkerLoop(): Promise<void> {
  await initRedisSemaphorePool();
  blockingClient = createBlockingRedisClient();
  if (!blockingClient) {
    queueLog.warn(
      "Could not create blocking Redis client; falling back to in-memory queue loop"
    );
    await runMemoryWorkerLoop();
    return;
  }

  const redis = getRedisClient();
  queueLog.info(
    { concurrencyLimit: getJenkinsConcurrencyLimit() },
    "Jenkins Redis BLPOP dispatch worker started"
  );

  while (workerRunning) {
    try {
      // 1. Block until a semaphore permit is available (enforces JENKINS_CONCURRENCY_SEMAPHORE)
      const permitRes = await blockingClient.blpop(REDIS_SEMAPHORE_KEY, 2);
      if (!permitRes) {
        continue;
      }
      const permit = permitRes[1];

      // 2. Block until a task arrives in the FIFO queue
      const taskRes = await blockingClient.blpop(REDIS_QUEUE_KEY, 2);
      if (!taskRes) {
        // Queue is idle; return the permit immediately
        await redis.rpush(REDIS_SEMAPHORE_KEY, permit);
        continue;
      }

      let task: JenkinsQueuedTask;
      try {
        task = JSON.parse(taskRes[1]) as JenkinsQueuedTask;
      } catch {
        await redis.rpush(REDIS_SEMAPHORE_KEY, permit);
        continue;
      }

      const key = buildJenkinsTaskKey(task.skillName, task.repoId);
      memPendingKeys.delete(key);

      // 3. Skip if the user aborted this task while it was waiting in the queue
      const isAborted =
        memAbortedKeys.has(key) ||
        (await redis.sismember(REDIS_ABORTED_SET_KEY, key)) === 1;
      if (isAborted) {
        memAbortedKeys.delete(key);
        await redis.srem(REDIS_ABORTED_SET_KEY, key).catch(() => {});
        await redis.rpush(REDIS_SEMAPHORE_KEY, permit);
        queueLog.info({ key }, "Skipped aborted queued Jenkins task");
        continue;
      }

      // 4. Bind permit to this active task (released when Jenkins build completes/fails/aborts)
      const prevPermit = await redis.hget(REDIS_ACTIVE_PERMITS_KEY, key);
      await redis.hset(REDIS_ACTIVE_PERMITS_KEY, key, permit);
      if (prevPermit && prevPermit !== permit) {
        await redis.rpush(REDIS_SEMAPHORE_KEY, prevPermit);
      }

      // 5. Dispatch asynchronously so the worker can immediately fill remaining permits up to N
      const executor = taskExecutor;
      if (executor) {
        void executor(task).catch(async (err) => {
          queueLog.error(
            { err, key },
            "Jenkins queued task executor failed; releasing permit"
          );
          await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
        });
      } else {
        await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
      }
    } catch (err) {
      if (!workerRunning) break;
      queueLog.warn({ err }, "Jenkins Redis BLPOP worker transient error");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function runMemoryWorkerLoop(): Promise<void> {
  memAvailablePermits = getJenkinsConcurrencyLimit();
  queueLog.info(
    { concurrencyLimit: memAvailablePermits },
    "Jenkins in-memory blocking dispatch worker started"
  );

  while (workerRunning) {
    if (memQueue.length === 0 || memAvailablePermits <= 0) {
      await waitForMemSignal(1000);
      continue;
    }

    const task = memQueue.shift();
    if (!task) continue;
    const key = buildJenkinsTaskKey(task.skillName, task.repoId);
    memPendingKeys.delete(key);

    if (memAbortedKeys.has(key)) {
      memAbortedKeys.delete(key);
      continue;
    }

    memAvailablePermits -= 1;
    memActivePermits.set(key, `mem-permit-${Date.now()}`);

    const executor = taskExecutor;
    if (executor) {
      void executor(task).catch(async (err) => {
        queueLog.error(
          { err, key },
          "Jenkins memory-queued task executor failed; releasing permit"
        );
        await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
      });
    } else {
      await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
    }
  }
}

export async function startJenkinsDispatchWorker(
  executor: JenkinsTaskExecutor
): Promise<void> {
  taskExecutor = executor;
  if (workerRunning) return;
  workerRunning = true;

  if (isRedisConnected()) {
    void runRedisWorkerLoop();
  } else {
    void runMemoryWorkerLoop();
  }
}

export async function stopJenkinsDispatchWorker(): Promise<void> {
  workerRunning = false;
  notifyMemWorker();
  if (blockingClient) {
    await blockingClient.quit().catch(() => blockingClient?.disconnect());
    blockingClient = null;
  }
}
