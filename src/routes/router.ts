import type http from "node:http";
import { createLogger } from "../config/logger.js";
import { collectMetricsText, getMetricsContentType } from "../config/metrics.js";
import {
  getAuthMeHandler,
  getOAuthAuthorizeUrlHandler,
  logoutHandler,
  oauthLoginHandler,
  testAlertMailHandler,
} from "../controllers/authController.js";

const routerLog = createLogger("router");
import {
  executeJenkinsXmlHandler,
  getJenkinsBuildHandler,
  getJenkinsNodesHandler,
} from "../controllers/jenkinsController.js";
import {
  abortGenerationJobHandler,
  getGenerationJobHandler,
  restartGenerationJobHandler,
  startGenerationJobHandler,
} from "../controllers/jobController.js";
import {
  createMcpHandler,
  deleteMcpHandler,
  listMcpsHandler,
} from "../controllers/mcpController.js";
import {
  abortPipelineReposHandler,
  getCatalogHandler,
  publishSkillHandler,
  rerunPipelineReposHandler,
  testPipelineHandler,
} from "../controllers/pipelineController.js";
import {
  deleteSkillHandler,
  downloadSkillHandler,
  generateSkillSyncHandler,
  getSkillDetailHandler,
  listSkillsHandler,
  runSkillHandler,
  updateSkillHandler,
  uploadSkillHandler,
} from "../controllers/skillController.js";
import {
  getTraceByIdHandler,
  listTracesHandler,
} from "../controllers/traceController.js";
import {
  abortWorkbenchSessionHandler,
  addWorkbenchTodoHandler,
  closeWorkbenchSessionHandler,
  createWorkbenchSessionHandler,
  getWorkbenchSessionHandler,
  listOpenAIModelsHandler,
  listWorkbenchExtensionsHandler,
  listWorkbenchSessionsHandler,
  removeWorkbenchTodoHandler,
  sendWorkbenchMessageHandler,
  setWorkbenchThinkingHandler,
  stopWorkbenchBgCommandHandler,
  submitWorkbenchQuestionAnswerHandler,
} from "../controllers/workbenchController.js";
import { getDbDriver, isDbConnected } from "../db/database.js";
import { getRedisMode, isRedisConnected } from "../db/redis.js";
import {
  extractTokenFromRequest,
  verifyTokenFromRedis,
} from "../services/authService.js";
import { sendCorsPreflight, sendJson } from "./httpUtils.js";

