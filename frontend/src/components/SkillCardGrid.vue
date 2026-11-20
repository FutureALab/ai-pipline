<template>
  <div class="card-grid-page">
    <div class="page-header">
      <div>
        <h1 class="title">AI Skill 流水线工作台</h1>
        <p class="subtitle">管理、生成、流水线测试并发布自定义 OMP Skill</p>
      </div>
      <div class="header-actions">
        <el-button size="large" @click="openUploadDialog">
          <el-icon><Upload /></el-icon>
          <span>上传 Skill</span>
        </el-button>
        <el-button type="primary" size="large" @click="$emit('create')">
          <el-icon><Plus /></el-icon>
          <span>新建 Skill</span>
        </el-button>
      </div>
    </div>

    <el-skeleton v-if="loading" :rows="4" animated />

    <el-empty
      v-else-if="skills.length === 0"
      description="暂无 Skill，点击右上角「上传 Skill」或「新建 Skill」开始"
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
              <div class="card-header-right" @click.stop>
                <el-tag :type="statusTagType(skill.status)" size="small">
                  {{ statusLabel(skill.status) }}
                </el-tag>
                <el-popover
                  placement="bottom-end"
                  :width="160"
                  trigger="click"
                  :teleported="true"
                >
                  <template #reference>
                    <button
                      type="button"
                      class="more-dots-btn"
                      title="更多操作"
                      @click.stop
                    >
                      <el-icon><MoreFilled /></el-icon>
                    </button>
                  </template>
                  <div class="card-more-menu" @click.stop>
                    <button
                      type="button"
                      class="more-menu-item"
                      @click="openRunSkillDialog(skill)"
                    >
                      <el-icon><VideoPlay /></el-icon>
                      <span>直接使用 Skill</span>
                    </button>
                    <button
                      type="button"
                      class="more-menu-item danger"
                      @click="handleDeleteSkill(skill)"
                    >
                      <el-icon><Delete /></el-icon>
                      <span>删除 Skill</span>
                    </button>
                  </div>
                </el-popover>
              </div>
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

    <!-- 上传 Skill 弹窗 -->
    <el-dialog
      v-model="uploadDialogVisible"
      title="上传本地 Skill"
      width="540px"
      :close-on-click-modal="!uploading"
    >
      <div
        class="upload-dropzone"
        :class="{ 'is-dragging': isDragging }"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleDrop"
      >
        <el-icon class="dropzone-icon"><UploadFilled /></el-icon>
        <div class="dropzone-title">
          拖拽 Skill ZIP 包或 SKILL.md 到此处
        </div>
        <div class="dropzone-sub">
          支持 .zip 压缩包（含 SKILL.md / scripts / references / assets）、单个 SKILL.md 或本地整个 Skill 文件夹
        </div>
        <div class="dropzone-btns">
          <el-button size="small" type="primary" plain @click="triggerFilePick">
            选择 ZIP / 文件
          </el-button>
          <el-button size="small" plain @click="triggerFolderPick">
            选择 Skill 文件夹
          </el-button>
        </div>
        <input
          ref="fileInputRef"
          type="file"
          multiple
          accept=".zip,.md,.txt,.sh,.py,.js,.ts,.json,.yaml,.yml"
          style="display: none"
          @change="handleFileInputChange"
        />
        <input
          ref="folderInputRef"
          type="file"
          webkitdirectory
          multiple
          style="display: none"
          @change="handleFileInputChange"
        />
      </div>

      <div v-if="uploadSummary" class="upload-preview-box">
        <div class="upload-preview-head">
          <span>{{ uploadSummary }}</span>
          <el-button link type="danger" size="small" @click="clearSelectedUpload">
            清空
          </el-button>
        </div>
        <div v-if="selectedFilePaths.length > 0" class="upload-file-chips">
          <code
            v-for="p in selectedFilePaths.slice(0, 12)"
            :key="p"
            :class="['upload-file-chip', { 'is-main': p === 'SKILL.md' || p.endsWith('/SKILL.md') }]"
          >
            {{ p }}
          </code>
          <span v-if="selectedFilePaths.length > 12" class="upload-more">
            等共 {{ selectedFilePaths.length }} 个文件
          </span>
        </div>
      </div>

      <el-form label-position="top" style="margin-top: 14px">
        <el-form-item label="Skill 名称（可选，留空自动从 SKILL.md / 文件名提取）">
          <el-input
            v-model="uploadForm.skillName"
            placeholder="例如：api-security-audit（kebab-case）"
          />
        </el-form-item>
        <el-form-item label="简介描述（可选，留空自动提取）">
          <el-input
            v-model="uploadForm.description"
            placeholder="简述该 Skill 的适用场景与功能"
          />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="uploadForm.creator" placeholder="Admin" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button :disabled="uploading" @click="uploadDialogVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="uploading"
          :disabled="!hasSelectedPayload"
          @click="handleConfirmUpload"
        >
          确认上传
        </el-button>
      </template>
    </el-dialog>

    <!-- 直接使用 Skill（创建多个 Jenkins 任务并执行打包后的二进制）弹窗 -->
    <el-dialog
      v-model="runDialogVisible"
      :title="`直接使用 Skill：${runTargetSkill?.skillName || ''}`"
      width="680px"
      :close-on-click-modal="!runningSkill"
      @closed="stopRunPolling"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 14px"
        title="后端将自动把当前 Skill 从数据库打包进 ai-pipeline 二进制可执行文件，并为所选的每个 Git 版本库创建独立的 Jenkins 任务直接执行该二进制。"
      />

      <el-form label-position="top">
        <el-form-item required>
          <template #label>
            <div class="run-label-row">
              <span>1. 选择相关应用（可多选：已选 {{ runForm.apps.length }} 个）</span>
              <div class="run-label-links">
                <el-button link type="primary" size="small" @click="selectAllRunApps">
                  全选
                </el-button>
                <el-button link size="small" @click="runForm.apps = []">
                  清空
                </el-button>
              </div>
            </div>
          </template>
          <el-select
            v-model="runForm.apps"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            :loading="loadingCatalog"
            placeholder="请选择一个或多个相关应用"
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
            <div class="run-label-row">
              <span>2. 选择 Git 版本库（可多选：已选 {{ runForm.repos.length }} 个，每个版本库将生成一个 Jenkins 任务）</span>
              <div class="run-label-links">
                <el-button link type="primary" size="small" @click="selectAllRunRepos">
                  全选
                </el-button>
                <el-button link size="small" @click="runForm.repos = []">
                  清空
                </el-button>
              </div>
            </div>
          </template>
          <el-select
            v-model="runForm.repos"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            :loading="loadingCatalog"
            placeholder="请选择一个或多个 Git 版本库"
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

        <el-form-item label="3. 附加任务提示词（可选）">
          <el-input
            v-model="runForm.taskPrompt"
            type="textarea"
            :rows="2"
            placeholder="留空则按 Skill 默认工作流直接对所选应用与版本库执行..."
          />
        </el-form-item>
      </el-form>

      <!-- Jenkins 任务执行列表与控制台日志 -->
      <div v-if="runJobs.length > 0" class="run-jobs-panel">
        <div class="run-jobs-title">
          <span>已创建的 Jenkins 任务（{{ runJobs.length }} 个）</span>
          <el-tag v-if="runBinaryTarget" size="small" type="success" effect="plain">
            二进制目标: {{ runBinaryTarget }}
          </el-tag>
        </div>

        <div class="run-jobs-list">
          <div
            v-for="job in runJobs"
            :key="job.repoId"
            :class="['run-job-item', { active: activeRunRepoId === job.repoId }]"
            @click="activeRunRepoId = job.repoId"
          >
            <div class="run-job-left">
              <el-tag
                size="small"
                :type="
                  job.status === 'success'
                    ? 'success'
                    : job.status === 'failed'
                      ? 'danger'
                      : 'warning'
                "
              >
                {{
                  job.status === "success"
                    ? "成功"
                    : job.status === "failed"
                      ? "失败"
                      : "执行中"
                }}
              </el-tag>
              <span class="run-job-repo">{{ job.repoName }}</span>
              <code v-if="job.jenkinsJobName" class="run-job-name">
                {{ job.jenkinsJobName }}{{ job.jenkinsBuildNumber ? ` #${job.jenkinsBuildNumber}` : "" }}
              </code>
            </div>
            <div class="run-job-right">
              <a
                v-if="job.jenkinsBuildUrl"
                :href="job.jenkinsBuildUrl"
                target="_blank"
                rel="noopener"
                class="run-job-link"
                @click.stop
              >
                Jenkins 控制台
              </a>
              <span class="run-job-dur">{{ job.durationMs }} ms</span>
            </div>
          </div>
        </div>

        <div v-if="activeRunJob" class="run-job-console">
          <div class="run-console-head">
            Jenkins 日志 — {{ activeRunJob.repoName }}
          </div>
          <pre class="run-console-body">{{ activeRunJob.logs.join("\n") }}</pre>
        </div>
      </div>

      <template #footer>
        <el-button :disabled="runningSkill" @click="runDialogVisible = false">
          关闭
        </el-button>
        <el-button
          type="primary"
          :loading="runningSkill"
          :disabled="runForm.apps.length === 0 || runForm.repos.length === 0"
          @click="handleExecuteRunSkill"
        >
          打包二进制并创建 Jenkins 任务
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  deleteSkill,
  fetchCatalog,
  fetchSkillDetail,
  runSkillOnJenkins,
  uploadSkill,
  type AppCatalogItem,
  type RepoCatalogItem,
  type RepoPipelineRun,
  type SkillCardRecord,
  type SkillLifecycleStatus,
} from "../api";

