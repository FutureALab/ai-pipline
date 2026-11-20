import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { queryDb } from "../db/database.js";
import type {
  CatalogAppRow,
  CatalogRepoRow,
  RepoPipelineRun,
  SkillCardRecord,
  SkillFileCategory,
  SkillFileEncoding,
  SkillFileEntry,
  SkillLifecycleStatus,
  SkillResourceSummary,
} from "../types/skill.js";
import {
  buildResourceSummary,
  enrichSkillFileEntry,
  normalizeRelativeSkillPath,
  normalizeSkillName,
  parseSkillFrontmatter,
  readSkillDirectoryFiles,
  resolveAllGlobalSkillRoots,
  resolveDefaultSkillsRoot,
  resolvePiSkillsRoot,
} from "./skillStorage.js";

function resolveSafeSkillFilePath(skillName: string, relativePath: string): string {
  const normalized = normalizeSkillName(skillName);
  const relPath = normalizeRelativeSkillPath(relativePath);
  const skillDir = path.resolve(resolveDefaultSkillsRoot("global"), normalized);
  const target = path.resolve(skillDir, relPath);
  if (target !== skillDir && !target.startsWith(skillDir + path.sep)) {
    throw new Error(`Invalid relative file path: "${relativePath}"`);
  }
  return target;
}

export async function readSkillMarkdown(skillName: string): Promise<string> {
  const normalized = normalizeSkillName(skillName);

  // 1. Database is the primary source of truth
  const res = await queryDb<{ content: string }>(
    `SELECT content FROM skill_files WHERE skill_name = $1 AND file_path = 'SKILL.md'`,
    [normalized]
  );
  if (res.rows[0]?.content !== undefined) {
    return res.rows[0].content;
  }

  const skillRow = await queryDb<{ skill_md: string }>(
    `SELECT skill_md FROM skills WHERE skill_name = $1`,
    [normalized]
  );
  if (skillRow.rows[0]?.skill_md) {
    return skillRow.rows[0].skill_md;
  }

  // 2. Fallback to disk if not yet in DB
  const filePath = path.join(
    resolveDefaultSkillsRoot("global"),
    normalized,
    "SKILL.md"
  );
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    throw new Error(`SKILL.md not found for "${normalized}"`);
  }
}

export async function syncSkillMetadata(skillName: string): Promise<void> {
  const normalized = normalizeSkillName(skillName);
  const res = await queryDb<{
    file_path: string;
    content: string;
    category: string;
  }>(
    `SELECT file_path, content, category FROM skill_files WHERE skill_name = $1`,
    [normalized]
  );

  const files: SkillFileEntry[] = res.rows.map((r) => ({
    path: r.file_path,
    content: r.content,
    category: r.category as SkillFileCategory,
  }));

  const { summary, hasScripts } = buildResourceSummary(files);
  const skillMd = files.find((f) => f.path === "SKILL.md");
  const frontmatter = skillMd ? parseSkillFrontmatter(skillMd.content) : null;

  if (skillMd && frontmatter) {
    await queryDb(
      `UPDATE skills
       SET frontmatter = $2::jsonb,
           has_scripts = $3,
           resource_summary = $4::jsonb,
           skill_md = $5,
           updated_at = NOW()
       WHERE skill_name = $1`,
      [
        normalized,
        JSON.stringify(frontmatter),
        hasScripts,
        JSON.stringify(summary),
        skillMd.content,
      ]
    );
  } else {
    await queryDb(
      `UPDATE skills
       SET has_scripts = $2,
           resource_summary = $3::jsonb,
           updated_at = NOW()
       WHERE skill_name = $1`,
      [normalized, hasScripts, JSON.stringify(summary)]
    );
  }
}

async function upsertSkillFileRow(
  normalizedSkillName: string,
  entry: Required<SkillFileEntry>
): Promise<void> {
  await queryDb(
    `INSERT INTO skill_files (
       skill_name, file_path, content, category, mime_type, encoding, size_bytes, is_executable, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (skill_name, file_path)
     DO UPDATE SET
       content = EXCLUDED.content,
       category = EXCLUDED.category,
       mime_type = EXCLUDED.mime_type,
       encoding = EXCLUDED.encoding,
       size_bytes = EXCLUDED.size_bytes,
       is_executable = EXCLUDED.is_executable,
       updated_at = NOW()`,
    [
      normalizedSkillName,
      entry.path,
      entry.content,
      entry.category,
      entry.mimeType,
      entry.encoding,
      entry.sizeBytes,
      entry.isExecutable,
    ]
  );
}

