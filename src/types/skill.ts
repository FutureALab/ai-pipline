export type SkillScope = "global" | "project";

export type SkillLifecycleStatus =
  | "draft"
  | "submitted"
  | "testing"
  | "test_passed"
  | "test_failed"
  | "published";

export type GenerationJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export interface SavedSkillInfo {
  skillName: string;
  skillDir: string;
  filePath: string;
  scope: SkillScope;
}

export type SkillFileCategory =
  | "skill_md"
  | "script"
  | "reference"
  | "asset"
  | "agent"
  | "eval"
  | "other";

export type SkillFileEncoding = "utf-8" | "base64";

export interface SkillFileEntry {
  path: string;
  content: string;
  category?: SkillFileCategory;
  mimeType?: string;
  encoding?: SkillFileEncoding;
  sizeBytes?: number;
  isExecutable?: boolean;
}

export interface SkillResourceSummary {
  totalFiles: number;
  scripts: number;
  references: number;
  assets: number;
  agents: number;
  other: number;
}

export interface RepoPipelineRun {
  repoId: string;
  repoName: string;
  repoUrl: string;
  status: "pending" | "running" | "success" | "failed";
  durationMs: number;
  logs: string[];
  jenkinsJobName?: string;
  jenkinsBuildNumber?: number;
  jenkinsBuildUrl?: string;
  jenkinsQueueUrl?: string;
  startedAt?: number;
  lastUpdatedAt?: number;
}

export interface UserMcpServer {
  id: string;
  owner: string;
  name: string;
  transport: "streamable-http";
  url: string;
  headers: Record<string, string>;
  description: string;
  createdAt: string;
  updatedAt: string;
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
  selectedMcps?: string[];
  pipelineRuns: RepoPipelineRun[];
  frontmatter?: Record<string, unknown>;
  hasScripts?: boolean;
  resourceSummary?: SkillResourceSummary;
}

export interface CatalogAppRow {
  id: string;
  name: string;
  env: string;
}

export interface CatalogRepoRow {
  id: string;
  name: string;
  url: string;
  branch: string;
}
