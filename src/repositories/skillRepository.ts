import fs from "node:fs/promises";
import path from "node:path";
import {
  INITIAL_APPS,
  INITIAL_REPOS,
  isDbConnected,
  queryDb,
} from "../db/postgres.js";
import type {
  CatalogAppRow,
  CatalogRepoRow,
  RepoPipelineRun,
  SkillCardRecord,
  SkillFileEntry,
  SkillLifecycleStatus,
} from "../types/skill.js";
import {
  listSkillsInDefaultDir,
  normalizeSkillName,
  resolveDefaultSkillsRoot,
} from "./skillStorage.js";

const META_FILE_PATH = path.resolve(process.cwd(), "data", "skills-meta.json");

async function readMetaStore(): Promise<Record<string, SkillCardRecord>> {
  try {
    const raw = await fs.readFile(META_FILE_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, SkillCardRecord>;
  } catch {
    return {};
  }
}

async function writeMetaStore(
  store: Record<string, SkillCardRecord>
): Promise<void> {
  await fs.mkdir(path.dirname(META_FILE_PATH), { recursive: true });
  await fs.writeFile(META_FILE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function extractDescriptionFromMarkdown(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return "自定义 AI Skill";
  const descMatch = fmMatch[1].match(/^description:\s*["']?(.+?)["']?\s*$/m);
  return descMatch ? descMatch[1].trim() : "自定义 AI Skill";
}

function resolveSafeSkillFilePath(skillName: string, relativePath: string): string {
  const normalized = normalizeSkillName(skillName);
  const skillDir = path.resolve(resolveDefaultSkillsRoot("global"), normalized);
  const target = path.resolve(skillDir, relativePath);
  if (target !== skillDir && !target.startsWith(skillDir + path.sep)) {
    throw new Error(`Invalid relative file path: "${relativePath}"`);
  }
  return target;
}

export async function readSkillMarkdown(skillName: string): Promise<string> {
  const normalized = normalizeSkillName(skillName);
  const filePath = path.join(
    resolveDefaultSkillsRoot("global"),
    normalized,
    "SKILL.md"
  );
  return fs.readFile(filePath, "utf-8");
}

export async function writeSkillFile(
  skillName: string,
  relativePath: string,
  content: string
): Promise<string> {
  const normalized = normalizeSkillName(skillName);
  const filePath = resolveSafeSkillFilePath(normalized, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");

  if (isDbConnected()) {
    await queryDb(
      `INSERT INTO skills (skill_name) VALUES ($1) ON CONFLICT (skill_name) DO NOTHING`,
      [normalized]
    );
    await queryDb(
      `INSERT INTO skill_files (skill_name, file_path, content, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (skill_name, file_path)
       DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [normalized, relativePath, content]
    );
  }

  return filePath;
}

export async function listSkillFiles(skillName: string): Promise<SkillFileEntry[]> {
  const normalized = normalizeSkillName(skillName);
  const skillDir = path.resolve(resolveDefaultSkillsRoot("global"), normalized);
  const results: SkillFileEntry[] = [];

  async function walk(currentDir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const content = await fs.readFile(full, "utf-8").catch(() => "");
        results.push({ path: rel, content });
      }
    }
  }

  await walk(skillDir, "");
  results.sort((a, b) => {
    if (a.path === "SKILL.md") return -1;
    if (b.path === "SKILL.md") return 1;
    return a.path.localeCompare(b.path);
  });
  return results;
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
    const dataBuf = Buffer.from(file.content, "utf-8");
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

interface DbSkillRow {
  skill_name: string;
  description: string;
  creator: string;
  created_at: Date | string;
  updated_at: Date | string;
  current_step: number;
  progress: number;
  status: SkillLifecycleStatus;
  selected_apps: string[];
  selected_repos: string[];
  pipeline_runs: RepoPipelineRun[];
}

function mapDbRowToCard(row: DbSkillRow): SkillCardRecord {
  return {
    skillName: row.skill_name,
    description: row.description,
    creator: row.creator,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    currentStep: (row.current_step as 1 | 2 | 3) || 1,
    progress: row.progress ?? 33,
    status: row.status ?? "draft",
    selectedApps: Array.isArray(row.selected_apps) ? row.selected_apps : [],
    selectedRepos: Array.isArray(row.selected_repos) ? row.selected_repos : [],
    pipelineRuns: Array.isArray(row.pipeline_runs) ? row.pipeline_runs : [],
  };
}

export async function listCatalogApps(): Promise<CatalogAppRow[]> {
  if (!isDbConnected()) return INITIAL_APPS;
  const res = await queryDb<CatalogAppRow>(
    `SELECT id, name, env FROM catalog_apps ORDER BY id ASC`
  );
  return res.rows;
}

export async function listCatalogRepos(): Promise<CatalogRepoRow[]> {
  if (!isDbConnected()) return INITIAL_REPOS;
  const res = await queryDb<CatalogRepoRow>(
    `SELECT id, name, url, branch FROM catalog_repos ORDER BY id ASC`
  );
  return res.rows;
}

export async function listSkillCards(): Promise<SkillCardRecord[]> {
  if (isDbConnected()) {
    const res = await queryDb<DbSkillRow>(
      `SELECT skill_name, description, creator, created_at, updated_at,
              current_step, progress, status, selected_apps, selected_repos, pipeline_runs
       FROM skills
       ORDER BY updated_at DESC`
    );
    return res.rows.map(mapDbRowToCard);
  }

  const store = await readMetaStore();
  const diskSkills = await listSkillsInDefaultDir("global");
  let changed = false;

  for (const disk of diskSkills) {
    if (!store[disk.skillName]) {
      const content = await fs.readFile(disk.filePath, "utf-8").catch(() => "");
      const now = new Date().toISOString();
      store[disk.skillName] = {
        skillName: disk.skillName,
        description: extractDescriptionFromMarkdown(content),
        creator: "System",
        createdAt: now,
        updatedAt: now,
        currentStep: 1,
        progress: 33,
        status: "draft",
        selectedApps: [],
        selectedRepos: [],
        pipelineRuns: [],
      };
      changed = true;
    }
  }

  if (changed) {
    await writeMetaStore(store);
  }

  return Object.values(store).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getSkillCard(
  skillName: string
): Promise<{ card: SkillCardRecord; content: string } | null> {
  const normalized = normalizeSkillName(skillName);
  if (isDbConnected()) {
    const res = await queryDb<DbSkillRow>(
      `SELECT skill_name, description, creator, created_at, updated_at,
              current_step, progress, status, selected_apps, selected_repos, pipeline_runs
       FROM skills WHERE skill_name = $1`,
      [normalized]
    );
    if (res.rows.length === 0) return null;
    const card = mapDbRowToCard(res.rows[0]);
    const content = await readSkillMarkdown(normalized).catch(async () => {
      const fileRes = await queryDb<{ content: string }>(
        `SELECT content FROM skill_files WHERE skill_name = $1 AND file_path = 'SKILL.md'`,
        [normalized]
      );
      return fileRes.rows[0]?.content ?? "";
    });
    return { card, content };
  }

  const cards = await listSkillCards();
  const card = cards.find((c) => c.skillName === normalized);
  if (!card) return null;

  const content = await readSkillMarkdown(normalized).catch(() => "");
  return { card, content };
}

export async function upsertSkillCard(
  skillName: string,
  patch: Partial<SkillCardRecord>
): Promise<SkillCardRecord> {
  const normalized = normalizeSkillName(skillName);

  if (isDbConnected()) {
    const existingRes = await queryDb<DbSkillRow>(
      `SELECT skill_name, description, creator, created_at, updated_at,
              current_step, progress, status, selected_apps, selected_repos, pipeline_runs
       FROM skills WHERE skill_name = $1`,
      [normalized]
    );
    const existing = existingRes.rows[0]
      ? mapDbRowToCard(existingRes.rows[0])
      : undefined;
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
      pipelineRuns: patch.pipelineRuns ?? existing?.pipelineRuns ?? [],
    };

    await queryDb(
      `INSERT INTO skills (
         skill_name, description, creator, created_at, updated_at,
         current_step, progress, status, selected_apps, selected_repos, pipeline_runs
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
       ON CONFLICT (skill_name)
       DO UPDATE SET
         description = EXCLUDED.description,
         creator = EXCLUDED.creator,
         updated_at = EXCLUDED.updated_at,
         current_step = EXCLUDED.current_step,
         progress = EXCLUDED.progress,
         status = EXCLUDED.status,
         selected_apps = EXCLUDED.selected_apps,
         selected_repos = EXCLUDED.selected_repos,
         pipeline_runs = EXCLUDED.pipeline_runs`,
      [
        next.skillName,
        next.description,
        next.creator,
        next.createdAt,
        next.updatedAt,
        next.currentStep,
        next.progress,
        next.status,
        JSON.stringify(next.selectedApps),
        JSON.stringify(next.selectedRepos),
        JSON.stringify(next.pipelineRuns),
      ]
    );

    return next;
  }

  const store = await readMetaStore();
  const now = new Date().toISOString();
  const existing = store[normalized];

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
    pipelineRuns: patch.pipelineRuns ?? existing?.pipelineRuns ?? [],
  };

  store[normalized] = next;
  await writeMetaStore(store);
  return next;
}
