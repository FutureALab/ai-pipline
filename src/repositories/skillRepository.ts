import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dbNow,
  getDb,
  getPrismaOrNull,
  isMysqlDriver,
  toDbBool,
  toDbTimestamp,
} from "../db/database.js";
import type { SkillRow } from "../db/schema.js";
import type { Prisma, Skill as PrismaSkill } from "../generated/prisma/client.js";
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
  const prisma = getPrismaOrNull();

  if (prisma) {
    const fileRow = await prisma.skillFile.findUnique({
      where: { skillName_filePath: { skillName: normalized, filePath: "SKILL.md" } },
      select: { content: true },
    });
    if (fileRow?.content !== undefined) return fileRow.content;

    const skillRow = await prisma.skill.findUnique({
      where: { skillName: normalized },
      select: { skillMd: true },
    });
    if (skillRow?.skillMd) return skillRow.skillMd;
  } else {
    const db = getDb();
    const fileRow = await db
      .selectFrom("skill_files")
      .select("content")
      .where("skill_name", "=", normalized)
      .where("file_path", "=", "SKILL.md")
      .executeTakeFirst();
    if (fileRow?.content !== undefined) return fileRow.content;

    const skillRow = await db
      .selectFrom("skills")
      .select("skill_md")
      .where("skill_name", "=", normalized)
      .executeTakeFirst();
    if (skillRow?.skill_md) return skillRow.skill_md;
  }

  // Fallback to disk if not yet in DB
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
  const prisma = getPrismaOrNull();

  if (prisma) {
    const rows = await prisma.skillFile.findMany({
      where: { skillName: normalized },
      select: { filePath: true, content: true, category: true },
    });
    const files: SkillFileEntry[] = rows.map((r) => ({
      path: r.filePath,
      content: r.content,
      category: r.category as SkillFileCategory,
    }));
    const { summary, hasScripts } = buildResourceSummary(files);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    const frontmatter = skillMd ? parseSkillFrontmatter(skillMd.content) : null;

    await prisma.skill.update({
      where: { skillName: normalized },
      data: {
        hasScripts,
        resourceSummary: summary as unknown as Prisma.InputJsonValue,
        updatedAt: new Date(),
        ...(skillMd && frontmatter
          ? {
              frontmatter: frontmatter as unknown as Prisma.InputJsonValue,
              skillMd: skillMd.content,
            }
          : {}),
      },
    });
    return;
  }

  const db = getDb();
  const rows = await db
    .selectFrom("skill_files")
    .select(["file_path", "content", "category"])
    .where("skill_name", "=", normalized)
    .execute();

  const files: SkillFileEntry[] = rows.map((r) => ({
    path: r.file_path,
    content: r.content,
    category: r.category as SkillFileCategory,
  }));

  const { summary, hasScripts } = buildResourceSummary(files);
  const skillMd = files.find((f) => f.path === "SKILL.md");
  const frontmatter = skillMd ? parseSkillFrontmatter(skillMd.content) : null;

  if (skillMd && frontmatter) {
    await db
      .updateTable("skills")
      .set({
        frontmatter: JSON.stringify(frontmatter),
        has_scripts: toDbBool(hasScripts),
        resource_summary: JSON.stringify(summary),
        skill_md: skillMd.content,
        updated_at: dbNow(),
      })
      .where("skill_name", "=", normalized)
      .execute();
  } else {
    await db
      .updateTable("skills")
      .set({
        has_scripts: toDbBool(hasScripts),
        resource_summary: JSON.stringify(summary),
        updated_at: dbNow(),
      })
      .where("skill_name", "=", normalized)
      .execute();
  }
}

