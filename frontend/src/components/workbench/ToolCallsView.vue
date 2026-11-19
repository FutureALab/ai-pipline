<template>
  <div v-if="blocks.length > 0" class="wb-tool-blocks">
    <template v-for="(block, bIdx) in blocks" :key="bIdx">
      <!-- Routine 工具折叠活动组 -->
      <details
        v-if="block.kind === 'routine-group'"
        class="wb-routine-group"
        :open="hasRunning(block.calls)"
      >
        <summary class="wb-routine-summary">
          <span class="wb-routine-dot" :class="groupStatusClass(block.calls)" />
          <span class="wb-routine-title">
            工具活动（{{ block.calls.length }} 项）
          </span>
          <span class="wb-routine-preview">
            {{ summarizeGroup(block.calls) }}
          </span>
        </summary>

        <div class="wb-routine-list">
          <div
            v-for="call in block.calls"
            :key="call.toolCallId"
            class="wb-tool-card"
            :class="[`status-${call.status}`, `kind-${cardKind(call)}`]"
          >
            <div
              class="wb-tool-card-head"
              @click="toggleExpand(call.toolCallId)"
            >
              <div class="wb-tool-head-left">
                <el-tag
                  size="small"
                  :type="statusTagType(call)"
                  effect="plain"
                >
                  {{ statusLabel(call) }}
                </el-tag>
                <span class="wb-tool-name">{{ call.toolName }}</span>
                <span class="wb-tool-summary">{{ summarizeCall(call) }}</span>
              </div>
              <div class="wb-tool-head-right">
                <span v-if="call.durationMs !== undefined" class="wb-tool-dur">
                  {{ formatDuration(call.durationMs) }}
                </span>
                <span class="wb-tool-toggle">
                  {{ isExpanded(call.toolCallId) ? "收起" : "详情" }}
                </span>
              </div>
            </div>

            <div v-if="isExpanded(call.toolCallId)" class="wb-tool-card-body">
              <!-- Bash 终端卡片 -->
              <template v-if="cardKind(call) === 'bash'">
                <div class="wb-bash-cmd">
                  $ {{ String(call.args.command || call.args.cmd || "") }}
                </div>
                <pre v-if="call.resultText" class="wb-code-out">{{
                  truncateOutput(call.resultText, call.toolCallId)
                }}</pre>
                <el-button
                  v-if="isLongOutput(call.resultText, call.toolCallId)"
                  link
                  size="small"
                  type="primary"
                  @click="showFullOutput(call.toolCallId)"
                >
                  展开全部输出（{{ lineCount(call.resultText) }} 行）
                </el-button>
              </template>

              <!-- Edit 差异卡片 -->
              <template v-else-if="cardKind(call) === 'edit'">
                <div class="wb-kv-line">
                  <span class="wb-kv-k">文件</span>
                  <code>{{ String(call.args.path || call.args.file_path || "") }}</code>
                </div>
                <div v-if="call.args.oldText || call.args.old_string" class="wb-diff-box">
                  <pre class="wb-diff-del">- {{ String(call.args.oldText || call.args.old_string) }}</pre>
                  <pre class="wb-diff-add">+ {{ String(call.args.newText || call.args.new_string || "") }}</pre>
                </div>
                <pre v-if="call.resultText" class="wb-code-out">{{
                  truncateOutput(call.resultText, call.toolCallId)
                }}</pre>
              </template>

              <!-- MCP 专用卡片 -->
              <template v-else-if="cardKind(call) === 'mcp'">
                <div class="wb-kv-line">
                  <span class="wb-kv-k">MCP</span>
                  <code>{{ summarizeCall(call) }}</code>
                </div>
                <details v-if="Object.keys(call.args).length > 0" class="wb-sub-details">
                  <summary>调用参数</summary>
                  <pre class="wb-code-out">{{ formatJson(call.args) }}</pre>
                </details>
                <pre v-if="call.resultText" class="wb-code-out">{{
                  truncateOutput(call.resultText, call.toolCallId)
                }}</pre>
                <el-button
                  v-if="isLongOutput(call.resultText, call.toolCallId)"
                  link
                  size="small"
                  type="primary"
                  @click="showFullOutput(call.toolCallId)"
                >
                  展开全部输出（{{ lineCount(call.resultText) }} 行）
                </el-button>
              </template>

              <!-- 通用 / Read / Write / Todo / Background / NextSteps 卡片 -->
              <template v-else>
                <details v-if="Object.keys(call.args).length > 0" class="wb-sub-details">
                  <summary>参数</summary>
                  <pre class="wb-code-out">{{ formatJson(call.args) }}</pre>
                </details>
                <pre v-if="call.resultText" class="wb-code-out">{{
                  truncateOutput(call.resultText, call.toolCallId)
                }}</pre>
                <el-button
                  v-if="isLongOutput(call.resultText, call.toolCallId)"
                  link
                  size="small"
                  type="primary"
                  @click="showFullOutput(call.toolCallId)"
                >
                  展开全部输出（{{ lineCount(call.resultText) }} 行）
                </el-button>
              </template>
            </div>
          </div>
        </div>
      </details>

      <!-- Primary 工具卡片：visualize -->
      <div
        v-else-if="block.kind === 'primary'"
        class="wb-primary-card"
        :class="{ 'is-error': block.call.isError }"
      >
        <div class="wb-primary-head">
          <div class="wb-primary-title-row">
            <el-tag size="small" type="primary" effect="light">
              {{ block.call.details?.type === "comparison" ? "方案对比" : block.call.details?.type === "file" ? "文件预览" : "可视化图表" }}
            </el-tag>
            <span class="wb-primary-title">
              {{ String(block.call.details?.title || summarizeCall(block.call)) }}
            </span>
          </div>
          <span v-if="block.call.durationMs !== undefined" class="wb-tool-dur">
            {{ formatDuration(block.call.durationMs) }}
          </span>
        </div>

        <div v-if="block.call.isError" class="wb-primary-error">
          {{ block.call.resultText || "可视化渲染失败" }}
        </div>

        <!-- Mermaid 图表 -->
        <div
          v-else-if="block.call.details?.type === 'diagram'"
          class="wb-viz-diagram"
        >
          <div class="wb-viz-toolbar">
            <span class="wb-viz-hint">Mermaid 架构 / 流程图</span>
            <el-button
              size="small"
              link
              type="primary"
              @click="copyText(String(block.call.details?.mermaid || ''))"
            >
              复制 Mermaid 源码
            </el-button>
          </div>
          <pre class="wb-mermaid-code">{{ String(block.call.details?.mermaid || "") }}</pre>
        </div>

        <!-- 多方案对比卡片 -->
        <div
          v-else-if="block.call.details?.type === 'comparison'"
          class="wb-viz-comparison"
        >
          <div
            v-for="(opt, idx) in asComparisonOptions(block.call.details?.options)"
            :key="idx"
            :class="['wb-cmp-col', { recommended: opt.recommended }]"
          >
            <div class="wb-cmp-head">
              <span class="wb-cmp-name">{{ opt.name }}</span>
              <el-tag v-if="opt.recommended" size="small" type="success">
                推荐
              </el-tag>
            </div>
            <p class="wb-cmp-desc">{{ opt.description }}</p>
            <div v-if="opt.pros.length > 0" class="wb-cmp-section">
              <div class="wb-cmp-label pro">优点</div>
              <ul>
                <li v-for="(p, pi) in opt.pros" :key="pi">{{ p }}</li>
              </ul>
            </div>
            <div v-if="opt.cons.length > 0" class="wb-cmp-section">
              <div class="wb-cmp-label con">缺点</div>
              <ul>
                <li v-for="(c, ci) in opt.cons" :key="ci">{{ c }}</li>
              </ul>
            </div>
            <pre v-if="opt.mermaid" class="wb-mermaid-code small">{{ opt.mermaid }}</pre>
          </div>
        </div>

        <!-- 工作区文件 / HTML 预览 -->
        <div
          v-else-if="block.call.details?.type === 'file'"
          class="wb-viz-file"
        >
          <div class="wb-viz-toolbar">
            <code>{{ asFileDetail(block.call.details?.file)?.path }}</code>
            <div v-if="block.call.details?.before" class="wb-viz-tabs">
              <el-radio-group
                :model-value="getFileTab(block.call.toolCallId)"
                size="small"
                @update:model-value="(val) => setFileTab(block.call.toolCallId, String(val))"
              >
                <el-radio-button value="after">当前 (After)</el-radio-button>
                <el-radio-button value="before">变更前 (Before)</el-radio-button>
              </el-radio-group>
            </div>
          </div>
          <template v-if="activePreviewFile(block.call)">
            <iframe
              v-if="isHtmlFile(activePreviewFile(block.call)!.ext)"
              class="wb-html-iframe"
              sandbox=""
              :srcdoc="activePreviewFile(block.call)!.content"
            />
            <pre v-else class="wb-code-out tall">{{
              activePreviewFile(block.call)!.content
            }}</pre>
          </template>
        </div>

        <pre v-else-if="block.call.resultText" class="wb-code-out">{{
          block.call.resultText
        }}</pre>
      </div>

      <!-- Interactive 工具卡片：ask_user_question 回执 -->
      <div
        v-else-if="block.kind === 'interactive'"
        class="wb-interactive-receipt"
        :class="{ waiting: block.call.status === 'waiting_input' }"
      >
        <div class="wb-interactive-head">
          <el-tag
            size="small"
            :type="block.call.status === 'waiting_input' ? 'warning' : 'success'"
          >
            {{ block.call.status === "waiting_input" ? "等待你的回答" : "已完成交互提问" }}
          </el-tag>
          <span class="wb-tool-summary">{{ summarizeCall(block.call) }}</span>
        </div>
        <pre
          v-if="block.call.status !== 'waiting_input' && block.call.resultText"
          class="wb-interactive-body"
        >{{ block.call.resultText }}</pre>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";
