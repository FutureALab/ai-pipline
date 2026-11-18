import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SavedSkillInfo,
  SkillFileCategory,
  SkillFileEncoding,
  SkillFileEntry,
  SkillResourceSummary,
  SkillScope,
} from "../types/skill.js";

export interface SkillSaveOptions {
  skillName: string;
  content: string;
  scope?: SkillScope;
  cwd?: string;
}

export interface SkillFilesSaveOptions {
  skillName: string;
  files: SkillFileEntry[];
  scope?: SkillScope;
  cwd?: string;
}

const IGNORED_DIR_NAMES = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".pytest_cache",
]);

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bin",
  ".exe",
  ".node",
  ".so",
  ".dylib",
  ".pyc",
]);

const EXECUTABLE_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".py", ".rb", ".pl"]);

const MIME_TYPE_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".py": "text/x-python",
  ".ts": "text/typescript",
  ".mts": "text/typescript",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".zip": "application/zip",
};

export function normalizeRelativeSkillPath(relativePath: string): string {
  const cleaned = relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim();
  if (!cleaned || cleaned.split("/").some((seg) => seg === "..")) {
    throw new Error(`Invalid relative skill file path: "${relativePath}"`);
  }
  return cleaned;
}

export function classifySkillFileCategory(relativePath: string): SkillFileCategory {
  const norm = normalizeRelativeSkillPath(relativePath);
  if (norm === "SKILL.md") return "skill_md";
  if (norm.startsWith("scripts/")) return "script";
  if (norm.startsWith("references/") || norm.startsWith("reference/")) return "reference";
  if (norm.startsWith("assets/")) return "asset";
  if (norm.startsWith("agents/")) return "agent";
  if (norm.startsWith("eval-viewer/") || norm.startsWith("evals/")) return "eval";
  return "other";
}

export function isBinarySkillBuffer(relativePath: string, buf: Buffer): boolean {
  const ext = path.posix.extname(relativePath.toLowerCase());
  if (BINARY_EXTENSIONS.has(ext)) return true;
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function resolveSkillMimeType(relativePath: string, isBinary = false): string {
  const ext = path.posix.extname(relativePath.toLowerCase());
  if (MIME_TYPE_MAP[ext]) return MIME_TYPE_MAP[ext];
  return isBinary ? "application/octet-stream" : "text/plain";
}

export function isExecutableSkillFile(
  relativePath: string,
  category: SkillFileCategory
): boolean {
  if (category === "script") return true;
  const ext = path.posix.extname(relativePath.toLowerCase());
  return EXECUTABLE_EXTENSIONS.has(ext);
}

export function enrichSkillFileEntry(
  entry: SkillFileEntry,
  rawBuffer?: Buffer
): Required<SkillFileEntry> {
  const relPath = normalizeRelativeSkillPath(entry.path);
  const category = entry.category ?? classifySkillFileCategory(relPath);
  const encoding: SkillFileEncoding =
    entry.encoding ??
    (rawBuffer && isBinarySkillBuffer(relPath, rawBuffer) ? "base64" : "utf-8");
  const isBinary = encoding === "base64";
  const mimeType = entry.mimeType ?? resolveSkillMimeType(relPath, isBinary);
  const sizeBytes =
    entry.sizeBytes ??
    (rawBuffer ? rawBuffer.length : Buffer.byteLength(entry.content, encoding));
  const isExecutable =
    entry.isExecutable ?? isExecutableSkillFile(relPath, category);

  return {
    path: relPath,
    content: entry.content,
    category,
    mimeType,
    encoding,
    sizeBytes,
    isExecutable,
  };
}

export function bufferToSkillFileEntry(
  relativePath: string,
  rawBuffer: Buffer
): Required<SkillFileEntry> {
  const relPath = normalizeRelativeSkillPath(relativePath);
  const binary = isBinarySkillBuffer(relPath, rawBuffer);
  const encoding: SkillFileEncoding = binary ? "base64" : "utf-8";
  const content = rawBuffer.toString(encoding);
  return enrichSkillFileEntry({ path: relPath, content, encoding }, rawBuffer);
}

/**
 * Parse YAML frontmatter from SKILL.md into a plain JSON-serializable object.
 */
export function parseSkillFrontmatter(markdown: string): Record<string, unknown> {
  const fmMatch = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};

  const result: Record<string, unknown> = {};
  const lines = fmMatch[1].split(/\r?\n/);
  let currentNestedKey: string | null = null;
  let currentListKey: string | null = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    const listMatch = rawLine.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentListKey) {
      const arr = Array.isArray(result[currentListKey])
        ? (result[currentListKey] as unknown[])
        : [];
      arr.push(stripYamlQuotes(listMatch[1].trim()));
      result[currentListKey] = arr;
      continue;
    }

    const nestedMatch = rawLine.match(/^\s{2,}([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (nestedMatch && currentNestedKey) {
      const parent =
        typeof result[currentNestedKey] === "object" &&
        result[currentNestedKey] !== null &&
        !Array.isArray(result[currentNestedKey])
          ? (result[currentNestedKey] as Record<string, unknown>)
          : {};
      parent[nestedMatch[1]] = stripYamlQuotes(nestedMatch[2].trim());
      result[currentNestedKey] = parent;
      continue;
    }

    const topMatch = rawLine.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!topMatch) continue;

    const key = topMatch[1];
    const val = topMatch[2].trim();
    currentNestedKey = null;
    currentListKey = null;

    if (!val) {
      currentNestedKey = key;
      currentListKey = key;
      result[key] = {};
    } else if (val.startsWith("[") && val.endsWith("]")) {
      result[key] = val
        .slice(1, -1)
        .split(",")
        .map((item) => stripYamlQuotes(item.trim()))
        .filter(Boolean);
    } else {
      result[key] = stripYamlQuotes(val);
    }
  }

  return result;
}

