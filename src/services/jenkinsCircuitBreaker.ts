import { createLogger } from "../config/logger.js";
import { sendJenkinsCircuitBreakerAlert } from "./mailService.js";

const cbLog = createLogger("jenkins-cb");

/**
 * Circuit breaker state for each Jenkins node:
 * - `HEALTHY` (正常): accepts 100% traffic. Failure -> `HALF_OPEN`.
 * - `HALF_OPEN` (半开): accepts 1/3 traffic (1 of every N=3 attempts).
 *     Success -> `HEALTHY`; Failure -> `BLOCKED`.
 * - `BLOCKED` (关闭/熔断): rejects 100% traffic.
 *     After `backoffMs` (default 3000ms) -> `HALF_OPEN`.
 */
export type JenkinsCircuitState = "HEALTHY" | "HALF_OPEN" | "BLOCKED";

export interface JenkinsNodeConfig {
  id: string;
  baseUrl: string;
  username: string;
  apiToken: string;
}

export interface JenkinsCircuitOptions {
  /** Backoff duration in ms before BLOCKED transitions to HALF_OPEN (default 3000ms). */
  backoffMs?: number;
  /** Denominator of traffic accepted in HALF_OPEN (default 3 => 1/3 traffic). */
  halfOpenTrafficDivisor?: number;
  /** Optional clock override for deterministic unit testing. */
  now?: () => number;
}

export interface JenkinsNodeStatusSnapshot {
  id: string;
  baseUrl: string;
  state: JenkinsCircuitState;
  backoffMs: number;
  remainingBackoffMs: number;
  halfOpenTrafficRatio: string;
  totalSuccess: number;
  totalFailure: number;
  totalRejected: number;
  lastError: string | null;
  lastStateChangeAt: number;
}

export class JenkinsNodeCircuitBreaker {
  public readonly config: JenkinsNodeConfig;
  private state: JenkinsCircuitState = "HEALTHY";
  private readonly backoffMs: number;
  private readonly halfOpenDivisor: number;
  private readonly nowFn: () => number;

  private blockedAt: number | null = null;
  private halfOpenAttemptCounter = 0;
  private totalSuccess = 0;
  private totalFailure = 0;
  private totalRejected = 0;
  private lastError: string | null = null;
  private lastStateChangeAt: number;

  constructor(config: JenkinsNodeConfig, options: JenkinsCircuitOptions = {}) {
    this.config = config;
    this.backoffMs = Math.max(100, Math.floor(options.backoffMs ?? 3000));
    this.halfOpenDivisor = Math.max(
      1,
      Math.floor(options.halfOpenTrafficDivisor ?? 3)
    );
    this.nowFn = options.now ?? (() => Date.now());
    this.lastStateChangeAt = this.nowFn();
  }

  public getState(now: number = this.nowFn()): JenkinsCircuitState {
    if (
      this.state === "BLOCKED" &&
      this.blockedAt !== null &&
      now - this.blockedAt >= this.backoffMs
    ) {
      this.transitionTo("HALF_OPEN", now, "backoff elapsed");
    }
    return this.state;
  }

  /**
   * Decide whether this node can accept the incoming request.
   * - HEALTHY: always true
   * - BLOCKED: false until backoffMs elapsed, then transitions to HALF_OPEN
   * - HALF_OPEN: allows 1 of every `halfOpenDivisor` (default 3 => 1/3) requests
   */
  public canAcceptRequest(now: number = this.nowFn()): boolean {
    const current = this.getState(now);
    if (current === "HEALTHY") {
      return true;
    }
    if (current === "BLOCKED") {
      this.totalRejected += 1;
      return false;
    }
    // HALF_OPEN: allow 1/3 of incoming traffic
    const attempt = this.halfOpenAttemptCounter++;
    const allowed = attempt % this.halfOpenDivisor === 0;
    if (!allowed) {
      this.totalRejected += 1;
    }
    return allowed;
  }

  public recordSuccess(now: number = this.nowFn()): void {
    this.totalSuccess += 1;
    this.lastError = null;
    if (this.state !== "HEALTHY") {
      this.transitionTo("HEALTHY", now, "probe succeeded");
    }
  }

  public recordFailure(error: unknown, now: number = this.nowFn()): void {
    this.totalFailure += 1;
    this.lastError = error instanceof Error ? error.message : String(error);

    if (this.state === "HEALTHY") {
      this.transitionTo("HALF_OPEN", now, `failure in HEALTHY: ${this.lastError}`);
    } else if (this.state === "HALF_OPEN") {
      this.transitionTo("BLOCKED", now, `failure in HALF_OPEN: ${this.lastError}`);
    } else {
      this.blockedAt = now;
    }
  }