import { ElMessage } from "element-plus";
import type { WorkbenchToolCall } from "../../api";
import {
  groupToolCallsForRender,
  resolveWebTool,
  type ToolCardKind,
} from "./toolRegistry";

const props = defineProps<{
  toolCalls: WorkbenchToolCall[];
}>();

const expandedIds = reactive<Record<string, boolean>>({});
const fullOutputIds = reactive<Record<string, boolean>>({});
const filePreviewTabs = reactive<Record<string, "after" | "before">>({});

const blocks = computed(() => groupToolCallsForRender(props.toolCalls || []));

function cardKind(call: WorkbenchToolCall): ToolCardKind {
  return resolveWebTool(call.toolName).cardKind;
}

function summarizeCall(call: WorkbenchToolCall): string {
  return resolveWebTool(call.toolName).summarize(call);
}

function hasRunning(calls: WorkbenchToolCall[]): boolean {
  return calls.some((c) => c.status === "running");
}

function groupStatusClass(calls: WorkbenchToolCall[]): string {
  if (calls.some((c) => c.status === "running")) return "running";
  if (calls.some((c) => c.status === "error" || c.isError)) return "error";
  return "done";
}

function summarizeGroup(calls: WorkbenchToolCall[]): string {
  const names = [...new Set(calls.map((c) => c.toolName))];
  return names.slice(0, 4).join(" · ") + (names.length > 4 ? " ..." : "");
}

