<template>
  <div class="workflow-page">
    <div class="workflow-topbar">
      <el-button @click="$emit('back')">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回卡片列表</span>
      </el-button>
      <div class="topbar-title">
        <span>Skill 流程向导：</span>
        <strong>{{ form.skillName || "未命名 Skill" }}</strong>
      </div>
      <div class="step-switcher">
        <el-button-group>
          <el-button
            :type="activeStep === 0 ? 'primary' : 'default'"
            size="small"
            @click="switchStep(0)"
          >
            第一步：生成与编辑
          </el-button>
          <el-button
            :type="activeStep === 2 ? 'primary' : 'default'"
            size="small"
            :disabled="maxReachedStep < 2"
            @click="switchStep(2)"
          >
            第三步：测试与发布
          </el-button>
        </el-button-group>
      </div>
    </div>

    <el-card class="steps-card" shadow="never">
      <el-steps :active="activeStep" finish-status="success" align-center>
        <el-step
          title="第一步：生成与编辑"
          description="填写名称描述，AI 生成并编辑 SKILL.md"
          class="clickable-step"
          @click="switchStep(0)"
        />
        <el-step
          title="第二步：提交确认"
          description="确认 Skill 内容并写入默认目录"
          :class="{ 'clickable-step': maxReachedStep >= 2 }"
          @click="maxReachedStep >= 2 && switchStep(2)"
        />
        <el-step
          title="第三步：测试流水线与发布"
          description="选择应用与 10 个版本库，测试通过后发布"
          :class="{ 'clickable-step': maxReachedStep >= 2 }"
          @click="maxReachedStep >= 2 && switchStep(2)"
        />
      </el-steps>
    </el-card>

    <!-- 第一步：左右两栏（左侧基础信息与生成，右侧目录树 + VS Code 预览/编辑 + 下载） -->
    <div v-if="activeStep === 0" class="step-one-container">
      <el-row :gutter="20">
        <el-col :xs="24" :md="9">
          <el-card shadow="never" class="panel-card">
            <template #header>
              <div class="panel-title">Skill 基本信息与 AI 生成</div>
            </template>

            <el-form label-position="top">
              <el-form-item label="Skill 名称" required>
                <el-input
                  v-model="form.skillName"
                  placeholder="例如：code-review"
                  :disabled="!isNewSkill"
                />
              </el-form-item>

              <el-form-item label="Skill 简介与描述" required>
                <el-input
                  v-model="form.description"
                  type="textarea"
                  :rows="3"
                  placeholder="简述该 Skill 的核心用途与触发场景"
                />
              </el-form-item>

              <el-form-item label="创建人">
                <el-input v-model="form.creator" placeholder="例如：Admin" />
              </el-form-item>

              <el-form-item label="AI 生成提示词">
                <el-input
                  v-model="form.prompt"
                  type="textarea"
                  :rows="5"
                  placeholder="输入自定义提示词，例如：生成一个针对 TypeScript 仓库的代码审查 Skill，检查类型安全、异常处理和单测覆盖..."
                />
              </el-form-item>

              <el-form-item label="长任务超时时间（秒，超时自动中断）">
                <el-input-number
                  v-model="timeoutSeconds"
                  :min="10"
                  :max="600"
                  :step="10"
                  style="width: 100%"
                  :disabled="generating"
                />
              </el-form-item>

              <div class="gen-actions">
                <el-button
                  type="primary"
                  :loading="generating"
                  style="flex: 1"
                  @click="handleGenerate"
                >
                  <el-icon><MagicStick /></el-icon>
                  <span>{{ generating ? "AI 生成中..." : "AI 生成 Skill" }}</span>
                </el-button>

                <el-button
                  v-if="generating && currentJob"
                  type="danger"
                  plain
                  @click="handleAbortGeneration"
                >
                  中断任务
                </el-button>

                <el-button
                  v-if="currentJob"
                  type="warning"
                  plain
                  @click="handleRestartGeneration"
                >
                  重新启动
                </el-button>
              </div>

              <div v-if="currentJob" class="job-status-box">
                <div class="job-status-header">
                  <el-tag :type="jobTagType(currentJob.status)" size="small">
                    {{ jobStatusLabel(currentJob.status) }}
                  </el-tag>
                  <span class="job-elapsed">
                    耗时：{{ (currentJob.elapsedMs / 1000).toFixed(1) }}s /
                    {{ Math.round(currentJob.timeoutMs / 1000) }}s
                  </span>
                </div>
                <p v-if="currentJob.errorMessage" class="job-error-msg">
                  {{ currentJob.errorMessage }}
                </p>
              </div>
            </el-form>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="15">
          <el-card shadow="never" class="panel-card vscode-card">
            <template #header>
              <div class="editor-header">
                <div class="vscode-tab">
                  <span class="dot" />
                  <span>{{ activeFilePath || "SKILL.md" }}</span>
                </div>
                <div class="editor-toolbar">
                  <el-radio-group v-model="editorMode" size="small">
                    <el-radio-button value="preview">VS Code 预览</el-radio-button>
                    <el-radio-button value="edit">编辑</el-radio-button>
                  </el-radio-group>
                  <el-button
                    size="small"
                    type="primary"
                    plain
                    :disabled="!form.skillName.trim() || skillFiles.length === 0"
                    @click="handleDownloadSkill"
                  >
                    <el-icon><Download /></el-icon>
                    <span>下载 Skill</span>
                  </el-button>
                </div>
              </div>
            </template>

            <div class="vscode-explorer-layout">
              <!-- 左侧目录树：展示 SKILL.md 及 scripts/ 等生成文件 -->
              <div class="vscode-sidebar">
                <div class="sidebar-title">EXPLORER</div>
                <el-tree
                  v-if="fileTreeData.length > 0"
                  :data="fileTreeData"
                  node-key="path"
                  default-expand-all
                  highlight-current
                  :current-node-key="activeFilePath"
                  @node-click="handleTreeNodeClick"
                >
                  <template #default="{ data }">
                    <span class="tree-node-label">
                      <el-icon v-if="data.isDir"><Folder /></el-icon>
                      <el-icon v-else><Document /></el-icon>
                      <span>{{ data.label }}</span>
                    </span>
                  </template>
                </el-tree>
                <div v-else class="sidebar-empty">暂无文件</div>
              </div>

              <!-- 右侧单栏：编辑或 VS Code 预览（无分屏） -->
              <div class="vscode-main">
                <textarea
                  v-if="editorMode === 'edit'"
                  v-model="activeFileContent"
                  class="vscode-textarea"
                  placeholder="等待 AI 生成 SKILL.md，或直接在此编写 / 修改文件内容..."
                  spellcheck="false"
                />
                <div
                  v-else
                  class="vscode-markdown-preview"
                  v-html="renderedPreview"
                />
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <div class="step-actions">
        <el-button
          type="success"
          size="large"
          :loading="submitting"
          :disabled="!form.skillName.trim() || !hasSkillContent"
          @click="handleSubmitStepOne"
        >
          提交并进入第三步
        </el-button>
      </div>
    </div>

    <!-- 第三步：左侧栏表单（应用下拉 + 10 个版本库下拉），右侧栏测试流水线与日志 -->
    <div v-else class="step-three-container">
      <el-row :gutter="20">
        <el-col :xs="24" :md="9">
          <el-card shadow="never" class="panel-card">
            <template #header>
              <div class="panel-title">测试范围配置（应用与版本库）</div>
            </template>

            <el-form label-position="top">
              <el-form-item label="1. 相关应用（多选）" required>
                <el-select
                  v-model="selectedApps"
                  multiple
                  filterable
                  collapse-tags
                  collapse-tags-tooltip
                  placeholder="请选择要测试的相关应用"
                  style="width: 100%"
                >
                  <el-option
                    v-for="app in catalogApps"
                    :key="app.id"
                    :label="`${app.name} (${app.env})`"
                    :value="app.id"
                  />
                </el-select>
              </el-form-item>

              <el-form-item required>
                <template #label>
                  <div class="repo-label-row">
                    <span>2. Git 版本库（必选 10 个：{{ selectedRepos.length }} / 10）</span>
                    <el-button link type="primary" size="small" @click="selectTenRepos">
                      一键选择前 10 个
                    </el-button>
                  </div>
                </template>
                <el-select
                  v-model="selectedRepos"
                  multiple
                  filterable
                  collapse-tags
                  collapse-tags-tooltip
                  placeholder="请选择 10 个 Git 版本库"
                  style="width: 100%"
                >
                  <el-option
                    v-for="repo in catalogRepos"
                    :key="repo.id"
                    :label="`${repo.name} (${repo.branch})`"
                    :value="repo.id"
                  />
                </el-select>
              </el-form-item>

              <el-alert
                v-if="selectedRepos.length !== 10"
                :title="`当前已选 ${selectedRepos.length} 个版本库，有且必须选够 10 个才能运行测试流水线！`"
                type="warning"
                show-icon
                :closable="false"
                style="margin-bottom: 14px"
              />
              <el-alert
                v-else
                title="已选满 10 个 Git 版本库，可以运行测试流水线。"
                type="success"
                show-icon
                :closable="false"
                style="margin-bottom: 14px"
              />

              <el-form-item label="3. 流水线执行模式">
                <el-select v-model="pipelineMode" style="width: 100%">
                  <el-option label="模拟流水线（快速验证）" value="simulate" />
                  <el-option label="本地 Git Clone + pi-agent" value="real" />
                  <el-option label="Jenkins 远程调用（传递 XML 执行）" value="jenkins" />
                </el-select>
              </el-form-item>

              <el-button
                type="primary"
                :loading="testing"
                :disabled="selectedApps.length === 0 || selectedRepos.length !== 10"
                style="width: 100%"
                @click="handleRunPipeline"
              >
                {{ testing ? "流水线执行中..." : "运行测试流水线" }}
              </el-button>
            </el-form>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="15">
          <el-card shadow="never" class="panel-card">
            <template #header>
              <div class="repo-header">
                <span class="panel-title">测试流水线状态与日志</span>
                <el-tag
                  v-if="pipelineRuns.length > 0"
                  :type="allTestsPassed ? 'success' : 'danger'"
                >
                  {{ allTestsPassed ? "全部测试成功" : "存在失败流水线" }}
                </el-tag>
              </div>
            </template>

            <el-empty
              v-if="pipelineRuns.length === 0"
              description="请在左侧选择应用和 10 个版本库后，点击「运行测试流水线」"
            />

            <div v-else class="pipeline-results">
              <div class="run-list">
                <div
                  v-for="run in pipelineRuns"
                  :key="run.repoId"
                  class="run-row"
                  :class="{ active: activeLogRepoId === run.repoId }"
                  @click="activeLogRepoId = run.repoId"
                >
                  <div class="run-info">
                    <el-tag
                      size="small"
                      :type="run.status === 'success' ? 'success' : 'danger'"
                    >
                      {{ run.status === "success" ? "成功" : "失败" }}
                    </el-tag>
                    <span class="run-repo-name">{{ run.repoName }}</span>
                  </div>
                  <span class="run-duration">{{ run.durationMs }} ms</span>
                </div>
              </div>

              <div class="log-terminal">
                <div class="log-terminal-header">
                  <span>Jenkins 控制台日志 — {{ activeRun?.repoName }}</span>
                </div>
                <pre class="log-terminal-body">{{ activeRun?.logs.join("\n") }}</pre>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <div class="step-actions between">
        <el-button @click="switchStep(0)">返回第一步修改</el-button>
        <el-button
          type="success"
          size="large"
          :loading="publishing"
          :disabled="!allTestsPassed"
          @click="handlePublish"
        >
          发布 Skill
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Marked } from "marked";
import hljs from "highlight.js";
import {
  abortGenerationJob,
  fetchCatalog,
  fetchGenerationJob,
  fetchSkillDetail,
  getSkillDownloadUrl,
  publishSkill,
  restartGenerationJob,
  runTestPipeline,
  startGenerationJob,
  updateSkill,
  type AppCatalogItem,
  type GenerationJobSnapshot,
  type GenerationJobStatus,
  type RepoCatalogItem,
  type RepoPipelineRun,
  type SkillFileEntry,
} from "../api";

