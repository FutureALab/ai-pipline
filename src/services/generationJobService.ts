import crypto from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { isDbConnected, queryDb } from "../db/postgres.js";
import {
  listSkillFiles,
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
    errorMessage: job.errorMessage,
    result: job.result,
  };
}

function persistJobToDb(job: InternalJob): void {
  if (!isDbConnected()) return;
  const snap = toSnapshot(job);
  void queryDb(
    `INSERT INTO generation_jobs (
       job_id, skill_name, status, started_at, ended_at, elapsed_ms,
       timeout_ms, payload, streamed_content, error_message, result, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, NOW())
     ON CONFLICT (job_id)
     DO UPDATE SET
       skill_name = EXCLUDED.skill_name,
       status = EXCLUDED.status,
       ended_at = EXCLUDED.ended_at,
       elapsed_ms = EXCLUDED.elapsed_ms,
       streamed_content = EXCLUDED.streamed_content,
       error_message = EXCLUDED.error_message,
       result = EXCLUDED.result,
       updated_at = NOW()`,
    [
      snap.jobId,
      snap.result?.skillName ?? job.payload.skillName ?? null,
      snap.status,
      snap.startedAt,
      snap.endedAt ?? null,
      snap.elapsedMs,
      snap.timeoutMs,
      JSON.stringify(job.payload),
      snap.streamedContent,
      snap.errorMessage ?? null,
      snap.result ? JSON.stringify(snap.result) : null,
    ]
  ).catch(() => {});
}

export function startGenerationJob(
  payload: StartGenerationPayload
): GenerationJobSnapshot {
  const jobId = crypto.randomUUID();
  const timeoutMs =
    typeof payload.timeoutMs === "number" && payload.timeoutMs >= 5_000
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

  jobs.set(jobId, job);
  persistJobToDb(job);

  const creator =
    payload.creator && payload.creator.trim() ? payload.creator.trim() : "Admin";

  void generateSkillFromPrompt({
    userPrompt: payload.description
      ? `Skill description: ${payload.description}\n\n${payload.prompt}`
      : payload.prompt,
    skillName: payload.skillName,
    scope: "global",
    jobId,
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
    onDelta: (chunk) => {
      job.streamedContent += chunk;
    },
  })
    .then(async (res) => {
      if (job.timer) clearTimeout(job.timer);
      const card = await upsertSkillCard(res.saved.skillName, {
        description: payload.description || payload.prompt.slice(0, 120),
        creator,
        currentStep: 1,
        progress: 33,
        status: "draft",
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
        .catch(() => {});
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
