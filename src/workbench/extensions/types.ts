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
  owner: string;
  cwd: string;
  selectedMcps: string[];
  todoStore: TodoSessionStore;
  bgCommandManager: BackgroundCommandManager;
  setNextSteps: (steps: WorkbenchNextStep[]) => void;
  askUserQuestion: (
    question: PendingUserQuestion,
    signal?: AbortSignal
  ) => Promise<UserQuestionSubmission>;
  onSkillSaved: (skill: {
    name: string;
    description: string;
    source: string;
  }) => void;
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
