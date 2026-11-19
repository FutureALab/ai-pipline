import type {
  ToolProminence,
  WorkbenchExtensionId,
  WorkbenchToolCall,
} from "../../api";

export type ToolCardKind =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "mcp"
  | "visualize"
  | "save-skill"
  | "ask-user-question"
  | "next-steps"
  | "todo"
  | "background-command"
  | "default";

export interface WebToolRegistration {
  name: string;
  extensionId?: WorkbenchExtensionId;
  cardKind: ToolCardKind;
  prominence: ToolProminence;
  label: string;
  summarize: (call: WorkbenchToolCall) => string;
}

const EXACT_REGISTRY = new Map<string, WebToolRegistration>();
const PREFIX_REGISTRY: Array<{ prefix: string; reg: WebToolRegistration }> = [];

export function registerWebTool(reg: WebToolRegistration): void {
  EXACT_REGISTRY.set(reg.name, reg);
}

export function registerWebToolPrefix(
  prefix: string,
  reg: WebToolRegistration
): void {
  PREFIX_REGISTRY.push({ prefix, reg });
  PREFIX_REGISTRY.sort((a, b) => b.prefix.length - a.prefix.length);
}

function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

// Built-in core pi tools (routine)
registerWebTool({
  name: "bash",
  cardKind: "bash",
  prominence: "routine",
  label: "终端命令",
  summarize: (c) => strArg(c.args, "command", "cmd").slice(0, 72) || "执行命令",
});

registerWebTool({
  name: "read",
  cardKind: "read",
  prominence: "routine",
  label: "读取文件",
  summarize: (c) => strArg(c.args, "path", "file_path") || "读取文件",
});

registerWebTool({
  name: "write",
  cardKind: "write",
  prominence: "routine",
  label: "写入文件",
  summarize: (c) => strArg(c.args, "path", "file_path") || "写入文件",
});

registerWebTool({
  name: "edit",
  cardKind: "edit",
  prominence: "routine",
  label: "编辑文件",
  summarize: (c) => strArg(c.args, "path", "file_path") || "编辑文件",
});

// MCP prefix tools (routine)
registerWebToolPrefix("mcp__", {
  name: "mcp__*",
  cardKind: "mcp",
  prominence: "routine",
  label: "MCP 工具",
  summarize: (c) => {
    const parts = c.toolName.replace(/^mcp__/, "").split("__");
    return parts.length >= 2 ? `${parts[0]} / ${parts.slice(1).join("__")}` : c.toolName;
  },
});

// Paired web extensions (matching backend src/workbench/extensions/registry.ts)
registerWebTool({
  name: "save_skill",
  extensionId: "skill-distiller",
  cardKind: "save-skill",
  prominence: "primary",
  label: "沉淀 Skill",
  summarize: (c) => strArg(c.args, "skillName") || "生成并保存 Skill",
});

registerWebTool({
  name: "visualize",
  extensionId: "visualize",
  cardKind: "visualize",
  prominence: "primary",
  label: "可视化展示",
  summarize: (c) =>
    strArg(c.args, "title", "path") ||
    (c.args.type === "comparison"
      ? "方案对比"
      : c.args.type === "file"
        ? "文件预览"
        : "架构 / 流程图"),
});

registerWebTool({
  name: "ask_user_question",
  extensionId: "ask-user-question",
  cardKind: "ask-user-question",
  prominence: "interactive",
  label: "交互式提问",
  summarize: (c) => {
    const qs = Array.isArray(c.args.questions) ? c.args.questions : [];
    if (qs.length > 0 && qs[0]?.header) {
      return qs.length > 1
        ? `${qs[0].header} 等 ${qs.length} 个问题`
        : String(qs[0].header);
    }
    return "等待用户确认";
  },
});

registerWebTool({
  name: "suggest_next_steps",
  extensionId: "next-steps",
  cardKind: "next-steps",
  prominence: "routine",
  label: "下一步建议",
  summarize: (c) => {
    const list = Array.isArray(c.args.suggestions) ? c.args.suggestions : [];
    return `生成了 ${list.length} 条下一步建议`;
  },
});

for (const todoTool of [
  "todo_list",
  "todo_write",
  "todo_add",
  "todo_update",
  "todo_remove",
  "todo_plan_summary",
]) {
  registerWebTool({
    name: todoTool,
    extensionId: "todos",
    cardKind: "todo",
    prominence: "routine",
    label: "任务清单",
    summarize: (c) => {
      if (c.toolName === "todo_update") {
        const status = strArg(c.args, "status");
        const id = strArg(c.args, "id");
        return `更新 ${id || "任务"}${status ? ` → ${status}` : ""}`;
      }
      if (c.toolName === "todo_add") {
        return `新增待办: ${strArg(c.args, "title").slice(0, 40)}`;
      }
      if (c.toolName === "todo_write") {
        const groups = Array.isArray(c.args.groups) ? c.args.groups.length : 0;
        return `更新工作计划 (${groups} 个任务组)`;
      }
      return c.toolName;
    },
  });
}

registerWebTool({
  name: "background_command",
  extensionId: "background-commands",
  cardKind: "background-command",
  prominence: "routine",
  label: "后台命令",
  summarize: (c) => {
    const action = strArg(c.args, "action") || "run";
    const detail = strArg(c.args, "name", "command", "id").slice(0, 48);
    return `${action}${detail ? `: ${detail}` : ""}`;
  },
});

const FALLBACK_REG: WebToolRegistration = {
  name: "default",
  cardKind: "default",
  prominence: "routine",
  label: "工具调用",
  summarize: (c) => {
    const p = strArg(c.args, "path", "command", "query", "url", "id");
    return p ? `${c.toolName}: ${p.slice(0, 60)}` : c.toolName;
  },
};

export function resolveWebTool(toolName: string): WebToolRegistration {
  const exact = EXACT_REGISTRY.get(toolName);
  if (exact) return exact;
  for (const entry of PREFIX_REGISTRY) {
    if (toolName.startsWith(entry.prefix)) return entry.reg;
  }
  return FALLBACK_REG;
}

export type ToolRenderBlock =
  | { kind: "routine-group"; calls: WorkbenchToolCall[] }
  | { kind: "primary"; call: WorkbenchToolCall }
  | { kind: "interactive"; call: WorkbenchToolCall };

export function groupToolCallsForRender(
  calls: WorkbenchToolCall[]
): ToolRenderBlock[] {
  const blocks: ToolRenderBlock[] = [];
  let currentRoutine: WorkbenchToolCall[] = [];

  const flushRoutine = () => {
    if (currentRoutine.length > 0) {
      blocks.push({ kind: "routine-group", calls: currentRoutine });
      currentRoutine = [];
    }
  };

  for (const call of calls) {
    const reg = resolveWebTool(call.toolName);
    if (reg.prominence === "primary") {
      flushRoutine();
      blocks.push({ kind: "primary", call });
    } else if (reg.prominence === "interactive") {
      flushRoutine();
      blocks.push({ kind: "interactive", call });
    } else {
      currentRoutine.push(call);
    }
  }
  flushRoutine();
  return blocks;
}
