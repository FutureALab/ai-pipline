import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type {
  BackgroundCommandStatus,
  WorkbenchBackgroundCommandSnapshot,
} from "../types.js";
import type {
  WorkbenchExtensionRuntimeContext,
  WorkbenchServerExtension,
} from "./types.js";

const MAX_ACTIVE_COMMANDS = 8;
const MAX_TERMINAL_RECORDS = 20;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_NAME_CHARS = 200;

interface InternalBgCommand {
  id: string;
  name: string;
  command: string;
  status: BackgroundCommandStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  errorMessage?: string;
  outputText: string;
  outputTruncated: boolean;
  stopRequested: boolean;
  child?: ChildProcess;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

function trimBoundedOutput(
  text: string,
  alreadyTruncated: boolean
): { text: string; truncated: boolean; lineCount: number } {
  let truncated = alreadyTruncated;
  let current = text;

  const byteLen = Buffer.byteLength(current, "utf-8");
  if (byteLen > MAX_OUTPUT_BYTES) {
    const buf = Buffer.from(current, "utf-8");
    current = buf.subarray(buf.byteLength - MAX_OUTPUT_BYTES).toString("utf-8");
    truncated = true;
  }

  const lines = current.split("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    current = lines.slice(lines.length - MAX_OUTPUT_LINES).join("\n");
    truncated = true;
    return { text: current, truncated, lineCount: MAX_OUTPUT_LINES };
  }

  return { text: current, truncated, lineCount: lines.length };
}

export class BackgroundCommandManager {
  private records = new Map<string, InternalBgCommand>();
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly onChange: () => void
  ) {}

  private toSnapshot(rec: InternalBgCommand): WorkbenchBackgroundCommandSnapshot {
    const lines = rec.outputText ? rec.outputText.split("\n") : [];
    const preview =
      lines.length > 60
        ? lines.slice(lines.length - 60).join("\n")
        : rec.outputText;
    return {
      id: rec.id,
      name: rec.name,
      command: rec.command,
      status: rec.status,
      startedAt: rec.startedAt,
      ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
      ...(rec.exitCode !== undefined ? { exitCode: rec.exitCode } : {}),
      ...(rec.signal !== undefined ? { signal: rec.signal } : {}),
      outputPreview: preview,
      outputTruncated: rec.outputTruncated,
      outputLines: lines.length,
      ...(rec.errorMessage ? { errorMessage: rec.errorMessage } : {}),
    };
  }

  private evictOldTerminalRecords(): void {
    const terminals = [...this.records.values()]
      .filter((r) => r.status !== "running" && r.status !== "stopping")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    for (let i = MAX_TERMINAL_RECORDS; i < terminals.length; i++) {
      this.records.delete(terminals[i].id);
    }
  }

  list(): WorkbenchBackgroundCommandSnapshot[] {
    return [...this.records.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => this.toSnapshot(r));
  }

  start(params: {
    command: string;
    name?: string;
    timeoutMs?: number;
  }): WorkbenchBackgroundCommandSnapshot {
    if (this.disposed) {
      throw new Error("Background command manager is disposed.");
    }
    const command = params.command.trim();
    if (!command) {
      throw new Error("`command` is required for `action: \"start\"`.");
    }
    if (Buffer.byteLength(command, "utf-8") > MAX_COMMAND_BYTES) {
      throw new Error("Command exceeds maximum allowed size (64 KiB).");
    }

    const activeCount = [...this.records.values()].filter(
      (r) => r.status === "running" || r.status === "stopping"
    ).length;
    if (activeCount >= MAX_ACTIVE_COMMANDS) {
      throw new Error(
        `Maximum active background commands (${MAX_ACTIVE_COMMANDS}) reached. Stop an existing command first.`
      );
    }

    const id = `bg_${crypto.randomUUID().slice(0, 8)}`;
    const name = (params.name?.trim() || command.slice(0, 60)).slice(
      0,
      MAX_NAME_CHARS
    );

    const rec: InternalBgCommand = {
      id,
      name,
      command,
      status: "running",
      startedAt: Date.now(),
      outputText: "",
      outputTruncated: false,
      stopRequested: false,
    };
    this.records.set(id, rec);

    const appendChunk = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const trimmed = trimBoundedOutput(
        rec.outputText + text,
        rec.outputTruncated
      );
      rec.outputText = trimmed.text;
      rec.outputTruncated = trimmed.truncated;
    };

