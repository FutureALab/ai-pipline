import crypto from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type {
  TodoItemStatus,
  WorkbenchTodoGroup,
  WorkbenchTodoItem,
  WorkbenchTodoState,
} from "../types.js";
import type {
  WorkbenchExtensionRuntimeContext,
  WorkbenchServerExtension,
} from "./types.js";

function deriveGroupStatus(
  items: WorkbenchTodoItem[]
): "pending" | "active" | "done" {
  if (items.length > 0 && items.every((i) => i.status === "done")) {
    return "done";
  }
  if (items.some((i) => i.status === "in_progress")) {
    return "active";
  }
  return "pending";
}

export class TodoSessionStore {
  private groups: Array<{
    id: string;
    title: string;
    items: WorkbenchTodoItem[];
  }> = [];
  private loose: WorkbenchTodoItem[] = [];
  private summary?: string;
  private updatedAt = Date.now();

  getSnapshot(): WorkbenchTodoState {
    return {
      groups: this.groups.map((g) => ({
        id: g.id,
        title: g.title,
        status: deriveGroupStatus(g.items),
        items: g.items.map((item) => ({ ...item })),
      })),
      loose: this.loose.map((item) => ({ ...item })),
      ...(this.summary ? { summary: this.summary } : {}),
      updatedAt: this.updatedAt,
    };
  }

  private demoteOtherInProgress(exceptId?: string): WorkbenchTodoItem[] {
    const paused: WorkbenchTodoItem[] = [];
    const now = Date.now();
    const visit = (items: WorkbenchTodoItem[]) => {
      for (const item of items) {
        if (item.status === "in_progress" && item.id !== exceptId) {
          item.status = "pending";
          item.updatedAt = now;
          paused.push({ ...item });
        }
      }
    };
    for (const g of this.groups) visit(g.items);
    visit(this.loose);
    return paused;
  }

  private findItem(
    id: string
  ): { item: WorkbenchTodoItem; group?: { id: string; title: string; items: WorkbenchTodoItem[] } } | null {
    for (const g of this.groups) {
      const found = g.items.find((i) => i.id === id);
      if (found) return { item: found, group: g };
    }
    const looseFound = this.loose.find((i) => i.id === id);
    if (looseFound) return { item: looseFound };
    return null;
  }

  addItem(params: {
    title: string;
    origin: "agent" | "user";
    group?: string;
    after?: string;
    note?: string;
  }): WorkbenchTodoItem {
    const title = params.title.trim();
    if (!title) throw new Error("Todo `title` is required.");
    const now = Date.now();
    const item: WorkbenchTodoItem = {
      id: `todo_${crypto.randomUUID().slice(0, 8)}`,
      title,
      status: "pending",
      origin: params.origin,
      ...(params.note?.trim() ? { note: params.note.trim() } : {}),
      createdAt: now,
      updatedAt: now,
    };

    if (params.after?.trim()) {
      const target = this.findItem(params.after.trim());
      if (!target) {
        throw new Error(`Todo item not found for \`after\`: ${params.after}`);
      }
      if (!target.group) {
        throw new Error(
          "Cannot insert `after` a loose item; promote loose items into a group instead."
        );
      }
      const idx = target.group.items.findIndex((i) => i.id === target.item.id);
      target.group.items.splice(idx + 1, 0, item);
      this.updatedAt = now;
      return { ...item };
    }

    if (params.group?.trim()) {
      const groupTitle = params.group.trim();
      let grp = this.groups.find(
        (g) => g.id === groupTitle || g.title.toLowerCase() === groupTitle.toLowerCase()
      );
      if (!grp) {
        grp = {
          id: `grp_${crypto.randomUUID().slice(0, 8)}`,
          title: groupTitle,
          items: [],
        };
        this.groups.push(grp);
      }
      grp.items.push(item);
      this.updatedAt = now;
      return { ...item };
    }

    this.loose.push(item);
    this.updatedAt = now;
    return { ...item };
  }

