import http from "node:http";
import { ensureTelemetryInitialized } from "./config/telemetry.js";
import { initDatabase } from "./db/postgres.js";
import { initRedis } from "./db/redis.js";
import { routeRequest } from "./routes/router.js";

export async function startServer(port: number = 3000): Promise<http.Server> {
  await initDatabase();
  await initRedis();
  ensureTelemetryInitialized();

  const server = http.createServer((req, res) => {
    void routeRequest(req, res, port);
  });

  server.listen(port, () => {
    console.log(`Skill Pipeline API listening on http://localhost:${port}`);
  });

  return server;
}
