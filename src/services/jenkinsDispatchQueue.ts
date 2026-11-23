import { createLogger } from "../config/logger.js";
import { BlockingQueue } from "../db/blockingQueue.js";
import {
  createBlockingRedisClient,
  getRedisClient,
  isRedisConnected,
  type RedisClient,
} from "../db/redis.js";

const queueLog = createLogger("jenkins-queue");

// Hash-tagged keys ensure all semaphore/abort keys map to the same Redis Cluster slot
const REDIS_SEMAPHORE_KEY = "{ai_pipeline:jenkins}:semaphore";
const REDIS_ACTIVE_PERMITS_KEY = "{ai_pipeline:jenkins}:active_permits";
const REDIS_ABORTED_SET_KEY = "{ai_pipeline:jenkins}:aborted_tasks";

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

// Track pending/aborted tasks and in-memory semaphore fallback
const memPendingKeys = new Set<string>();
const memActivePermits = new Map<string, string>();
const memAbortedKeys = new Set<string>();
let memAvailablePermits = getJenkinsConcurrencyLimit();
let memPermitWaiters: Array<() => void> = [];

let dispatchQueue: BlockingQueue<JenkinsQueuedTask> | null = null;
let taskExecutor: JenkinsTaskExecutor | null = null;
let workerRunning = false;
let semaphoreBlockingClient: RedisClient | null = null;
let redisSemaphoreInitialized = false;

function notifyMemPermitWaiters(): void {
  const waiters = memPermitWaiters;
  memPermitWaiters = [];
  for (const resolve of waiters) {
    resolve();
  }
}

function waitForMemPermit(timeoutMs = 1500): Promise<void> {
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
    memPermitWaiters.push(done);
  });
}

function getOrCreateDispatchQueue(): BlockingQueue<JenkinsQueuedTask> {
  if (!dispatchQueue) {
    dispatchQueue = new BlockingQueue<JenkinsQueuedTask>({
      name: "jenkins-dispatch",
      concurrency: getJenkinsConcurrencyLimit(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    });
  }
  return dispatchQueue;
}

async function initRedisSemaphorePool(): Promise<void> {
  if (!isRedisConnected() || redisSemaphoreInitialized) return;
  const redis = getRedisClient();
  const limit = getJenkinsConcurrencyLimit();

  // All 3 keys share hash tag `{ai_pipeline:jenkins}`, safe for Redis Cluster pipeline
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
    { limit, semaphoreKey: REDIS_SEMAPHORE_KEY },
    "Initialized Redis Cluster semaphore pool for BullMQ Jenkins dispatch"
  );
}

async function acquireSemaphorePermit(): Promise<string | null> {
  if (isRedisConnected()) {
    await initRedisSemaphorePool();
    if (!semaphoreBlockingClient) {
      semaphoreBlockingClient = createBlockingRedisClient();
    }
    if (semaphoreBlockingClient) {
      while (workerRunning) {
        const res = await semaphoreBlockingClient.blpop(REDIS_SEMAPHORE_KEY, 2);
        if (res) return res[1];
      }
      return null;
    }
  }

  while (workerRunning) {
    if (memAvailablePermits > 0) {
      memAvailablePermits -= 1;
      return `mem-permit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    await waitForMemPermit(1000);
  }
  return null;
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
    const keys = tasks.map((t) => buildJenkinsTaskKey(t.skillName, t.repoId));
    await redis.srem(REDIS_ABORTED_SET_KEY, ...keys).catch(() => {});
  }

  const queue = getOrCreateDispatchQueue();
  const mode = await queue.enqueueBulk(
    tasks.map((task) => ({
      name: "dispatch-jenkins",
      data: task,
      opts: { jobId: task.taskId },
    }))
  );

  const normalizedMode = mode === "bullmq" ? "redis" : "memory";
  queueLog.info(
    { count: tasks.length, concurrencyLimit, mode: normalizedMode },
    `Enqueued Jenkins tasks into ${mode === "bullmq" ? "BullMQ (Redis)" : "in-memory"} blocking queue`
  );
  return { mode: normalizedMode, concurrencyLimit };
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
    notifyMemPermitWaiters();
  }
}

async function processQueuedJenkinsTask(task: JenkinsQueuedTask): Promise<void> {
  const key = buildJenkinsTaskKey(task.skillName, task.repoId);
  memPendingKeys.delete(key);

  // Skip immediately if aborted while waiting in queue
  if (isRedisConnected()) {
    const redis = getRedisClient();
    const isAborted =
      memAbortedKeys.has(key) ||
      (await redis.sismember(REDIS_ABORTED_SET_KEY, key)) === 1;
    if (isAborted) {
      memAbortedKeys.delete(key);
      await redis.srem(REDIS_ABORTED_SET_KEY, key).catch(() => {});
      queueLog.info({ key }, "Skipped aborted queued Jenkins task");
      return;
    }
  } else if (memAbortedKeys.has(key)) {
    memAbortedKeys.delete(key);
    queueLog.info({ key }, "Skipped aborted queued Jenkins task");
    return;
  }

  // Acquire semaphore permit (blocks until a Jenkins build slot is free)
  const permit = await acquireSemaphorePermit();
  if (!permit) return;

  if (isRedisConnected()) {
    const redis = getRedisClient();
    const prevPermit = await redis.hget(REDIS_ACTIVE_PERMITS_KEY, key);
    await redis.hset(REDIS_ACTIVE_PERMITS_KEY, key, permit);
    if (prevPermit && prevPermit !== permit) {
      await redis.rpush(REDIS_SEMAPHORE_KEY, prevPermit);
    }
  } else {
    memActivePermits.set(key, permit);
  }

  const executor = taskExecutor;
  if (!executor) {
    await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
    return;
  }

  try {
    await executor(task);
  } catch (err) {
    queueLog.error(
      { err, key },
      "Jenkins queued task executor failed; releasing permit"
    );
    await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
  }
}

export async function startJenkinsDispatchWorker(
  executor: JenkinsTaskExecutor
): Promise<void> {
  taskExecutor = executor;
  if (workerRunning) return;
  workerRunning = true;
  memAvailablePermits = getJenkinsConcurrencyLimit();

  if (isRedisConnected()) {
    await initRedisSemaphorePool();
  }

  const queue = getOrCreateDispatchQueue();
  queue.startWorker(processQueuedJenkinsTask);
}

export async function stopJenkinsDispatchWorker(): Promise<void> {
  workerRunning = false;
  notifyMemPermitWaiters();
  if (dispatchQueue) {
    await dispatchQueue.close();
    dispatchQueue = null;
  }
  if (semaphoreBlockingClient) {
    await semaphoreBlockingClient
      .quit()
      .catch(() => semaphoreBlockingClient?.disconnect());
    semaphoreBlockingClient = null;
  }
}