  updateItem(params: {
    id: string;
    status?: TodoItemStatus;
    title?: string;
    note?: string;
    summary?: string;
  }): {
    item: WorkbenchTodoItem;
    paused: WorkbenchTodoItem[];
    nextOpenInGroup?: WorkbenchTodoItem;
  } {
    const found = this.findItem(params.id);
    if (!found) {
      throw new Error(`Todo item not found: ${params.id}`);
    }
    const now = Date.now();
    let paused: WorkbenchTodoItem[] = [];

    if (params.status) {
      if (params.status === "in_progress") {
        paused = this.demoteOtherInProgress(found.item.id);
      }
      found.item.status = params.status;
      if (params.status !== "done") {
        delete found.item.summary;
      }
    }
    if (typeof params.title === "string" && params.title.trim()) {
      found.item.title = params.title.trim();
    }
    if (typeof params.note === "string") {
      if (params.note.trim()) found.item.note = params.note.trim();
      else delete found.item.note;
    }
    if (typeof params.summary === "string") {
      if (params.summary.trim()) found.item.summary = params.summary.trim();
      else delete found.item.summary;
    }
    found.item.updatedAt = now;
    this.updatedAt = now;

    let nextOpenInGroup: WorkbenchTodoItem | undefined;
    if (params.status === "done" && found.group) {
      const next = found.group.items.find((i) => i.status === "pending");
      if (next) nextOpenInGroup = { ...next };
    }

    return {
      item: { ...found.item },
      paused,
      nextOpenInGroup,
    };
  }

