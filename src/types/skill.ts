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

export interface SkillFileEntry {
  path: string;
  content: string;
}

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