export async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number
): Promise<void> {
  const method = req.method ?? "GET";
  if (method === "OPTIONS") {
    return sendCorsPreflight(res);
  }

  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  try {
    if (method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        dbConnected: isDbConnected(),
        dbDriver: getDbDriver(),
        redisConnected: isRedisConnected(),
        redisMode: getRedisMode(),
      });
    }

    if (method === "GET" && url.pathname === "/metrics") {
      const body = await collectMetricsText();
      res.writeHead(200, {
        "Content-Type": getMetricsContentType(),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    // Auth endpoints (always accessible without global auth gate)
    if (method === "GET" && url.pathname === "/api/auth/me") {
      return await getAuthMeHandler(req, res, url);
    }
    if (method === "GET" && url.pathname === "/api/auth/oauth/url") {
      return await getOAuthAuthorizeUrlHandler(res);
    }
    if (method === "POST" && url.pathname === "/api/auth/oauth/login") {
      return await oauthLoginHandler(req, res);
    }
    if (method === "POST" && url.pathname === "/api/auth/logout") {
      return await logoutHandler(req, res, url);
    }

    // Optional global Redis-backed API auth gate (enable with AUTH_REQUIRED=true)
    if (process.env.AUTH_REQUIRED === "true" && url.pathname.startsWith("/api/")) {
      const token = extractTokenFromRequest(req, url);
      const auth = await verifyTokenFromRedis(token);
      if (!auth.authenticated) {
        return sendJson(res, 401, {
          authenticated: false,
          error: auth.reason,
        });
      }
    }

    if (method === "POST" && url.pathname === "/api/alerts/mail/test") {
      return await testAlertMailHandler(req, res);
    }

    if (method === "GET" && url.pathname === "/api/traces") {
      return await listTracesHandler(res, url);
    }

    const traceDetailMatch = url.pathname.match(/^\/api\/traces\/([^/]+)$/);
    if (method === "GET" && traceDetailMatch) {
      return await getTraceByIdHandler(res, traceDetailMatch[1]);
    }

    if (method === "GET" && url.pathname === "/api/catalog") {
      return await getCatalogHandler(res);
    }

    if (method === "GET" && url.pathname === "/api/mcps") {
      return await listMcpsHandler(res, url);
    }
    if (method === "POST" && url.pathname === "/api/mcps") {
      return await createMcpHandler(req, res);
    }
    const mcpDeleteMatch = url.pathname.match(/^\/api\/mcps\/([^/]+)$/);
    if (method === "DELETE" && mcpDeleteMatch) {
      return await deleteMcpHandler(res, mcpDeleteMatch[1], url);
    }

    if (method === "POST" && url.pathname === "/api/openai/models") {
      return await listOpenAIModelsHandler(req, res);
    }

    if (method === "GET" && url.pathname === "/api/workbench/extensions") {
      return await listWorkbenchExtensionsHandler(res);
    }
    if (method === "GET" && url.pathname === "/api/workbench/sessions") {
      return await listWorkbenchSessionsHandler(res, url);
    }
    if (method === "POST" && url.pathname === "/api/workbench/sessions") {
      return await createWorkbenchSessionHandler(req, res);
    }
    const wbMsgMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)\/messages$/
    );
    if (method === "POST" && wbMsgMatch) {
      return await sendWorkbenchMessageHandler(req, res, wbMsgMatch[1]);
    }
    const wbAbortMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)\/abort$/
    );
    if (method === "POST" && wbAbortMatch) {
      return await abortWorkbenchSessionHandler(res, wbAbortMatch[1]);
    }
    const wbThinkingMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)\/thinking$/
    );
    if (method === "POST" && wbThinkingMatch) {
      return await setWorkbenchThinkingHandler(req, res, wbThinkingMatch[1]);
    }
    const wbQuestionAnswerMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)\/question\/answer$/
    );
    if (method === "POST" && wbQuestionAnswerMatch) {
      return await submitWorkbenchQuestionAnswerHandler(
        req,
        res,
        wbQuestionAnswerMatch[1]
      );
    }
    const wbTodosMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)\/todos$/
    );
    if (method === "POST" && wbTodosMatch) {
      return await addWorkbenchTodoHandler(req, res, wbTodosMatch[1]);
    }
    const wbTodoItemMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)\/todos\/([^/]+)$/
    );
    if (method === "DELETE" && wbTodoItemMatch) {
      return await removeWorkbenchTodoHandler(
        res,
        wbTodoItemMatch[1],
        wbTodoItemMatch[2]
      );
    }
    const wbBgStopMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)\/bg-commands\/([^/]+)\/stop$/
    );
    if (method === "POST" && wbBgStopMatch) {
      return await stopWorkbenchBgCommandHandler(
        res,
        wbBgStopMatch[1],
        wbBgStopMatch[2]
      );
    }
    const wbSessionMatch = url.pathname.match(
      /^\/api\/workbench\/sessions\/([^/]+)$/
    );
    if (method === "GET" && wbSessionMatch) {
      return await getWorkbenchSessionHandler(res, wbSessionMatch[1]);
    }
    if (method === "DELETE" && wbSessionMatch) {
      return await closeWorkbenchSessionHandler(res, wbSessionMatch[1]);
    }

    if (method === "GET" && url.pathname === "/api/jenkins/nodes") {
      return await getJenkinsNodesHandler(res);
    }

    if (method === "POST" && url.pathname === "/api/jenkins/execute") {
      return await executeJenkinsXmlHandler(req, res);
    }

    const jenkinsBuildMatch = url.pathname.match(
      /^\/api\/jenkins\/jobs\/([^/]+)\/(\d+)$/
    );
    if (method === "GET" && jenkinsBuildMatch) {
      return await getJenkinsBuildHandler(
        res,
        jenkinsBuildMatch[1],
        jenkinsBuildMatch[2]
      );
    }

    if (method === "GET" && url.pathname === "/api/skills") {
      return await listSkillsHandler(res);
    }

    if (method === "POST" && url.pathname === "/api/skills/upload") {
      return await uploadSkillHandler(req, res);
    }

    if (method === "POST" && url.pathname === "/api/skills/generate/start") {
      return await startGenerationJobHandler(req, res);
    }

    const jobStatusMatch = url.pathname.match(
      /^\/api\/skills\/generate\/jobs\/([^/]+)$/
    );
    if (method === "GET" && jobStatusMatch) {
      return await getGenerationJobHandler(res, jobStatusMatch[1]);
    }

    const jobAbortMatch = url.pathname.match(
      /^\/api\/skills\/generate\/jobs\/([^/]+)\/abort$/
    );
    if (method === "POST" && jobAbortMatch) {
      return await abortGenerationJobHandler(req, res, jobAbortMatch[1]);
    }

    const jobRestartMatch = url.pathname.match(
      /^\/api\/skills\/generate\/jobs\/([^/]+)\/restart$/
    );
    if (method === "POST" && jobRestartMatch) {
      return await restartGenerationJobHandler(req, res, jobRestartMatch[1]);
    }

    if (method === "POST" && url.pathname === "/api/skills/generate") {
      return await generateSkillSyncHandler(req, res);
    }

    if (method === "POST" && url.pathname === "/api/skills/run") {
      return await runSkillHandler(req, res);
    }

    const downloadMatch = url.pathname.match(
      /^\/api\/skills\/([^/]+)\/download$/
    );
    if (method === "GET" && downloadMatch) {
      return await downloadSkillHandler(res, downloadMatch[1]);
    }

    const abortMatch = url.pathname.match(
      /^\/api\/skills\/([^/]+)\/test-pipeline\/abort$/
    );
    if (method === "POST" && abortMatch) {
      return await abortPipelineReposHandler(req, res, abortMatch[1]);
    }

    const rerunMatch = url.pathname.match(
      /^\/api\/skills\/([^/]+)\/test-pipeline\/rerun$/
    );
    if (method === "POST" && rerunMatch) {
      return await rerunPipelineReposHandler(req, res, rerunMatch[1]);
    }

    const testMatch = url.pathname.match(
      /^\/api\/skills\/([^/]+)\/test-pipeline$/
    );
    if (method === "POST" && testMatch) {
      return await testPipelineHandler(req, res, testMatch[1]);
    }

    const publishMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/publish$/);
    if (method === "POST" && publishMatch) {
      return await publishSkillHandler(res, publishMatch[1]);
    }

    const detailMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (method === "GET" && detailMatch) {
      return await getSkillDetailHandler(res, detailMatch[1]);
    }
    if (method === "PUT" && detailMatch) {
      return await updateSkillHandler(req, res, detailMatch[1]);
    }
    if (method === "DELETE" && detailMatch) {
      return await deleteSkillHandler(res, detailMatch[1]);
    }

    return sendJson(res, 404, { error: "Not Found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    routerLog.error(
      { err: error, method, path: url.pathname },
      "Unhandled route error"
    );
    return sendJson(res, 500, { error: message });
  }
}
