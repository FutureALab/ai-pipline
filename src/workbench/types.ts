export type WorkbenchExtensionId =
  | "ask-user-question"
  | "next-steps"
  | "todos"
  | "visualize"
  | "background-commands"
  | "skill-distiller";

export type ToolProminence = "routine" | "primary" | "interactive";

export interface WorkbenchExtensionDescriptor {
  id: WorkbenchExtensionId;
  title: string;
  description: string;
  toolNames: string[];
  defaultEnabled: boolean;
  prominence: ToolProminence;
}

export type WorkbenchToolCallStatus =
  | "running"
  | "waiting_input"
  | "completed"
  | "error";

export interface WorkbenchToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: WorkbenchToolCallStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  resultText?: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
  recommendedReason?: string;
}

export interface UserQuestionItem {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  preview?: string;
  options: UserQuestionOption[];
}

export interface PendingUserQuestion {
  toolCallId: string;
  questions: UserQuestionItem[];
  createdAt: number;
}

export interface UserQuestionAnswerItem {
  questionId: string;
  selectedLabels: string[];
  otherText?: string;
  discussFirst?: boolean;
  discussNote?: string;
}

export interface UserQuestionSubmission {
  toolCallId: string;
  answers: UserQuestionAnswerItem[];
  cancelled?: boolean;
  chatInstead?: boolean;
}

export interface WorkbenchNextStep {
  label: string;
  prompt: string;
}

export type TodoItemStatus = "pending" | "in_progress" | "done";

export interface WorkbenchTodoItem {
  id: string;
  title: string;
  status: TodoItemStatus;
  origin: "agent" | "user";
  note?: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkbenchTodoGroup {
  id: string;
  title: string;
  status: "pending" | "active" | "done";
  items: WorkbenchTodoItem[];
}

export interface WorkbenchTodoState {
  groups: WorkbenchTodoGroup[];
  loose: WorkbenchTodoItem[];
  summary?: string;
  updatedAt: number;
}

export type BackgroundCommandStatus =
  | "running"
  | "stopping"
  | "completed"
  | "error"
  | "stopped";

export interface WorkbenchBackgroundCommandSnapshot {
  id: string;
  name: string;
  command: string;
  status: BackgroundCommandStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  outputPreview: string;
  outputTruncated: boolean;
  outputLines: number;
  errorMessage?: string;
}
