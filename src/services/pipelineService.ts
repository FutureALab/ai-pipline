import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../config/logger.js";
import {
  getSkillCard,
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
  abortJenkinsJob,
  executeJenkinsJobWithXml,
  getJenkinsBuildStatus,
  resolveJenkinsQueueItem,
} from "./jenkinsClient.js";
import {
  enqueueJenkinsDispatchTasks,
  getJenkinsConcurrencyLimit,
  isTaskPendingInQueue,
  markJenkinsTasksAborted,
  releaseJenkinsSemaphorePermit,
  startJenkinsDispatchWorker,
  type JenkinsQueuedTask,
} from "./jenkinsDispatchQueue.js";
import { runSkillInRepo } from "./skillRunner.js";

const execFileAsync = promisify(execFile);
const pipelineLog = createLogger("pipeline");

/** Per-skill mutex to serialize pipeline_runs DB updates across concurrent workers */
const skillCardLocks = new Map<string, Promise<unknown>>();
async function withSkillCardLock<T>(
  skillName: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = skillCardLocks.get(skillName) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  skillCardLocks.set(
    skillName,
    prev.then(() => next)
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (skillCardLocks.get(skillName) === next) {
      skillCardLocks.delete(skillName);
    }
  }
}

async function dispatchSingleQueuedJenkinsTask(
  task: JenkinsQueuedTask
): Promise<void> {
  const start = Date.now();
  try {
    const result = await executeJenkinsJobWithXml({
      jobName: task.jobName,
      repoUrl: task.repoUrl,
      repoBranch: task.repoBranch,
      skillName: task.skillName,
      skillContent: task.skillContent,
      taskPrompt: task.taskPrompt,
      waitForCompletion: false,
    });

    const now = Date.now();
    const status: RepoPipelineRun["status"] =
      result.status === "success"
        ? "success"
        : result.status === "queued"
          ? "running"
          : "failed";

    const updatedRun: RepoPipelineRun = {
      repoId: task.repoId,
      repoName: task.repoName,
      repoUrl: task.repoUrl,
      status,
      durationMs: result.durationMs,
      jenkinsJobName: result.jobName,
      jenkinsBuildNumber: result.buildNumber,
      jenkinsBuildUrl: result.buildUrl,
      jenkinsQueueUrl: result.queueUrl,
      startedAt: start,
      lastUpdatedAt: now,
      logs: [
        ...(task.binaryTarget
          ? [
              `[Binary] Built ${task.binaryTarget} binary with embedded skill "${task.skillName}"`,
            ]
          : []),
        ...(task.buildWarn ? [task.buildWarn] : []),
        `[Jenkins] Triggering pipeline for repo "${task.repoName}" (${task.repoUrl})`,
        `[Jenkins] Target apps: ${task.apps.join(", ") || "none"}`,
        ...result.logs,
      ],
    };

    await withSkillCardLock(task.skillName, async () => {
      const latest = await getSkillCard(task.skillName);
      if (!latest) return;
      const runs = latest.card.pipelineRuns.map((r) =>
        r.repoId === task.repoId ? updatedRun : r
      );
      if (!runs.some((r) => r.repoId === task.repoId)) {
        runs.push(updatedRun);
      }
      await upsertSkillCard(task.skillName, { pipelineRuns: runs });
    });

    if (status === "success" || status === "failed") {
      await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failedRun: RepoPipelineRun = {
      repoId: task.repoId,
      repoName: task.repoName,
      repoUrl: task.repoUrl,
      status: "failed",
      durationMs: Date.now() - start,
      jenkinsJobName: task.jobName,
      startedAt: start,
      lastUpdatedAt: Date.now(),
      logs: [
        ...(task.buildWarn ? [task.buildWarn] : []),
        `[Jenkins] Triggering pipeline for repo "${task.repoName}" (${task.repoUrl})`,
        `[Jenkins] Target apps: ${task.apps.join(", ") || "none"}`,
        `[ERROR] ${msg}`,
      ],
    };

    await withSkillCardLock(task.skillName, async () => {
      const latest = await getSkillCard(task.skillName);
      if (!latest) return;
      const runs = latest.card.pipelineRuns.map((r) =>
        r.repoId === task.repoId ? failedRun : r
      );
      const allTerminal =
        runs.length > 0 &&
        runs.every((r) => r.status === "success" || r.status === "failed");
      const allPassed = allTerminal && runs.every((r) => r.status === "success");
      await upsertSkillCard(task.skillName, {
        pipelineRuns: runs,
        ...(latest.card.status === "testing" && allTerminal
          ? {
              progress: allPassed ? 90 : 66,
              status: allPassed ? "test_passed" : "test_failed",
            }
          : {}),
      });
    });

    await releaseJenkinsSemaphorePermit(task.skillName, task.repoId);
  }
}

export async function initJenkinsPipelineQueueWorker(): Promise<void> {
  await startJenkinsDispatchWorker(dispatchSingleQueuedJenkinsTask);
}

/** Max time (ms) a running/pending pipeline item may stay without Jenkins build/queue response before auto-failing (default 45s) */
const PIPELINE_NO_RESPONSE_TIMEOUT_MS = Number(
  process.env.PIPELINE_NO_RESPONSE_TIMEOUT_MS || 45_000
);
/** Max time (ms) a building Jenkins job may produce zero console log updates before auto-failing (default 60s) */
const PIPELINE_IDLE_LOG_TIMEOUT_MS = Number(
  process.env.PIPELINE_IDLE_LOG_TIMEOUT_MS || 60_000
);

export type PipelineExecutionMode = "real" | "simulate" | "jenkins";

export async function ensureJenkinsBundledBinaryForSkills(
  skillNames: string[]
): Promise<string> {
  const uniqueNames = [...new Set(skillNames.map((s) => s.trim()).filter(Boolean))];
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
    { skillNames: uniqueNames, target },
    "Building Linux ai-pipeline binary with embedded skill(s) for Jenkins"
  );
  const cliArgs = ["run", scriptPath, target];
  if (uniqueNames.length > 0) {
    cliArgs.push("--skills", uniqueNames.join(","));
  }
  await execFileAsync("bun", cliArgs, {
    cwd: process.cwd(),
    timeout: 180_000,
  });
  return target;
}

