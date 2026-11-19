<template>
  <el-dialog
    :model-value="visible"
    title="创造模式工具扩展开关"
    width="620px"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
      title="前后端配对注册机制：关闭扩展后，新建会话将不再向模型注入对应工具（节省上下文 Token），历史消息里的工具卡片仍保持正常渲染。"
    />

    <div class="wb-ext-list">
      <div v-for="ext in extensions" :key="ext.id" class="wb-ext-item">
        <div class="wb-ext-info">
          <div class="wb-ext-title-row">
            <span class="wb-ext-title">{{ ext.title }}</span>
            <el-tag size="small" effect="plain">
              {{ ext.prominence }}
            </el-tag>
          </div>
          <div class="wb-ext-desc">{{ ext.description }}</div>
          <div class="wb-ext-tools">
            <code v-for="t in ext.toolNames" :key="t" class="wb-ext-tool-chip">
              {{ t }}
            </code>
          </div>
        </div>
        <el-switch
          :model-value="!disabledSet.has(ext.id)"
          @change="(val) => toggle(ext.id, Boolean(val))"
        />
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  WorkbenchExtensionDescriptor,
  WorkbenchExtensionId,
} from "../../api";

const props = defineProps<{
  visible: boolean;
  extensions: WorkbenchExtensionDescriptor[];
  disabledExtensions: string[];
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
  (e: "update:disabledExtensions", val: string[]): void;
}>();

const disabledSet = computed(() => new Set(props.disabledExtensions));

function toggle(id: WorkbenchExtensionId, enabled: boolean) {
  const next = new Set(props.disabledExtensions);
  if (enabled) next.delete(id);
  else next.add(id);
  emit("update:disabledExtensions", [...next]);
}
</script>

<style scoped>
.wb-ext-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wb-ext-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  background: #fafafa;
}

.wb-ext-info {
  flex: 1;
  min-width: 0;
}

.wb-ext-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.wb-ext-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.wb-ext-desc {
  font-size: 12px;
  color: #606266;
  line-height: 1.5;
  margin-bottom: 6px;
}

.wb-ext-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.wb-ext-tool-chip {
  font-size: 11px;
  padding: 1px 6px;
  background: #ffffff;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  color: #606266;
}
</style>