function statusTagType(call: WorkbenchToolCall) {
  if (call.status === "running") return "primary";
  if (call.status === "waiting_input") return "warning";
  if (call.status === "error" || call.isError) return "danger";
  return "success";
}

function statusLabel(call: WorkbenchToolCall): string {
  if (call.status === "running") return "执行中";
  if (call.status === "waiting_input") return "待输入";
  if (call.status === "error" || call.isError) return "失败";
  return "完成";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function toggleExpand(id: string) {
  expandedIds[id] = !expandedIds[id];
}

function isExpanded(id: string): boolean {
  return Boolean(expandedIds[id]);
}

function lineCount(text?: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function isLongOutput(text: string | undefined, id: string): boolean {
  if (!text || fullOutputIds[id]) return false;
  return text.split("\n").length > 16 || text.length > 1400;
}

function truncateOutput(text: string, id: string): string {
  if (fullOutputIds[id]) return text;
  const lines = text.split("\n");
  if (lines.length <= 16 && text.length <= 1400) return text;
  return lines.slice(0, 16).join("\n").slice(0, 1400) + "\n...";
}

function showFullOutput(id: string) {
  fullOutputIds[id] = true;
}

function formatJson(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

interface ComparisonOpt {
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  recommended: boolean;
  mermaid?: string;
}

function asComparisonOptions(raw: unknown): ComparisonOpt[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: any) => ({
    name: String(item?.name || "方案"),
    description: String(item?.description || ""),
    pros: Array.isArray(item?.pros) ? item.pros.map(String) : [],
    cons: Array.isArray(item?.cons) ? item.cons.map(String) : [],
    recommended: Boolean(item?.recommended),
    mermaid: typeof item?.mermaid === "string" ? item.mermaid : undefined,
  }));
}

interface FileDetail {
  path: string;
  content: string;
  ext: string;
  truncated?: boolean;
}

function asFileDetail(raw: unknown): FileDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.content !== "string") return null;
  return {
    path: String(obj.path || ""),
    content: obj.content,
    ext: String(obj.ext || ""),
    truncated: Boolean(obj.truncated),
  };
}

function getFileTab(id: string): "after" | "before" {
  return filePreviewTabs[id] || "after";
}

function setFileTab(id: string, val: string) {
  filePreviewTabs[id] = val === "before" ? "before" : "after";
}

function activePreviewFile(call: WorkbenchToolCall): FileDetail | null {
  const tab = getFileTab(call.toolCallId);
  if (tab === "before" && call.details?.before) {
    return asFileDetail(call.details.before);
  }
  return asFileDetail(call.details?.file);
}