export async function ensureJenkinsBundledBinaryForSkill(
  skillName: string
): Promise<string> {
  return ensureJenkinsBundledBinaryForSkills([skillName]);
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
    const limit = getJenkinsConcurrencyLimit();
    const now = Date.now();

    const queuedRuns: RepoPipelineRun[] = selectedRepos.map((repo) => ({
      repoId: repo.id,
      repoName: repo.name,
      repoUrl: repo.url,
      status: "pending",
      durationMs: 0,
      jenkinsJobName: `ai-skill-${params.skillName}-${repo.id}`,
      startedAt: now,
      lastUpdatedAt: now,
      logs: [
        ...(buildWarn ? [buildWarn] : []),
        `[Queue] 已进入 Redis 阻塞队列，等待信号量槽位（并发上限: ${limit}）...`,
      ],
    }));

    const card = await withSkillCardLock(params.skillName, () =>
      upsertSkillCard(params.skillName, {
        selectedApps: params.apps,
        selectedRepos: params.repoIds,
        pipelineRuns: queuedRuns,
        currentStep: 3,
        progress: 66,
        status: "testing",
      })
    );

    await enqueueJenkinsDispatchTasks(
      selectedRepos.map((repo) => ({
        taskId: crypto.randomUUID(),
        skillName: params.skillName,
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
        repoBranch: repo.branch,
        apps: params.apps,
        jobName: `ai-skill-${params.skillName}-${repo.id}`,
        taskPrompt: `Apply skill ${params.skillName} for apps [${params.apps.join(", ")}] on repository ${repo.name}.`,
        skillContent,
        buildWarn,
        enqueuedAt: now,
      }))
    );

    return {
      card,
      allPassed: false,
      pipelineRuns: queuedRuns,
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
 * Re-run one or more specific repositories (e.g. failed ones) in an existing
 * test pipeline while preserving the status/logs of all other repositories.
 */
export async function rerunPipelineTestRepos(params: {
  skillName: string;
  apps: string[];
  repoIds: string[];
  mode: PipelineExecutionMode;
}): Promise<{
  card: SkillCardRecord;
  allPassed: boolean;
  pipelineRuns: RepoPipelineRun[];
}> {
  const existing = await getSkillCard(params.skillName);
  const existingRuns: RepoPipelineRun[] = existing?.card.pipelineRuns
    ? [...existing.card.pipelineRuns]
    : [];
  const effectiveApps =
    params.apps.length > 0 ? params.apps : (existing?.card.selectedApps ?? []);
  const effectiveSelectedRepos =
    existing?.card.selectedRepos && existing.card.selectedRepos.length > 0
      ? existing.card.selectedRepos
      : params.repoIds;

  const catalogRepos = await listCatalogRepos();
  const repoMap = new Map(catalogRepos.map((r) => [r.id, r]));
  const targetRepoIds = [...new Set(params.repoIds)];
  const targetRepos = targetRepoIds.map(
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

  // Mark target repos as running immediately in DB
  const rerunStartedAt = Date.now();
  const targetIdSet = new Set(targetRepoIds);
  const mergedRuns: RepoPipelineRun[] = existingRuns.map((r) =>
    targetIdSet.has(r.repoId)
      ? {
          ...r,
          status: "running",
          durationMs: 0,
          jenkinsBuildNumber: undefined,
          jenkinsBuildUrl: undefined,
          jenkinsQueueUrl: undefined,
          startedAt: rerunStartedAt,
          lastUpdatedAt: rerunStartedAt,
          logs: [`[Jenkins] Re-running pipeline for repo "${r.repoName}"...`],
        }
      : r
  );
  for (const repo of targetRepos) {
    if (!mergedRuns.some((r) => r.repoId === repo.id)) {
      mergedRuns.push({
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
        status: "running",
        durationMs: 0,
        startedAt: rerunStartedAt,
        lastUpdatedAt: rerunStartedAt,
        logs: [`[Jenkins] Re-running pipeline for repo "${repo.name}"...`],
      });
    }
  }

  await upsertSkillCard(params.skillName, {
    selectedApps: effectiveApps,
    selectedRepos: effectiveSelectedRepos,
    pipelineRuns: mergedRuns,
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
        "Auto-build of Jenkins binary failed during rerun; continuing with existing binary if present"
      );
      buildWarn = `[WARN] Auto-build binary failed: ${msg}`;
    }

    const skillContent = await readSkillMarkdown(params.skillName).catch(
      () => ""
    );
    const limit = getJenkinsConcurrencyLimit();
    const now = Date.now();

    const queuedById = new Map<string, RepoPipelineRun>();
    for (const repo of targetRepos) {
      queuedById.set(repo.id, {
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
        status: "pending",
        durationMs: 0,
        jenkinsJobName: `ai-skill-${params.skillName}-${repo.id}`,
        startedAt: now,
        lastUpdatedAt: now,
        logs: [
          ...(buildWarn ? [buildWarn] : []),
          `[Queue] 已重新进入 Redis 阻塞队列，等待信号量槽位（并发上限: ${limit}）...`,
        ],
      });
    }

    const { card, finalRuns } = await withSkillCardLock(
      params.skillName,
      async () => {
        const latest = await getSkillCard(params.skillName);
        const baseRuns =
          latest?.card.pipelineRuns && latest.card.pipelineRuns.length > 0
            ? latest.card.pipelineRuns
            : mergedRuns;
        const nextRuns = baseRuns.map((r) => queuedById.get(r.repoId) ?? r);
        for (const r of queuedById.values()) {
          if (!nextRuns.some((item) => item.repoId === r.repoId)) {
            nextRuns.push(r);
          }
        }
        const savedCard = await upsertSkillCard(params.skillName, {
          selectedApps: effectiveApps,
          selectedRepos: effectiveSelectedRepos,
          pipelineRuns: nextRuns,
          currentStep: 3,
          progress: 66,
          status: "testing",
        });
        return { card: savedCard, finalRuns: nextRuns };
      }
    );

    await enqueueJenkinsDispatchTasks(
      targetRepos.map((repo) => ({
        taskId: crypto.randomUUID(),
        skillName: params.skillName,
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
        repoBranch: repo.branch,
        apps: effectiveApps,
        jobName: `ai-skill-${params.skillName}-${repo.id}`,
        taskPrompt: `Apply skill ${params.skillName} for apps [${effectiveApps.join(", ")}] on repository ${repo.name}.`,
        skillContent,
        buildWarn,
        enqueuedAt: now,
      }))
    );

    return {
      card,
      allPassed: false,
      pipelineRuns: finalRuns,
    };
  }

  // simulate / real modes: run requested repos and merge back
  const updatedMap = new Map<string, RepoPipelineRun>();
  for (const repo of targetRepos) {
    const run = await runSingleRepoPipeline(
      params.skillName,
      repo,
      effectiveApps,
      params.mode
    );
    updatedMap.set(repo.id, run);
  }

  const finalRuns = mergedRuns.map((r) => updatedMap.get(r.repoId) ?? r);
  const allPassed =
    finalRuns.length > 0 && finalRuns.every((r) => r.status === "success");
  const card = await upsertSkillCard(params.skillName, {
    selectedApps: effectiveApps,
    selectedRepos: effectiveSelectedRepos,
    pipelineRuns: finalRuns,
    currentStep: 3,
    progress: allPassed ? 90 : 66,
    status: allPassed ? "test_passed" : "test_failed",
  });

  return {
    card,
    allPassed,
    pipelineRuns: finalRuns,
  };
}

/**
 * Abort one or more (or all) running/pending Jenkins pipeline runs for a Skill:
 * 1. Marks them aborted in the Redis dispatch queue (so queued tasks are skipped)
 * 2. Stops any active Jenkins build or cancels any Jenkins queue item
 * 3. Releases their Redis semaphore permits
 * 4. Marks those runs as `failed` so the user can immediately click "重跑"
 */
export async function abortPipelineTestRepos(params: {
  skillName: string;
  repoIds?: string[];
}): Promise<{
  card: SkillCardRecord;
  abortedRepoIds: string[];
  pipelineRuns: RepoPipelineRun[];
}> {
  const existing = await getSkillCard(params.skillName);
  if (!existing) {
    throw new Error(`Skill "${params.skillName}" not found`);
  }

  const currentRuns = existing.card.pipelineRuns ?? [];
  const requestedSet =
    params.repoIds && params.repoIds.length > 0
      ? new Set(params.repoIds)
      : null;

  const targetRuns = currentRuns.filter((r) => {
    const matchesTarget = requestedSet ? requestedSet.has(r.repoId) : true;
    return matchesTarget && (r.status === "running" || r.status === "pending");
  });

  const targetRepoIds = targetRuns.map((r) => r.repoId);
  if (targetRepoIds.length === 0) {
    return {
      card: existing.card,
      abortedRepoIds: [],
      pipelineRuns: currentRuns,
    };
  }

  // 1. Mark aborted in Redis queue & release held semaphore permits
  await markJenkinsTasksAborted(params.skillName, targetRepoIds);

  // 2. Best-effort stop on Jenkins server for already-dispatched builds/queues
  const stopResults = await Promise.all(
    targetRuns.map(async (run) => {
      if (!run.jenkinsBuildNumber && !run.jenkinsQueueUrl) {
        return { repoId: run.repoId, note: "已从 Redis 阻塞队列移除" };
      }
      try {
        const res = await abortJenkinsJob({
          jobName: run.jenkinsJobName,
          buildNumber: run.jenkinsBuildNumber,
          queueUrl: run.jenkinsQueueUrl,
          buildUrl: run.jenkinsBuildUrl,
        });
        return { repoId: run.repoId, note: res.detail };
      } catch (err) {
        return {
          repoId: run.repoId,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
  const stopNoteById = new Map(stopResults.map((s) => [s.repoId, s.note]));
  const abortedSet = new Set(targetRepoIds);
  const now = Date.now();

  const { card, finalRuns } = await withSkillCardLock(
    params.skillName,
    async () => {
      const latest = await getSkillCard(params.skillName);
      const baseRuns = latest?.card.pipelineRuns ?? currentRuns;
      const nextRuns: RepoPipelineRun[] = baseRuns.map((r) => {
        if (!abortedSet.has(r.repoId)) return r;
        const startedAt = r.startedAt ?? now;
        const note = stopNoteById.get(r.repoId);
        return {
          ...r,
          status: "failed",
          durationMs: r.durationMs || Math.max(1, now - startedAt),
          lastUpdatedAt: now,
          logs: [
            ...r.logs,
            `[Jenkins] 任务已被用户手动中断${note ? `（${note}）` : ""}，可点击「重跑」重新执行。`,
          ],
        };
      });

      const anyActive = nextRuns.some(
        (r) => r.status === "running" || r.status === "pending"
      );
      const allPassed =
        !anyActive &&
        nextRuns.length > 0 &&
        nextRuns.every((r) => r.status === "success");

      const savedCard = await upsertSkillCard(params.skillName, {
        pipelineRuns: nextRuns,
        ...(!anyActive && latest?.card.status === "testing"
          ? {
              progress: allPassed ? 90 : 66,
              status: allPassed ? "test_passed" : "test_failed",
            }
          : {}),
      });
      return { card: savedCard, finalRuns: nextRuns };
    }
  );

  return {
    card,
    abortedRepoIds: targetRepoIds,
    pipelineRuns: finalRuns,
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

  // 2. When non-blocking, route through Redis blocking queue + semaphore so Jenkins isn't flooded
  if (!wait) {
    const limit = getJenkinsConcurrencyLimit();
    const now = Date.now();
    const queuedRuns: RepoPipelineRun[] = selectedRepos.map((repo) => ({
      repoId: repo.id,
      repoName: repo.name,
      repoUrl: repo.url,
      status: "pending",
      durationMs: 0,
      jenkinsJobName: `ai-skill-run-${params.skillName}-${repo.id}`,
      startedAt: now,
      lastUpdatedAt: now,
      logs: [
        `[Binary] Built ${binaryTarget} binary with embedded skill "${params.skillName}"`,
        `[Queue] 已进入 Redis 阻塞队列，等待信号量槽位（并发上限: ${limit}）...`,
      ],
    }));

    const card = await withSkillCardLock(params.skillName, () =>
      upsertSkillCard(params.skillName, {
        selectedApps: params.apps,
        selectedRepos: params.repoIds,
        pipelineRuns: queuedRuns,
      })
    );

    await enqueueJenkinsDispatchTasks(
      selectedRepos.map((repo) => {
        const prompt = params.taskPrompt?.trim()
          ? `${params.taskPrompt.trim()} (Target apps: [${params.apps.join(", ")}], repository: ${repo.name})`
          : `Apply skill ${params.skillName} for apps [${params.apps.join(", ")}] on repository ${repo.name}.`;
        return {
          taskId: crypto.randomUUID(),
          skillName: params.skillName,
          repoId: repo.id,
          repoName: repo.name,
          repoUrl: repo.url,
          repoBranch: repo.branch,
          apps: params.apps,
          jobName: `ai-skill-run-${params.skillName}-${repo.id}`,
          taskPrompt: prompt,
          skillContent,
          binaryTarget,
          enqueuedAt: now,
        };
      })
    );

    return {
      skillName: params.skillName,
      binaryTarget,
      card,
      pipelineRuns: queuedRuns,
    };
  }

  // 2b. Blocking mode (waitForCompletion === true): execute directly and wait
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

/**
 * Batch-run multiple published Skills across selected apps & repositories:
 * 1. Compiles the `ai-pipeline` binary ONCE embedding all requested skills
 * 2. Enqueues all (skill × repo) Jenkins jobs into the Redis blocking queue
 *    throttled by JENKINS_CONCURRENCY_SEMAPHORE.
 */
export async function executeBatchDirectSkillsJenkinsRuns(params: {
  skillNames: string[];
  apps: string[];
  repoIds: string[];
  taskPrompt?: string;
}): Promise<{
  skillNames: string[];
  binaryTarget: string;
  totalTasks: number;
  results: Array<{
    skillName: string;
    card: SkillCardRecord;
    pipelineRuns: RepoPipelineRun[];
  }>;
}> {
  const uniqueSkillNames = [...new Set(params.skillNames)];
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

  // 1. Build ONE binary embedding all selected skills
  const binaryTarget =
    await ensureJenkinsBundledBinaryForSkills(uniqueSkillNames);

  const limit = getJenkinsConcurrencyLimit();
  const now = Date.now();
  const allQueuedTasks: JenkinsQueuedTask[] = [];
  const results: Array<{
    skillName: string;
    card: SkillCardRecord;
    pipelineRuns: RepoPipelineRun[];
  }> = [];

  for (const skillName of uniqueSkillNames) {
    const skillContent = await readSkillMarkdown(skillName).catch(() => "");
    const queuedRuns: RepoPipelineRun[] = selectedRepos.map((repo) => ({
      repoId: repo.id,
      repoName: repo.name,
      repoUrl: repo.url,
      status: "pending",
      durationMs: 0,
      jenkinsJobName: `ai-skill-run-${skillName}-${repo.id}`,
      startedAt: now,
      lastUpdatedAt: now,
      logs: [
        `[Binary] Built ${binaryTarget} binary with embedded skill(s): ${uniqueSkillNames.join(", ")}`,
        `[Queue] 已进入 Redis 阻塞队列，等待信号量槽位（并发上限: ${limit}）...`,
      ],
    }));

    const card = await withSkillCardLock(skillName, () =>
      upsertSkillCard(skillName, {
        selectedApps: params.apps,
        selectedRepos: params.repoIds,
        pipelineRuns: queuedRuns,
      })
    );

    results.push({ skillName, card, pipelineRuns: queuedRuns });

    for (const repo of selectedRepos) {
      const prompt = params.taskPrompt?.trim()
        ? `${params.taskPrompt.trim()} (Target apps: [${params.apps.join(", ")}], repository: ${repo.name})`
        : `Apply skill ${skillName} for apps [${params.apps.join(", ")}] on repository ${repo.name}.`;
      allQueuedTasks.push({
        taskId: crypto.randomUUID(),
        skillName,
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
        repoBranch: repo.branch,
        apps: params.apps,
        jobName: `ai-skill-run-${skillName}-${repo.id}`,
        taskPrompt: prompt,
        skillContent,
        binaryTarget,
        enqueuedAt: now,
      });
    }
  }

  await enqueueJenkinsDispatchTasks(allQueuedTasks);

  return {
    skillNames: uniqueSkillNames,
    binaryTarget,
    totalTasks: allQueuedTasks.length,
    results,
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
      const now = Date.now();
      const cardUpdatedMs = Date.parse(card.updatedAt);
      let changed = false;
      const completedRepoIds: string[] = [];
      const updatedRuns = await Promise.all(
        card.pipelineRuns.map(async (run) => {
          if (run.status !== "running" && run.status !== "pending") {
            return run;
          }

          // Tasks waiting in our Redis blocking queue for a semaphore permit must NOT be timed out prematurely
          if (
            run.status === "pending" &&
            isTaskPendingInQueue(card.skillName, run.repoId)
          ) {
            return run;
          }

          const startedAt =
            run.startedAt ??
            (Number.isFinite(cardUpdatedMs) ? cardUpdatedMs : now);
          const lastActivityAt =
            run.lastUpdatedAt ??
            run.startedAt ??
            (Number.isFinite(cardUpdatedMs) ? cardUpdatedMs : now);

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
                completedRepoIds.push(run.repoId);
                return {
                  ...run,
                  status: "failed" as const,
                  durationMs: Math.max(1, now - startedAt),
                  startedAt,
                  lastUpdatedAt: now,
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
                if (now - lastActivityAt >= PIPELINE_NO_RESPONSE_TIMEOUT_MS) {
                  changed = true;
                  completedRepoIds.push(run.repoId);
                  return {
                    ...run,
                    status: "failed" as const,
                    durationMs: Math.max(1, now - startedAt),
                    startedAt,
                    lastUpdatedAt: now,
                    logs: [
                      ...run.logs,
                      `[ERROR] 超过 ${Math.round(PIPELINE_NO_RESPONSE_TIMEOUT_MS / 1000)} 秒未开始执行，已自动判定为失败，请点击「重跑」重试。`,
                    ],
                  };
                }
                if (queueInfo.why) {
                  const whyLine = `[Jenkins] Queued: ${queueInfo.why}`;
                  if (run.logs[run.logs.length - 1] !== whyLine) {
                    changed = true;
                    return {
                      ...run,
                      startedAt,
                      lastUpdatedAt: now,
                      logs: [...run.logs, whyLine],
                    };
                  }
                }
                return run;
              }
            } catch {
              if (now - lastActivityAt >= PIPELINE_NO_RESPONSE_TIMEOUT_MS) {
                changed = true;
                completedRepoIds.push(run.repoId);
                return {
                  ...run,
                  status: "failed" as const,
                  durationMs: Math.max(1, now - startedAt),
                  startedAt,
                  lastUpdatedAt: now,
                  logs: [
                    ...run.logs,
                    `[ERROR] 超过 ${Math.round(PIPELINE_NO_RESPONSE_TIMEOUT_MS / 1000)} 秒无法获取 Jenkins 队列状态，已自动判定为失败，请点击「重跑」重试。`,
                  ],
                };
              }
              return run;
            }
          }

          if (!run.jenkinsJobName || !buildNumber) {
            if (now - lastActivityAt >= PIPELINE_NO_RESPONSE_TIMEOUT_MS) {
              changed = true;
              completedRepoIds.push(run.repoId);
              return {
                ...run,
                status: "failed" as const,
                durationMs: Math.max(1, now - startedAt),
                startedAt,
                lastUpdatedAt: now,
                logs: [
                  ...run.logs,
                  `[ERROR] 超过 ${Math.round(PIPELINE_NO_RESPONSE_TIMEOUT_MS / 1000)} 秒未收到 Jenkins 任务响应，已自动判定为失败，请点击「重跑」重试。`,
                ],
              };
            }
            return run;
          }

          try {
            const build = await getJenkinsBuildStatus(
              run.jenkinsJobName,
              buildNumber,
              buildUrl
            );
            const nextLogs = [
              `[Jenkins] Job: ${run.jenkinsJobName} (#${buildNumber})`,
              ...(build.url || buildUrl
                ? [`[Jenkins] Build URL: ${build.url || buildUrl}`]
                : []),
              ...(build.consoleText ? build.consoleText.split("\n") : []),
            ];

            if (!build.building) {
              const nextStatus: RepoPipelineRun["status"] =
                build.result === "SUCCESS" ? "success" : "failed";
              changed = true;
              completedRepoIds.push(run.repoId);
              return {
                ...run,
                status: nextStatus,
                durationMs: build.duration || Math.max(1, now - startedAt),
                jenkinsBuildNumber: buildNumber,
                jenkinsBuildUrl: build.url || buildUrl,
                startedAt,
                lastUpdatedAt: now,
                logs: nextLogs,
              };
            }

            const prevLogText = run.logs.join("\n");
            const nextLogText = nextLogs.join("\n");
            const logsChanged =
              nextLogText !== prevLogText ||
              buildNumber !== run.jenkinsBuildNumber;

            if (logsChanged) {
              changed = true;
              return {
                ...run,
                status: "running" as const,
                durationMs: build.duration || run.durationMs,
                jenkinsBuildNumber: buildNumber,
                jenkinsBuildUrl: build.url || buildUrl,
                startedAt,
                lastUpdatedAt: now,
                logs: nextLogs,
              };
            }

            if (now - lastActivityAt >= PIPELINE_IDLE_LOG_TIMEOUT_MS) {
              changed = true;
              completedRepoIds.push(run.repoId);
              return {
                ...run,
                status: "failed" as const,
                durationMs: build.duration || Math.max(1, now - startedAt),
                jenkinsBuildNumber: buildNumber,
                jenkinsBuildUrl: build.url || buildUrl,
                startedAt,
                lastUpdatedAt: now,
                logs: [
                  ...nextLogs,
                  `[ERROR] 超过 ${Math.round(PIPELINE_IDLE_LOG_TIMEOUT_MS / 1000)} 秒无任何日志更新，已自动判定为失败，请点击「重跑」重试。`,
                ],
              };
            }

            return run;
          } catch {
            if (now - lastActivityAt >= PIPELINE_NO_RESPONSE_TIMEOUT_MS) {
              changed = true;
              completedRepoIds.push(run.repoId);
              return {
                ...run,
                status: "failed" as const,
                durationMs: Math.max(1, now - startedAt),
                startedAt,
                lastUpdatedAt: now,
                logs: [
                  ...run.logs,
                  `[ERROR] 超过 ${Math.round(PIPELINE_NO_RESPONSE_TIMEOUT_MS / 1000)} 秒无法获取 Jenkins 构建状态，已自动判定为失败，请点击「重跑」重试。`,
                ],
              };
            }
            return run;
          }
        })
      );

      for (const repoId of completedRepoIds) {
        await releaseJenkinsSemaphorePermit(card.skillName, repoId);
      }

      const allTerminal =
        updatedRuns.length > 0 &&
        updatedRuns.every(
          (r) => r.status === "success" || r.status === "failed"
        );
      const shouldFinalizeTesting = card.status === "testing" && allTerminal;

      if (changed || shouldFinalizeTesting) {
        await withSkillCardLock(card.skillName, async () => {
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
        });
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
