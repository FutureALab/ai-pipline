<template>
  <div v-if="pendingQuestion" class="wb-question-dock">
    <div class="wb-qd-header">
      <div class="wb-qd-title">
        <el-tag size="small" type="warning" effect="dark">需要你的确认</el-tag>
        <span>
          {{ activeQuestion?.header || "请回答以下问题" }}
          <span v-if="questions.length > 1" class="wb-qd-pager">
            ({{ activeIndex + 1 }} / {{ questions.length }})
          </span>
        </span>
      </div>
      <div class="wb-qd-header-actions">
        <el-button
          v-if="questions.length > 1"
          size="small"
          text
          :disabled="activeIndex === 0"
          @click="activeIndex--"
        >
          上一题
        </el-button>
        <el-button
          v-if="questions.length > 1"
          size="small"
          text
          :disabled="activeIndex >= questions.length - 1"
          @click="activeIndex++"
        >
          下一题
        </el-button>
      </div>
    </div>

    <div v-if="activeQuestion" class="wb-qd-body">
      <div class="wb-qd-question">{{ activeQuestion.question }}</div>
      <pre v-if="activeQuestion.preview" class="wb-qd-preview">{{
        activeQuestion.preview
      }}</pre>

      <div class="wb-qd-options">
        <div
          v-for="opt in activeQuestion.options"
          :key="opt.label"
          :class="[
            'wb-qd-option',
            { selected: isSelected(activeQuestion.id, opt.label) },
          ]"
          @click="toggleOption(activeQuestion, opt.label)"
        >
          <div class="wb-qd-opt-top">
            <span class="wb-qd-opt-check">
              {{
                activeQuestion.multiSelect
                  ? isSelected(activeQuestion.id, opt.label)
                    ? "☑"
                    : "☐"
                  : isSelected(activeQuestion.id, opt.label)
                    ? "●"
                    : "○"
              }}
            </span>
            <span class="wb-qd-opt-label">{{ opt.label }}</span>
            <el-tag v-if="opt.recommended" size="small" type="success" effect="plain">
              推荐
            </el-tag>
          </div>
          <div v-if="opt.description" class="wb-qd-opt-desc">
            {{ opt.description }}
          </div>
          <div v-if="opt.recommendedReason" class="wb-qd-opt-reason">
            推荐理由：{{ opt.recommendedReason }}
          </div>
        </div>
      </div>

      <div class="wb-qd-extras">
        <el-input
          v-model="draftFor(activeQuestion.id).otherText"
          size="small"
          placeholder="其他自定义回答（可选）..."
          @input="onOtherInput(activeQuestion.id)"
        />
        <div class="wb-qd-discuss-row">
          <el-checkbox v-model="draftFor(activeQuestion.id).discussFirst">
            先讨论一下再决定
          </el-checkbox>
          <el-input
            v-if="draftFor(activeQuestion.id).discussFirst"
            v-model="draftFor(activeQuestion.id).discussNote"
            size="small"
            placeholder="希望 AI 解释哪部分？"
            style="flex: 1"
          />
        </div>
      </div>
    </div>

    <div class="wb-qd-footer">
      <div class="wb-qd-footer-left">
        <el-button size="small" text @click="handleChatInstead">
          改用对话回复
        </el-button>
        <el-button size="small" text type="info" @click="handleSkip">
          跳过
        </el-button>
      </div>
      <div class="wb-qd-footer-right">
        <el-button
          v-if="activeIndex < questions.length - 1"
          size="small"
          type="primary"
          plain
          @click="activeIndex++"
        >
          下一题 →
        </el-button>
        <el-button
          size="small"
          type="primary"
          :loading="submitting"
          @click="handleSubmit"
        >
          提交答案
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type {
  PendingUserQuestion,
  UserQuestionAnswerItem,
  UserQuestionItem,
  UserQuestionSubmission,
} from "../../api";

const props = defineProps<{
  pendingQuestion: PendingUserQuestion | null;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  (e: "submit", payload: UserQuestionSubmission): void;
}>();

interface DraftAnswer {
  selectedLabels: string[];
  otherText: string;
  discussFirst: boolean;
  discussNote: string;
}

const activeIndex = ref(0);
const drafts = reactive<Record<string, DraftAnswer>>({});

