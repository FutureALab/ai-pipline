<template>
  <div class="card-grid-page">
    <div class="page-header">
      <div>
        <h1 class="title">AI Skill 流水线工作台</h1>
        <p class="subtitle">管理、生成、流水线测试并发布自定义 OMP Skill</p>
      </div>
      <el-button type="primary" size="large" @click="$emit('create')">
        <el-icon><Plus /></el-icon>
        <span>新建 Skill</span>
      </el-button>
    </div>

    <el-skeleton v-if="loading" :rows="4" animated />

    <el-empty
      v-else-if="skills.length === 0"
      description="暂无 Skill，点击右上角「新建 Skill」开始创建"
    />

    <el-row v-else :gutter="20">
      <el-col
        v-for="skill in skills"
        :key="skill.skillName"
        :xs="24"
        :sm="12"
        :md="8"
        :lg="6"
        class="card-col"
      >
        <el-card
          class="skill-card"
          shadow="hover"
          @click="$emit('select', skill)"
        >
          <template #header>
            <div class="card-header">
              <span class="skill-name">{{ skill.skillName }}</span>
              <el-tag :type="statusTagType(skill.status)" size="small">
                {{ statusLabel(skill.status) }}
              </el-tag>
            </div>
          </template>

          <p class="skill-desc">{{ skill.description || "暂无简介描述" }}</p>

          <div class="progress-section">
            <div class="progress-meta">
              <span>当前进度：第 {{ skill.currentStep }} 步 / 共 3 步</span>
              <span>{{ skill.progress }}%</span>
            </div>
            <el-progress
              :percentage="skill.progress"
              :status="skill.status === 'published' ? 'success' : skill.status === 'test_failed' ? 'exception' : undefined"
              :stroke-width="8"
              :show-text="false"
            />
          </div>

          <div class="card-footer">
            <span class="meta-item">
              <el-icon><User /></el-icon>
              {{ skill.creator }}
            </span>
            <span class="meta-item">
              <el-icon><Clock /></el-icon>
              {{ formatDate(skill.createdAt) }}
            </span>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import type { SkillCardRecord, SkillLifecycleStatus } from "../api";

defineProps<{
  skills: SkillCardRecord[];
  loading: boolean;
}>();

defineEmits<{
  (e: "select", skill: SkillCardRecord): void;
  (e: "create"): void;
}>();

function statusLabel(status: SkillLifecycleStatus): string {
  const map: Record<SkillLifecycleStatus, string> = {
    draft: "第1步 · 生成/编辑",
    submitted: "第3步 · 待测试",
    testing: "第3步 · 测试中",
    test_passed: "第3步 · 测试通过",
    test_failed: "第3步 · 测试失败",
    published: "已发布",
  };
  return map[status] ?? status;
}

function statusTagType(
  status: SkillLifecycleStatus
): "info" | "warning" | "success" | "danger" | "primary" {
  switch (status) {
    case "published":
    case "test_passed":
      return "success";
    case "test_failed":
      return "danger";
    case "submitted":
    case "testing":
      return "warning";
    default:
      return "primary";
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<style scoped>
.card-grid-page {
  max-width: 1360px;
  margin: 0 auto;
  padding: 28px 24px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.title {
  margin: 0;
  font-size: 24px;
  color: #1f2937;
}

.subtitle {
  margin: 6px 0 0;
  font-size: 14px;
  color: #6b7280;
}

.card-col {
  margin-bottom: 20px;
}

.skill-card {
  cursor: pointer;
  height: 100%;
  display: flex;
  flex-direction: column;
  transition: transform 0.15s ease;
}

.skill-card:hover {
  transform: translateY(-2px);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.skill-name {
  font-weight: 600;
  font-size: 16px;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-desc {
  margin: 0 0 16px;
  font-size: 13px;
  color: #4b5563;
  line-height: 1.5;
  min-height: 40px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.progress-section {
  margin-bottom: 14px;
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}

.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: #9ca3af;
  border-top: 1px solid #f3f4f6;
  padding-top: 10px;
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