function isHtmlFile(ext: string): boolean {
  return ext === "html" || ext === "htm";
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制到剪贴板");
  } catch {
    ElMessage.warning("复制失败，请手动选中复制");
  }
}
</script>

<style scoped>
.wb-tool-blocks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

.wb-routine-group {
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  background: #fafafa;
  overflow: hidden;
}

.wb-routine-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  color: #606266;
  user-select: none;
}

.wb-routine-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.wb-routine-dot.running {
  background: #409eff;
  box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.2);
}
.wb-routine-dot.done {
  background: #67c23a;
}
.wb-routine-dot.error {
  background: #f56c6c;
}

.wb-routine-title {
  font-weight: 600;
  color: #303133;
}

.wb-routine-preview {
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-routine-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px 10px;
  border-top: 1px solid #ebeef5;
}

.wb-tool-card {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #ffffff;
}

.wb-tool-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
}

.wb-tool-head-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.wb-tool-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  color: #303133;
}

.wb-tool-summary {
  color: #606266;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-tool-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.wb-tool-dur {
  font-size: 11px;
  color: #909399;
}

.wb-tool-toggle {
  font-size: 11px;
  color: #409eff;
}

.wb-tool-card-body {
  padding: 8px 10px;
  border-top: 1px solid #f2f6fc;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-bash-cmd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: #1e222a;
  color: #e6edf3;
  padding: 6px 8px;
  border-radius: 5px;
  overflow-x: auto;
}

.wb-code-out {
  margin: 0;
  padding: 8px;
  background: #f5f7fa;
  border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow: auto;
}
.wb-code-out.tall {
  max-height: 380px;
}

.wb-diff-box {
  border-radius: 5px;
  overflow: hidden;
  border: 1px solid #ebeef5;
}
.wb-diff-del {
  margin: 0;
  padding: 6px 8px;
  background: #fef0f0;
  color: #c45656;
  font-size: 11px;
  white-space: pre-wrap;
}
.wb-diff-add {
  margin: 0;
  padding: 6px 8px;
  background: #f0f9eb;
  color: #529b2e;
  font-size: 11px;
  white-space: pre-wrap;
}

.wb-kv-line {
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.wb-kv-k {
  color: #909399;
}

.wb-sub-details summary {
  font-size: 11px;
  color: #909399;
  cursor: pointer;
}

/* Primary visualize card */
.wb-primary-card {
  border: 1px solid #d9ecff;
  border-radius: 8px;
  background: #ffffff;
  overflow: hidden;
}
.wb-primary-card.is-error {
  border-color: #fde2e2;
}
.wb-primary-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f4f9ff;
  border-bottom: 1px solid #e6f0ff;
}
.wb-primary-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-primary-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}
.wb-primary-error {
  padding: 10px 12px;
  color: #f56c6c;
  font-size: 12px;
}

.wb-viz-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid #f2f6fc;
  font-size: 12px;
  color: #606266;
}
.wb-mermaid-code {
  margin: 0;
  padding: 10px 12px;
  background: #1e222a;
  color: #e6edf3;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-x: auto;
}
.wb-mermaid-code.small {
  margin-top: 6px;
  border-radius: 6px;
  font-size: 11px;
}

.wb-viz-comparison {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  padding: 12px;
}
.wb-cmp-col {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 10px;
  background: #fafafa;
}
.wb-cmp-col.recommended {
  border-color: #67c23a;
  background: #f6ffed;
}
.wb-cmp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.wb-cmp-name {
  font-weight: 600;
  font-size: 13px;
  color: #303133;
}
.wb-cmp-desc {
  margin: 0 0 8px;
  font-size: 12px;
  color: #606266;
  line-height: 1.5;
}
.wb-cmp-section {
  margin-top: 6px;
}
.wb-cmp-label {
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 3px;
}
.wb-cmp-label.pro {
  color: #529b2e;
}
.wb-cmp-label.con {
  color: #c45656;
}
.wb-cmp-section ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  color: #606266;
}

.wb-html-iframe {
  width: 100%;
  height: 320px;
  border: none;
  background: #ffffff;
}

/* Interactive receipt */
.wb-interactive-receipt {
  border: 1px solid #e1f3d8;
  background: #f0f9eb;
  border-radius: 8px;
  padding: 8px 10px;
}
.wb-interactive-receipt.waiting {
  border-color: #faecd8;
  background: #fdf6ec;
}
.wb-interactive-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.wb-interactive-body {
  margin: 6px 0 0;
  font-size: 12px;
  color: #606266;
  white-space: pre-wrap;
  font-family: inherit;
}
</style>
