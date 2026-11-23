import crypto from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { OpenAIOverrideConfig } from "../config/envModel.js";
import {
  dbNow,
  getDb,
  getPrismaOrNull,
  isDbConnected,
  isMysqlDriver,
} from "../db/database.js";
import { Prisma } from "../generated/prisma/client.js";
import { getMcpServersByIdsForOwner } from "../repositories/mcpRepository.js";
import {
  listSkillFiles,
  replaceSkillFiles,
  upsertSkillCard,
} from "../repositories/skillRepository.js";
import type {
  GenerationJobStatus,
  SkillCardRecord,
  SkillFileEntry,
} from "../types/skill.js";
import { generateSkillFromPrompt } from "./skillGenerator.js";

export interface StartGenerationPayload {
  prompt: string;
  skillName?: string;
  description?: string;
  creator?: string;
  selectedMcps?: string[];
  openaiConfig?: OpenAIOverrideConfig;
  timeoutMs?: number;
}

export interface GenerationJobResult {
  card: SkillCardRecord;
  skillName: string;
  filePath: string;
  content: string;
  files: SkillFileEntry[];
  modelFallbackMessage?: string;
}

export interface GenerationJobSnapshot {
  jobId: string;
  status: GenerationJobStatus;
  startedAt: number;
  endedAt?: number;
  elapsedMs: number;
  timeoutMs: number;
  streamedContent: string;
  progressLogs?: string[];
  errorMessage?: string;
  result?: GenerationJobResult;
}

interface InternalJob extends GenerationJobSnapshot {
  payload: StartGenerationPayload;
  abortController: AbortController;
  session?: AgentSession;
  timer?: ReturnType<typeof setTimeout>;
  abortReason?: "user" | "timeout" | "restart";
}

const DEFAULT_TIMEOUT_MS = 120_000;
const jobs = new Map<string, InternalJob>();

function toSnapshot(job: InternalJob): GenerationJobSnapshot {
  return {
    jobId: job.jobId,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    timeoutMs: job.timeoutMs,
    streamedContent: job.streamedContent,
    progressLogs: job.progressLogs ? [...job.progressLogs] : [],
    errorMessage: job.errorMessage,
    result: job.result,
  };
}

function sanitizePayloadForDb(payload: StartGenerationPayload): StartGenerationPayload {
  if (!payload.openaiConfig?.apiKey) return payload;
  return {
    ...payload,
    openaiConfig: {
      ...payload.openaiConfig,
      apiKey: "***",
    },
  };
}

function persistJobToDb(job: InternalJob): void {
  if (!isDbConnected()) return;
  const snap = toSnapshot(job);
  const safePayload = sanitizePayloadForDb(job.payload);
  const prisma = getPrismaOrNull();

  if (prisma) {
    const now = new Date();
    const skillName = snap.result?.skillName ?? job.payload.skillName ?? null;
    const resultJson = snap.result
      ? (snap.result as unknown as Prisma.InputJsonValue)
      : Prisma.JsonNull;
    void prisma.generationJob
      .upsert({
        where: { jobId: snap.jobId },
        create: {
          jobId: snap.jobId,
          skillName,
          status: snap.status,
          startedAt: BigInt(snap.startedAt),
          endedAt: snap.endedAt !== undefined ? BigInt(snap.endedAt) : null,
          elapsedMs: snap.elapsedMs,
          timeoutMs: snap.timeoutMs,
          payload: safePayload as unknown as Prisma.InputJsonValue,
          streamedContent: snap.streamedContent,
          errorMessage: snap.errorMessage ?? null,
          result: resultJson,
          updatedAt: now,
        },
        update: {
          skillName,
          status: snap.status,
          endedAt: snap.endedAt !== undefined ? BigInt(snap.endedAt) : null,
          elapsedMs: snap.elapsedMs,
          streamedContent: snap.streamedContent,
          errorMessage: snap.errorMessage ?? null,
          result: resultJson,
          updatedAt: now,
        },
      })
      .catch(() => {});
    return;
  }

  const db = getDb();
  const now = dbNow();

  const values = {
    job_id: snap.jobId,
    skill_name: snap.result?.skillName ?? job.payload.skillName ?? null,
    status: snap.status,
    started_at: snap.startedAt,
    ended_at: snap.endedAt ?? null,
    elapsed_ms: snap.elapsedMs,
    timeout_ms: snap.timeoutMs,
    payload: JSON.stringify(safePayload),
    streamed_content: snap.streamedContent,
    error_message: snap.errorMessage ?? null,
    result: snap.result ? JSON.stringify(snap.result) : null,
    updated_at: now,
  };
  const update = {
    skill_name: values.skill_name,
    status: values.status,
    ended_at: values.ended_at,
    elapsed_ms: values.elapsed_ms,
    streamed_content: values.streamed_content,
    error_message: values.error_message,
    result: values.result,
    updated_at: now,
  };

  const query = isMysqlDriver()
    ? db.insertInto("generation_jobs").values(values).onDuplicateKeyUpdate(update)
    : db
        .insertInto("generation_jobs")
        .values(values)
        .onConflict((oc) => oc.column("job_id").doUpdateSet(update));

  void query.execute().catch(() => {});
}

