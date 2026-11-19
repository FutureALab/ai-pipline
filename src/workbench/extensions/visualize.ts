import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type {
  WorkbenchExtensionRuntimeContext,
  WorkbenchServerExtension,
} from "./types.js";

const MERMAID_HEADER_RE =
  /^\s*(?:%%\{[\s\S]*?\}%%\s*)*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|mindmap|timeline|sankey-beta|xychart-beta|block-beta)\b/;

const MAX_PREVIEW_BYTES = 120_000;

function validateMermaidBasic(source: string): void {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("`mermaid` source is empty. Provide valid Mermaid diagram code.");
  }
  const withoutComments = trimmed
    .split("\n")
    .filter((line) => !line.trim().startsWith("%%"))
    .join("\n")
    .trim();
  if (!MERMAID_HEADER_RE.test(withoutComments)) {
    throw new Error(
      "Mermaid diagram must start with a valid diagram declaration (e.g. `flowchart TD`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `gantt`, `mindmap`)."
    );
  }
}

async function readWorkspacePreviewFile(
  cwd: string,
  relPath: string
): Promise<{ path: string; content: string; truncated: boolean; ext: string }> {
  const cleanRel = relPath.trim();
  if (!cleanRel) {
    throw new Error("File `path` is required for `type: \"file\"`.");
  }
  const absRoot = path.resolve(cwd);
  const absTarget = path.resolve(absRoot, cleanRel);
  if (
    absTarget !== absRoot &&
    !absTarget.startsWith(absRoot + path.sep)
  ) {
    throw new Error(`File path escapes workspace root: ${cleanRel}`);
  }

  const stat = await fs.stat(absTarget).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`Workspace file not found: ${cleanRel}`);
  }

  const buf = await fs.readFile(absTarget);
  const truncated = buf.byteLength > MAX_PREVIEW_BYTES;
  const content = (
    truncated ? buf.subarray(0, MAX_PREVIEW_BYTES) : buf
  ).toString("utf-8");

  return {
    path: path.relative(absRoot, absTarget),
    content,
    truncated,
    ext: path.extname(absTarget).toLowerCase().replace(/^\./, ""),
  };
}

export const visualizeExtension: WorkbenchServerExtension = {
  descriptor: {
    id: "visualize",
    title: "可视化展示 (visualize)",
    description:
      "在对话中直接渲染 Mermaid 架构/流程图、多方案优缺点对比卡片，以及工作区 HTML/文件预览。",
    toolNames: ["visualize"],
    defaultEnabled: true,
    prominence: "primary",
  },
  promptGuideline:
    "When explaining architecture, pipeline flows, state transitions, or comparing multiple design options, prefer calling `visualize` (`diagram` with Mermaid, `comparison` with structured pros/cons, or `file` for HTML mockups/files) instead of ASCII art.",
  createTools(
    ctx: WorkbenchExtensionRuntimeContext,
    pi: ExtensionAPI
  ): ToolDefinition<any, any>[] {
    const { Type } = pi.typebox;
    const paramsSchema = Type.Object({
      type: Type.Union([
        Type.Literal("diagram"),
        Type.Literal("comparison"),
        Type.Literal("file"),
      ]),
      title: Type.Optional(Type.String({ description: "Card title" })),
      mermaid: Type.Optional(
        Type.String({
          description: "Mermaid diagram source (required when type is 'diagram')",
        })
      ),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            description: Type.String(),
            pros: Type.Optional(Type.Array(Type.String())),
            cons: Type.Optional(Type.Array(Type.String())),
            recommended: Type.Optional(Type.Boolean()),
            mermaid: Type.Optional(Type.String()),
          }),
          {
            description: "Options to compare (required when type is 'comparison')",
          }
        )
      ),
      path: Type.Optional(
        Type.String({
          description: "Workspace-relative file path (required when type is 'file')",
        })
      ),
      before: Type.Optional(
        Type.String({
          description: "Optional workspace-relative 'before' file path for comparison",
        })
      ),
    });

    return [
      {
        name: "visualize",
        label: "Visualize",
        description:
          "Render a rich visual card in the workbench chat: a Mermaid diagram (`diagram`), a structured multi-option trade-off comparison (`comparison`), or an inline workspace file/HTML preview (`file`, optionally with `before`).",
        parameters: paramsSchema,
        loadMode: "essential",
        approval: "read",
        async execute(_toolCallId, params) {
          const kind = params?.type;
          const title =
            typeof params?.title === "string" && params.title.trim()
              ? params.title.trim()
              : undefined;

          if (kind === "diagram") {
            const mermaid = String(params?.mermaid ?? "").trim();
            validateMermaidBasic(mermaid);
            const md = `${title ? `### ${title}\n\n` : ""}\`\`\`mermaid\n${mermaid}\n\`\`\``;
            return {
              content: [{ type: "text", text: md }],
              details: {
                type: "diagram",
                title: title || "架构 / 流程图",
                mermaid,
              },
            };
          }

          if (kind === "comparison") {
            const options = Array.isArray(params?.options) ? params.options : [];
            if (options.length === 0) {
              throw new Error(
                "`options` must contain at least one option when `type` is 'comparison'."
              );
            }
            const normalized = options.map((opt: any) => {
              if (typeof opt.mermaid === "string" && opt.mermaid.trim()) {
                validateMermaidBasic(opt.mermaid);
              }
              return {
                name: String(opt.name || "方案").trim(),
                description: String(opt.description || "").trim(),
                pros: Array.isArray(opt.pros)
                  ? opt.pros.map((p: unknown) => String(p))
                  : [],
                cons: Array.isArray(opt.cons)
                  ? opt.cons.map((c: unknown) => String(c))
                  : [],
                recommended: Boolean(opt.recommended),
                ...(typeof opt.mermaid === "string" && opt.mermaid.trim()
                  ? { mermaid: opt.mermaid.trim() }
                  : {}),
              };
            });

            const lines: string[] = [title ? `### ${title}` : "### 方案对比"];
            for (const opt of normalized) {
              lines.push(
                `\n#### ${opt.name}${opt.recommended ? " (Recommended)" : ""}`
              );
              lines.push(opt.description);
              if (opt.pros.length > 0) {
                lines.push("优点：" + opt.pros.join("；"));
              }
              if (opt.cons.length > 0) {
                lines.push("缺点：" + opt.cons.join("；"));
              }
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {
                type: "comparison",
                title: title || "方案对比",
                options: normalized,
              },
            };
          }

          if (kind === "file") {
            const target = await readWorkspacePreviewFile(
              ctx.cwd,
              String(params?.path ?? "")
            );
            const before =
              typeof params?.before === "string" && params.before.trim()
                ? await readWorkspacePreviewFile(ctx.cwd, params.before)
                : undefined;

            return {
              content: [
                {
                  type: "text",
                  text: `Rendered preview for \`${target.path}\`${before ? ` (compared with \`${before.path}\`)` : ""}.`,
                },
              ],
              details: {
                type: "file",
                title: title || target.path,
                file: target,
                ...(before ? { before } : {}),
              },
            };
          }

          throw new Error(`Unsupported visualize type: ${String(kind)}`);
        },
      },
    ];
  },
};