defineProps<{
  skills: SkillCardRecord[];
  loading: boolean;
}>();

const emit = defineEmits<{
  (e: "select", skill: SkillCardRecord): void;
  (e: "create"): void;
  (e: "uploaded", skill: SkillCardRecord): void;
}>();

const uploadDialogVisible = ref(false);
const uploading = ref(false);
const isDragging = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const folderInputRef = ref<HTMLInputElement | null>(null);

const uploadForm = reactive({
  skillName: "",
  description: "",
  creator: "Admin",
});

const selectedZipBase64 = ref("");
const selectedFileName = ref("");
const selectedFiles = ref<
  Array<{ path: string; content: string; encoding: "utf-8" | "base64" }>
>([]);

const hasSelectedPayload = computed(
  () => Boolean(selectedZipBase64.value) || selectedFiles.value.length > 0
);

const selectedFilePaths = computed(() =>
  selectedFiles.value.map((f) => f.path)
);

const uploadSummary = computed(() => {
  if (selectedZipBase64.value) {
    return `已选择 ZIP 压缩包：${selectedFileName.value}`;
  }
  if (selectedFiles.value.length > 0) {
    return `已选择 ${selectedFiles.value.length} 个文件`;
  }
  return "";
});

function openUploadDialog() {
  clearSelectedUpload();
  uploadForm.skillName = "";
  uploadForm.description = "";
  uploadDialogVisible.value = true;
}

