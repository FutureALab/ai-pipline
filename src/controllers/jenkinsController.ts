import type http from "node:http";
import { readSkillMarkdown } from "../repositories/skillRepository.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import {
  executeJenkinsJobWithXml,
  getJenkinsBuildStatus,
} from "../services/jenkinsClient.js";

/**
 * Third-party endpoint: create/update a Jenkins job with raw `xml` (or auto-generated
 * pi-agent pipeline XML) and trigger execution immediately.
 */
export async function executeJenkinsXmlHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  const jobName =
    typeof body.jobName === "string" && body.jobName.trim()
      ? body.jobName.trim()
      : process.env.JENKINS_DEFAULT_JOB || "ai-skill-pipeline";
  const xml = typeof body.xml === "string" ? body.xml : undefined;
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : undefined;
  const repoBranch =
    typeof body.repoBranch === "string" ? body.repoBranch : undefined;
  const skillName =
    typeof body.skillName === "string" ? body.skillName : undefined;
  const taskPrompt =
    typeof body.taskPrompt === "string" ? body.taskPrompt : undefined;
  const waitForCompletion = body.waitForCompletion !== false;
  const timeoutMs =
    typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
  const parameters =
    body.parameters && typeof body.parameters === "object"
      ? (body.parameters as Record<string, string>)
      : undefined;

  if (!xml?.trim() && (!repoUrl?.trim() || !skillName?.trim())) {
    return sendJson(res, 400, {
      error: "Either `xml` or (`repoUrl` and `skillName`) is required",
    });
  }

  const skillContent = skillName
    ? await readSkillMarkdown(skillName).catch(() => "")
    : "";

  const result = await executeJenkinsJobWithXml({
    jobName,
    xml,
    repoUrl,
    repoBranch,
    skillName,
    skillContent,
    taskPrompt,
    parameters,
    waitForCompletion,
    timeoutMs,
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
