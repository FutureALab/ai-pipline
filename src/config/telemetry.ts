import fs from "node:fs";
import path from "node:path";
import { trace, type Attributes, type Context } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import { isDbConnected, queryDb } from "../db/database.js";

export type AgentTelemetryConfig = NonNullable<
  CreateAgentSessionOptions["telemetry"]
>;

export interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: {
    code: number;
    message?: string;
  };
  attributes: Record<string, unknown>;
  events: Array<{
    name: string;
    timeMs: number;
    attributes?: Record<string, unknown>;
  }>;
}

const MAX_IN_MEMORY_SPANS = 500;
const TRACE_LOG_PATH = path.resolve(process.cwd(), "data", "traces.jsonl");
const recentSpans: RecordedSpan[] = [];
let initialized = false;

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

class LocalTraceSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {
    // no-op
  }

  onEnd(span: ReadableSpan): void {
    const startTimeMs = hrTimeToMs(span.startTime);
    const endTimeMs = hrTimeToMs(span.endTime);
    const parentSpanId = span.parentSpanContext?.spanId;

    const record: RecordedSpan = {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: span.name,
      kind: span.kind,
      startTimeMs,
      endTimeMs,
      durationMs: Math.round((endTimeMs - startTimeMs) * 100) / 100,
      status: {
        code: span.status.code,
        ...(span.status.message ? { message: span.status.message } : {}),
      },
      attributes: { ...span.attributes },
      events: span.events.map((ev) => ({
        name: ev.name,
        timeMs: hrTimeToMs(ev.time),
        ...(ev.attributes ? { attributes: { ...ev.attributes } } : {}),
      })),
    };

    recentSpans.unshift(record);
    if (recentSpans.length > MAX_IN_MEMORY_SPANS) {
      recentSpans.length = MAX_IN_MEMORY_SPANS;
    }

    try {
      fs.mkdirSync(path.dirname(TRACE_LOG_PATH), { recursive: true });
      fs.appendFileSync(TRACE_LOG_PATH, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // Ignore disk write errors
    }

    if (isDbConnected()) {
      void queryDb(
        `INSERT INTO ai_trace_spans (
           trace_id, span_id, parent_span_id, name, kind,
           start_time_ms, end_time_ms, duration_ms, status, attributes, events
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)`,
        [
          record.traceId,
          record.spanId,
          record.parentSpanId ?? null,
          record.name,
          record.kind,
          record.startTimeMs,
          record.endTimeMs,
          record.durationMs,
          JSON.stringify(record.status),
          JSON.stringify(record.attributes),
          JSON.stringify(record.events),
        ]
      ).catch(() => {});
    }
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export function ensureTelemetryInitialized(): void {
  if (initialized) return;
  initialized = true;

  if (process.env.OTEL_ENABLED === "false") {
    return;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "ai-pipline2";
  const spanProcessors: SpanProcessor[] = [new LocalTraceSpanProcessor()];

  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

  if (otlpEndpoint) {
    const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
    spanProcessors.push(new BatchSpanProcessor(exporter));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    spanProcessors,
  });

  provider.register();
}

export function buildSessionTelemetryConfig(context: {
  operation: "skill_generate" | "skill_run";
  skillName?: string;
  jobId?: string;
  extraAttributes?: Attributes;
}): AgentTelemetryConfig {
  ensureTelemetryInitialized();

  const rawCapture = (
    process.env.OTEL_CAPTURE_CONTENT || "summary"
  ).toLowerCase();
  const captureMessageContent =
    rawCapture === "full" || rawCapture === "true"
      ? "full"
      : rawCapture === "false" || rawCapture === "none"
        ? false
        : "summary";

  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "ai-pipline2";

  return {
    tracer: trace.getTracer(serviceName),
    tracerName: serviceName,
    captureMessageContent,
    agent: {
      name: context.operation === "skill_generate" ? "skill-generator" : "skill-runner",
    },
    attributes: {
      "pipeline.operation": context.operation,
      ...(context.skillName ? { "skill.name": context.skillName } : {}),
      ...(context.jobId ? { "generation.job_id": context.jobId } : {}),
      ...(context.extraAttributes ?? {}),
    },
  };
}

type DbSpanRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  status: RecordedSpan["status"] | string;
  attributes: Record<string, unknown> | string;
  events: RecordedSpan["events"] | string;
};

function parseJsonValue<T>(val: T | string | null | undefined, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val;
}

function mapDbSpanRow(row: DbSpanRow): RecordedSpan {
  const status = parseJsonValue<RecordedSpan["status"]>(row.status, { code: 0 });
  const attributes = parseJsonValue<Record<string, unknown>>(row.attributes, {});
  const events = parseJsonValue<RecordedSpan["events"]>(row.events, []);
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
    name: row.name,
    kind: row.kind,
    startTimeMs: row.start_time_ms,
    endTimeMs: row.end_time_ms,
    durationMs: row.duration_ms,
    status,
    attributes,
    events: Array.isArray(events) ? events : [],
  };
}

export async function getRecentSpans(
  limit: number = 100
): Promise<RecordedSpan[]> {
  if (isDbConnected()) {
    const res = await queryDb<DbSpanRow>(
      `SELECT trace_id, span_id, parent_span_id, name, kind,
              start_time_ms, end_time_ms, duration_ms, status, attributes, events
       FROM ai_trace_spans
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows.map(mapDbSpanRow);
  }

  if (recentSpans.length > 0) {
    return recentSpans.slice(0, limit);
  }

  try {
    const raw = fs.readFileSync(TRACE_LOG_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const parsed: RecordedSpan[] = [];
    for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
      try {
        parsed.push(JSON.parse(lines[i]) as RecordedSpan);
      } catch {
        // skip malformed line
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export async function getSpansByTraceId(
  traceId: string
): Promise<RecordedSpan[]> {
  if (isDbConnected()) {
    const res = await queryDb<DbSpanRow>(
      `SELECT trace_id, span_id, parent_span_id, name, kind,
              start_time_ms, end_time_ms, duration_ms, status, attributes, events
       FROM ai_trace_spans
       WHERE trace_id = $1
       ORDER BY start_time_ms ASC`,
      [traceId]
    );
    return res.rows.map(mapDbSpanRow);
  }

  return (await getRecentSpans(MAX_IN_MEMORY_SPANS))
    .filter((s) => s.traceId === traceId)
    .sort((a, b) => a.startTimeMs - b.startTimeMs);
}
