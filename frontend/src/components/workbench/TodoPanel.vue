<template>
  <el-dialog
    :model-value="visible"
    title="会话任务清单 (pi-todos)"
    width="620px"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="wb-todo-dialog">
      <div class="wb-todo-add-row">
        <el-input
          v-model="newTitle"
          size="small"
          placeholder="向待办队列追加一条任务（Agent 将在下一轮自动识别并规划）..."
          @keyup.enter="handleAdd"
        />
        <el-button
          size="small"
          type="primary"
          :disabled="!newTitle.trim()"
          @click="handleAdd"
        >
          添加
        </el-button>
      </div>

      <el-empty
        v-if="todos.groups.length === 0 && todos.loose.length === 0"
        description="当前会话暂无任务计划，可在对话中让 Agent 制定计划或在上方手动添加待办"
        :image-size="64"
      />

      <div v-else class="wb-todo-body">
        <div v-for="group in todos.groups" :key="group.id" class="wb-todo-group">
          <div class="wb-todo-group-head">
            <span class="wb-todo-group-title">{{ group.title }}</span>
            <el-tag
              size="small"
              :type="
                group.status === 'done'
                  ? 'success'
                  : group.status === 'active'
                    ? 'primary'
                    : 'info'
              "
            >
              {{ groupProgressText(group) }}
            </el-tag>
          </div>
          <div class="wb-todo-items">
            <div
              v-for="item in group.items"
              :key="item.id"
              :class="['wb-todo-item', `status-${item.status}`]"
            >
              <span class="wb-todo-icon">{{ statusIcon(item.status) }}</span>
              <div class="wb-todo-text">
                <div class="wb-todo-title">
                  {{ item.title }}
                  <el-tag
                    v-if="item.origin === 'user'"
                    size="small"
                    type="warning"
                    effect="plain"
                  >
                    我添加的
                  </el-tag>
                </div>
                <div v-if="item.note" class="wb-todo-note">{{ item.note }}</div>
              </div>
              <el-button
                link
                size="small"
                type="danger"
                @click="emit('remove', item.id)"
              >
                删除
              </el-button>
            </div>
          </div>
        </div>

        <div v-if="todos.loose.length > 0" class="wb-todo-group">
          <div class="wb-todo-group-head">
            <span class="wb-todo-group-title">待规划队列 (Loose)</span>
            <el-tag size="small" type="warning">{{ todos.loose.length }} 项</el-tag>
          </div>
          <div class="wb-todo-items">
            <div
              v-for="item in todos.loose"
              :key="item.id"
              :class="['wb-todo-item', `status-${item.status}`]"
            >
              <span class="wb-todo-icon">{{ statusIcon(item.status) }}</span>
              <div class="wb-todo-text">
                <div class="wb-todo-title">
                  {{ item.title }}
                  <el-tag
                    v-if="item.origin === 'user'"
                    size="small"
                    type="warning"
                    effect="plain"
                  >
                    我添加的
                  </el-tag>
                </div>
                <div v-if="item.note" class="wb-todo-note">{{ item.note }}</div>
              </div>
              <el-button
                link
                size="small"
                type="danger"
                @click="emit('remove', item.id)"
              >
                删除
              </el-button>
            </div>
          </div>
        </div>

        <div v-if="todos.summary" class="wb-todo-summary">
          <strong>完成总结：</strong>{{ todos.summary }}
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type {
  TodoItemStatus,
  WorkbenchTodoGroup,
  WorkbenchTodoState,
} from "../../api";

defineProps<{
  visible: boolean;
  todos: WorkbenchTodoState;
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
  (e: "add", title: string): void;
  (e: "remove", itemId: string): void;
}>();

const newTitle = ref("");

function handleAdd() {
  const title = newTitle.value.trim();
  if (!title) return;
  emit("add", title);
  newTitle.value = "";
}

function statusIcon(status: TodoItemStatus): string {
  if (status === "done") return "✓";
  if (status === "in_progress") return "▶";
  return "○";
}

function groupProgressText(group: WorkbenchTodoGroup): string {
  const done = group.items.filter((i) => i.status === "done").length;
  return `${done} / ${group.items.length}`;
}
</script>

<style scoped>
.wb-todo-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wb-todo-add-row {
  display: flex;
  gap: 8px;
}

.wb-todo-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 460px;
  overflow-y: auto;
}

.wb-todo-group {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
}

.wb-todo-group-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f5f7fa;
  border-bottom: 1px solid #ebeef5;
}

.wb-todo-group-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.wb-todo-items {
  display: flex;
  flex-direction: column;
}

.wb-todo-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #f2f6fc;
  font-size: 13px;
}
.wb-todo-item:last-child {
  border-bottom: none;
}
.wb-todo-item.status-in_progress {
  background: #ecf5ff;
}
.wb-todo-item.status-done .wb-todo-title {
  text-decoration: line-through;
  color: #909399;
}

.wb-todo-icon {
  width: 18px;
  text-align: center;
  font-weight: 700;
  flex-shrink: 0;
}
.wb-todo-item.status-done .wb-todo-icon {
  color: #67c23a;
}
.wb-todo-item.status-in_progress .wb-todo-icon {
  color: #409eff;
}
.wb-todo-item.status-pending .wb-todo-icon {
  color: #c0c4cc;
}

.wb-todo-text {
  flex: 1;
  min-width: 0;
}
.wb-todo-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wb-todo-note {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}

.wb-todo-summary {
  padding: 10px 12px;
  background: #f0f9eb;
  border: 1px solid #e1f3d8;
  border-radius: 8px;
  font-size: 12px;
  color: #529b2e;
}
</style>
