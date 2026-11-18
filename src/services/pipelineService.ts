import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
} from "./jenkinsClient.js";
import { runSkillInRepo } from "./skillRunner.js";

const execFileAsync = promisify(execFile);

export type PipelineExecutionMode = "real" | "simulate" | "jenkins";

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
    const testingCards = cards.filter((c) => c.status === "testing");

    for (const card of testingCards) {
      let changed = false;
      const updatedRuns = await Promise.all(
        card.pipelineRuns.map(async (run) => {
          if (
            run.status !== "running" ||
            !run.jenkinsJobName ||
            !run.jenkinsBuildNumber
          ) {
            return run;
          }
          try {
            const build = await getJenkinsBuildStatus(
              run.jenkinsJobName,
              run.jenkinsBuildNumber
            );
            const nextLogs = [
              `[Jenkins] Job: ${run.jenkinsJobName} (#${run.jenkinsBuildNumber})`,
              ...(build.url || run.jenkinsBuildUrl
                ? [`[Jenkins] Build URL: ${build.url || run.jenkinsBuildUrl}`]
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
              jenkinsBuildUrl: build.url || run.jenkinsBuildUrl,
              logs: nextLogs,
            };
          } catch {
            return run;
          }
        })
      );

      if (changed) {
        await upsertSkillCard(card.skillName, {
          pipelineRuns: updatedRuns,
        }).catch(() => {});
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
