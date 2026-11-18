import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SavedSkillInfo, SkillScope } from "../types/skill.js";

export interface SkillSaveOptions {
  skillName: string;
  content: string;
  scope?: SkillScope;
  cwd?: string;
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