    try {
      const child = spawn(command, {
        cwd: this.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      rec.child = child;

      child.stdout?.on("data", appendChunk);
      child.stderr?.on("data", appendChunk);

      if (
        typeof params.timeoutMs === "number" &&
        Number.isFinite(params.timeoutMs) &&
        params.timeoutMs > 0
      ) {
        rec.timeoutHandle = setTimeout(() => {
          if (rec.status === "running") {
            rec.errorMessage = `Timed out after ${params.timeoutMs}ms`;
            this.terminateProcessTree(rec);
          }
        }, params.timeoutMs);
      }

      child.on("error", (err) => {
        if (rec.timeoutHandle) clearTimeout(rec.timeoutHandle);
        rec.status = "error";
        rec.endedAt = Date.now();
        rec.errorMessage = err.message.slice(0, 4096);
        rec.child = undefined;
        this.evictOldTerminalRecords();
        this.onChange();
      });

      child.on("close", (code, sig) => {
        if (rec.timeoutHandle) clearTimeout(rec.timeoutHandle);
        rec.endedAt = Date.now();
        rec.exitCode = code;
        rec.signal = sig;
        rec.child = undefined;
        if (rec.stopRequested) {
          rec.status = "stopped";
        } else if (rec.errorMessage) {
          rec.status = "error";
        } else if (code === 0) {
          rec.status = "completed";
        } else {
          rec.status = "error";
          rec.errorMessage = `Exited with code ${code ?? "null"}${sig ? ` (signal ${sig})` : ""}`;
        }
        this.evictOldTerminalRecords();
        this.onChange();
      });
    } catch (err) {
      rec.status = "error";
      rec.endedAt = Date.now();
      rec.errorMessage = (
        err instanceof Error ? err.message : String(err)
      ).slice(0, 4096);
      this.evictOldTerminalRecords();
    }

    this.onChange();
    return this.toSnapshot(rec);
  }

  getOutput(id: string): {
    snapshot: WorkbenchBackgroundCommandSnapshot;
    text: string;
    truncated: boolean;
  } {
    const rec = this.records.get(id);
    if (!rec) {
      throw new Error(`Background command not found: ${id}`);
    }
    return {
      snapshot: this.toSnapshot(rec),
      text: rec.outputText,
      truncated: rec.outputTruncated,
    };
  }

  private terminateProcessTree(rec: InternalBgCommand): void {
    const child = rec.child;
    if (!child || !child.pid) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore already-exited process
      }
    }
  }

  stop(id: string): WorkbenchBackgroundCommandSnapshot {
    const rec = this.records.get(id);
    if (!rec) {
      throw new Error(`Background command not found: ${id}`);
    }
    if (rec.status === "running") {
      rec.stopRequested = true;
      rec.status = "stopping";
      if (rec.timeoutHandle) clearTimeout(rec.timeoutHandle);
      this.terminateProcessTree(rec);
      this.onChange();
    }
    return this.toSnapshot(rec);
  }

  dispose(): void {
    this.disposed = true;
    for (const rec of this.records.values()) {
      if (rec.timeoutHandle) clearTimeout(rec.timeoutHandle);
      if (rec.status === "running" || rec.status === "stopping") {
        rec.stopRequested = true;
        rec.status = "stopping";
        this.terminateProcessTree(rec);
      }
    }
  }
}

export const backgroundCommandsExtension: WorkbenchServerExtension = {
  descriptor: {
    id: "background-commands",
    title: "受控后台命令 (background_command)",
    description:
      "支持在不阻塞对话轮次的情况下启动、查看日志和停止后台进程（如 dev server、长构建/测试），限制并发与日志上限并在关闭会话时统一清理。",
    toolNames: ["background_command"],
    defaultEnabled: true,
    prominence: "routine",
  },
  promptGuideline:
    "For long-running commands (e.g., dev servers, file watchers, long test suites) that would block a normal bash turn, use `background_command` with `action: \"start\"` instead of `&` or `nohup`. Use `output` to inspect bounded logs and `stop` when finished.",
  createTools(
    ctx: WorkbenchExtensionRuntimeContext,
    pi: ExtensionAPI
  ): ToolDefinition<any, any>[] {
    const { Type } = pi.typebox;
    const paramsSchema = Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("output"),
        Type.Literal("stop"),
      ]),
      command: Type.Optional(
        Type.String({ description: "Shell command to run (for action='start')" })
      ),
      name: Type.Optional(
        Type.String({ description: "Optional display name (for action='start')" })
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Optional timeout in ms before terminating (for action='start')",
        })
      ),
      id: Type.Optional(
        Type.String({
          description: "Background command ID (for action='output' or 'stop')",
        })
      ),
    });

    return [
      {
        name: "background_command",
        label: "Background Command",
        description:
          "Manage session-scoped background shell commands without blocking the turn: `start`, `list`, `output`, or `stop`.",
        parameters: paramsSchema,
        loadMode: "essential",
        approval: "exec",
        async execute(_toolCallId, params) {
          const action = params?.action;
          if (action === "start") {
            const snap = ctx.bgCommandManager.start({
              command: String(params?.command ?? ""),
              name: params?.name,
              timeoutMs: params?.timeoutMs,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Started background command \`${snap.id}\` (${snap.name}) — status: ${snap.status}`,
                },
              ],
              details: { action, command: snap },
            };
          }

          if (action === "list") {
            const list = ctx.bgCommandManager.list();
            const text =
              list.length === 0
                ? "No background commands in this session."
                : list
                    .map(
                      (c) =>
                        `- \`${c.id}\` [${c.status}] ${c.name} (${c.outputLines} lines)`
                    )
                    .join("\n");
            return {
              content: [{ type: "text", text }],
              details: { action, commands: list },
            };
          }

          if (action === "output") {
            const id = String(params?.id ?? "").trim();
            if (!id) throw new Error("`id` is required for `action: \"output\"`.");
            const res = ctx.bgCommandManager.getOutput(id);
            const header = `Command \`${res.snapshot.id}\` (${res.snapshot.name}) [${res.snapshot.status}]${res.truncated ? " (truncated to latest buffer)" : ""}:`;
            return {
              content: [
                {
                  type: "text",
                  text: `${header}\n\n${res.text || "(no output yet)"}`,
                },
              ],
              details: {
                action,
                command: res.snapshot,
                truncated: res.truncated,
              },
            };
          }

          if (action === "stop") {
            const id = String(params?.id ?? "").trim();
            if (!id) throw new Error("`id` is required for `action: \"stop\"`.");
            const snap = ctx.bgCommandManager.stop(id);
            return {
              content: [
                {
                  type: "text",
                  text: `Stop requested for \`${snap.id}\` (${snap.name}) — current status: ${snap.status}`,
                },
              ],
              details: { action, command: snap },
            };
          }

          throw new Error(`Unknown background_command action: ${String(action)}`);
        },
      },
    ];
  },
};
