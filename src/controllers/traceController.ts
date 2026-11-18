import type http from "node:http";
import { getRecentSpans, getSpansByTraceId } from "../config/telemetry.js";
import { sendJson } from "../routes/httpUtils.js";

export async function listTracesHandler(
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const limitParam = Number(url.searchParams.get("limit") || 100);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 500)
      : 100;
  const spans = await getRecentSpans(limit);
  sendJson(res, 200, { count: spans.length, spans });
}

export async function getTraceByIdHandler(
  res: http.ServerResponse,
  rawTraceId: string
): Promise<void> {
  const traceId = decodeURIComponent(rawTraceId);
  const spans = await getSpansByTraceId(traceId);
  sendJson(res, 200, { traceId, count: spans.length, spans });
}