export function startGenerationJob(
  payload: StartGenerationPayload
): GenerationJobSnapshot {
  const jobId = crypto.randomUUID();
  // timeoutMs === 0 disables timeout completely; >= 5000 sets custom timeout; otherwise default 120s
  const timeoutMs =
    payload.timeoutMs === 0
      ? 0
      : typeof payload.timeoutMs === "number" && payload.timeoutMs >= 5_000
        ? payload.timeoutMs
        : DEFAULT_TIMEOUT_MS;

  const abortController = new AbortController();
  const job: InternalJob = {
    jobId,
    status: "running",
    startedAt: Date.now(),
    elapsedMs: 0,
    timeoutMs,
    streamedContent: "",
    payload: { ...payload, timeoutMs },
    abortController,
  };

  if (timeoutMs > 0) {
    job.timer = setTimeout(() => {
      if (job.status !== "running") return;
      job.abortReason = "timeout";
      job.errorMessage = `生成任务超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已自动中断，可点击「重新启动」重试。`;
      abortController.abort();
      if (job.session) {
        void job.session.abort({
          goalReason: "interrupted",
          reason: job.errorMessage,
        });
      }
    }, timeoutMs);
  }

  jobs.set(jobId, job);
  persistJobToDb(job);

  const creator =
    payload.creator && payload.creator.trim() ? payload.creator.trim() : "Admin";
  const selectedMcpIds = Array.isArray(payload.selectedMcps)
    ? payload.selectedMcps
    : [];
  job.progressLogs = [];
  let hasTextDelta = false;

  void getMcpServersByIdsForOwner(selectedMcpIds, creator)
    .then((mcpServers) =>
      generateSkillFromPrompt({
        userPrompt: payload.description
          ? `Skill description: ${payload.description}\n\n${payload.prompt}`
          : payload.prompt,
        skillName: payload.skillName,
        scope: "global",
        jobId,
        mcpServers,
        openaiConfig: payload.openaiConfig,
        abortSignal: abortController.signal,
        onSessionReady: (session) => {
          job.session = session;
          if (abortController.signal.aborted) {
            void session.abort({
              goalReason: "interrupted",
              reason: job.errorMessage || "Generation interrupted",
            });
          }
        },
        onProgress: (message) => {
          const logs = job.progressLogs ?? [];
          logs.push(message);
          if (logs.length > 50) logs.shift();
          job.progressLogs = logs;
          if (!hasTextDelta) {
            job.streamedContent =
              `<!-- skill-creator 执行进度 -->\n` +
              logs.map((line) => `- ${line}`).join("\n");
          }
        },
        onDelta: (chunk) => {
          if (!hasTextDelta) {
            hasTextDelta = true;
            job.streamedContent = chunk;
          } else {
            job.streamedContent += chunk;
          }
        },
      })
    )
    .then(async (res) => {
      if (job.timer) clearTimeout(job.timer);
      await replaceSkillFiles(res.saved.skillName, res.files);
      const card = await upsertSkillCard(res.saved.skillName, {
        description: payload.description || payload.prompt.slice(0, 120),
        creator,
        currentStep: 1,
        progress: 33,
        status: "draft",
        selectedMcps: selectedMcpIds,
        frontmatter: res.frontmatter,
        hasScripts: res.hasScripts,
        resourceSummary: res.resourceSummary,
      });
      const files = await listSkillFiles(res.saved.skillName);

      job.status = "completed";
      job.endedAt = Date.now();
      job.result = {
        card,
        skillName: res.saved.skillName,
        filePath: res.saved.filePath,
        content: res.content,
        files,
        modelFallbackMessage: res.modelFallbackMessage,
      };
      persistJobToDb(job);
    })
    .catch((err) => {
      if (job.timer) clearTimeout(job.timer);
      job.endedAt = Date.now();

      if (job.abortReason === "timeout") {
        job.status = "timeout";
        job.errorMessage =
          job.errorMessage || "Generation timed out and was interrupted";
      } else if (
        job.abortReason === "user" ||
        job.abortReason === "restart" ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        job.status = "aborted";
        job.errorMessage =
          job.errorMessage ||
          (err instanceof Error ? err.message : "Generation interrupted");
      } else {
        job.status = "failed";
        job.errorMessage = err instanceof Error ? err.message : String(err);
      }
      persistJobToDb(job);
    });

  return toSnapshot(job);
}

export function getGenerationJob(jobId: string): GenerationJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? toSnapshot(job) : null;
}

export async function abortGenerationJob(
  jobId: string,
  reason: string = "用户手动中断生成任务",
  abortReason: "user" | "restart" = "user"
): Promise<GenerationJobSnapshot | null> {
  const job = jobs.get(jobId);
  if (!job) return null;

  if (job.status === "running") {
    if (job.timer) clearTimeout(job.timer);
    job.abortReason = abortReason;
    job.errorMessage = reason;
    job.status = "aborted";
    job.endedAt = Date.now();
    job.abortController.abort();
    if (job.session) {
      await job.session
        .abort({
          goalReason: "interrupted",
          reason,
        })
        .catch(() => { });
    }
    persistJobToDb(job);
  }

  return toSnapshot(job);
}

export async function restartGenerationJob(
  jobId: string,
  overrides?: Partial<StartGenerationPayload>
): Promise<GenerationJobSnapshot | null> {
  const oldJob = jobs.get(jobId);
  if (!oldJob) return null;

  if (oldJob.status === "running") {
    await abortGenerationJob(jobId, "用户重新启动生成任务", "restart");
  }

  return startGenerationJob({
    ...oldJob.payload,
    ...overrides,
  });
}