interface TreeNode {
  label: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

const props = defineProps<{
  initialSkillName: string | null;
}>();

const emit = defineEmits<{
  (e: "back"): void;
  (e: "published"): void;
}>();

const marked = new Marked({
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      const highlighted = hljs.highlight(text, { language }).value;
      return `<pre class="hljs"><code>${highlighted}</code></pre>`;
    },
  },
});

const activeStep = ref<0 | 2>(0);
const maxReachedStep = ref<0 | 2>(0);
const isNewSkill = ref(!props.initialSkillName);
const editorMode = ref<"preview" | "edit">("preview");

const generating = ref(false);
const submitting = ref(false);
const testing = ref(false);
const publishing = ref(false);
const timeoutSeconds = ref(120);
const currentJob = ref<GenerationJobSnapshot | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const form = reactive({
  skillName: props.initialSkillName ?? "",
  description: "",
  creator: "Admin",
  prompt: "",
});

const skillFiles = ref<SkillFileEntry[]>([{ path: "SKILL.md", content: "" }]);
const activeFilePath = ref<string>("SKILL.md");

const catalogApps = ref<AppCatalogItem[]>([]);
const catalogRepos = ref<RepoCatalogItem[]>([]);
const selectedApps = ref<string[]>([]);
const selectedRepos = ref<string[]>([]);
const pipelineMode = ref<"simulate" | "real" | "jenkins">("simulate");
const pipelineRuns = ref<RepoPipelineRun[]>([]);
const activeLogRepoId = ref<string>("");

