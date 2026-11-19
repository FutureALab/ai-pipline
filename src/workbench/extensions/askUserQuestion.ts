import crypto from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type {
  PendingUserQuestion,
  UserQuestionItem,
  UserQuestionSubmission,
} from "../types.js";
import type {
  WorkbenchExtensionRuntimeContext,
  WorkbenchServerExtension,
} from "./types.js";

function formatSubmissionForModel(
  questions: UserQuestionItem[],
  submission: UserQuestionSubmission
): string {
  if (submission.chatInstead) {
    return "The user chose to reply directly in chat instead of using the questionnaire. End this turn and wait for their message.";
  }
  if (submission.cancelled) {
    return "The user skipped the questionnaire without answering. Proceed carefully with your best judgment and state any assumptions clearly.";
  }

  const answerMap = new Map(
    submission.answers.map((item) => [item.questionId, item])
  );
  const lines: string[] = ["User answered the questionnaire:"];

  for (const q of questions) {
    const ans = answerMap.get(q.id);
    if (!ans) {
      lines.push(`- **${q.header}**: (unanswered)`);
      continue;
    }
    if (ans.discussFirst) {
      const note = ans.discussNote?.trim();
      lines.push(
        `- **${q.header}**: [Discuss first]${note ? ` ${note}` : " Please explain this option/trade-off before deciding."}`
      );
      continue;
    }
    const parts: string[] = [];
    if (ans.selectedLabels.length > 0) {
      parts.push(ans.selectedLabels.join(", "));
    }
    if (ans.otherText?.trim()) {
      parts.push(`Other: ${ans.otherText.trim()}`);
    }
    lines.push(
      `- **${q.header}**: ${parts.length > 0 ? parts.join(" | ") : "(unanswered)"}`
    );
  }

  return lines.join("\n");
}

export const askUserQuestionExtension: WorkbenchServerExtension = {
  descriptor: {
    id: "ask-user-question",
    title: "交互式提问 (ask_user_question)",
    description:
      "当需求不明确或需要架构/参数决策时，弹出结构化单选/多选问卷并暂停等待用户回答。",
    toolNames: ["ask_user_question"],
    defaultEnabled: true,
    prominence: "interactive",
  },
  promptGuideline:
    "When requirements are ambiguous or you need the user to choose between concrete options (e.g., Skill parameters, deployment strategy, architecture trade-offs), call `ask_user_question` instead of guessing. Put all related questions in a single call, mark the best default option with `recommended: true` and `recommendedReason`.",
  createTools(
    ctx: WorkbenchExtensionRuntimeContext,
    pi: ExtensionAPI
  ): ToolDefinition<any, any>[] {
    const { Type } = pi.typebox;
    const optionSchema = Type.Object({
      label: Type.String({ description: "Short option label" }),
      description: Type.Optional(
        Type.String({ description: "Concise explanation of this option" })
      ),
      recommended: Type.Optional(
        Type.Boolean({ description: "Mark as recommended default choice" })
      ),
      recommendedReason: Type.Optional(
        Type.String({ description: "Why this option is recommended" })
      ),
    });

    const questionSchema = Type.Object({
      id: Type.Optional(Type.String({ description: "Stable question ID" })),
      header: Type.String({
        description: "Short topic title (2-6 words), shown as section heading",
      }),
      question: Type.String({ description: "The full question text" }),
      multiSelect: Type.Optional(
        Type.Boolean({ description: "Allow selecting multiple options" })
      ),
      preview: Type.Optional(
        Type.String({
          description: "Optional markdown snippet or context shown above options",
        })
      ),
      options: Type.Array(optionSchema, {
        minItems: 1,
        maxItems: 6,
        description: "Choices presented to the user",
      }),
    });

    const paramsSchema = Type.Object({
      questions: Type.Array(questionSchema, {
        minItems: 1,
        maxItems: 6,
        description: "One or more structured questions to ask the user",
      }),
    });

    return [
      {
        name: "ask_user_question",
        label: "Ask User Question",
        description:
          "Ask the user one or more structured multiple-choice questions and pause execution until they submit answers. Use this when clarifying requirements, confirming designs, or choosing between alternatives.",
        parameters: paramsSchema,
        loadMode: "essential",
        approval: "read",
        async execute(toolCallId, params, signal) {
          const rawQuestions = Array.isArray(params?.questions)
            ? params.questions
            : [];
          if (rawQuestions.length === 0) {
            throw new Error("`questions` must contain at least one question.");
          }

          const questions: UserQuestionItem[] = rawQuestions.map(
            (q: any, idx: number) => ({
              id:
                typeof q.id === "string" && q.id.trim()
                  ? q.id.trim()
                  : `q_${idx + 1}_${crypto.randomUUID().slice(0, 6)}`,
              header: String(q.header || `问题 ${idx + 1}`).trim(),
              question: String(q.question || "").trim(),
              multiSelect: Boolean(q.multiSelect),
              ...(typeof q.preview === "string" && q.preview.trim()
                ? { preview: q.preview.trim() }
                : {}),
              options: (Array.isArray(q.options) ? q.options : []).map(
                (opt: any) => ({
                  label: String(opt.label || "").trim(),
                  ...(typeof opt.description === "string" &&
                  opt.description.trim()
                    ? { description: opt.description.trim() }
                    : {}),
                  ...(opt.recommended ? { recommended: true } : {}),
                  ...(typeof opt.recommendedReason === "string" &&
                  opt.recommendedReason.trim()
                    ? { recommendedReason: opt.recommendedReason.trim() }
                    : {}),
                })
              ),
            })
          );

          const pending: PendingUserQuestion = {
            toolCallId,
            questions,
            createdAt: Date.now(),
          };

          const submission = await ctx.askUserQuestion(pending, signal);
          const text = formatSubmissionForModel(questions, submission);

          return {
            content: [{ type: "text", text }],
            details: {
              questions,
              submission,
            },
          };
        },
      },
    ];
  },
};
