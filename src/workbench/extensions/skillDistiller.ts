import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
  listSkillFiles,
  replaceSkillFiles,
  upsertSkillCard,
} from "../../repositories/skillRepository.js";
import {
  buildResourceSummary,
  enrichSkillFileEntry,
  extractDescriptionFromMarkdown,
  normalizeRelativeSkillPath,
  normalizeSkillName,
  parseSkillFrontmatter,
  saveSkillFilesToDefaultDir,
} from "../../repositories/skillStorage.js";
import type { SkillFileEntry } from "../../types/skill.js";
import type {
  WorkbenchExtensionRuntimeContext,
  WorkbenchServerExtension,
} from "./types.js";

function ensureSkillFrontmatter(
  skillName: string,
  description: string,
  rawMarkdown: string
): string {
  const trimmed = rawMarkdown.trim();
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(trimmed)) {
    return trimmed + "\n";
  }
  const safeDesc = description.replace(/\r?\n/g, " ").trim();
  return `---\nname: ${skillName}\ndescription: ${safeDesc}\n---\n\n${trimmed}\n`;
}

export const skillDistillerExtension: WorkbenchServerExtension = {
  descriptor: {
    id: "skill-distiller",
    title: "直接沉淀 Skill (save_skill)",
    description:
      "在创造模式中由 AI 直接生成并保存完整的 Skill 包（含 SKILL.md、scripts/references/assets）到系统目录与数据库，无需跳转。",
    toolNames: ["save_skill"],
    defaultEnabled: true,
    prominence: "primary",
  },
  promptGuideline:
    "When the user asks to distill, save, or create a Skill from the current conversation or repository exploration, call `save_skill` directly with a clean kebab-case `skillName`, concise `description`, complete `skillMd` (with YAML frontmatter `name` & `description`), and any reusable `files` (`scripts/*`, `references/*`, `assets/*`).",
  createTools(
    ctx: WorkbenchExtensionRuntimeContext,
    pi: ExtensionAPI
  ): ToolDefinition<any, any>[] {
    const { Type } = pi.typebox;
    const paramsSchema = Type.Object({
      skillName: Type.String({
        description:
          "Kebab-case skill name (e.g. 'jenkins-build-analyzer', 'api-smoke-tester')",
      }),
      description: Type.String({
        description:
          "Concise description of what the skill does and when to trigger it",
      }),
      skillMd: Type.String({
        description:
          "Complete SKILL.md markdown content, including YAML frontmatter (`name`, `description`) and clear step-by-step instructions",
      }),
      files: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({
              description:
                "Relative path inside the skill directory (e.g. 'scripts/run.sh', 'references/guide.md')",
            }),
            content: Type.String({ description: "UTF-8 file content" }),
          }),
          {
            description:
              "Optional supporting files (scripts, references, assets) bundled alongside SKILL.md",
          }
        )
      ),
    });

    return [
      {
        name: "save_skill",
        label: "Save Skill",
        description:
          "Create or update a complete Skill package (SKILL.md + optional scripts/references/assets) directly in the platform's skill library and database.",
        parameters: paramsSchema,
        loadMode: "essential",
        approval: "write",
        async execute(_toolCallId, params) {
          const rawName = String(params?.skillName ?? "").trim();
          if (!rawName) {
            throw new Error("`skillName` is required.");
          }
          const skillName = normalizeSkillName(rawName);
          const rawSkillMd = String(params?.skillMd ?? "").trim();
          if (!rawSkillMd) {
            throw new Error("`skillMd` content is required.");
          }

          const description =
            String(params?.description ?? "").trim() ||
            extractDescriptionFromMarkdown(rawSkillMd, skillName);
          const finalSkillMd = ensureSkillFrontmatter(
            skillName,
            description,
            rawSkillMd
          );

          const entryMap = new Map<string, SkillFileEntry>();
          entryMap.set(
            "SKILL.md",
            enrichSkillFileEntry({
              path: "SKILL.md",
              content: finalSkillMd,
              encoding: "utf-8",
            })
          );

          const rawFiles = Array.isArray(params?.files) ? params.files : [];
          for (const f of rawFiles) {
            const rel = normalizeRelativeSkillPath(String(f?.path ?? ""));
            if (!rel || rel === "SKILL.md") continue;
            entryMap.set(
              rel,
              enrichSkillFileEntry({
                path: rel,
                content: String(f?.content ?? ""),
                encoding: "utf-8",
              })
            );
          }

          const entries = [...entryMap.values()];
          const saved = await saveSkillFilesToDefaultDir({
            skillName,
            files: entries,
            scope: "global",
          });

          await replaceSkillFiles(skillName, entries);

          const frontmatter = parseSkillFrontmatter(finalSkillMd);
          const { hasScripts, summary: resourceSummary } =
            buildResourceSummary(entries);

          const card = await upsertSkillCard(skillName, {
            description,
            creator: ctx.owner,
            selectedMcps: ctx.selectedMcps,
            currentStep: 1,
            progress: 33,
            status: "draft",
            frontmatter,
            hasScripts,
            resourceSummary,
          });

          const persistedFiles = await listSkillFiles(skillName).catch(
            () => entries
          );

          ctx.onSkillSaved({
            name: skillName,
            description,
            source: "workbench",
          });
          ctx.onStateChange();

          const fileList = persistedFiles.map((f) => f.path);
          return {
            content: [
              {
                type: "text",
                text: `Skill \`${skillName}\` 已直接生成并保存成功！\n- 保存路径：\`${saved.filePath}\`\n- 包含文件（${fileList.length} 个）：${fileList.map((p) => `\`${p}\``).join(", ")}`,
              },
            ],
            details: {
              skillName,
              description,
              filePath: saved.filePath,
              files: fileList,
              hasScripts,
              resourceSummary,
              card,
            },
          };
        },
      },
    ];
  },
};