export async function writeSkillFile(
  skillName: string,
  relativePath: string,
  content: string,
  encoding?: SkillFileEncoding
): Promise<string> {
  const normalized = normalizeSkillName(skillName);
  const enriched = enrichSkillFileEntry({ path: relativePath, content, encoding });
  const filePath = resolveSafeSkillFilePath(normalized, enriched.path);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(enriched.content, enriched.encoding));
  if (enriched.isExecutable) {
    await fs.chmod(filePath, 0o755).catch(() => {});
  }

  await queryDb(
    `INSERT INTO skills (skill_name) VALUES ($1) ON CONFLICT (skill_name) DO NOTHING`,
    [normalized]
  );
  await upsertSkillFileRow(normalized, enriched);
  await syncSkillMetadata(normalized);

  return filePath;
}

export async function deleteSkillFile(
  skillName: string,
  relativePath: string
): Promise<void> {
  const normalized = normalizeSkillName(skillName);
  const relPath = normalizeRelativeSkillPath(relativePath);
  const filePath = resolveSafeSkillFilePath(normalized, relPath);

  await fs.rm(filePath, { force: true }).catch(() => {});
  await queryDb(
    `DELETE FROM skill_files WHERE skill_name = $1 AND file_path = $2`,
    [normalized, relPath]
  );
  await syncSkillMetadata(normalized);
}

export async function replaceSkillFiles(
  skillName: string,
  files: SkillFileEntry[]
): Promise<void> {
  const normalized = normalizeSkillName(skillName);
  const enrichedFiles = files.map((f) => enrichSkillFileEntry(f));
  const nextPaths = new Set(enrichedFiles.map((f) => f.path));

  await queryDb(
    `INSERT INTO skills (skill_name) VALUES ($1) ON CONFLICT (skill_name) DO NOTHING`,
    [normalized]
  );

  // Remove stale files from disk and DB
  const existingDb = await queryDb<{ file_path: string }>(
    `SELECT file_path FROM skill_files WHERE skill_name = $1`,
    [normalized]
  );
  for (const row of existingDb.rows) {
    if (!nextPaths.has(row.file_path)) {
      const target = resolveSafeSkillFilePath(normalized, row.file_path);
      await fs.rm(target, { force: true }).catch(() => {});
      await queryDb(
        `DELETE FROM skill_files WHERE skill_name = $1 AND file_path = $2`,
        [normalized, row.file_path]
      );
    }
  }

  for (const entry of enrichedFiles) {
    const target = resolveSafeSkillFilePath(normalized, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(entry.content, entry.encoding));
    if (entry.isExecutable) {
      await fs.chmod(target, 0o755).catch(() => {});
    }
    await upsertSkillFileRow(normalized, entry);
  }

  await syncSkillMetadata(normalized);
}