  removeItem(id: string): boolean {
    const now = Date.now();
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      const idx = g.items.findIndex((i) => i.id === id);
      if (idx >= 0) {
        g.items.splice(idx, 1);
        if (g.items.length === 0) {
          this.groups.splice(gi, 1);
        }
        this.updatedAt = now;
        return true;
      }
    }
    const looseIdx = this.loose.findIndex((i) => i.id === id);
    if (looseIdx >= 0) {
      this.loose.splice(looseIdx, 1);
      this.updatedAt = now;
      return true;
    }
    return false;
  }

  /**
   * Identity-preserving reconcile of groups (inspired by ThinkRail pi-todos):
   * - Preserves existing item IDs/status when matched by (groupTitle, stepTitle)
   * - Always preserves `done` items and `loose` items
   * - Never mints or deletes loose items
   */
  reconcileGroups(
    incomingGroups: Array<{
      title: string;
      items: Array<{ title: string; note?: string }>;
    }>
  ): WorkbenchTodoState {
    const now = Date.now();
    const existingGroupByKey = new Map(
      this.groups.map((g) => [g.title.trim().toLowerCase(), g])
    );
    const nextGroups: Array<{
      id: string;
      title: string;
      items: WorkbenchTodoItem[];
    }> = [];
    const seenGroupKeys = new Set<string>();

    for (const rawGroup of incomingGroups) {
      const groupTitle = rawGroup.title.trim();
      if (!groupTitle) continue;
      const gKey = groupTitle.toLowerCase();
      seenGroupKeys.add(gKey);

      const existingGroup = existingGroupByKey.get(gKey);
      const existingByTitle = new Map(
        (existingGroup?.items ?? []).map((i) => [
          i.title.trim().toLowerCase(),
          i,
        ])
      );

      const matchedIds = new Set<string>();
      const reconciledItems: WorkbenchTodoItem[] = [];

      for (const rawItem of rawGroup.items) {
        const stepTitle = rawItem.title.trim();
        if (!stepTitle) continue;
        const sKey = stepTitle.toLowerCase();
        const existing = existingByTitle.get(sKey);
        if (existing) {
          matchedIds.add(existing.id);
          if (typeof rawItem.note === "string") {
            if (rawItem.note.trim()) existing.note = rawItem.note.trim();
            else delete existing.note;
            existing.updatedAt = now;
          }
          reconciledItems.push(existing);
        } else {
          reconciledItems.push({
            id: `todo_${crypto.randomUUID().slice(0, 8)}`,
            title: stepTitle,
            status: "pending",
            origin: "agent",
            ...(rawItem.note?.trim() ? { note: rawItem.note.trim() } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      // Preserve any done items or user-authored open items in this group
      for (const oldItem of existingGroup?.items ?? []) {
        if (
          !matchedIds.has(oldItem.id) &&
          (oldItem.status === "done" || oldItem.origin === "user")
        ) {
          reconciledItems.push(oldItem);
        }
      }

      if (reconciledItems.length > 0) {
        nextGroups.push({
          id: existingGroup?.id ?? `grp_${crypto.randomUUID().slice(0, 8)}`,
          title: groupTitle,
          items: reconciledItems,
        });
      }
    }

    // Preserve any omitted groups that have done items or user-authored items
    for (const oldGroup of this.groups) {
      const gKey = oldGroup.title.trim().toLowerCase();
      if (seenGroupKeys.has(gKey)) continue;
      const kept = oldGroup.items.filter(
        (i) => i.status === "done" || i.origin === "user"
      );
      if (kept.length > 0) {
        nextGroups.push({
          id: oldGroup.id,
          title: oldGroup.title,
          items: kept,
        });
      }
    }

    this.groups = nextGroups;
    this.updatedAt = now;
    return this.getSnapshot();
  }

  setPlanSummary(summary?: string): void {
    this.summary = summary?.trim() || undefined;
    this.updatedAt = Date.now();
  }

  renderText(statusFilter?: TodoItemStatus): string {
    const snap = this.getSnapshot();
    const lines: string[] = [];

    const fmtItem = (item: WorkbenchTodoItem) => {
      const icon =
        item.status === "done"
          ? "[x]"
          : item.status === "in_progress"
            ? "[~]"
            : "[ ]";
      const tag = item.origin === "user" ? " (user)" : "";
      const note = item.note ? ` — ${item.note}` : "";
      return `  ${icon} \`${item.id}\` ${item.title}${tag}${note}`;
    };

    if (snap.groups.length === 0 && snap.loose.length === 0) {
      return "TODO list is currently empty.";
    }

    for (const g of snap.groups) {
      const doneCount = g.items.filter((i) => i.status === "done").length;
      const filtered = statusFilter
        ? g.items.filter((i) => i.status === statusFilter)
        : g.items;
      if (statusFilter && filtered.length === 0) continue;
      lines.push(
        `### ${g.title} [${g.status}] (${doneCount}/${g.items.length})`
      );
      for (const item of filtered) {
        lines.push(fmtItem(item));
      }
    }

    const filteredLoose = statusFilter
      ? snap.loose.filter((i) => i.status === statusFilter)
      : snap.loose;
    if (filteredLoose.length > 0) {
      lines.push("### Loose / Inbox");
      for (const item of filteredLoose) {
        lines.push(fmtItem(item));
      }
    }

    if (snap.summary) {
      lines.push(`\n**Plan Summary:** ${snap.summary}`);
    }

    const hasOpen =
      snap.groups.some((g) => g.items.some((i) => i.status === "pending")) ||
      snap.loose.some((i) => i.status === "pending");
    const hasInProgress =
      snap.groups.some((g) => g.items.some((i) => i.status === "in_progress")) ||
      snap.loose.some((i) => i.status === "in_progress");
    if (hasOpen && !hasInProgress) {
      lines.push(
        "\n_Tip: Open items exist with none `in_progress`. Use `todo_update` to mark the active step._"
      );
    }

    return lines.join("\n");
  }
}

export const todosExtension: WorkbenchServerExtension = {
  descriptor: {
    id: "todos",
    title: "会话任务清单 (pi-todos)",
    description:
      "提供 todo_list / todo_write / todo_add / todo_update / todo_remove / todo_plan_summary，支持任务组进度追踪与人机双向协作。",
    toolNames: [
      "todo_list",
      "todo_write",
      "todo_add",
      "todo_update",
      "todo_remove",
      "todo_plan_summary",
    ],
    defaultEnabled: true,
    prominence: "routine",
  },
  promptGuideline:
    "For tasks requiring 3 or more substantive steps (or when the user explicitly asks for a plan), use `todo_write` to establish task groups and `todo_update` to progress one step at a time (`pending` -> `in_progress` -> `done`). Check `todo_list` if the user adds items to the shared TODO list.",
  createTools(
    ctx: WorkbenchExtensionRuntimeContext,
    pi: ExtensionAPI
  ): ToolDefinition<any, any>[] {
    const { Type } = pi.typebox;
    const statusUnion = Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("done"),
    ]);

    return [
      {
        name: "todo_list",
        label: "Todo List",
        description:
          "Read the current session TODO plan grouped by task, including user-added loose items.",
        parameters: Type.Object({
          status: Type.Optional(statusUnion),
        }),
        loadMode: "essential",
        approval: "read",
        async execute(_toolCallId, params) {
          const text = ctx.todoStore.renderText(params?.status);
          return {
            content: [{ type: "text", text }],
            details: { todos: ctx.todoStore.getSnapshot() },
          };
        },
      },
      {
        name: "todo_write",
        label: "Todo Write Plan",
        description:
          "Reconcile the session TODO plan using task groups. Identity-preserving: keeps completed items, user items, and loose items intact.",
        parameters: Type.Object({
          groups: Type.Array(
            Type.Object({
              title: Type.String({ description: "Outcome-oriented task group title" }),
              items: Type.Array(
                Type.Object({
                  title: Type.String({ description: "Verifiable step title" }),
                  note: Type.Optional(Type.String()),
                }),
                { minItems: 1 }
              ),
            }),
            { minItems: 1 }
          ),
        }),
        loadMode: "essential",
        approval: "write",
        async execute(_toolCallId, params) {
          const groups = Array.isArray(params?.groups) ? params.groups : [];
          const snap = ctx.todoStore.reconcileGroups(groups);
          ctx.onStateChange();
          return {
            content: [{ type: "text", text: ctx.todoStore.renderText() }],
            details: { todos: snap },
          };
        },
      },
      {
        name: "todo_add",
        label: "Todo Add",
        description:
          "Add a single TODO item into a group, after an existing grouped item, or into the loose queue (omit both `group` and `after`).",
        parameters: Type.Object({
          title: Type.String(),
          group: Type.Optional(Type.String()),
          after: Type.Optional(Type.String()),
          note: Type.Optional(Type.String()),
        }),
        loadMode: "essential",
        approval: "write",
        async execute(_toolCallId, params) {
          const item = ctx.todoStore.addItem({
            title: String(params?.title ?? ""),
            origin: "agent",
            group: params?.group,
            after: params?.after,
            note: params?.note,
          });
          ctx.onStateChange();
          return {
            content: [
              {
                type: "text",
                text: `Added TODO \`${item.id}\`: ${item.title}`,
              },
            ],
            details: { item, todos: ctx.todoStore.getSnapshot() },
          };
        },
      },
      {
        name: "todo_update",
        label: "Todo Update",
        description:
          "Update a TODO item's status (`pending` | `in_progress` | `done`), title, note, or completion summary. Setting `in_progress` automatically pauses any previous `in_progress` item.",
        parameters: Type.Object({
          id: Type.String(),
          status: Type.Optional(statusUnion),
          title: Type.Optional(Type.String()),
          note: Type.Optional(Type.String()),
          summary: Type.Optional(Type.String()),
        }),
        loadMode: "essential",
        approval: "write",
        async execute(_toolCallId, params) {
          const res = ctx.todoStore.updateItem({
            id: String(params?.id ?? ""),
            status: params?.status,
            title: params?.title,
            note: params?.note,
            summary: params?.summary,
          });
          ctx.onStateChange();
          const lines = [
            `Updated \`${res.item.id}\` (${res.item.title}) -> **${res.item.status}**`,
          ];
          if (res.paused.length > 0) {
            lines.push(
              `Paused previous in-progress: ${res.paused.map((p) => `\`${p.id}\` ${p.title}`).join(", ")}`
            );
          }
          if (res.nextOpenInGroup) {
            lines.push(
              `Next open step in group: \`${res.nextOpenInGroup.id}\` ${res.nextOpenInGroup.title}`
            );
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { ...res, todos: ctx.todoStore.getSnapshot() },
          };
        },
      },
      {
        name: "todo_remove",
        label: "Todo Remove",
        description: "Remove a TODO item by ID.",
        parameters: Type.Object({
          id: Type.String(),
        }),
        loadMode: "essential",
        approval: "write",
        async execute(_toolCallId, params) {
          const id = String(params?.id ?? "");
          const ok = ctx.todoStore.removeItem(id);
          if (!ok) {
            throw new Error(`Todo item not found: ${id}`);
          }
          ctx.onStateChange();
          return {
            content: [{ type: "text", text: `Removed TODO \`${id}\`.` }],
            details: { removedId: id, todos: ctx.todoStore.getSnapshot() },
          };
        },
      },
      {
        name: "todo_plan_summary",
        label: "Todo Plan Summary",
        description: "Set or clear the overall plan completion summary.",
        parameters: Type.Object({
          summary: Type.Optional(Type.String()),
        }),
        loadMode: "essential",
        approval: "write",
        async execute(_toolCallId, params) {
          ctx.todoStore.setPlanSummary(params?.summary);
          ctx.onStateChange();
          return {
            content: [
              {
                type: "text",
                text: params?.summary?.trim()
                  ? `Plan summary updated.`
                  : `Plan summary cleared.`,
              },
            ],
            details: { todos: ctx.todoStore.getSnapshot() },
          };
        },
      },
    ];
  },
};
