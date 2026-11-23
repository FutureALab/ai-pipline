import type http from "node:http";
import { readSkillMarkdown } from "../repositories/skillRepository.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import {
  JenkinsExecuteSchema,
  parseWithSchema,
} from "../schemas/apiSchemas.js";
import {
  executeJenkinsJobWithXml,
  getJenkinsBuildStatus,
  getJenkinsClusterStatus,
} from "../services/jenkinsClient.js";

/**
 * Third-party endpoint: create/update a Jenkins job with raw `xml` (or auto-generated
 * pi-agent pipeline XML) and trigger execution immediately.
 */
export async function executeJenkinsXmlHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const rawBody = await readJsonBody(req);
  const parsed = parseWithSchema(JenkinsExecuteSchema, rawBody);
  if (!parsed.ok) {
    return sendJson(res, 400, {
      error: parsed.error,
      issues: parsed.issues,
    });
  }

  const data = parsed.data;
  const jobName =
    data.jobName || process.env.JENKINS_DEFAULT_JOB || "ai-skill-pipeline";

  const skillContent = data.skillName
    ? await readSkillMarkdown(data.skillName).catch(() => "")
    : "";

  const result = await executeJenkinsJobWithXml({
    jobName,
    xml: data.xml,
    repoUrl: data.repoUrl,
    repoBranch: data.repoBranch,
    skillName: data.skillName,
    skillContent,
    taskPrompt: data.taskPrompt,
    parameters: data.parameters,
    waitForCompletion: data.waitForCompletion !== false,
    timeoutMs: data.timeoutMs,
  });

  sendJson(res, 200, result);
}

export async function getJenkinsBuildHandler(
  res: http.ServerResponse,
  rawJobName: string,
  rawBuildNumber: string
): Promise<void> {
  const jobName = decodeURIComponent(rawJobName);
  const buildNumber = Number(rawBuildNumber);
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
    return sendJson(res, 400, { error: "Invalid buildNumber" });
  }

  const status = await getJenkinsBuildStatus(jobName, buildNumber);
  sendJson(res, 200, { jobName, buildNumber, ...status });
}

export async function getJenkinsNodesHandler(
  res: http.ServerResponse
): Promise<void> {
  sendJson(res, 200, {
    nodes: getJenkinsClusterStatus(),
  });
}