const questions = computed(() => props.pendingQuestion?.questions ?? []);
const activeQuestion = computed(() => questions.value[activeIndex.value] ?? null);

watch(
  () => props.pendingQuestion?.toolCallId,
  () => {
    activeIndex.value = 0;
    for (const key of Object.keys(drafts)) {
      delete drafts[key];
    }
    for (const q of props.pendingQuestion?.questions ?? []) {
      const rec = q.options.find((o) => o.recommended);
      drafts[q.id] = {
        selectedLabels: rec ? [rec.label] : [],
        otherText: "",
        discussFirst: false,
        discussNote: "",
      };
    }
  },
  { immediate: true }
);

function draftFor(questionId: string): DraftAnswer {
  if (!drafts[questionId]) {
    drafts[questionId] = {
      selectedLabels: [],
      otherText: "",
      discussFirst: false,
      discussNote: "",
    };
  }
  return drafts[questionId];
}

function isSelected(questionId: string, label: string): boolean {
  return draftFor(questionId).selectedLabels.includes(label);
}

function toggleOption(q: UserQuestionItem, label: string) {
  const d = draftFor(q.id);
  d.discussFirst = false;
  if (q.multiSelect) {
    const idx = d.selectedLabels.indexOf(label);
    if (idx >= 0) d.selectedLabels.splice(idx, 1);
    else d.selectedLabels.push(label);
  } else {
    d.selectedLabels = [label];
  }
}

function onOtherInput(questionId: string) {
  const d = draftFor(questionId);
  if (d.otherText.trim()) {
    d.discussFirst = false;
  }
}

function handleSubmit() {
  if (!props.pendingQuestion) return;
  const answers: UserQuestionAnswerItem[] = questions.value.map((q) => {
    const d = draftFor(q.id);
    return {
      questionId: q.id,
      selectedLabels: [...d.selectedLabels],
      ...(d.otherText.trim() ? { otherText: d.otherText.trim() } : {}),
      ...(d.discussFirst ? { discussFirst: true } : {}),
      ...(d.discussNote.trim() ? { discussNote: d.discussNote.trim() } : {}),
    };
  });
  emit("submit", {
    toolCallId: props.pendingQuestion.toolCallId,
    answers,
  });
}

function handleSkip() {
  if (!props.pendingQuestion) return;
  emit("submit", {
    toolCallId: props.pendingQuestion.toolCallId,
    answers: [],
    cancelled: true,
  });
}

function handleChatInstead() {
  if (!props.pendingQuestion) return;
  emit("submit", {
    toolCallId: props.pendingQuestion.toolCallId,
    answers: [],
    chatInstead: true,
  });
}
</script>

<style scoped>
.wb-question-dock {
  border: 1px solid #e6a23c;
  background: #fffdf7;
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 10px;
  box-shadow: 0 2px 8px rgba(230, 162, 60, 0.12);
}

.wb-qd-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.wb-qd-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.wb-qd-pager {
  font-weight: 400;
  color: #909399;
  font-size: 12px;
}

.wb-qd-question {
  font-size: 13px;
  color: #303133;
  margin-bottom: 8px;
  line-height: 1.5;
}

.wb-qd-preview {
  margin: 0 0 8px;
  padding: 8px;
  background: #f5f7fa;
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
}

.wb-qd-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.wb-qd-option {
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  padding: 8px 10px;
  background: #ffffff;
  cursor: pointer;
  transition: all 0.15s ease;
}
.wb-qd-option:hover {
  border-color: #409eff;
}
.wb-qd-option.selected {
  border-color: #409eff;
  background: #ecf5ff;
}

.wb-qd-opt-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
}
.wb-qd-opt-check {
  color: #409eff;
  font-size: 14px;
}
.wb-qd-opt-desc {
  margin-top: 4px;
  margin-left: 22px;
  font-size: 12px;
  color: #606266;
}
.wb-qd-opt-reason {
  margin-top: 3px;
  margin-left: 22px;
  font-size: 11px;
  color: #529b2e;
}

.wb-qd-extras {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.wb-qd-discuss-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wb-qd-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid #f2e6cf;
  padding-top: 8px;
}

.wb-qd-footer-left,
.wb-qd-footer-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