async function ensureSkillRowExists(normalizedSkillName: string): Promise<void> {
  const prisma = getPrismaOrNull();
  if (prisma) {
    await prisma.skill.upsert({
      where: { skillName: normalizedSkillName },
      create: { skillName: normalizedSkillName },
      update: {},
    });
    return;
  }

  const db = getDb();
  const now = dbNow();
  const stub = {
    skill_name: normalizedSkillName,
    description: "",
    creator: "Admin",
    is_builtin: toDbBool(false),
    created_at: now,
    updated_at: now,
    current_step: 1,
    progress: 33,
    status: "draft",
    selected_apps: "[]",
    selected_repos: "[]",
    selected_mcps: "[]",
    pipeline_runs: "[]",
    frontmatter: "{}",
    has_scripts: toDbBool(false),
    resource_summary: "{}",
    skill_md: "",
  };

  if (isMysqlDriver()) {
    await db.insertInto("skills").ignore().values(stub).execute();
  } else {
    await db
      .insertInto("skills")
      .values(stub)
      .onConflict((oc) => oc.column("skill_name").doNothing())
      .execute();
  }
}

async function upsertSkillFileRow(
  normalizedSkillName: string,
  entry: Required<SkillFileEntry>
): Promise<void> {
  const prisma = getPrismaOrNull();
  if (prisma) {
    await prisma.skillFile.upsert({
      where: {
        skillName_filePath: {
          skillName: normalizedSkillName,
          filePath: entry.path,
        },
      },
      create: {
        skillName: normalizedSkillName,
        filePath: entry.path,
        content: entry.content,
        category: entry.category,
        mimeType: entry.mimeType,
        encoding: entry.encoding,
        sizeBytes: entry.sizeBytes,
        isExecutable: entry.isExecutable,
        updatedAt: new Date(),
      },
      update: {
        content: entry.content,
        category: entry.category,
        mimeType: entry.mimeType,
        encoding: entry.encoding,
        sizeBytes: entry.sizeBytes,
        isExecutable: entry.isExecutable,
        updatedAt: new Date(),
      },
    });
    return;
  }

  const db = getDb();
  const now = dbNow();
  const values = {
    skill_name: normalizedSkillName,
    file_path: entry.path,
    content: entry.content,
    category: entry.category,
    mime_type: entry.mimeType,
    encoding: entry.encoding,
    size_bytes: entry.sizeBytes,
    is_executable: toDbBool(entry.isExecutable),
    updated_at: now,
  };
  const update = {
    content: entry.content,
    category: entry.category,
    mime_type: entry.mimeType,
    encoding: entry.encoding,
    size_bytes: entry.sizeBytes,
    is_executable: toDbBool(entry.isExecutable),
    updated_at: now,
  };

  if (isMysqlDriver()) {
    await db
      .insertInto("skill_files")
      .values(values)
      .onDuplicateKeyUpdate(update)
      .execute();
  } else {
    await db
      .insertInto("skill_files")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["skill_name", "file_path"]).doUpdateSet(update)
      )
      .execute();
  }
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

  await ensureSkillRowExists(normalized);
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
  const prisma = getPrismaOrNull();
  if (prisma) {
    await prisma.skillFile.deleteMany({
      where: { skillName: normalized, filePath: relPath },
    });
  } else {
    await getDb()
      .deleteFrom("skill_files")
      .where("skill_name", "=", normalized)
      .where("file_path", "=", relPath)
      .execute();
  }
  await syncSkillMetadata(normalized);
}

