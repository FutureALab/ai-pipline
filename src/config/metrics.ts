import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import { getJenkinsClusterStatus } from "../services/jenkinsClient.js";
import { getJenkinsDispatchQueueMetrics } from "../services/jenkinsDispatchQueue.js";

const registry = new Registry();
registry.setDefaultLabels({
  app: process.env.OTEL_SERVICE_NAME?.trim() || "ai-pipline2",
});

collectDefaultMetrics({
  register: registry,
  prefix: "ai_pipeline_",
});

const httpRequestsTotal = new Counter({
  name: "ai_pipeline_http_requests_total",
  help: "Total number of HTTP requests handled",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

const httpRequestDurationSeconds = new Histogram({
  name: "ai_pipeline_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const blockingQueueJobsGauge = new Gauge({
  name: "ai_pipeline_blocking_queue_jobs",
  help: "Current number of jobs in blocking queues by state",
  labelNames: ["queue", "mode", "state"] as const,
  registers: [registry],
});

const jenkinsCircuitStateGauge = new Gauge({
  name: "ai_pipeline_jenkins_circuit_breaker_state",
  help: "Jenkins node circuit breaker state (0=HEALTHY, 1=HALF_OPEN, 2=BLOCKED)",
  labelNames: ["node_id", "base_url"] as const,
  registers: [registry],
});

const jenkinsCircuitRequestsGauge = new Gauge({
  name: "ai_pipeline_jenkins_circuit_breaker_requests",
  help: "Cumulative Jenkins node request counts by outcome",
  labelNames: ["node_id", "base_url", "outcome"] as const,
  registers: [registry],
});

const jenkinsCircuitRemainingBackoffGauge = new Gauge({
  name: "ai_pipeline_jenkins_circuit_breaker_remaining_backoff_ms",
  help: "Remaining circuit breaker backoff time in ms for a BLOCKED Jenkins node",
  labelNames: ["node_id", "base_url"] as const,
  registers: [registry],
});

function normalizeMetricRoute(pathname: string): string {
  return pathname
    .replace(/\/api\/skills\/[^/]+(?=\/|$)/, "/api/skills/:name")
    .replace(/\/api\/skills\/generate\/jobs\/[^/]+/, "/api/skills/generate/jobs/:id")
    .replace(/\/api\/workbench\/sessions\/[^/]+/, "/api/workbench/sessions/:id")
    .replace(/\/api\/jenkins\/jobs\/[^/]+\/\d+/, "/api/jenkins/jobs/:job/:build")
    .replace(/\/api\/traces\/[^/]+/, "/api/traces/:traceId")
    .replace(/\/api\/mcps\/[^/]+/, "/api/mcps/:id");
}

export function recordHttpMetric(
  method: string,
  pathname: string,
  statusCode: number,
  durationMs: number
): void {
  if (pathname === "/metrics") return;
  const route = normalizeMetricRoute(pathname);
  const status = String(statusCode);
  httpRequestsTotal.inc({ method, route, status_code: status });
  httpRequestDurationSeconds.observe(
    { method, route, status_code: status },
    durationMs / 1000
  );
}

export function getMetricsContentType(): string {
  return registry.contentType;
}

export async function collectMetricsText(): Promise<string> {
  // 1. Refresh Jenkins circuit breaker gauges
  const nodes = getJenkinsClusterStatus();
  for (const node of nodes) {
    const stateVal =
      node.state === "HEALTHY" ? 0 : node.state === "HALF_OPEN" ? 1 : 2;
    jenkinsCircuitStateGauge.set(
      { node_id: node.id, base_url: node.baseUrl },
      stateVal
    );
    jenkinsCircuitRemainingBackoffGauge.set(
      { node_id: node.id, base_url: node.baseUrl },
      node.remainingBackoffMs
    );
    jenkinsCircuitRequestsGauge.set(
      { node_id: node.id, base_url: node.baseUrl, outcome: "success" },
      node.totalSuccess
    );
    jenkinsCircuitRequestsGauge.set(
      { node_id: node.id, base_url: node.baseUrl, outcome: "failure" },
      node.totalFailure
    );
    jenkinsCircuitRequestsGauge.set(
      { node_id: node.id, base_url: node.baseUrl, outcome: "rejected" },
      node.totalRejected
    );
  }

  // 2. Refresh BullMQ / BlockingQueue gauges
  const queueMetrics = await getJenkinsDispatchQueueMetrics().catch(() => null);
  if (queueMetrics) {
    const { mode, waiting, active, completed, failed } = queueMetrics;
    blockingQueueJobsGauge.set({ queue: "jenkins-dispatch", mode, state: "waiting" }, waiting);
    blockingQueueJobsGauge.set({ queue: "jenkins-dispatch", mode, state: "active" }, active);
    blockingQueueJobsGauge.set({ queue: "jenkins-dispatch", mode, state: "completed" }, completed);
    blockingQueueJobsGauge.set({ queue: "jenkins-dispatch", mode, state: "failed" }, failed);
  }

  return await registry.metrics();
}
