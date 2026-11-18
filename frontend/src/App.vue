<template>
  <div class="app-shell">
    <SkillCardGrid
      v-if="viewMode === 'grid'"
      :skills="skills"
      :loading="loading"
      @select="openSkill"
      @create="createNewSkill"
    />

    <SkillWorkflow
      v-else
      :initial-skill-name="activeSkillName"
      @back="backToGrid"
      @published="backToGrid"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { fetchSkills, type SkillCardRecord } from "./api";
import SkillCardGrid from "./components/SkillCardGrid.vue";
import SkillWorkflow from "./components/SkillWorkflow.vue";

const viewMode = ref<"grid" | "workflow">("grid");
const loading = ref(false);
const skills = ref<SkillCardRecord[]>([]);
const activeSkillName = ref<string | null>(null);

async function loadSkills() {
  loading.value = true;
  try {
    const res = await fetchSkills();
    skills.value = res.skills;
  } catch (err) {
    ElMessage.error(
      err instanceof Error ? err.message : "无法连接到后端 API 服务"
    );
  } finally {
    loading.value = false;
  }
}

function openSkill(skill: SkillCardRecord) {
  activeSkillName.value = skill.skillName;
  viewMode.value = "workflow";
}

function createNewSkill() {
  activeSkillName.value = null;
  viewMode.value = "workflow";
}

async function backToGrid() {
  viewMode.value = "grid";
  await loadSkills();
}

onMounted(loadSkills);
</script>

<style>
body {
  margin: 0;
  background-color: #f5f7fa;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
}

.app-shell {
  min-height: 100vh;
}
</style>
