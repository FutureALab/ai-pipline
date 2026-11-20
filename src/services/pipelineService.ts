import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../config/logger.js";
import {
  listCatalogRepos,
  listSkillCards,
  readSkillMarkdown,
  upsertSkillCard,
} from "../repositories/skillRepository.js";
import type {
  CatalogRepoRow,
  RepoPipelineRun,
  SkillCardRecord,
} from "../types/skill.js";
import {
  executeJenkinsJobWithXml,
  getJenkinsBuildStatus,
  resolveJenkinsQueueItem,
} from "./jenkinsClient.js";
import { runSkillInRepo } from "./skillRunner.js";

const execFileAsync = promisify(execFile);
const pipelineLog = createLogger("pipeline");

export type PipelineExecutionMode = "real" | "simulate" | "jenkins";

export async function ensureJenkinsBundledBinaryForSkill(
  skillName: string
): Promise<string> {
  const target =
    process.env.JENKINS_BINARY_TARGET?.trim() ||
    (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
  if (process.env.JENKINS_AUTO_BUILD_BINARY === "false") {
    return target;
  }
  const scriptPath = path.resolve(process.cwd(), "scripts/build-binaries.ts");
  const exists = await fs
    .stat(scriptPath)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!exists) return target;

  pipelineLog.info(
    { skillName, target },
    "Building Linux ai-pipeline binary with embedded skill for Jenkins"
  );
  await execFileAsync(
    "bun",
    ["run", scriptPath, target, "--skill", skillName],
    {
      cwd: process.cwd(),
      timeout: 180_000,
    }
  );
  return target;
}