function clearSelectedUpload() {
  selectedZipBase64.value = "";
  selectedFileName.value = "";
  selectedFiles.value = [];
  if (fileInputRef.value) fileInputRef.value.value = "";
  if (folderInputRef.value) folderInputRef.value.value = "";
}

function triggerFilePick() {
  fileInputRef.value?.click();
}

function triggerFolderPick() {
  folderInputRef.value?.click();
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsText(file, "utf-8");
  });
}

function isLikelyBinaryName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|wasm|node|exe|bin|woff2?|ttf|eot|mp4|mp3)$/i.test(
    name
  );
}

function tryPrefillFromSkillMd(markdown: string, fallbackName: string) {
  const fmMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (nameMatch && !uploadForm.skillName.trim()) {
      uploadForm.skillName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    if (descMatch && !uploadForm.description.trim()) {
      uploadForm.description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (!uploadForm.skillName.trim() && fallbackName) {
    uploadForm.skillName = fallbackName
      .replace(/\.(zip|md)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}

async function processPickedFiles(fileList: FileList | File[]) {
  const arr = Array.from(fileList).filter((f) => {
    const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(
      /\\/g,
      "/"
    );
    return !rel.split("/").some((seg) => seg === ".DS_Store" || seg === "__MACOSX");
  });
  if (arr.length === 0) return;

  clearSelectedUpload();

  // Single ZIP package
  if (arr.length === 1 && arr[0].name.toLowerCase().endsWith(".zip")) {
    const file = arr[0];
    const dataUrl = await readAsDataUrl(file);
    selectedZipBase64.value = dataUrl;
    selectedFileName.value = file.name;
    if (!uploadForm.skillName.trim()) {
      uploadForm.skillName = file.name
        .replace(/\.zip$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }
    return;
  }

  // Multiple files or folder
  const collected: Array<{
    path: string;
    content: string;
    encoding: "utf-8" | "base64";
  }> = [];

  for (const file of arr) {
    const relPath = (
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name
    )
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");

    if (isLikelyBinaryName(relPath)) {
      const dataUrl = await readAsDataUrl(file);
      const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      collected.push({ path: relPath, content: b64, encoding: "base64" });
    } else {
      const text = await readAsText(file);
      collected.push({ path: relPath, content: text, encoding: "utf-8" });
      if (relPath === "SKILL.md" || relPath.endsWith("/SKILL.md")) {
        const folderGuess = relPath.includes("/") ? relPath.split("/")[0] : "";
        tryPrefillFromSkillMd(text, folderGuess);
      }
    }
  }

  // If user selected a single .md file not named SKILL.md, prefill from it too
  if (
    collected.length === 1 &&
    collected[0].encoding === "utf-8" &&
    collected[0].path.toLowerCase().endsWith(".md")
  ) {
    tryPrefillFromSkillMd(collected[0].content, collected[0].path);
  }

  selectedFiles.value = collected;
  selectedFileName.value = arr[0]?.name || "";
}

async function handleFileInputChange(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;
  try {
    await processPickedFiles(input.files);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "读取文件失败");
  }
}

async function handleDrop(e: DragEvent) {
  isDragging.value = false;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  try {
    await processPickedFiles(files);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "读取拖拽文件失败");
  }
}

async function handleConfirmUpload() {
  if (!hasSelectedPayload.value) {
    ElMessage.warning("请先选择要上传的 Skill 文件或压缩包");
    return;
  }

  uploading.value = true;
  try {
    const res = await uploadSkill({
      skillName: uploadForm.skillName.trim() || undefined,
      description: uploadForm.description.trim() || undefined,
      creator: uploadForm.creator.trim() || "Admin",
      fileName: selectedFileName.value || undefined,
      ...(selectedZipBase64.value
        ? { zipBase64: selectedZipBase64.value }
        : { files: selectedFiles.value }),
    });
    ElMessage.success(
      `Skill「${res.skillName}」上传成功（共 ${res.files.length} 个文件）`
    );
    uploadDialogVisible.value = false;
    emit("uploaded", res.card);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "上传 Skill 失败");
  } finally {
    uploading.value = false;
  }
}

// 直接使用 Skill（打包二进制 + 批量创建 Jenkins 任务）
const runDialogVisible = ref(false);
const runningSkill = ref(false);
const loadingCatalog = ref(false);
const catalogApps = ref<AppCatalogItem[]>([]);
const catalogRepos = ref<RepoCatalogItem[]>([]);
const runTargetSkill = ref<SkillCardRecord | null>(null);
const runBinaryTarget = ref("");
const runJobs = ref<RepoPipelineRun[]>([]);
const activeRunRepoId = ref("");
let runPollTimer: ReturnType<typeof setInterval> | null = null;

const runForm = reactive({
  apps: [] as string[],
  repos: [] as string[],
  taskPrompt: "",
});

const activeRunJob = computed(
  () =>
    runJobs.value.find((j) => j.repoId === activeRunRepoId.value) ??
    runJobs.value[0] ??
    null
);

async function ensureCatalogLoaded() {
  if (catalogApps.value.length > 0 && catalogRepos.value.length > 0) return;
  loadingCatalog.value = true;
  try {
    const res = await fetchCatalog();
    catalogApps.value = res.apps;
    catalogRepos.value = res.repos;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加载应用与版本库列表失败");
  } finally {
    loadingCatalog.value = false;
  }
}

function selectAllRunApps() {
  runForm.apps = catalogApps.value.map((a) => a.id);
}

function selectAllRunRepos() {
  runForm.repos = catalogRepos.value.map((r) => r.id);
}

function stopRunPolling() {
  if (runPollTimer) {
    clearInterval(runPollTimer);
    runPollTimer = null;
  }
}

function startRunPolling(skillName: string) {
  stopRunPolling();
  runPollTimer = setInterval(async () => {
    try {
      const detail = await fetchSkillDetail(skillName);
      if (detail.card.pipelineRuns && detail.card.pipelineRuns.length > 0) {
        runJobs.value = detail.card.pipelineRuns;
        if (!activeRunRepoId.value && runJobs.value[0]) {
          activeRunRepoId.value = runJobs.value[0].repoId;
        }
      }
      const hasRunning = runJobs.value.some(
        (j) => j.status === "running" || j.status === "pending"
      );
      if (!hasRunning) {
        stopRunPolling();
        emit("uploaded", detail.card);
      }
    } catch {
      stopRunPolling();
    }
  }, 2500);
}

async function openRunSkillDialog(skill: SkillCardRecord) {
  runTargetSkill.value = skill;
  runForm.apps = [...(skill.selectedApps ?? [])];
  runForm.repos = [...(skill.selectedRepos ?? [])];
  runForm.taskPrompt = "";
  runBinaryTarget.value = "";
  runJobs.value = [];
  activeRunRepoId.value = "";
  runDialogVisible.value = true;
  await ensureCatalogLoaded();
  if (runForm.apps.length === 0 && catalogApps.value.length > 0) {
    runForm.apps = [catalogApps.value[0].id];
  }
  if (runForm.repos.length === 0 && catalogRepos.value.length > 0) {
    runForm.repos = [catalogRepos.value[0].id];
  }
}

async function handleExecuteRunSkill() {
  if (!runTargetSkill.value) return;
  if (runForm.apps.length === 0 || runForm.repos.length === 0) {
    ElMessage.warning("请至少选择 1 个应用和 1 个 Git 版本库");
    return;
  }

  runningSkill.value = true;
  stopRunPolling();
  try {
    const res = await runSkillOnJenkins({
      skillName: runTargetSkill.value.skillName,
      apps: runForm.apps,
      repos: runForm.repos,
      taskPrompt: runForm.taskPrompt.trim() || undefined,
    });
    runBinaryTarget.value = res.binaryTarget;
    runJobs.value = res.pipelineRuns;
    activeRunRepoId.value = res.pipelineRuns[0]?.repoId || "";
    ElMessage.success(
      `已打包二进制并创建 ${res.pipelineRuns.length} 个 Jenkins 任务`
    );
    emit("uploaded", res.card);
    if (
      res.pipelineRuns.some(
        (j) => j.status === "running" || j.status === "pending"
      )
    ) {
      startRunPolling(runTargetSkill.value.skillName);
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "创建 Jenkins 任务失败");
  } finally {
    runningSkill.value = false;
  }
}

async function handleDeleteSkill(skill: SkillCardRecord) {
  try {
    await ElMessageBox.confirm(
      `确定要彻底删除 Skill「${skill.skillName}」吗？此操作将同时清理数据库、resource 目录以及 ~/.pi / ~/.omp 中的该 Skill 文件。`,
      "删除确认",
      {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
        confirmButtonClass: "el-button--danger",
      }
    );
  } catch {
    return;
  }

  try {
    const res = await deleteSkill(skill.skillName);
    ElMessage.success(
      `已删除 Skill「${res.skillName}」（同步清理了 ${res.removedDirs.length} 个本地目录）`
    );
    emit("uploaded", skill);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "删除 Skill 失败");
  }
}

onUnmounted(stopRunPolling);

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

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
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

.card-header-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.more-dots-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s ease;
}
.more-dots-btn:hover {
  background: #f3f4f6;
  color: #111827;
}

