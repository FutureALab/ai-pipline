import type http from "node:http";
import {
  getSkillCard,
  listCatalogApps,
  listCatalogRepos,
  upsertSkillCard,
} from "../repositories/skillRepository.js";
import { normalizeSkillName } from "../repositories/skillStorage.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import {
  executeBatchPipelineTest,
  type PipelineExecutionMode,
} from "../services/pipelineService.js";

export async function getCatalogHandler(res: http.ServerResponse): Promise<void> {
  const [apps, repos] = await Promise.all([
    listCatalogApps(),
    listCatalogRepos(),
  ]);
  sendJson(res, 200, { apps, repos });
}

export async function testPipelineHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawName: string
): Promise<void> {
  const name = normalizeSkillName(decodeURIComponent(rawName));
  const body = await readJsonBody(req);
  const apps = Array.isArray(body.apps)
    ? body.apps.filter((x): x is string => typeof x === "string")
    : [];
  const repoIds = Array.isArray(body.repos)
    ? body.repos.filter((x): x is string => typeof x === "string")
    : [];
  const mode: PipelineExecutionMode =
    body.mode === "real" || body.mode === "jenkins" ? body.mode : "simulate";

  if (apps.length === 0) {
    return sendJson(res, 400, { error: "请至少勾选 1 个相关应用" });
  }
  if (repoIds.length !== 10) {
    return sendJson(res, 400, {
      error: `Git 版本库有且必须选够 10 个（当前已选 ${repoIds.length} 个）`,
    });
  }

  const result = await executeBatchPipelineTest({
    skillName: name,
    apps,
    repoIds,
    mode,
  });
  sendJson(res, 200, result);
}

export async function publishSkillHandler(
  res: http.ServerResponse,
  rawName: string
): Promise<void> {
  const name = normalizeSkillName(decodeURIComponent(rawName));
  const existing = await getSkillCard(name);
  if (!existing) {
    return sendJson(res, 404, { error: `Skill "${name}" not found` });
  }
  if (existing.card.status !== "test_passed") {
    return sendJson(res, 400, {
      error: "只有全部测试流水线成功通过后才能发布",
    });
  }

  const card = await upsertSkillCard(name, {
    currentStep: 3,
    progress: 100,
    status: "published",
  });
  sendJson(res, 200, { card });
}
