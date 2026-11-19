import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type {
  PendingUserQuestion,
  UserQuestionSubmission,
  WorkbenchExtensionDescriptor,
  WorkbenchNextStep,
} from "../types.js";
import type { BackgroundCommandManager } from "./backgroundCommands.js";
import type { TodoSessionStore } from "./todos.js";

export interface WorkbenchExtensionRuntimeContext {
  sessionId: string;
  cwd: string;
  todoStore: TodoSessionStore;
  bgCommandManager: BackgroundCommandManager;
  setNextSteps: (steps: WorkbenchNextStep[]) => void;
  askUserQuestion: (
    question: PendingUserQuestion,
    signal?: AbortSignal
  ) => Promise<UserQuestionSubmission>;
  onStateChange: () => void;
}

export interface WorkbenchServerExtension {
  descriptor: WorkbenchExtensionDescriptor;
  promptGuideline?: string;
  createTools: (
    ctx: WorkbenchExtensionRuntimeContext,
    pi: ExtensionAPI
  ) => ToolDefinition<any, any>[];
}