const activeFileContent = computed({
  get() {
    return (
      skillFiles.value.find((f) => f.path === activeFilePath.value)?.content ?? ""
    );
  },
  set(val: string) {
    const target = skillFiles.value.find((f) => f.path === activeFilePath.value);
    if (target) {
      target.content = val;
    } else {
      skillFiles.value.push({ path: activeFilePath.value, content: val });
    }
  },
});

const hasSkillContent = computed(() =>
  skillFiles.value.some((f) => f.content.trim().length > 0)
);

const fileTreeData = computed<TreeNode[]>(() => {
  const root: TreeNode[] = [];

  for (const file of skillFiles.value) {
    const parts = file.path.split("/").filter(Boolean);
    let currentLevel = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isDir = i < parts.length - 1;

      let existing = currentLevel.find((n) => n.path === currentPath);
      if (!existing) {
        existing = {
          label: part,
          path: currentPath,
          isDir,
          ...(isDir ? { children: [] } : {}),
        };
        currentLevel.push(existing);
      }
      if (isDir && existing.children) {
        currentLevel = existing.children;
      }
    }
  }

  return root;
});

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const renderedPreview = computed(() => {
  const content = activeFileContent.value;
  if (!content.trim()) {
    return '<p class="empty-preview">AI 生成后将在此处以 VS Code 样式实时渲染...</p>';
  }

  const lower = activeFilePath.value.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return marked.parse(content) as string;
  }

  const ext = lower.split(".").pop() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    js: "javascript",
    sh: "bash",
    bash: "bash",
    py: "python",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
  };
  const lang = langMap[ext];
  const highlighted =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(content, { language: lang }).value
      : escapeHtml(content);

  return `<pre class="hljs code-file-preview"><code>${highlighted}</code></pre>`;
});

