export type SkillLifecycleStatus =
  | "draft"
  | "submitted"
  | "testing"
  | "test_passed"
  | "test_failed"
  | "published";

export interface RepoPipelineRun {
  repoId: string;
  repoName: string;
  repoUrl: string;
  status: "pending" | "running" | "success" | "failed";
  durationMs: number;
  logs: string[];
}

export interface SkillCardRecord {
  skillName: string;
  description: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
  currentStep: 1 | 2 | 3;
  progress: number;
  status: SkillLifecycleStatus;
  selectedApps: string[];
  selectedRepos: string[];
  pipelineRuns: RepoPipelineRun[];
}

export interface SkillFileEntry {
  path: string;
  content: string;
}

export type GenerationJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export interface GenerationJobSnapshot {
  jobId: string;
  status: GenerationJobStatus;
  startedAt: number;
  endedAt?: number;
  elapsedMs: number;
  timeoutMs: number;
  streamedContent: string;
  errorMessage?: string;
  result?: {
    card: SkillCardRecord;
    skillName: string;
    filePath: string;
    content: string;
    files: SkillFileEntry[];
  };
}

export interface AppCatalogItem {
  id: string;
  name: string;
  env: string;
}

export interface RepoCatalogItem {
  id: string;
  name: string;
  url: string;
  branch: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function fetchSkills(): Promise<{ skills: SkillCardRecord[] }> {
  return request("/api/skills");
}

export function fetchSkillDetail(
  skillName: string
): Promise<{ card: SkillCardRecord; content: string; files: SkillFileEntry[] }> {
  return request(`/api/skills/${encodeURIComponent(skillName)}`);
}

export function generateSkill(payload: {
  skillName?: string;
  description?: string;
  creator?: string;
  prompt: string;
}): Promise<{
  card: SkillCardRecord;
  skillName: string;
  filePath: string;
  content: string;
  files: SkillFileEntry[];
}> {
  return request("/api/skills/generate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateSkill(
  skillName: string,
  payload: {
    description?: string;
    creator?: string;
    content?: string;
    files?: SkillFileEntry[];
    submit?: boolean;
  }
): Promise<{ card: SkillCardRecord; content: string; files: SkillFileEntry[] }> {
  return request(`/api/skills/${encodeURIComponent(skillName)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function getSkillDownloadUrl(skillName: string): string {
  return `/api/skills/${encodeURIComponent(skillName)}/download`;
}

export function startGenerationJob(payload: {
  skillName?: string;
  description?: string;
  creator?: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ job: GenerationJobSnapshot }> {
  return request("/api/skills/generate/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchGenerationJob(
  jobId: string
): Promise<{ job: GenerationJobSnapshot }> {
  return request(`/api/skills/generate/jobs/${encodeURIComponent(jobId)}`);
}

export function abortGenerationJob(
  jobId: string,
  reason?: string
): Promise<{ job: GenerationJobSnapshot }> {
  return request(`/api/skills/generate/jobs/${encodeURIComponent(jobId)}/abort`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function restartGenerationJob(
  jobId: string,
  payload?: { prompt?: string; timeoutMs?: number }
): Promise<{ job: GenerationJobSnapshot }> {
  return request(
    `/api/skills/generate/jobs/${encodeURIComponent(jobId)}/restart`,
    {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }
  );
}

export function fetchCatalog(): Promise<{
  apps: AppCatalogItem[];
  repos: RepoCatalogItem[];
}> {
  return request("/api/catalog");
}

export function runTestPipeline(
  skillName: string,
  payload: { apps: string[]; repos: string[]; mode: "simulate" | "real" | "jenkins" }
): Promise<{
  card: SkillCardRecord;
  allPassed: boolean;
  pipelineRuns: RepoPipelineRun[];
}> {
  return request(
    `/api/skills/${encodeURIComponent(skillName)}/test-pipeline`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export function publishSkill(
  skillName: string
): Promise<{ card: SkillCardRecord }> {
  return request(`/api/skills/${encodeURIComponent(skillName)}/publish`, {
    method: "POST",
  });
}
