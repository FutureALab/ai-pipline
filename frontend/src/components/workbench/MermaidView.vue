<template>
  <div class="wb-mermaid-view">
    <div class="wb-mermaid-toolbar">
      <span class="wb-mermaid-hint">Mermaid 架构 / 流程图</span>
      <div class="wb-mermaid-actions">
        <el-button
          size="small"
          link
          type="primary"
          @click="showSource = !showSource"
        >
          {{ showSource ? "查看图表" : "查看源码" }}
        </el-button>
        <el-button size="small" link type="primary" @click="copySource">
          复制源码
        </el-button>
      </div>
    </div>

    <div v-if="renderError" class="wb-mermaid-err">
      图表渲染失败（{{ renderError }}），已降级显示源码：
    </div>

    <pre v-if="showSource || renderError" class="wb-mermaid-code">{{ code }}</pre>
    <div v-else-if="rendering" class="wb-mermaid-loading">
      正在渲染 Mermaid 图表...
    </div>
    <div v-else class="wb-mermaid-svg" v-html="svgHtml" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";

const props = defineProps<{
  code: string;
}>();

const svgHtml = ref("");
const rendering = ref(false);
const renderError = ref("");
const showSource = ref(false);

let mermaidInitialized = false;
let renderCounter = 0;

async function renderDiagram() {
  const source = (props.code || "").trim();
  if (!source) {
    svgHtml.value = "";
    renderError.value = "Mermaid 源码为空";
    return;
  }

  rendering.value = true;
  renderError.value = "";
  try {
    const mod = await import("mermaid");
    const mermaid = mod.default;
    const isDark =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: isDark ? "dark" : "default",
      flowchart: { htmlLabels: true, curve: "basis" },
    });
    mermaidInitialized = true;

    const id = `wb-mermaid-${Date.now()}-${++renderCounter}`;
    const { svg } = await mermaid.render(id, source);
    svgHtml.value = svg;
  } catch (err) {
    svgHtml.value = "";
    renderError.value = err instanceof Error ? err.message : String(err);
  } finally {
    rendering.value = false;
  }
}

async function copySource() {
  try {
    await navigator.clipboard.writeText(props.code || "");
    ElMessage.success("已复制 Mermaid 源码");
  } catch {
    ElMessage.warning("复制失败，请手动选中复制");
  }
}

onMounted(() => {
  void renderDiagram();
});

watch(
  () => props.code,
  () => {
    void renderDiagram();
  }
);
</script>

<style scoped>
.wb-mermaid-view {
  width: 100%;
}

.wb-mermaid-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid #f2f6fc;
  font-size: 12px;
  color: #606266;
}

.wb-mermaid-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wb-mermaid-loading {
  padding: 20px;
  text-align: center;
  font-size: 12px;
  color: #909399;
}

.wb-mermaid-svg {
  padding: 14px 12px;
  background: #ffffff;
  overflow-x: auto;
  display: flex;
  justify-content: center;
}

.wb-mermaid-svg :deep(svg) {
  max-width: 100%;
  height: auto;
}

.wb-mermaid-err {
  padding: 6px 12px;
  background: #fef0f0;
  color: #f56c6c;
  font-size: 12px;
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
</style>