async function runSingleRepoPipeline(
  skillName: string,
  repo: CatalogRepoRow,
  apps: string[],
  mode: PipelineExecutionMode,
  onRunUpdate?: (run: RepoPipelineRun) => Promise<void>
): Promise<RepoPipelineRun> {
  const start = Date.now();
  const logs: string[] = [
    `[Jenkins] Triggering pipeline for repo "${repo.name}" (${repo.url})`,
    `[Jenkins] Target apps: ${apps.join(", ") || "none"}`,
    `[Stage 1/3] git clone --branch ${repo.branch} --depth 1 ${repo.url}`,
  ];

  if (mode === "jenkins") {
    try {
      const skillContent = await readSkillMarkdown(skillName).catch(() => "");
      const jobName = `ai-skill-${skillName}-${repo.id}`;
      const result = await executeJenkinsJobWithXml({
        jobName,
        repoUrl: repo.url,
        repoBranch: repo.branch,
        skillName,
        skillContent,
        taskPrompt: `Apply skill ${skillName} for apps [${apps.join(", ")}] on repository ${repo.name}.`,
        waitForCompletion: true,
        pollIntervalMs: 3000,
        onLogUpdate: async (info) => {
          await onRunUpdate?.({
            repoId: repo.id,
            repoName: repo.name,
            repoUrl: repo.url,
            status: info.building ? "running" : "running",
            durationMs: Date.now() - start,
            jenkinsJobName: info.jobName,
            jenkinsBuildNumber: info.buildNumber,
            jenkinsBuildUrl: info.buildUrl,
            logs: [
              `[Jenkins] Job: ${info.jobName} (#${info.buildNumber ?? "-"})`,
              ...(info.buildUrl ? [`[Jenkins] Build URL: ${info.buildUrl}`] : []),
              ...info.logs,
            ],
          });
        },
      });

      return {
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
        status: result.status === "success" ? "success" : "failed",
        durationMs: result.durationMs,
        jenkinsJobName: result.jobName,
        jenkinsBuildNumber: result.buildNumber,
        jenkinsBuildUrl: result.buildUrl,
        logs: [
          `[Jenkins] Job: ${result.jobName} (#${result.buildNumber ?? "-"})`,
          ...(result.buildUrl ? [`[Jenkins] Build URL: ${result.buildUrl}`] : []),
          ...result.logs,
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
        status: "failed",
        durationMs: Date.now() - start,
        logs: [...logs, `[ERROR] ${msg}`],
      };
    }
  }

  if (mode === "simulate") {
    logs.push(`[git] Cloned ${repo.name} into workspace/target-repo`);
    logs.push(`[Stage 2/3] Loading skill "${skillName}" from ~/.omp/agent/skills/${skillName}/SKILL.md`);
    logs.push(`[Stage 3/3] Running AI agent session with /skill:${skillName} ...`);
    logs.push(`[AI] Checked repository structure, validated rules & executed skill workflow.`);
    logs.push(`[Jenkins] Pipeline PASSED for ${repo.name}`);
    return {
      repoId: repo.id,
      repoName: repo.name,
      repoUrl: repo.url,
      status: "success",
      durationMs: Math.max(120, Date.now() - start),
      logs,
    };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-jenkins-${repo.id}-`));
  try {
    await execFileAsync("git", ["clone", "--branch", repo.branch, "--depth", "1", repo.url, tmpDir], {
      timeout: 60_000,
    });
    logs.push(`[git] Cloned ${repo.name} into ${tmpDir}`);
    logs.push(`[Stage 2/3] Executing /skill:${skillName} via @oh-my-pi/pi-coding-agent`);

    const runResult = await runSkillInRepo({
      skillName,
      cwd: tmpDir,
      taskPrompt: `Apply skill ${skillName} for apps [${apps.join(", ")}] on repository ${repo.name}.`,
    });
    logs.push(`[AI Output]\n${runResult.output.slice(0, 2000)}`);
    logs.push(`[Jenkins] Pipeline PASSED for ${repo.name} in ${runResult.durationMs}ms`);

    return {
      repoId: repo.id,
      repoName: repo.name,
      repoUrl: repo.url,
      status: "success",
      durationMs: Date.now() - start,
      logs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`[ERROR] ${msg}`);
    logs.push(`[Jenkins] Pipeline FAILED for ${repo.name}`);
    return {
      repoId: repo.id,
      repoName: repo.name,
      repoUrl: repo.url,
      status: "failed",
      durationMs: Date.now() - start,
      logs,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function executeBatchPipelineTest(params: {
  skillName: string;
  apps: string[];
  repoIds: string[];
  mode: PipelineExecutionMode;
}): Promise<{
  card: SkillCardRecord;
  allPassed: boolean;
  pipelineRuns: RepoPipelineRun[];
}> {
  const catalogRepos = await listCatalogRepos();
  const repoMap = new Map(catalogRepos.map((r) => [r.id, r]));
  const selectedRepos = params.repoIds.map(
    (id) =>
      repoMap.get(id) ?? {
        id,
        name: id,
        url: id.startsWith("http") ? id : `https://git.example.com/org/${id}.git`,
        branch: "main",
      }
  );

  const pipelineRuns: RepoPipelineRun[] = selectedRepos.map((repo) => ({
    repoId: repo.id,
    repoName: repo.name,
    repoUrl: repo.url,
    status: "pending",
    durationMs: 0,
    logs: [`[Jenkins] Queued pipeline for repo "${repo.name}"`],
  }));

  await upsertSkillCard(params.skillName, {
    selectedApps: params.apps,
    selectedRepos: params.repoIds,
    pipelineRuns,
    currentStep: 3,
    progress: 66,
    status: "testing",
  });

  if (params.mode === "jenkins") {
    let buildWarn: string | null = null;
    try {
      await ensureJenkinsBundledBinaryForSkill(params.skillName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLog.warn(
        { skillName: params.skillName, err },
        "Auto-build of Jenkins binary failed; continuing with existing binary if present"
      );
      buildWarn = `[WARN] Auto-build binary failed: ${msg}`;
    }

    const skillContent = await readSkillMarkdown(params.skillName).catch(() => "");

    // Fire ALL selected repos to Jenkins concurrently without waiting for each build to complete
    const dispatchedRuns: RepoPipelineRun[] = await Promise.all(
      selectedRepos.map(async (repo) => {
        const start = Date.now();
        const jobName = `ai-skill-${params.skillName}-${repo.id}`;
        try {
          const result = await executeJenkinsJobWithXml({
            jobName,
            repoUrl: repo.url,
            repoBranch: repo.branch,
            skillName: params.skillName,
            skillContent,
            taskPrompt: `Apply skill ${params.skillName} for apps [${params.apps.join(", ")}] on repository ${repo.name}.`,
            waitForCompletion: false,
          });
          const status: RepoPipelineRun["status"] =
            result.status === "success"
              ? "success"
              : result.status === "queued"
                ? "running"
                : "failed";
          return {
            repoId: repo.id,
            repoName: repo.name,
            repoUrl: repo.url,
            status,
            durationMs: result.durationMs,
            jenkinsJobName: result.jobName,
            jenkinsBuildNumber: result.buildNumber,
            jenkinsBuildUrl: result.buildUrl,
            jenkinsQueueUrl: result.queueUrl,
            logs: [
              ...(buildWarn ? [buildWarn] : []),
              `[Jenkins] Triggering pipeline for repo "${repo.name}" (${repo.url})`,
              `[Jenkins] Target apps: ${params.apps.join(", ") || "none"}`,
              ...result.logs,
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            repoId: repo.id,
            repoName: repo.name,
            repoUrl: repo.url,
            status: "failed",
            durationMs: Date.now() - start,
            jenkinsJobName: jobName,
            logs: [
              ...(buildWarn ? [buildWarn] : []),
              `[Jenkins] Triggering pipeline for repo "${repo.name}" (${repo.url})`,
              `[Jenkins] Target apps: ${params.apps.join(", ") || "none"}`,
              `[ERROR] ${msg}`,
            ],
          };
        }
      })
    );

    const anyRunning = dispatchedRuns.some((r) => r.status === "running");
    const allPassed =
      !anyRunning && dispatchedRuns.every((r) => r.status === "success");
    const nextStatus = anyRunning
      ? "testing"
      : allPassed
        ? "test_passed"
        : "test_failed";

    const card = await upsertSkillCard(params.skillName, {
      selectedApps: params.apps,
      selectedRepos: params.repoIds,
      pipelineRuns: dispatchedRuns,
      currentStep: 3,
      progress: allPassed ? 90 : 66,
      status: nextStatus,
    });

    return {
      card,
      allPassed,
      pipelineRuns: dispatchedRuns,
    };
  }

  for (let i = 0; i < selectedRepos.length; i++) {
    const repo = selectedRepos[i];
    pipelineRuns[i] = {
      ...pipelineRuns[i],
      status: "running",
      logs: [`[Jenkins] Starting pipeline for repo "${repo.name}"...`],
    };
    await upsertSkillCard(params.skillName, {
      selectedApps: params.apps,
      selectedRepos: params.repoIds,
      pipelineRuns: [...pipelineRuns],
      currentStep: 3,
      progress: 66,
      status: "testing",
    });

    const run = await runSingleRepoPipeline(
      params.skillName,
      repo,
      params.apps,
      params.mode,
      async (partialRun) => {
        pipelineRuns[i] = partialRun;
        await upsertSkillCard(params.skillName, {
          selectedApps: params.apps,
          selectedRepos: params.repoIds,
          pipelineRuns: [...pipelineRuns],
          currentStep: 3,
          progress: 66,
          status: "testing",
        }).catch(() => {});
      }
    );
    pipelineRuns[i] = run;
    await upsertSkillCard(params.skillName, {
      selectedApps: params.apps,
      selectedRepos: params.repoIds,
      pipelineRuns: [...pipelineRuns],
      currentStep: 3,
      progress: 66,
      status: "testing",
    });
  }

  const allPassed = pipelineRuns.every((r) => r.status === "success");
  const card = await upsertSkillCard(params.skillName, {
    selectedApps: params.apps,
    selectedRepos: params.repoIds,
    pipelineRuns,
    currentStep: 3,
    progress: allPassed ? 90 : 66,
    status: allPassed ? "test_passed" : "test_failed",
  });

  return {
    card,
    allPassed,
    pipelineRuns,
  };
}

/**
 * Directly run a Skill across multiple selected apps & repositories by:
 * 1. Compiling the `ai-pipeline` binary with `--skill <skillName>` embedded from DB
 * 2. Creating and triggering a dedicated Jenkins job for each selected repository
 *    that executes the compiled binary directly.
 */
export async function executeDirectSkillJenkinsRuns(params: {
  skillName: string;
  apps: string[];
  repoIds: string[];
  taskPrompt?: string;
  waitForCompletion?: boolean;
}): Promise<{
  skillName: string;
  binaryTarget: string;
  card: SkillCardRecord;
  pipelineRuns: RepoPipelineRun[];
}> {
  const catalogRepos = await listCatalogRepos();
  const repoMap = new Map(catalogRepos.map((r) => [r.id, r]));
  const selectedRepos = params.repoIds.map(
    (id) =>
      repoMap.get(id) ?? {
        id,
        name: id,
        url: id.startsWith("http")
          ? id
          : `https://git.example.com/org/${id}.git`,
        branch: "main",
      }
  );

  // 1. Build the binary embedding this skill from database
  const binaryTarget = await ensureJenkinsBundledBinaryForSkill(
    params.skillName
  );
  const skillContent = await readSkillMarkdown(params.skillName).catch(
    () => ""
  );
  const wait = params.waitForCompletion === true;

  // 2. Create & trigger a Jenkins job for each selected repository
  const pipelineRuns: RepoPipelineRun[] = await Promise.all(
    selectedRepos.map(async (repo) => {
      const start = Date.now();
      const jobName = `ai-skill-run-${params.skillName}-${repo.id}`;
      const prompt = params.taskPrompt?.trim()
        ? `${params.taskPrompt.trim()} (Target apps: [${params.apps.join(", ")}], repository: ${repo.name})`
        : `Apply skill ${params.skillName} for apps [${params.apps.join(", ")}] on repository ${repo.name}.`;

      try {
        const result = await executeJenkinsJobWithXml({
          jobName,
          repoUrl: repo.url,
          repoBranch: repo.branch,
          skillName: params.skillName,
          skillContent,
          taskPrompt: prompt,
          waitForCompletion: wait,
          pollIntervalMs: 3000,
        });

        const status: RepoPipelineRun["status"] =
          result.status === "success"
            ? "success"
            : result.status === "queued"
              ? "running"
              : "failed";

        return {
          repoId: repo.id,
          repoName: repo.name,
          repoUrl: repo.url,
          status,
          durationMs: result.durationMs,
          jenkinsJobName: result.jobName,
          jenkinsBuildNumber: result.buildNumber,
          jenkinsBuildUrl: result.buildUrl,
          jenkinsQueueUrl: result.queueUrl,
          logs: [
            `[Binary] Built ${binaryTarget} binary with embedded skill "${params.skillName}"`,
            `[Jenkins] Job: ${result.jobName}${result.buildNumber ? ` (#${result.buildNumber})` : ""}`,
            `[Jenkins] Target apps: ${params.apps.join(", ") || "none"}`,
            ...(result.buildUrl
              ? [`[Jenkins] Build URL: ${result.buildUrl}`]
              : []),
            ...result.logs,
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          repoId: repo.id,
          repoName: repo.name,
          repoUrl: repo.url,
          status: "failed",
          durationMs: Date.now() - start,
          jenkinsJobName: jobName,
          logs: [
            `[Binary] Built ${binaryTarget} binary with embedded skill "${params.skillName}"`,
            `[Jenkins] Triggering job "${jobName}" for repo "${repo.name}" (${repo.url})`,
            `[ERROR] ${msg}`,
          ],
        };
      }
    })
  );

  const card = await upsertSkillCard(params.skillName, {
    selectedApps: params.apps,
    selectedRepos: params.repoIds,
    pipelineRuns,
  });

  return {
    skillName: params.skillName,
    binaryTarget,
    card,
    pipelineRuns,
  };
}

let jenkinsSyncTimer: ReturnType<typeof setInterval> | null = null;
let jenkinsSyncInFlight = false;

/**
 * Sync active Jenkins build console logs into `skills.pipeline_runs` every 3 seconds.
 */
export async function syncRunningJenkinsLogsOnce(): Promise<void> {
  if (jenkinsSyncInFlight) return;
  jenkinsSyncInFlight = true;
  try {
    const cards = await listSkillCards();
    const testingCards = cards.filter(
      (c) =>
        c.status === "testing" ||
        c.pipelineRuns.some((r) => r.status === "running")
    );

    for (const card of testingCards) {
      let changed = false;
      const updatedRuns = await Promise.all(
        card.pipelineRuns.map(async (run) => {
          if (run.status !== "running") {
            return run;
          }

          let buildNumber = run.jenkinsBuildNumber;
          let buildUrl = run.jenkinsBuildUrl;

          // Resolve queued Jenkins builds that didn't have a buildNumber at dispatch time
          if (!buildNumber && run.jenkinsQueueUrl) {
            try {
              const queueInfo = await resolveJenkinsQueueItem(
                run.jenkinsQueueUrl
              );
              if (queueInfo.cancelled) {
                changed = true;
                return {
                  ...run,
                  status: "failed" as const,
                  logs: [
                    ...run.logs,
                    "[Jenkins] Build was cancelled while waiting in queue.",
                  ],
                };
              }
              if (queueInfo.buildNumber) {
                buildNumber = queueInfo.buildNumber;
                buildUrl = queueInfo.buildUrl || buildUrl;
                changed = true;
              } else {
                if (queueInfo.why) {
                  const whyLine = `[Jenkins] Queued: ${queueInfo.why}`;
                  if (run.logs[run.logs.length - 1] !== whyLine) {
                    changed = true;
                    return { ...run, logs: [...run.logs, whyLine] };
                  }
                }
                return run;
              }
            } catch {
              return run;
            }
          }

          if (!run.jenkinsJobName || !buildNumber) {
            return run;
          }

          try {
            const build = await getJenkinsBuildStatus(
              run.jenkinsJobName,
              buildNumber
            );
            const nextLogs = [
              `[Jenkins] Job: ${run.jenkinsJobName} (#${buildNumber})`,
              ...(build.url || buildUrl
                ? [`[Jenkins] Build URL: ${build.url || buildUrl}`]
                : []),
              ...(build.consoleText ? build.consoleText.split("\n") : []),
            ];
            const nextStatus: RepoPipelineRun["status"] = build.building
              ? "running"
              : build.result === "SUCCESS"
                ? "success"
                : "failed";
            changed = true;
            return {
              ...run,
              status: nextStatus,
              durationMs: build.duration || run.durationMs,
              jenkinsBuildNumber: buildNumber,
              jenkinsBuildUrl: build.url || buildUrl,
              logs: nextLogs,
            };
          } catch {
            return run;
          }
        })
      );

      const allTerminal =
        updatedRuns.length > 0 &&
        updatedRuns.every(
          (r) => r.status === "success" || r.status === "failed"
        );
      const shouldFinalizeTesting = card.status === "testing" && allTerminal;

      if (changed || shouldFinalizeTesting) {
        if (shouldFinalizeTesting) {
          const allPassed = updatedRuns.every((r) => r.status === "success");
          await upsertSkillCard(card.skillName, {
            pipelineRuns: updatedRuns,
            progress: allPassed ? 90 : 66,
            status: allPassed ? "test_passed" : "test_failed",
          }).catch(() => {});
        } else {
          await upsertSkillCard(card.skillName, {
            pipelineRuns: updatedRuns,
          }).catch(() => {});
        }
      }
    }
  } catch {
    // Ignore transient DB/Jenkins polling errors
  } finally {
    jenkinsSyncInFlight = false;
  }
}

export function startJenkinsLogSyncScheduler(intervalMs = 3000): void {
  if (jenkinsSyncTimer) return;
  jenkinsSyncTimer = setInterval(() => {
    void syncRunningJenkinsLogsOnce();
  }, intervalMs);
  jenkinsSyncTimer.unref?.();
}

export function stopJenkinsLogSyncScheduler(): void {
  if (jenkinsSyncTimer) {
    clearInterval(jenkinsSyncTimer);
    jenkinsSyncTimer = null;
  }
}
