import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { createLogger } from "../config/logger.js";
import {
  EMBEDDED_SKILLS,
  type EmbeddedSkillPackage,
} from "../generated/embeddedSkills.js";
import {
  extractDescriptionFromMarkdown,
  normalizeSkillName,
  resolveAllGlobalSkillRoots,
  resolveDefaultSkillsRoot,
  saveSkillFilesToDir,
} from "./skillStorage.js";

const log = createLogger("embedded-skills");

let cachedMaterializeRoot: string | null = null;

export function getEmbeddedSkills(): readonly EmbeddedSkillPackage[] {
  return EMBEDDED_SKILLS;
}

export function findEmbeddedSkill(
  skillName: string
): EmbeddedSkillPackage | undefined {
  const normalized = normalizeSkillName(skillName);
  return EMBEDDED_SKILLS.find((s) => s.skillName === normalized);
}

/**
 * Materialize all embedded skills (built-in + optional DB-bundled skills) onto disk
 * so pi-agent `discoverSkills()` and any bundled `scripts/*` execute identically
 * on Jenkins / CI / standalone binary hosts.
 *
 * Returns the materialized Skill[] descriptors (pointing to the extracted directories).
 */
export async function materializeEmbeddedSkills(options?: {
  onlySkillName?: string;
  forceOverwrite?: boolean;
}): Promise<{ rootDir: string; skills: Skill[] }> {
  const targets = options?.onlySkillName
    ? EMBEDDED_SKILLS.filter(
        (s) => s.skillName === normalizeSkillName(options.onlySkillName!)
      )
    : [...EMBEDDED_SKILLS];

  if (targets.length === 0) {
    return {
      rootDir: resolveDefaultSkillsRoot("global"),
      skills: [],
    };
  }

  const candidateRoots = resolveAllGlobalSkillRoots();
  let primaryRoot = resolveDefaultSkillsRoot("global");
  let wroteToGlobal = false;

  for (const root of candidateRoots) {
    try {
      await fs.mkdir(root, { recursive: true });
      for (const pkg of targets) {
        const destDir = path.join(root, pkg.skillName);
        if (!options?.forceOverwrite) {
          const exists = await fs
            .stat(path.join(destDir, "SKILL.md"))
            .then((st) => st.isFile())
            .catch(() => false);
          if (exists && pkg.source === "builtin") {
            continue;
          }
        }
        await saveSkillFilesToDir(destDir, pkg.files);
      }
      wroteToGlobal = true;
    } catch (err) {
      log.warn(
        { root, err },
        "Failed to materialize embedded skills to global agent dir"
      );
    }
  }

  // Fallback to OS temp dir if global HOME dir is read-only (e.g. restricted Jenkins agent)
  if (!wroteToGlobal) {
    primaryRoot =
      cachedMaterializeRoot ||
      path.join(os.tmpdir(), "ai-pipeline-embedded-skills");
    cachedMaterializeRoot = primaryRoot;
    await fs.mkdir(primaryRoot, { recursive: true });
    for (const pkg of targets) {
      await saveSkillFilesToDir(path.join(primaryRoot, pkg.skillName), pkg.files);
    }
  }

  const skills: Skill[] = targets.map((pkg) => {
    const baseDir = path.join(primaryRoot, pkg.skillName);
    const skillMd = pkg.files.find((f) => f.path === "SKILL.md")?.content || "";
    return {
      name: pkg.skillName,
      description:
        pkg.description ||
        extractDescriptionFromMarkdown(skillMd, pkg.skillName),
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
      source: `embedded:${pkg.source}`,
    };
  });

  log.info(
    {
      count: targets.length,
      rootDir: primaryRoot,
      skills: targets.map((t) => `${t.skillName}(${t.source})`),
    },
    "Materialized embedded skills from binary"
  );

  return { rootDir: primaryRoot, skills };
}
