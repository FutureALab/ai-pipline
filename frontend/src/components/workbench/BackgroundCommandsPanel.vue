<template>
  <el-dialog
    :model-value="visible"
    title="受控后台命令 (background_command)"
    width="680px"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-empty
      v-if="commands.length === 0"
      description="当前会话没有启动后台命令（Agent 可通过 background_command 启动 dev server 或长耗时测试）"
      :image-size="64"
    />

    <div v-else class="wb-bg-list">
      <div v-for="cmd in commands" :key="cmd.id" class="wb-bg-card">
        <div class="wb-bg-head">
          <div class="wb-bg-left">
            <el-tag size="small" :type="statusType(cmd.status)">
              {{ statusText(cmd.status) }}
            </el-tag>
            <span class="wb-bg-name">{{ cmd.name }}</span>
            <code class="wb-bg-id">{{ cmd.id }}</code>
          </div>
          <div class="wb-bg-right">
            <span class="wb-bg-meta">{{ cmd.outputLines }} 行</span>
            <el-button
              v-if="cmd.status === 'running'"
              size="small"
              type="danger"
              plain
              @click="emit('stop', cmd.id)"
            >
              停止
            </el-button>
          </div>
        </div>

        <div class="wb-bg-cmd">$ {{ cmd.command }}</div>

        <div v-if="cmd.errorMessage" class="wb-bg-err">
          {{ cmd.errorMessage }}
        </div>

        <details class="wb-bg-logs" :open="cmd.status === 'running'">
          <summary>
            最近输出{{ cmd.outputTruncated ? "（已环形截断至最新缓冲）" : "" }}
          </summary>
          <pre class="wb-bg-out">{{ cmd.outputPreview || "（暂无输出）" }}</pre>
        </details>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import type {
  BackgroundCommandStatus,
  WorkbenchBackgroundCommandSnapshot,
} from "../../api";

defineProps<{
  visible: boolean;
  commands: WorkbenchBackgroundCommandSnapshot[];
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
  (e: "stop", commandId: string): void;
}>();

function statusType(status: BackgroundCommandStatus) {
  if (status === "running") return "primary";
  if (status === "stopping") return "warning";
  if (status === "completed") return "success";
  if (status === "error") return "danger";
  return "info";
}

function statusText(status: BackgroundCommandStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "stopping":
      return "停止中";
    case "completed":
      return "已完成";
    case "error":
      return "异常";
    case "stopped":
      return "已停止";
  }
}
</script>

<style scoped>
.wb-bg-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 480px;
  overflow-y: auto;
}

.wb-bg-card {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-bg-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.wb-bg-left,
.wb-bg-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wb-bg-name {
  font-weight: 600;
  font-size: 13px;
  color: #303133;
}

.wb-bg-id {
  font-size: 11px;
  color: #909399;
}

.wb-bg-meta {
  font-size: 12px;
  color: #909399;
}

.wb-bg-cmd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: #1e222a;
  color: #e6edf3;
  padding: 6px 8px;
  border-radius: 5px;
  overflow-x: auto;
}

.wb-bg-err {
  font-size: 12px;
  color: #f56c6c;
}

.wb-bg-logs summary {
  font-size: 12px;
  color: #606266;
  cursor: pointer;
}

.wb-bg-out {
  margin: 6px 0 0;
  padding: 8px;
  background: #ffffff;
  border: 1px solid #ebeef5;
  border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