function stripYamlQuotes(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

export function extractDescriptionFromMarkdown(
  content: string,
  fallback = "Built-in AI Skill"
): string {
  const fm = parseSkillFrontmatter(content);
  if (typeof fm.description === "string" && fm.description.trim()) {
    return fm.description.trim();
  }
  return fallback;
}

export function buildResourceSummary(files: SkillFileEntry[]): {
  summary: SkillResourceSummary;
  hasScripts: boolean;
} {
  const summary: SkillResourceSummary = {
    totalFiles: files.length,
    scripts: 0,
    references: 0,
    assets: 0,
    agents: 0,
    other: 0,
  };

  for (const file of files) {
    const category = file.category ?? classifySkillFileCategory(file.path);
    switch (category) {
      case "script":
        summary.scripts += 1;
        break;
      case "reference":
        summary.references += 1;
        break;
      case "asset":
        summary.assets += 1;
        break;
      case "agent":
        summary.agents += 1;
        break;
      case "skill_md":
        break;
      default:
        summary.other += 1;
        break;
    }
  }

  return {
    summary,
    hasScripts: summary.scripts > 0,
  };
}

/**
 * Recursively read all files in a skill directory with category/mime/encoding metadata.
 */
export async function readSkillDirectoryFiles(
  skillDir: string
): Promise<Required<SkillFileEntry>[]> {
  const results: Required<SkillFileEntry>[] = [];

  async function walk(currentDir: string, prefix: string): Promise<void> {
    const entries = await fs
      .readdir(currentDir, { withFileTypes: true })
      .catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        await walk(path.join(currentDir, entry.name), rel);
      } else if (entry.isFile()) {
        if (IGNORED_FILE_NAMES.has(entry.name) || entry.name.endsWith(".pyc")) {
          continue;
        }
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(currentDir, entry.name);
        const buf = await fs.readFile(full).catch(() => null);
        if (!buf) continue;
        results.push(bufferToSkillFileEntry(rel, buf));
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

/**
 * Normalize a skill name into a safe kebab-case directory name.
 */
export function normalizeSkillName(rawName: string): string {
  const normalized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error(`Invalid skill name: "${rawName}"`);
  }
  return normalized;
}

/**
 * Resolve OMP's default skills directory.
 * - global: $OMP_AGENT_DIR/skills or ~/.omp/agent/skills
 * - project: <cwd>/.omp/skills
 */
export function resolveDefaultSkillsRoot(
  scope: SkillScope = "global",
  cwd: string = process.cwd()
): string {
  if (scope === "project") {
    return path.resolve(cwd, ".omp", "skills");
  }
  const agentDir =
    process.env.OMP_AGENT_DIR?.trim() || path.join(os.homedir(), ".omp", "agent");
  return path.join(agentDir, "skills");
}

/**
 * Resolve Pi agent skills directory (~/.pi/agent/skills or $PI_CODING_AGENT_DIR/skills).
 */
export function resolvePiSkillsRoot(): string {
  const piDir =
    process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(piDir, "skills");
}

/**
 * Return all global agent skill roots to keep synchronized.
 * When OMP_AGENT_DIR is explicitly overridden (e.g. in tests), only sync to that root
 * unless PI_CODING_AGENT_DIR is also explicitly set.
 */
export function resolveAllGlobalSkillRoots(): string[] {
  const ompRoot = path.resolve(resolveDefaultSkillsRoot("global"));
  const roots = [ompRoot];

  const hasCustomOmp = Boolean(process.env.OMP_AGENT_DIR?.trim());
  const hasCustomPi = Boolean(process.env.PI_CODING_AGENT_DIR?.trim());
  if (!hasCustomOmp || hasCustomPi) {
    const piRoot = path.resolve(resolvePiSkillsRoot());
    if (!roots.includes(piRoot)) {
      roots.push(piRoot);
    }
  }

  return roots;
}

/**
 * Write a complete list of skill files into a specific skill directory.
 */
export async function saveSkillFilesToDir(
  skillDir: string,
  files: SkillFileEntry[]
): Promise<void> {
  const resolvedSkillDir = path.resolve(skillDir);
  await fs.mkdir(resolvedSkillDir, { recursive: true });

  for (const file of files) {
    const relPath = normalizeRelativeSkillPath(file.path);
    const target = path.resolve(resolvedSkillDir, relPath);
    if (
      target !== resolvedSkillDir &&
      !target.startsWith(resolvedSkillDir + path.sep)
    ) {
      throw new Error(`Invalid relative file path: "${file.path}"`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const encoding = file.encoding === "base64" ? "base64" : "utf-8";
    const buf = Buffer.from(file.content, encoding);
    await fs.writeFile(target, buf);
    if (file.isExecutable) {
      await fs.chmod(target, 0o755).catch(() => {});
    }
  }
}

/**
 * Save a generated SKILL.md directly into OMP's default skills directory.
 */
export async function saveSkillToDefaultDir(
  options: SkillSaveOptions
): Promise<SavedSkillInfo> {
  const scope = options.scope ?? "global";
  const skillName = normalizeSkillName(options.skillName);
  const skillsRoot = resolveDefaultSkillsRoot(scope, options.cwd);
  const skillDir = path.join(skillsRoot, skillName);
  const filePath = path.join(skillDir, "SKILL.md");

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(filePath, options.content, "utf-8");

  return {
    skillName,
    skillDir,
    filePath,
    scope,
  };
}

/**
 * Save a complete skill package (SKILL.md plus scripts, references, assets, etc.)
 * into OMP's default skills directory.
 */
export async function saveSkillFilesToDefaultDir(
  options: SkillFilesSaveOptions
): Promise<SavedSkillInfo> {
  const scope = options.scope ?? "global";
  const skillName = normalizeSkillName(options.skillName);
  const skillsRoot = resolveDefaultSkillsRoot(scope, options.cwd);
  const skillDir = path.resolve(skillsRoot, skillName);

  await saveSkillFilesToDir(skillDir, options.files);

  if (scope === "global") {
    for (const root of resolveAllGlobalSkillRoots()) {
      const targetDir = path.resolve(root, skillName);
      if (targetDir !== skillDir) {
        await saveSkillFilesToDir(targetDir, options.files);
      }
    }
  }

  return {
    skillName,
    skillDir,
    filePath: path.join(skillDir, "SKILL.md"),
    scope,
  };
}

/**
 * Check whether a skill exists in the default directory.
 */
export async function findSkillInDefaultDir(
  skillName: string,
  scope: SkillScope = "global",
  cwd: string = process.cwd()
): Promise<SavedSkillInfo | null> {
  const normalized = normalizeSkillName(skillName);
  const skillsRoot = resolveDefaultSkillsRoot(scope, cwd);
  const skillDir = path.join(skillsRoot, normalized);
  const filePath = path.join(skillDir, "SKILL.md");

  try {
    await fs.access(filePath);
    return {
      skillName: normalized,
      skillDir,
      filePath,
      scope,
    };
  } catch {
    return null;
  }
}

/**
 * List all skills currently stored in the default skills directory.
 */
export async function listSkillsInDefaultDir(
  scope: SkillScope = "global",
  cwd: string = process.cwd()
): Promise<SavedSkillInfo[]> {
  const skillsRoot = resolveDefaultSkillsRoot(scope, cwd);
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    const results: SavedSkillInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsRoot, entry.name);
      const filePath = path.join(skillDir, "SKILL.md");
      try {
        await fs.access(filePath);
        results.push({
          skillName: entry.name,
          skillDir,
          filePath,
          scope,
        });
      } catch {
        // Ignore directories without SKILL.md
      }
    }
    return results;
  } catch {
    return [];
  }
}