.card-more-menu {
  display: flex;
  flex-direction: column;
}

.more-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #303133;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}
.more-menu-item:hover {
  background: #ecf5ff;
  color: #409eff;
}
.more-menu-item.danger {
  color: #f56c6c;
}
.more-menu-item.danger:hover {
  background: #fef0f0;
  color: #f56c6c;
}

.run-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
.run-label-links {
  display: flex;
  gap: 6px;
}

.run-jobs-panel {
  margin-top: 12px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 12px;
  background: #f9fafb;
}
.run-jobs-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.run-jobs-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
}
.run-job-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #ebeef5;
  background: #ffffff;
  cursor: pointer;
  font-size: 12.5px;
}
.run-job-item.active {
  border-color: #409eff;
  background: #ecf5ff;
}
.run-job-left,
.run-job-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.run-job-repo {
  font-weight: 600;
  color: #303133;
}
.run-job-name {
  font-size: 11px;
  color: #606266;
  background: #f4f4f5;
  padding: 1px 6px;
  border-radius: 4px;
}
.run-job-link {
  font-size: 12px;
  color: #409eff;
  text-decoration: none;
}
.run-job-link:hover {
  text-decoration: underline;
}
.run-job-dur {
  font-size: 11.5px;
  color: #909399;
}
.run-job-console {
  margin-top: 10px;
  border-radius: 6px;
  overflow: hidden;
  background: #1e222a;
  color: #e6edf3;
}
.run-console-head {
  padding: 6px 10px;
  font-size: 11.5px;
  background: #282c34;
  color: #9ca3af;
}
.run-console-body {
  margin: 0;
  padding: 10px;
  font-size: 11.5px;
  line-height: 1.5;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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

.upload-dropzone {
  border: 1.5px dashed #d1d5db;
  border-radius: 10px;
  background: #f9fafb;
  padding: 22px 16px;
  text-align: center;
  transition: all 0.15s ease;
}
.upload-dropzone.is-dragging {
  border-color: #409eff;
  background: #ecf5ff;
}
.dropzone-icon {
  font-size: 32px;
  color: #409eff;
  margin-bottom: 6px;
}
.dropzone-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}
.dropzone-sub {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
.dropzone-btns {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  gap: 10px;
}

.upload-preview-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f4f9ff;
  border: 1px solid #d9ecff;
}
.upload-preview-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12.5px;
  font-weight: 600;
  color: #303133;
}
.upload-file-chips {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.upload-file-chip {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #ffffff;
  border: 1px solid #dcdfe6;
  color: #606266;
}
.upload-file-chip.is-main {
  border-color: #67c23a;
  color: #529b2e;
  background: #f0f9eb;
  font-weight: 600;
}
.upload-more {
  font-size: 11.5px;
  color: #909399;
}
</style>
