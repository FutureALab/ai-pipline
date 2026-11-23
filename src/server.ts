import crypto from "node:crypto";
import http from "node:http";
import { createLogger, getLogConfigSummary } from "./config/logger.js";
import { ensureTelemetryInitialized } from "./config/telemetry.js";
import { getDbDriver, initDatabase } from "./db/database.js";
import { getRedisMode, initRedis, isRedisConnected } from "./db/redis.js";
import { routeRequest } from "./routes/router.js";
import {
  initJenkinsPipelineQueueWorker,
  startJenkinsLogSyncScheduler,
} from "./services/pipelineService.js";

const serverLog = createLogger("server");
const httpLog = createLogger("http");

const QUIET_POLL_PATH_RE =
  /^\/api\/(?:workbench\/sessions\/[^/]+|skills\/generate\/jobs\/[^/]+)$/;

export async function startServer(port: number = 3000): Promise<http.Server> {
  const bootStart = Date.now();
  serverLog.info({ port, log: getLogConfigSummary() }, "Bootstrapping Skill Pipeline API server...");

  await initDatabase();
  await initRedis();
  ensureTelemetryInitialized();
  await initJenkinsPipelineQueueWorker();
  startJenkinsLogSyncScheduler(3000);

  const server = http.createServer((req, res) => {
    const reqId = crypto.randomUUID().slice(0, 8);
    const reqStart = Date.now();
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0] || "/";

    res.on("finish", () => {
      const durationMs = Date.now() - reqStart;
      const statusCode = res.statusCode;

      if (method === "OPTIONS") return;

      const isQuietPoll =
        method === "GET" &&
        statusCode < 400 &&
        (pathname === "/health" || QUIET_POLL_PATH_RE.test(pathname));

      const payload = { reqId, method, path: pathname, statusCode, durationMs };

      if (statusCode >= 500) {
        httpLog.error(payload, "HTTP request failed");
      } else if (statusCode >= 400) {
        httpLog.warn(payload, "HTTP client error");
      } else if (isQuietPoll) {
        httpLog.debug(payload, "HTTP poll request");
      } else {
        httpLog.info(payload, "HTTP request completed");
      }
    });

    void routeRequest(req, res, port);
  });

  server.on("error", (err) => {
    serverLog.fatal({ err, port }, "HTTP server error");
  });

  server.listen(port, () => {
    serverLog.info(
      {
        url: `http://localhost:${port}`,
        dbDriver: getDbDriver(),
        redisConnected: isRedisConnected(),
        redisMode: getRedisMode(),
        bootMs: Date.now() - bootStart,
      },
      `Skill Pipeline API listening on http://localhost:${port}`
    );
  });

  return server;
}