const allTestsPassed = computed(
  () =>
    pipelineRuns.value.length === 10 &&
    pipelineRuns.value.every((r) => r.status === "success")
);

const activeRun = computed(
  () =>
    pipelineRuns.value.find((r) => r.repoId === activeLogRepoId.value) ??
    pipelineRuns.value[0]
);

function switchStep(step: 0 | 2) {
  if (step === 2 && maxReachedStep.value < 2) {
    return;
  }
  activeStep.value = step;
}

function handleTreeNodeClick(node: TreeNode) {
  if (!node.isDir) {
    activeFilePath.value = node.path;
  }
}

function handleDownloadSkill() {
  if (!form.skillName.trim()) return;
  const link = document.createElement("a");
  link.href = getSkillDownloadUrl(form.skillName);
  link.download = `${form.skillName}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

onMounted(async () => {
  try {
    const catalog = await fetchCatalog();
    catalogApps.value = catalog.apps;
    catalogRepos.value = catalog.repos;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加载应用与仓库列表失败");
  }

  if (props.initialSkillName) {
    try {
      const detail = await fetchSkillDetail(props.initialSkillName);
      form.skillName = detail.card.skillName;
      form.description = detail.card.description;
      form.creator = detail.card.creator;
      skillFiles.value =
        detail.files && detail.files.length > 0
          ? detail.files
          : [{ path: "SKILL.md", content: detail.content }];
      activeFilePath.value = skillFiles.value[0]?.path || "SKILL.md";
      selectedApps.value = detail.card.selectedApps;
      selectedRepos.value = detail.card.selectedRepos;
      pipelineRuns.value = detail.card.pipelineRuns;
      if (detail.card.pipelineRuns.length > 0) {
        activeLogRepoId.value = detail.card.pipelineRuns[0].repoId;
      }
      if (detail.card.currentStep >= 2) {
        maxReachedStep.value = 2;
      }
      // 点击卡片默认进入第一步
      activeStep.value = 0;
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : "加载 Skill 详情失败");
    }
  }
});

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onUnmounted(() => {
  stopPolling();
});

function jobStatusLabel(status: GenerationJobStatus): string {
  const map: Record<GenerationJobStatus, string> = {
    running: "长任务执行中",
    completed: "生成完成",
    failed: "生成失败",
    aborted: "已手动中断",
    timeout: "执行超时已中断",
  };
  return map[status] ?? status;
}

function jobTagType(
  status: GenerationJobStatus
): "info" | "warning" | "success" | "danger" | "primary" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "timeout":
      return "danger";
    case "aborted":
      return "warning";
    default:
      return "primary";
  }
}

function beginJobPolling(jobId: string) {
  stopPolling();
  generating.value = true;

  pollTimer = setInterval(async () => {
    try {
      const { job } = await fetchGenerationJob(jobId);
      currentJob.value = job;

      if (job.streamedContent) {
        const mdFile = skillFiles.value.find((f) => f.path === "SKILL.md");
        if (mdFile) {
          mdFile.content = job.streamedContent;
        } else {
          skillFiles.value.unshift({ path: "SKILL.md", content: job.streamedContent });
        }
        activeFilePath.value = "SKILL.md";
      }

      if (job.status !== "running") {
        stopPolling();
        generating.value = false;

        if (job.status === "completed" && job.result) {
          form.skillName = job.result.skillName;
          skillFiles.value =
            job.result.files && job.result.files.length > 0
              ? job.result.files
              : [{ path: "SKILL.md", content: job.result.content }];
          activeFilePath.value = skillFiles.value[0]?.path || "SKILL.md";
          if (!form.description) {
            form.description = job.result.card.description;
          }
          isNewSkill.value = false;
          ElMessage.success(`Skill "${job.result.skillName}" 已生成并保存到默认目录`);
        } else if (job.status === "aborted") {
          ElMessage.warning(job.errorMessage || "生成任务已中断，可随时重新启动");
        } else if (job.status === "timeout") {
          ElMessage.error(job.errorMessage || "生成超时，已中断，可点击重新启动");
        } else if (job.status === "failed") {
          ElMessage.error(job.errorMessage || "AI 生成失败");
        }
      }
    } catch (err) {
      stopPolling();
      generating.value = false;
      ElMessage.error(err instanceof Error ? err.message : "查询生成任务状态失败");
    }
  }, 800);
}

async function handleGenerate() {
  if (!form.prompt.trim()) {
    ElMessage.warning("请先填写 AI 生成提示词");
    return;
  }
  generating.value = true;
  try {
    const { job } = await startGenerationJob({
      skillName: form.skillName || undefined,
      description: form.description || undefined,
      creator: form.creator || "Admin",
      prompt: form.prompt,
      timeoutMs: timeoutSeconds.value * 1000,
    });
    currentJob.value = job;
    beginJobPolling(job.jobId);
  } catch (err) {
    generating.value = false;
    ElMessage.error(err instanceof Error ? err.message : "启动生成任务失败");
  }
}

async function handleAbortGeneration() {
  if (!currentJob.value) return;
  try {
    const { job } = await abortGenerationJob(
      currentJob.value.jobId,
      "用户手动中断了生成任务"
    );
    currentJob.value = job;
    stopPolling();
    generating.value = false;
    ElMessage.warning("已中断当前生成任务，可点击「重新启动」继续");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "中断任务失败");
  }
}

async function handleRestartGeneration() {
  if (!currentJob.value) return;
  try {
    const { job } = await restartGenerationJob(currentJob.value.jobId, {
      prompt: form.prompt,
      timeoutMs: timeoutSeconds.value * 1000,
    });
    currentJob.value = job;
    beginJobPolling(job.jobId);
    ElMessage.info("已中断旧任务并重新启动 AI 生成");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "重新启动任务失败");
  }
}

async function handleSubmitStepOne() {
  if (!form.skillName.trim() || !hasSkillContent.value) {
    ElMessage.warning("请确保 Skill 名称和内容不为空");
    return;
  }
  submitting.value = true;
  try {
    const res = await updateSkill(form.skillName, {
      description: form.description,
      creator: form.creator,
      files: skillFiles.value,
      replaceFiles: true,
      submit: true,
    });
    skillFiles.value = res.files;
    isNewSkill.value = false;
    maxReachedStep.value = 2;
    activeStep.value = 2;
    ElMessage.success("已提交保存，进入第三步：选择应用与 10 个版本库进行测试");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "提交失败");
  } finally {
    submitting.value = false;
  }
}

function selectTenRepos() {
  selectedRepos.value = catalogRepos.value.slice(0, 10).map((r) => r.id);
}

async function handleRunPipeline() {
  if (selectedApps.value.length === 0) {
    ElMessage.warning("请至少选择 1 个相关应用");
    return;
  }
  if (selectedRepos.value.length !== 10) {
    ElMessage.warning(`必须选够 10 个 Git 版本库（当前 ${selectedRepos.value.length} 个）`);
    return;
  }

  testing.value = true;
  try {
    const res = await runTestPipeline(form.skillName, {
      apps: selectedApps.value,
      repos: selectedRepos.value,
      mode: pipelineMode.value,
    });
    pipelineRuns.value = res.pipelineRuns;
    if (res.pipelineRuns.length > 0) {
      activeLogRepoId.value = res.pipelineRuns[0].repoId;
    }
    if (res.allPassed) {
      ElMessage.success("10 个版本库流水线全部测试成功，可以点击发布了！");
    } else {
      ElMessage.error("部分测试流水线失败，请查看控制台日志");
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "流水线执行失败");
  } finally {
    testing.value = false;
  }
}

async function handlePublish() {
  if (!allTestsPassed.value) {
    ElMessage.warning("请先确保 10 个版本库测试全部通过");
    return;
  }
  publishing.value = true;
  try {
    await publishSkill(form.skillName);
    ElMessage.success(`Skill "${form.skillName}" 发布成功！`);
    emit("published");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "发布失败");
  } finally {
    publishing.value = false;
  }
}
</script>

<style scoped>
.workflow-page {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px 24px 40px;
}

.workflow-topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 12px;
}

.topbar-title {
  font-size: 16px;
  color: #374151;
}

.steps-card {
  margin-bottom: 20px;
}

.clickable-step {
  cursor: pointer;
}

.panel-card {
  height: 100%;
}

.panel-title {
  font-weight: 600;
  font-size: 15px;
  color: #111827;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.vscode-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
}

.vscode-tab .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3b82f6;
}

.vscode-explorer-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 12px;
  height: 520px;
}

.vscode-sidebar {
  border: 1px solid #2d2d2d;
  border-radius: 6px;
  background: #252526;
  color: #cccccc;
  overflow-y: auto;
  padding: 8px 4px;
}

.sidebar-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #9ca3af;
  padding: 4px 10px 8px;
}

.vscode-sidebar :deep(.el-tree) {
  background: transparent;
  color: #d4d4d4;
}

.vscode-sidebar :deep(.el-tree-node__content:hover) {
  background: #2a2d2e;
}

.vscode-sidebar :deep(.el-tree--highlight-current .el-tree-node.is-current > .el-tree-node__content) {
  background: #094771;
  color: #ffffff;
}

.tree-node-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.sidebar-empty {
  padding: 12px;
  font-size: 12px;
  color: #6b7280;
}

.vscode-main {
  height: 100%;
  min-width: 0;
}

.vscode-textarea {
  width: 100%;
  height: 100%;
  resize: none;
  border: 1px solid #2d2d2d;
  border-radius: 6px;
  padding: 14px;
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  outline: none;
}

.vscode-markdown-preview {
  height: 100%;
  overflow-y: auto;
  border: 1px solid #2d2d2d;
  border-radius: 6px;
  padding: 16px 20px;
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.65;
  box-sizing: border-box;
}

.vscode-markdown-preview :deep(h1),
.vscode-markdown-preview :deep(h2),
.vscode-markdown-preview :deep(h3) {
  color: #ffffff;
  border-bottom: 1px solid #333;
  padding-bottom: 4px;
  margin-top: 16px;
}

.vscode-markdown-preview :deep(code) {
  background: #2d2d2d;
  padding: 2px 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
}

.vscode-markdown-preview :deep(pre.hljs) {
  background: #141414;
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  border: 1px solid #303030;
}

.vscode-markdown-preview :deep(pre.hljs.code-file-preview) {
  margin: 0;
  min-height: 100%;
  box-sizing: border-box;
}

.vscode-markdown-preview :deep(pre.hljs code) {
  background: transparent;
  padding: 0;
}

.vscode-markdown-preview :deep(blockquote) {
  border-left: 3px solid #3b82f6;
  margin: 10px 0;
  padding-left: 12px;
  color: #9ca3af;
}

.empty-preview {
  color: #6b7280;
}

.step-actions {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.step-actions.between {
  justify-content: space-between;
}

.gen-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.job-status-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
}

.job-status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.job-elapsed {
  font-size: 12px;
  color: #6b7280;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.job-error-msg {
  margin: 8px 0 0;
  font-size: 12px;
  color: #dc2626;
  line-height: 1.5;
}

.repo-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.repo-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.pipeline-results {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.run-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
}

.run-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid #f3f4f6;
}

.run-row:hover {
  background: #f9fafb;
}

.run-row.active {
  background: #eff6ff;
}

.run-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.run-repo-name {
  font-weight: 500;
  font-size: 13px;
}

.run-duration {
  font-size: 12px;
  color: #6b7280;
}

.log-terminal {
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #2d2d2d;
}

.log-terminal-header {
  background: #252526;
  color: #cccccc;
  padding: 8px 12px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.log-terminal-body {
  margin: 0;
  padding: 12px;
  background: #141414;
  color: #a7f3d0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  max-height: 260px;
  overflow-y: auto;
  white-space: pre-wrap;
}
</style>
