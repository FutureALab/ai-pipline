import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type {
  WorkbenchExtensionDescriptor,
  WorkbenchExtensionId,
} from "../types.js";
import { askUserQuestionExtension } from "./askUserQuestion.js";
import { backgroundCommandsExtension } from "./backgroundCommands.js";
import { nextStepsExtension } from "./nextSteps.js";
import { todosExtension } from "./todos.js";
import type {
  WorkbenchExtensionRuntimeContext,
  WorkbenchServerExtension,
} from "./types.js";
import { visualizeExtension } from "./visualize.js";

export const WORKBENCH_SERVER_EXTENSIONS: readonly WorkbenchServerExtension[] = [
  askUserQuestionExtension,
  nextStepsExtension,
  todosExtension,
  visualizeExtension,
  backgroundCommandsExtension,
];

export function getWorkbenchExtensionCatalog(): WorkbenchExtensionDescriptor[] {
  return WORKBENCH_SERVER_EXTENSIONS.map((ext) => ({ ...ext.descriptor }));
}

export function resolveEnabledExtensions(
  disabledExtensionIds?: string[]
): WorkbenchServerExtension[] {
  const disabled = new Set(
    (disabledExtensionIds ?? []).map((id) => id.trim()).filter(Boolean)
  );
  return WORKBENCH_SERVER_EXTENSIONS.filter((ext) => {
    if (disabled.has(ext.descriptor.id)) return false;
    return ext.descriptor.defaultEnabled;
  });
}

export function buildWorkbenchExtensions(
  disabledExtensionIds: string[] | undefined,
  ctx: WorkbenchExtensionRuntimeContext
): {
  enabledIds: WorkbenchExtensionId[];
  factories: ExtensionFactory[];
  appendSystemPrompt: string;
} {
  const active = resolveEnabledExtensions(disabledExtensionIds);
  const enabledIds = active.map((ext) => ext.descriptor.id);

  const factories: ExtensionFactory[] = active.map((ext) => {
    return (pi) => {
      const tools = ext.createTools(ctx, pi);
      for (const tool of tools) {
        pi.registerTool(tool);
      }
    };
  });

  const guidelines = active
    .map((ext) => ext.promptGuideline?.trim())
    .filter((line): line is string => Boolean(line));

  const appendSystemPrompt =
    guidelines.length > 0
      ? [
          "## Workbench Tool Guidelines",
          ...guidelines.map((g) => `- ${g}`),
        ].join("\n")
      : "";

  return {
    enabledIds,
    factories,
    appendSystemPrompt,
  };
}
