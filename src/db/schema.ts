import type { Generated, Insertable, Selectable, Updateable } from "kysely";

export interface SkillsTable {
  skill_name: string;
  description: Generated<string>;
  creator: Generated<string>;
  is_builtin: Generated<boolean | number>;
  created_at: Generated<Date | string>;
  updated_at: Generated<Date | string>;
  current_step: Generated<number>;
  progress: Generated<number>;
  status: Generated<string>;
  selected_apps: Generated<unknown>;
  selected_repos: Generated<unknown>;
  selected_mcps: Generated<unknown>;
  pipeline_runs: Generated<unknown>;
  frontmatter: Generated<unknown>;
  has_scripts: Generated<boolean | number>;
  resource_summary: Generated<unknown>;
  skill_md: Generated<string>;
}

export interface McpServersTable {
  id: string;
  owner: string;
  name: string;
  transport: Generated<string>;
  url: string;
  headers: Generated<unknown>;
  description: Generated<string>;
  created_at: Generated<Date | string>;
  updated_at: Generated<Date | string>;
}

export interface SkillFilesTable {
  skill_name: string;
  file_path: string;
  content: Generated<string>;
  category: Generated<string>;
  mime_type: Generated<string>;
  encoding: Generated<string>;
  size_bytes: Generated<number>;
  is_executable: Generated<boolean | number>;
  updated_at: Generated<Date | string>;
}

export interface CatalogAppsTable {
  id: string;
  name: string;
  env: Generated<string>;
  created_at: Generated<Date | string>;
}

export interface CatalogReposTable {
  id: string;
  name: string;
  url: string;
  branch: Generated<string>;
  created_at: Generated<Date | string>;
}

export interface GenerationJobsTable {
  job_id: string;
  skill_name: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  elapsed_ms: Generated<number>;
  timeout_ms: Generated<number>;
  payload: Generated<unknown>;
  streamed_content: Generated<string>;
  error_message: string | null;
  result: unknown | null;
  updated_at: Generated<Date | string>;
}

export interface AiTraceSpansTable {
  id: Generated<number>;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: Generated<number>;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  status: Generated<unknown>;
  attributes: Generated<unknown>;
  events: Generated<unknown>;
  created_at: Generated<Date | string>;
}

export interface DatabaseSchema {
  skills: SkillsTable;
  mcp_servers: McpServersTable;
  skill_files: SkillFilesTable;
  catalog_apps: CatalogAppsTable;
  catalog_repos: CatalogReposTable;
  generation_jobs: GenerationJobsTable;
  ai_trace_spans: AiTraceSpansTable;
}

export type SkillRow = Selectable<SkillsTable>;
export type NewSkillRow = Insertable<SkillsTable>;
export type SkillRowUpdate = Updateable<SkillsTable>;

export type McpServerRow = Selectable<McpServersTable>;
export type SkillFileRow = Selectable<SkillFilesTable>;
export type CatalogAppDbRow = Selectable<CatalogAppsTable>;
export type CatalogRepoDbRow = Selectable<CatalogReposTable>;
export type GenerationJobRow = Selectable<GenerationJobsTable>;
export type AiTraceSpanRow = Selectable<AiTraceSpansTable>;
