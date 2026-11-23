import { Queue, Worker, type JobsOptions } from "bullmq";
import { createLogger } from "../config/logger.js";
import {
  createBullMQConnection,
  getRedisKeyPrefix,
  isRedisConnected,
  type RedisClient,
} from "./redis.js";

const log = createLogger("blocking-queue");

export interface BlockingQueueOptions {
  /** Logical queue name (must not contain colons for BullMQ Cluster compatibility). */
  name: string;
  /** Worker concurrency (defaults to 1). */
  concurrency?: number;
  /** Default BullMQ job options (attempts, backoff, cleanup). */
  defaultJobOptions?: JobsOptions;
}

export interface BlockingQueueMetrics {
  mode: "bullmq" | "memory";
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

/**
 * Distributed blocking queue backed by BullMQ (Redis Cluster & Standalone safe via hash-tag prefix)
 * with an automatic in-memory blocking fallback when Redis is unavailable.
 */
export class BlockingQueue<T extends object> {
  private readonly name: string;
  private readonly concurrency: number;
  private readonly defaultJobOptions: JobsOptions;

  private queue: Queue<T> | null = null;
  private worker: Worker<T> | null = null;
  private queueConn: RedisClient | null = null;
  private workerConn: RedisClient | null = null;

  // In-memory fallback state
  private readonly memItems: Array<{ jobName: string; data: T }> = [];
  private memWaiters: Array<() => void> = [];
  private memProcessor: ((data: T) => Promise<void>) | null = null;
  private memRunning = false;
  private memActive = 0;
  private memCompleted = 0;
  private memFailed = 0;

  constructor(options: BlockingQueueOptions) {
    this.name = options.name.replace(/:/g, "-");
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.defaultJobOptions = {
      removeOnComplete: 500,
      removeOnFail: 500,
      ...options.defaultJobOptions,
    };
  }

  public isUsingBullMQ(): boolean {
    return this.queue !== null;
  }

  private ensureBullMQQueue(): Queue<T> | null {
    if (!isRedisConnected()) return null;
    if (this.queue) return this.queue;

    const conn = createBullMQConnection();
    if (!conn) return null;

    this.queueConn = conn;
    this.queue = new Queue<T>(this.name, {
      connection: conn as never,
      prefix: getRedisKeyPrefix(),
      defaultJobOptions: this.defaultJobOptions,
    });
    return this.queue;
  }

  public async enqueue(
    jobName: string,
    data: T,
    opts?: JobsOptions
  ): Promise<"bullmq" | "memory"> {
    const q = this.ensureBullMQQueue();
    if (q) {
      await q.add(jobName as never, data as never, opts);
      return "bullmq";
    }

    this.memItems.push({ jobName, data });
    this.notifyMemWaiters();
    return "memory";
  }

  public async enqueueBulk(
    items: Array<{ name: string; data: T; opts?: JobsOptions }>
  ): Promise<"bullmq" | "memory"> {
    if (items.length === 0) {
      return isRedisConnected() ? "bullmq" : "memory";
    }

    const q = this.ensureBullMQQueue();
    if (q) {
      await q.addBulk(
        items.map((item) => ({
          name: item.name as never,
          data: item.data as never,
          opts: item.opts,
        }))
      );
      return "bullmq";
    }

    for (const item of items) {
      this.memItems.push({ jobName: item.name, data: item.data });
    }
    this.notifyMemWaiters();
    return "memory";
  }

  public startWorker(processor: (data: T) => Promise<void>): "bullmq" | "memory" {
    this.memProcessor = processor;

    if (isRedisConnected()) {
      if (this.worker) return "bullmq";
      const conn = createBullMQConnection();
      if (conn) {
        this.workerConn = conn;
        this.worker = new Worker<T>(
          this.name,
          async (job) => {
            await processor(job.data);
          },
          {
            connection: conn as never,
            prefix: getRedisKeyPrefix(),
            concurrency: this.concurrency,
          }
        );

        this.worker.on("failed", (job, err) => {
          log.warn(
            { queue: this.name, jobId: job?.id, err },
            "BullMQ job execution failed"
          );
        });

        this.worker.on("error", (err) => {
          log.warn({ queue: this.name, err }, "BullMQ worker error");
        });

        log.info(
          { queue: this.name, prefix: getRedisKeyPrefix(), concurrency: this.concurrency },
          "Started BullMQ blocking queue worker"
        );
        return "bullmq";
      }
    }

    if (!this.memRunning) {
      this.memRunning = true;
      void this.runMemoryLoop();
      log.info(
        { queue: this.name, concurrency: this.concurrency },
        "Started in-memory blocking queue worker (Redis unavailable)"
      );
    }
    return "memory";
  }

  public async getMetrics(): Promise<BlockingQueueMetrics> {
    if (this.queue) {
      const counts = await this.queue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed"
      );
      return {
        mode: "bullmq",
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
      };
    }

    return {
      mode: "memory",
      waiting: this.memItems.length,
      active: this.memActive,
      completed: this.memCompleted,
      failed: this.memFailed,
    };
  }

  public async close(): Promise<void> {
    this.memRunning = false;
    this.notifyMemWaiters();

    if (this.worker) {
      await this.worker.close().catch(() => {});
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close().catch(() => {});
      this.queue = null;
    }
    if (this.workerConn) {
      await this.workerConn.quit().catch(() => this.workerConn?.disconnect());
      this.workerConn = null;
    }
    if (this.queueConn) {
      await this.queueConn.quit().catch(() => this.queueConn?.disconnect());
      this.queueConn = null;
    }
  }

  private notifyMemWaiters(): void {
    const waiters = this.memWaiters;
    this.memWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private waitForMemSignal(timeoutMs = 1500): Promise<void> {
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
      this.memWaiters.push(done);
    });
  }

  private async runMemoryLoop(): Promise<void> {
    while (this.memRunning) {
      if (this.memItems.length === 0 || this.memActive >= this.concurrency) {
        await this.waitForMemSignal(1000);
        continue;
      }

      const item = this.memItems.shift();
      if (!item) continue;

      const processor = this.memProcessor;
      if (!processor) continue;

      this.memActive += 1;
      void processor(item.data)
        .then(() => {
          this.memCompleted += 1;
        })
        .catch((err) => {
          this.memFailed += 1;
          log.warn({ queue: this.name, err }, "In-memory queue job failed");
        })
        .finally(() => {
          this.memActive -= 1;
          this.notifyMemWaiters();
        });
    }
  }
}
