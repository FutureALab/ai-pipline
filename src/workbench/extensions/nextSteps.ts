import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { WorkbenchNextStep } from "../types.js";
import type {
  WorkbenchExtensionRuntimeContext,
  WorkbenchServerExtension,
} from "./types.js";

export const nextStepsExtension: WorkbenchServerExtension = {
  descriptor: {
    id: "next-steps",
    title: "下一步建议 (suggest_next_steps)",
    description:
      "在回复末尾生成 2~4 个可一键发送的后续快捷建议（如运行测试、沉淀为 Skill）。",
    toolNames: ["suggest_next_steps"],
    defaultEnabled: true,
    prominence: "routine",
  },
  promptGuideline:
    "When finishing a turn where clear follow-up actions exist (e.g., running tests, refining a file, or distilling the solution into a Skill), you may call `suggest_next_steps` with 2-4 concise, actionable suggestions as your final step.",
  createTools(
    ctx: WorkbenchExtensionRuntimeContext,
    pi: ExtensionAPI
  ): ToolDefinition<any, any>[] {
    const { Type } = pi.typebox;
    const paramsSchema = Type.Object({
      suggestions: Type.Array(
        Type.Object({
          label: Type.String({
            description: "Short button label shown above the input (<= 24 chars)",
          }),
          prompt: Type.Optional(
            Type.String({
              description:
                "Full message sent when clicked; defaults to `label` if omitted",
            })
          ),
        }),
        {
          minItems: 1,
          maxItems: 5,
          description: "List of plausible next messages the user might send",
        }
      ),
    });

    return [
      {
        name: "suggest_next_steps",
        label: "Suggest Next Steps",
        description:
          "Offer 2-4 one-click follow-up suggestions above the user's input box at the end of a turn. Do not call this mid-task.",
        parameters: paramsSchema,
        loadMode: "essential",
        approval: "read",
        async execute(_toolCallId, params) {
          const raw = Array.isArray(params?.suggestions)
            ? params.suggestions
            : [];
          const normalized: WorkbenchNextStep[] = [];
          const seen = new Set<string>();

          for (const item of raw) {
            const label =
              typeof item === "string"
                ? item.trim()
                : String(item?.label ?? "").trim();
            if (!label) continue;
            const prompt =
              typeof item === "string"
                ? label
                : String(item?.prompt ?? "").trim() || label;
            const key = prompt.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            normalized.push({
              label: label.slice(0, 48),
              prompt: prompt.slice(0, 400),
            });
            if (normalized.length >= 5) break;
          }

          ctx.setNextSteps(normalized);
          ctx.onStateChange();

          const summary =
            normalized.length > 0
              ? `Suggested ${normalized.length} next steps:\n` +
                normalized.map((s, i) => `${i + 1}. ${s.label}`).join("\n")
              : "No valid next-step suggestions provided.";

          return {
            content: [{ type: "text", text: summary }],
            details: {
              suggestions: normalized,
            },
          };
        },
      },
    ];
  },
};