export async function replaceSkillFiles(
  skillName: string,
  files: SkillFileEntry[]
): Promise<void> {
  const normalized = normalizeSkillName(skillName);
  const enrichedFiles = files.map((f) => enrichSkillFileEntry(f));
  const nextPaths = new Set(enrichedFiles.map((f) => f.path));

  await ensureSkillRowExists(normalized);

  const prisma = getPrismaOrNull();
  const existingPaths: string[] = prisma
    ? (
        await prisma.skillFile.findMany({
          where: { skillName: normalized },
          select: { filePath: true },
        })
      ).map((r) => r.filePath)
    : (
        await getDb()
          .selectFrom("skill_files")
          .select("file_path")
          .where("skill_name", "=", normalized)
          .execute()
      ).map((r) => r.file_path);

  for (const oldPath of existingPaths) {
    if (!nextPaths.has(oldPath)) {
      const target = resolveSafeSkillFilePath(normalized, oldPath);
      await fs.rm(target, { force: true }).catch(() => {});
      if (prisma) {
        await prisma.skillFile.deleteMany({
          where: { skillName: normalized, filePath: oldPath },
        });
      } else {
        await getDb()
          .deleteFrom("skill_files")
          .where("skill_name", "=", normalized)
          .where("file_path", "=", oldPath)
          .execute();
      }
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
  const prisma = getPrismaOrNull();

  if (prisma) {
    const dbFiles = await prisma.skillFile.findMany({
      where: { skillName: normalized },
    });
    if (dbFiles.length > 0) {
      const results: SkillFileEntry[] = dbFiles.map((row) => ({
        path: row.filePath,
        content: row.content,
        category: (row.category as SkillFileCategory) || undefined,
        mimeType: row.mimeType || undefined,
        encoding: (row.encoding as SkillFileEncoding) || "utf-8",
        sizeBytes: row.sizeBytes ?? undefined,
        isExecutable: Boolean(row.isExecutable),
      }));
      results.sort((a, b) => {
        if (a.path === "SKILL.md") return -1;
        if (b.path === "SKILL.md") return 1;
        return a.path.localeCompare(b.path);
      });
      return results;
    }

    const skillRow = await prisma.skill.findUnique({
      where: { skillName: normalized },
      select: { skillMd: true },
    });
    if (skillRow?.skillMd) {
      return [enrichSkillFileEntry({ path: "SKILL.md", content: skillRow.skillMd })];
    }
  } else {
    const db = getDb();
    const dbFiles = await db
      .selectFrom("skill_files")
      .select([
        "file_path",
        "content",
        "category",
        "mime_type",
        "encoding",
        "size_bytes",
        "is_executable",
      ])
      .where("skill_name", "=", normalized)
      .execute();

    if (dbFiles.length > 0) {
      const results: SkillFileEntry[] = dbFiles.map((row) => ({
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

    const skillRow = await db
      .selectFrom("skills")
      .select("skill_md")
      .where("skill_name", "=", normalized)
      .executeTakeFirst();
    if (skillRow?.skill_md) {
      return [enrichSkillFileEntry({ path: "SKILL.md", content: skillRow.skill_md })];
    }
  }

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

function parseJsonArray<T>(val: unknown): T[] {
  if (Array.isArray(val)) return val as T[];
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObject<T extends object>(val: unknown, fallback: T): T {
  if (val && typeof val === "object" && !Array.isArray(val)) return val as T;
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

type SelectedSkillRow = Omit<SkillRow, "skill_md">;

function mapPrismaSkillToCard(row: Omit<PrismaSkill, "skillMd">): SkillCardRecord {
  return {
    skillName: row.skillName,
    description: row.description,
    creator: row.creator,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    currentStep: (row.currentStep as 1 | 2 | 3) || 1,
    progress: row.progress ?? 33,
    status: (row.status as SkillLifecycleStatus) ?? "draft",
    selectedApps: parseJsonArray<string>(row.selectedApps),
    selectedRepos: parseJsonArray<string>(row.selectedRepos),
    selectedMcps: parseJsonArray<string>(row.selectedMcps),
    pipelineRuns: parseJsonArray<RepoPipelineRun>(row.pipelineRuns),
    frontmatter: parseJsonObject<Record<string, unknown>>(row.frontmatter, {}),
    hasScripts: Boolean(row.hasScripts),
    resourceSummary: parseJsonObject<SkillResourceSummary>(
      row.resourceSummary,
      { ...DEFAULT_RESOURCE_SUMMARY }
    ),
  };
}

function mapDbRowToCard(row: SelectedSkillRow): SkillCardRecord {
  const resourceSummary = parseJsonObject<SkillResourceSummary>(
    row.resource_summary,
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
    status: (row.status as SkillLifecycleStatus) ?? "draft",
    selectedApps: parseJsonArray<string>(row.selected_apps),
    selectedRepos: parseJsonArray<string>(row.selected_repos),
    selectedMcps: parseJsonArray<string>(row.selected_mcps),
    pipelineRuns: parseJsonArray<RepoPipelineRun>(row.pipeline_runs),
    frontmatter: parseJsonObject<Record<string, unknown>>(row.frontmatter, {}),
    hasScripts: Boolean(row.has_scripts),
    resourceSummary,
  };
}

const SKILL_SELECT_COLUMNS = [
  "skill_name",
  "description",
  "creator",
  "is_builtin",
  "created_at",
  "updated_at",
  "current_step",
  "progress",
  "status",
  "selected_apps",
  "selected_repos",
  "selected_mcps",
  "pipeline_runs",
  "frontmatter",
  "has_scripts",
  "resource_summary",
] as const;

export async function deleteSkillCompletely(skillName: string): Promise<{
  skillName: string;
  removedDirs: string[];
}> {
  const normalized = normalizeSkillName(skillName);
  if (!normalized) {
    throw new Error("Invalid skill name");
  }

  const prisma = getPrismaOrNull();
  if (prisma) {
    await prisma.skillFile.deleteMany({ where: { skillName: normalized } });
    await prisma.skill.deleteMany({ where: { skillName: normalized } });
  } else {
    const db = getDb();
    await db.deleteFrom("skill_files").where("skill_name", "=", normalized).execute();
    await db.deleteFrom("skills").where("skill_name", "=", normalized).execute();
  }

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
  const prisma = getPrismaOrNull();
  if (prisma) {
    return await prisma.catalogApp.findMany({
      select: { id: true, name: true, env: true },
      orderBy: { id: "asc" },
    });
  }
  return await getDb()
    .selectFrom("catalog_apps")
    .select(["id", "name", "env"])
    .orderBy("id", "asc")
    .execute();
}

export async function listCatalogRepos(): Promise<CatalogRepoRow[]> {
  const prisma = getPrismaOrNull();
  if (prisma) {
    return await prisma.catalogRepo.findMany({
      select: { id: true, name: true, url: true, branch: true },
      orderBy: { id: "asc" },
    });
  }
  return await getDb()
    .selectFrom("catalog_repos")
    .select(["id", "name", "url", "branch"])
    .orderBy("id", "asc")
    .execute();
}

export async function listSkillCards(): Promise<SkillCardRecord[]> {
  const prisma = getPrismaOrNull();
  if (prisma) {
    const rows = await prisma.skill.findMany({
      where: { isBuiltin: false },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(mapPrismaSkillToCard);
  }
  const rows = await getDb()
    .selectFrom("skills")
    .select(SKILL_SELECT_COLUMNS)
    .where("is_builtin", "=", toDbBool(false))
    .orderBy("updated_at", "desc")
    .execute();
  return rows.map(mapDbRowToCard);
}

export async function getSkillCard(
  skillName: string
): Promise<{ card: SkillCardRecord; content: string } | null> {
  const normalized = normalizeSkillName(skillName);
  const prisma = getPrismaOrNull();
  if (prisma) {
    const row = await prisma.skill.findUnique({
      where: { skillName: normalized },
    });
    if (!row) return null;
    const card = mapPrismaSkillToCard(row);
    const content = await readSkillMarkdown(normalized).catch(() => "");
    return { card, content };
  }

  const row = await getDb()
    .selectFrom("skills")
    .select(SKILL_SELECT_COLUMNS)
    .where("skill_name", "=", normalized)
    .executeTakeFirst();
  if (!row) return null;

  const card = mapDbRowToCard(row);
  const content = await readSkillMarkdown(normalized).catch(() => "");
  return { card, content };
}

export async function upsertSkillCard(
  skillName: string,
  patch: Partial<SkillCardRecord> & { isBuiltin?: boolean }
): Promise<SkillCardRecord> {
  const normalized = normalizeSkillName(skillName);
  const prisma = getPrismaOrNull();

  if (prisma) {
    const existingRow = await prisma.skill.findUnique({
      where: { skillName: normalized },
    });
    const existing = existingRow ? mapPrismaSkillToCard(existingRow) : undefined;
    const existingBuiltin = existingRow ? existingRow.isBuiltin : false;
    const nowDate = new Date();
    const nowIso = nowDate.toISOString();

    const next: SkillCardRecord = {
      skillName: normalized,
      description: patch.description ?? existing?.description ?? "自定义 AI Skill",
      creator: patch.creator ?? existing?.creator ?? "Admin",
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
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

    const isBuiltinVal = patch.isBuiltin ?? existingBuiltin;
    const commonData = {
      description: next.description,
      creator: next.creator,
      isBuiltin: isBuiltinVal,
      updatedAt: nowDate,
      currentStep: next.currentStep,
      progress: next.progress,
      status: next.status,
      selectedApps: next.selectedApps as unknown as Prisma.InputJsonValue,
      selectedRepos: next.selectedRepos as unknown as Prisma.InputJsonValue,
      selectedMcps: (next.selectedMcps ?? []) as unknown as Prisma.InputJsonValue,
      pipelineRuns: next.pipelineRuns as unknown as Prisma.InputJsonValue,
      frontmatter: (next.frontmatter ?? {}) as unknown as Prisma.InputJsonValue,
      hasScripts: next.hasScripts ?? false,
      resourceSummary: (next.resourceSummary ?? DEFAULT_RESOURCE_SUMMARY) as unknown as Prisma.InputJsonValue,
    };

    await prisma.skill.upsert({
      where: { skillName: normalized },
      create: {
        skillName: normalized,
        createdAt: new Date(next.createdAt),
        ...commonData,
      },
      update: commonData,
    });

    return next;
  }

  const db = getDb();
  const existingRow = await db
    .selectFrom("skills")
    .select(SKILL_SELECT_COLUMNS)
    .where("skill_name", "=", normalized)
    .executeTakeFirst();
  const existing = existingRow ? mapDbRowToCard(existingRow) : undefined;
  const existingBuiltin = existingRow ? Boolean(existingRow.is_builtin) : false;
  const nowIso = new Date().toISOString();

  const next: SkillCardRecord = {
    skillName: normalized,
    description: patch.description ?? existing?.description ?? "自定义 AI Skill",
    creator: patch.creator ?? existing?.creator ?? "Admin",
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
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

  const isBuiltinVal = toDbBool(patch.isBuiltin ?? existingBuiltin);
  const values = {
    skill_name: next.skillName,
    description: next.description,
    creator: next.creator,
    is_builtin: isBuiltinVal,
    created_at: toDbTimestamp(next.createdAt),
    updated_at: toDbTimestamp(next.updatedAt),
    current_step: next.currentStep,
    progress: next.progress,
    status: next.status,
    selected_apps: JSON.stringify(next.selectedApps),
    selected_repos: JSON.stringify(next.selectedRepos),
    selected_mcps: JSON.stringify(next.selectedMcps ?? []),
    pipeline_runs: JSON.stringify(next.pipelineRuns),
    frontmatter: JSON.stringify(next.frontmatter ?? {}),
    has_scripts: toDbBool(next.hasScripts ?? false),
    resource_summary: JSON.stringify(next.resourceSummary ?? DEFAULT_RESOURCE_SUMMARY),
    skill_md: "",
  };

  const update = {
    description: values.description,
    creator: values.creator,
    is_builtin: values.is_builtin,
    updated_at: values.updated_at,
    current_step: values.current_step,
    progress: values.progress,
    status: values.status,
    selected_apps: values.selected_apps,
    selected_repos: values.selected_repos,
    selected_mcps: values.selected_mcps,
    pipeline_runs: values.pipeline_runs,
    frontmatter: values.frontmatter,
    has_scripts: values.has_scripts,
    resource_summary: values.resource_summary,
  };

  if (isMysqlDriver()) {
    await db
      .insertInto("skills")
      .values(values)
      .onDuplicateKeyUpdate(update)
      .execute();
  } else {
    await db
      .insertInto("skills")
      .values(values)
      .onConflict((oc) => oc.column("skill_name").doUpdateSet(update))
      .execute();
  }

  return next;
}
