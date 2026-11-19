<template>
  <div v-if="steps.length > 0 && !disabled" class="wb-next-steps">
    <span class="wb-ns-label">下一步建议：</span>
    <div class="wb-ns-chips">
      <button
        v-for="(step, idx) in steps"
        :key="idx"
        type="button"
        class="wb-ns-chip"
        :title="step.prompt"
        @click="emit('select', step.prompt)"
      >
        <span class="wb-ns-idx">{{ idx + 1 }}</span>
        <span>{{ step.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { WorkbenchNextStep } from "../../api";

defineProps<{
  steps: WorkbenchNextStep[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "select", prompt: string): void;
}>();
</script>

<style scoped>
.wb-next-steps {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0 8px;
}

.wb-ns-label {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}

.wb-ns-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wb-ns-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #d9ecff;
  background: #ecf5ff;
  color: #409eff;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.wb-ns-chip:hover {
  background: #409eff;
  color: #ffffff;
  border-color: #409eff;
}

.wb-ns-idx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(64, 158, 255, 0.15);
  font-size: 11px;
  font-weight: 600;
}
.wb-ns-chip:hover .wb-ns-idx {
  background: rgba(255, 255, 255, 0.25);
}
</style>