export async function listSkillFiles(skillName: string): Promise<SkillFileEntry[]> {
  const normalized = normalizeSkillName(skillName);

  // 1. Database is the primary source of truth
  const dbFiles = await queryDb<{
    file_path: string;
    content: string;
    category: string;
    mime_type: string;
    encoding: string;
    size_bytes: number;
    is_executable: boolean | number;
  }>(
    `SELECT file_path, content, category, mime_type, encoding, size_bytes, is_executable
     FROM skill_files
     WHERE skill_name = $1`,
    [normalized]
  );

  if (dbFiles.rows.length > 0) {
    const results: SkillFileEntry[] = dbFiles.rows.map((row) => ({
      path: row.file_path,
      content: row.content,
      category: (row.category as SkillFileCategory) || undefined,
      mimeType: row.mime_type || undefined,
      encoding: (row.encoding as SkillFileEncoding) || "utf-8",
      sizeBytes: row.size_bytes ?? undefined,
      isExecutable: Boolean(row.is_executable),
    }));
    results.sort((a, b) => {
      if (a.path === "SKILL.md") return -1;
      if (b.path === "SKILL.md") return 1;
      return a.path.localeCompare(b.path);
    });
    return results;
  }

  // 2. Fallback to skills.skill_md if skill_files has no rows yet
  const skillRow = await queryDb<{ skill_md: string }>(
    `SELECT skill_md FROM skills WHERE skill_name = $1`,
    [normalized]
  );
  if (skillRow.rows[0]?.skill_md) {
    return [enrichSkillFileEntry({ path: "SKILL.md", content: skillRow.rows[0].skill_md })];
  }

  // 3. Fallback to disk
  const skillDir = path.resolve(resolveDefaultSkillsRoot("global"), normalized);
  return await readSkillDirectoryFiles(skillDir);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function buildSkillZipBuffer(skillName: string): Promise<Buffer> {
  const files = await listSkillFiles(skillName);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(`${normalizeSkillName(skillName)}/${file.path}`, "utf-8");
    const encoding = file.encoding === "base64" ? "base64" : "utf-8";
    const dataBuf = Buffer.from(file.content, encoding);
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

type DbSkillRow = {
  skill_name: string;
  description: string;
  creator: string;
  is_builtin: boolean | number;
  created_at: Date | string;
  updated_at: Date | string;
  current_step: number;
  progress: number;
  status: SkillLifecycleStatus;
  selected_apps: string[] | string;
  selected_repos: string[] | string;
  selected_mcps: string[] | string | null;
  pipeline_runs: RepoPipelineRun[] | string;
  frontmatter: Record<string, unknown> | string | null;
  has_scripts: boolean | number | null;
  resource_summary: SkillResourceSummary | string | null;
};

function parseJsonArray<T>(val: T[] | string | null | undefined): T[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObject<T extends object>(
  val: T | string | null | undefined,
  fallback: T
): T {
  if (val && typeof val === "object" && !Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

const DEFAULT_RESOURCE_SUMMARY: SkillResourceSummary = {
  totalFiles: 0,
  scripts: 0,
  references: 0,
  assets: 0,
  agents: 0,
  other: 0,
};

function mapDbRowToCard(row: DbSkillRow): SkillCardRecord {
  const resourceSummary = parseJsonObject<SkillResourceSummary>(
    row.resource_summary as SkillResourceSummary | string | null | undefined,
    { ...DEFAULT_RESOURCE_SUMMARY }
  );
  return {
    skillName: row.skill_name,
    description: row.description,
    creator: row.creator,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    currentStep: (row.current_step as 1 | 2 | 3) || 1,
    progress: row.progress ?? 33,
    status: row.status ?? "draft",
    selectedApps: parseJsonArray<string>(row.selected_apps),
    selectedRepos: parseJsonArray<string>(row.selected_repos),
    selectedMcps: parseJsonArray<string>(row.selected_mcps),
    pipelineRuns: parseJsonArray<RepoPipelineRun>(row.pipeline_runs),
    frontmatter: parseJsonObject<Record<string, unknown>>(row.frontmatter, {}),
    hasScripts: Boolean(row.has_scripts),
    resourceSummary,
  };
}

const SKILL_SELECT_COLUMNS = `
  skill_name, description, creator, is_builtin, created_at, updated_at,
  current_step, progress, status, selected_apps, selected_repos, selected_mcps,
  pipeline_runs, frontmatter, has_scripts, resource_summary
`;

export async function deleteSkillCompletely(skillName: string): Promise<{
  skillName: string;
  removedDirs: string[];
}> {
  const normalized = normalizeSkillName(skillName);
  if (!normalized) {
    throw new Error("Invalid skill name");
  }

  // 1. Delete from database tables
  await queryDb(`DELETE FROM skill_files WHERE skill_name = $1`, [normalized]);
  await queryDb(`DELETE FROM skills WHERE skill_name = $1`, [normalized]);

  // 2. Remove from all disk locations:
  //    - resource/builtin-skills/<name>, resource/skills/<name>, resource/<name>
  //    - ~/.pi/agent/skills/<name>, ~/.pi/skills/<name>
  //    - ~/.omp/agent/skills/<name>
  //    - project .omp/skills/<name>, .pi/skills/<name>
  const cwd = process.cwd();
  const home = os.homedir();
  const candidateRoots = new Set<string>([
    ...resolveAllGlobalSkillRoots(),
    resolveDefaultSkillsRoot("global", cwd),
    resolveDefaultSkillsRoot("project", cwd),
    resolvePiSkillsRoot(),
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".pi", "skills"),
    path.join(home, ".omp", "agent", "skills"),
    path.join(home, ".omp", "skills"),
    path.resolve(cwd, "resource", "builtin-skills"),
    path.resolve(cwd, "resource", "skills"),
    path.resolve(cwd, "resource"),
    path.resolve(cwd, ".pi", "agent", "skills"),
    path.resolve(cwd, ".pi", "skills"),
  ]);

  const removedDirs: string[] = [];
  for (const root of candidateRoots) {
    const absRoot = path.resolve(root);
    const targetDir = path.resolve(absRoot, normalized);
    // Safety guard: targetDir must be a direct child of absRoot and not equal to absRoot
    if (
      targetDir === absRoot ||
      path.dirname(targetDir) !== absRoot ||
      normalized === "builtin-skills" ||
      normalized === "skills"
    ) {
      continue;
    }

    const stat = await fs.stat(targetDir).catch(() => null);
    if (stat?.isDirectory()) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      removedDirs.push(targetDir);
    }
  }

  return {
    skillName: normalized,
    removedDirs,
  };
}

export async function listCatalogApps(): Promise<CatalogAppRow[]> {
  const res = await queryDb<CatalogAppRow & Record<string, unknown>>(
    `SELECT id, name, env FROM catalog_apps ORDER BY id ASC`
  );
  return res.rows;
}

export async function listCatalogRepos(): Promise<CatalogRepoRow[]> {
  const res = await queryDb<CatalogRepoRow & Record<string, unknown>>(
    `SELECT id, name, url, branch FROM catalog_repos ORDER BY id ASC`
  );
  return res.rows;
}

/**
 * List user-created skills (built-in skills with `is_builtin = true` are hidden from UI).
 */
export async function listSkillCards(): Promise<SkillCardRecord[]> {
  const res = await queryDb<DbSkillRow>(
    `SELECT ${SKILL_SELECT_COLUMNS}
     FROM skills
     WHERE is_builtin = $1
     ORDER BY updated_at DESC`,
    [false]
  );
  return res.rows.map(mapDbRowToCard);
}

export async function getSkillCard(
  skillName: string
): Promise<{ card: SkillCardRecord; content: string } | null> {
  const normalized = normalizeSkillName(skillName);
  const res = await queryDb<DbSkillRow>(
    `SELECT ${SKILL_SELECT_COLUMNS}
     FROM skills WHERE skill_name = $1`,
    [normalized]
  );
  if (res.rows.length === 0) return null;

  const card = mapDbRowToCard(res.rows[0]);
  const content = await readSkillMarkdown(normalized).catch(() => "");
  return { card, content };
}

export async function upsertSkillCard(
  skillName: string,
  patch: Partial<SkillCardRecord> & { isBuiltin?: boolean }
): Promise<SkillCardRecord> {
  const normalized = normalizeSkillName(skillName);

  const existingRes = await queryDb<DbSkillRow>(
    `SELECT ${SKILL_SELECT_COLUMNS}
     FROM skills WHERE skill_name = $1`,
    [normalized]
  );
  const existing = existingRes.rows[0]
    ? mapDbRowToCard(existingRes.rows[0])
    : undefined;
  const existingBuiltin = existingRes.rows[0]
    ? Boolean(existingRes.rows[0].is_builtin)
    : false;
  const now = new Date().toISOString();

  const next: SkillCardRecord = {
    skillName: normalized,
    description: patch.description ?? existing?.description ?? "自定义 AI Skill",
    creator: patch.creator ?? existing?.creator ?? "Admin",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    currentStep: patch.currentStep ?? existing?.currentStep ?? 1,
    progress: patch.progress ?? existing?.progress ?? 33,
    status: patch.status ?? existing?.status ?? "draft",
    selectedApps: patch.selectedApps ?? existing?.selectedApps ?? [],
    selectedRepos: patch.selectedRepos ?? existing?.selectedRepos ?? [],
    selectedMcps: patch.selectedMcps ?? existing?.selectedMcps ?? [],
    pipelineRuns: patch.pipelineRuns ?? existing?.pipelineRuns ?? [],
    frontmatter: patch.frontmatter ?? existing?.frontmatter ?? {},
    hasScripts: patch.hasScripts ?? existing?.hasScripts ?? false,
    resourceSummary:
      patch.resourceSummary ?? existing?.resourceSummary ?? { ...DEFAULT_RESOURCE_SUMMARY },
  };

  await queryDb(
    `INSERT INTO skills (
       skill_name, description, creator, is_builtin, created_at, updated_at,
       current_step, progress, status, selected_apps, selected_repos, selected_mcps,
       pipeline_runs, frontmatter, has_scripts, resource_summary
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16::jsonb)
     ON CONFLICT (skill_name)
     DO UPDATE SET
       description = EXCLUDED.description,
       creator = EXCLUDED.creator,
       is_builtin = EXCLUDED.is_builtin,
       updated_at = EXCLUDED.updated_at,
       current_step = EXCLUDED.current_step,
       progress = EXCLUDED.progress,
       status = EXCLUDED.status,
       selected_apps = EXCLUDED.selected_apps,
       selected_repos = EXCLUDED.selected_repos,
       selected_mcps = EXCLUDED.selected_mcps,
       pipeline_runs = EXCLUDED.pipeline_runs,
       frontmatter = EXCLUDED.frontmatter,
       has_scripts = EXCLUDED.has_scripts,
       resource_summary = EXCLUDED.resource_summary`,
    [
      next.skillName,
      next.description,
      next.creator,
      patch.isBuiltin ?? existingBuiltin,
      next.createdAt,
      next.updatedAt,
      next.currentStep,
      next.progress,
      next.status,
      JSON.stringify(next.selectedApps),
      JSON.stringify(next.selectedRepos),
      JSON.stringify(next.selectedMcps ?? []),
      JSON.stringify(next.pipelineRuns),
      JSON.stringify(next.frontmatter ?? {}),
      next.hasScripts ?? false,
      JSON.stringify(next.resourceSummary ?? DEFAULT_RESOURCE_SUMMARY),
    ]
  );

  return next;
}
