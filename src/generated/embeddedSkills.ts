import type { SkillFileEntry } from "../types/skill.js";

export interface EmbeddedSkillPackage {
  skillName: string;
  source: "builtin" | "database";
  description: string;
  files: SkillFileEntry[];
}

// Populated automatically by scripts/build-binaries.ts during binary compilation.
export const EMBEDDED_SKILLS: readonly EmbeddedSkillPackage[] = [];