  public getSnapshot(now: number = this.nowFn()): JenkinsNodeStatusSnapshot {
    const state = this.getState(now);
    const remainingBackoffMs =
      state === "BLOCKED" && this.blockedAt !== null
        ? Math.max(0, this.backoffMs - (now - this.blockedAt))
        : 0;
    return {
      id: this.config.id,
      baseUrl: this.config.baseUrl,
      state,
      backoffMs: this.backoffMs,
      remainingBackoffMs,
      halfOpenTrafficRatio: `1/${this.halfOpenDivisor}`,
      totalSuccess: this.totalSuccess,
      totalFailure: this.totalFailure,
      totalRejected: this.totalRejected,
      lastError: this.lastError,
      lastStateChangeAt: this.lastStateChangeAt,
    };
  }

  private transitionTo(
    next: JenkinsCircuitState,
    now: number,
    reason: string
  ): void {
    const prev = this.state;
    this.state = next;
    this.lastStateChangeAt = now;

    if (next === "HALF_OPEN") {
      this.halfOpenAttemptCounter = 0;
      this.blockedAt = null;
    } else if (next === "BLOCKED") {
      this.blockedAt = now;
      this.halfOpenAttemptCounter = 0;
    } else {
      this.blockedAt = null;
      this.halfOpenAttemptCounter = 0;
    }

    cbLog.warn(
      {
        nodeId: this.config.id,
        baseUrl: this.config.baseUrl,
        from: prev,
        to: next,
        backoffMs: this.backoffMs,
        reason,
      },
      `Jenkins circuit breaker transitioned ${prev} -> ${next}`
    );

    if (next === "BLOCKED") {
      void sendJenkinsCircuitBreakerAlert({
        nodeId: this.config.id,
        baseUrl: this.config.baseUrl,
        fromState: prev,
        toState: next,
        backoffMs: this.backoffMs,
        reason,
      });
    }
  }
}

export class JenkinsRoundRobinRouter {
  private readonly breakers: JenkinsNodeCircuitBreaker[];
  private readonly nowFn: () => number;
  private rrCursor = 0;

  constructor(nodes: JenkinsNodeConfig[], options: JenkinsCircuitOptions = {}) {
    if (nodes.length === 0) {
      throw new Error("At least one Jenkins node must be configured");
    }
    this.nowFn = options.now ?? (() => Date.now());
    this.breakers = nodes.map(
      (node) => new JenkinsNodeCircuitBreaker(node, options)
    );
  }

  public getNodes(): JenkinsNodeConfig[] {
    return this.breakers.map((b) => b.config);
  }

  public getStatusSnapshots(): JenkinsNodeStatusSnapshot[] {
    const now = this.nowFn();
    return this.breakers.map((b) => b.getSnapshot(now));
  }

  public findNodeByUrl(url: string | undefined): JenkinsNodeCircuitBreaker | null {
    if (!url) return null;
    try {
      const targetOrigin = new URL(url).origin;
      for (const b of this.breakers) {
        try {
          if (new URL(b.config.baseUrl).origin === targetOrigin) {
            return b;
          }
        } catch {
          // ignore malformed node url
        }
      }
    } catch {
      // ignore malformed target url
    }
    return null;
  }

  public acquireNextNode(
    excludeIds?: Set<string>
  ): JenkinsNodeCircuitBreaker | null {
    const now = this.nowFn();
    const count = this.breakers.length;

    for (let offset = 0; offset < count; offset++) {
      const idx = (this.rrCursor + offset) % count;
      const candidate = this.breakers[idx];
      if (excludeIds?.has(candidate.config.id)) continue;

      if (candidate.canAcceptRequest(now)) {
        this.rrCursor = (idx + 1) % count;
        return candidate;
      }
    }

    this.rrCursor = (this.rrCursor + 1) % count;
    return null;
  }

  /**
   * Execute an operation across Jenkins nodes using round-robin selection + circuit-breaker failover.
   */
  public async executeWithFailover<T>(
    operation: (node: JenkinsNodeConfig) => Promise<T>
  ): Promise<{ result: T; node: JenkinsNodeConfig }> {
    const triedIds = new Set<string>();
    const errors: string[] = [];

    for (let attempt = 0; attempt < this.breakers.length; attempt++) {
      const breaker = this.acquireNextNode(triedIds);
      if (!breaker) break;
      triedIds.add(breaker.config.id);

      try {
        const result = await operation(breaker.config);
        breaker.recordSuccess();
        return { result, node: breaker.config };
      } catch (err) {
        breaker.recordFailure(err);
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${breaker.config.id} ${breaker.config.baseUrl}] ${msg}`);
      }
    }

    const summary = this.getStatusSnapshots()
      .map(
        (s) =>
          `${s.id}(${s.state}${s.remainingBackoffMs > 0 ? `, backoff=${s.remainingBackoffMs}ms` : ""})`
      )
      .join(", ");

    const detail =
      errors.length > 0
        ? `Attempts failed: ${errors.join("; ")}. `
        : "All Jenkins nodes rejected traffic by circuit breaker. ";

    throw new Error(`${detail}Cluster status: [${summary}]`);
  }
}
