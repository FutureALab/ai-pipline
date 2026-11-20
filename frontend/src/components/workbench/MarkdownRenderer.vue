<template>
  <div class="md-renderer-shell">
    <div
      ref="containerRef"
      class="md-renderer"
      @click="handleContainerClick"
      v-html="renderedHtml"
    />

    <!-- Image Lightbox Modal -->
    <div
      v-if="lightboxSrc"
      class="md-lightbox"
      @click="lightboxSrc = ''"
    >
      <img :src="lightboxSrc" class="md-lightbox-img" @click.stop />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import katex from "katex";
import { Marked } from "marked";

const props = defineProps<{
  content: string;
  streaming?: boolean;
}>();

const containerRef = ref<HTMLElement | null>(null);
const lightboxSrc = ref("");

let mermaidInitialized = false;
let mermaidSeq = 0;

function encodeB64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function encodePlantUmlHex(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `~h${hex}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EMOJI_SHORTCODES: Record<string, string> = {
  white_check_mark: "✅",
  check: "✅",
  x: "❌",
  warning: "⚠️",
  bulb: "💡",
  rocket: "🚀",
  sparkles: "✨",
  fire: "🔥",
  memo: "📝",
  wrench: "🔧",
  bug: "🐛",
  tada: "🎉",
  info: "ℹ️",
  star: "⭐",
  zap: "⚡",
  lock: "🔒",
  package: "📦",
  book: "📖",
  link: "🔗",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
};

/**
 * Convert markmap markdown headings/lists to Mermaid mindmap syntax.
 */
function markmapToMermaidMindmap(src: string): string {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "mindmap\n  root((Empty))";
  if (/^\s*mindmap\b/.test(lines[0])) return src;

  const out: string[] = ["mindmap"];
  let hasRoot = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (!hasRoot) {
        out.push(`  root((${text}))`);
        hasRoot = true;
      } else {
        out.push(`${"  ".repeat(level + 1)}${text}`);
      }
      continue;
    }
    const list = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (list) {
      const indent = Math.floor(list[1].length / 2) + (hasRoot ? 2 : 1);
      const text = list[2].trim();
      if (!hasRoot) {
        out.push(`  root((${text}))`);
        hasRoot = true;
      } else {
        out.push(`${"  ".repeat(indent)}${text}`);
      }
      continue;
    }
    if (!hasRoot) {
      out.push(`  root((${line.trim()}))`);
      hasRoot = true;
    } else {
      out.push(`    ${line.trim()}`);
    }
  }
  return out.join("\n");
}

function parseCsvRows(raw: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"' && raw[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

function renderCsvTableHtml(raw: string, isTsv: boolean): string {
  const rows = parseCsvRows(raw, isTsv ? "\t" : ",");
  if (rows.length === 0) return `<pre class="hljs md-code-pre"><code>${escapeHtml(raw)}</code></pre>`;
  const [header, ...body] = rows;
  const ths = header.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const trs = body
    .map(
      (r) =>
        `<tr>${header.map((_, idx) => `<td>${escapeHtml(r[idx] ?? "")}</td>`).join("")}</tr>`
    )
    .join("");
  return `<div class="md-table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

/**
 * Pre-process extended Markdown syntax while protecting fenced & inline code:
 * - Containers: :::info / :::tip / :::warning / :::danger / :::note / :::details
 * - LaTeX Math: $$...$$, \[...\], $...$, \(...\)
 * - Inline Highlighter: ==marked text==
 * - Emoji shortcodes: :rocket:, :white_check_mark:, etc.
 */
function preprocessExtendedMarkdown(markdown: string): string {
  const codePlaceholders: string[] = [];
  const protectedMd = markdown.replace(
    /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g,
    (match) => {
      const idx = codePlaceholders.push(match) - 1;
      return `@@CODE_PH_${idx}@@`;
    }
  );

  // 1. :::details Title ... ::: (Collapse block)
  let result = protectedMd.replace(
    /^:::details(?:[ \t]+([^\n]*))?\r?\n([\s\S]*?)^:::[ \t]*$/gm,
    (_m, title: string | undefined, body: string) => {
      const summary = escapeHtml((title || "点击展开详情").trim());
      return `<details class="md-collapse"><summary>${summary}</summary>\n\n${body.trim()}\n\n</details>`;
    }
  );

  // 2. :::info|tip|warning|danger|note [Title] ... ::: (Highlighter callout block)
  result = result.replace(
    /^:::(info|note|tip|warning|danger|caution|important)(?:[ \t]+([^\n]*))?\r?\n([\s\S]*?)^:::[ \t]*$/gim,
    (_m, rawType: string, title: string | undefined, body: string) => {
      const key = rawType.toUpperCase();
      const cls =
        key === "DANGER" || key === "CAUTION"
          ? "caution"
          : key === "WARNING"
            ? "warning"
            : key === "TIP"
              ? "tip"
              : key === "IMPORTANT"
                ? "important"
                : "note";
      const label = escapeHtml((title || key).trim());
      return `<div class="md-alert md-alert-${cls}"><div class="md-alert-title">${label}</div>\n\n${body.trim()}\n\n</div>`;
    }
  );

  // 3. LaTeX Math
  const renderTex = (tex: string, displayMode: boolean): string => {
    try {
      const rendered = katex.renderToString(tex.trim(), {
        displayMode,
        throwOnError: false,
        strict: false,
      });
      return displayMode
        ? `<div class="md-math-block">${rendered}</div>`
        : rendered;
    } catch {
      return escapeHtml(tex);
    }
  };

  result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) =>
    renderTex(tex, true)
  );
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) =>
    renderTex(tex, true)
  );
  result = result.replace(/\\\((.+?)\\\)/g, (_, tex: string) =>
    renderTex(tex, false)
  );
  result = result.replace(
    /(?<!\\)\$(?!\s)([^$\n]+?)(?<!\s)\$/g,
    (full, tex: string) => {
      if (/^\d+(?:[.,]\d+)?$/.test(tex.trim())) return full;
      return renderTex(tex, false);
    }
  );

  // 4. Inline Highlighter: ==text==
  result = result.replace(/==([^=\n]+)==/g, "<mark class=\"md-mark\">$1</mark>");

  // 5. Common Emoji shortcodes
  result = result.replace(
    /:([a-z0-9_+-]+):/gi,
    (full, name: string) => EMOJI_SHORTCODES[name.toLowerCase()] ?? full
  );

  return result.replace(/@@CODE_PH_(\d+)@@/g, (_, idxStr: string) => {
    return codePlaceholders[Number(idxStr)] ?? "";
  });
}

const ALERT_META: Record<string, { cls: string; label: string }> = {
  NOTE: { cls: "note", label: "Note" },
  TIP: { cls: "tip", label: "Tip" },
  IMPORTANT: { cls: "important", label: "Important" },
  WARNING: { cls: "warning", label: "Warning" },
  CAUTION: { cls: "caution", label: "Caution" },
};

const MERMAID_ALIASES = new Set([
  "mermaid",
  "mindmap",
  "flowchart",
  "kanban",
  "markmap",
]);

const mdEngine = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const rawLang = (lang || "").trim().toLowerCase().split(/\s+/)[0] || "";
      const b64 = encodeB64(text);

      // 1. Mermaid / Mindmap / Flowchart / Kanban / Markmap
      if (MERMAID_ALIASES.has(rawLang)) {
        const normalizedMermaid =
          rawLang === "markmap"
            ? markmapToMermaidMindmap(text)
            : rawLang === "mindmap" && !/^\s*mindmap\b/.test(text)
              ? markmapToMermaidMindmap(text)
              : text;
        const mmdB64 = encodeB64(normalizedMermaid);
        return `<div class="md-special-block md-mermaid-block" data-mermaid-b64="${mmdB64}">
          <div class="md-code-header">
            <span class="md-code-lang">${escapeHtml(rawLang)}</span>
            <div class="md-code-actions">
              <button type="button" class="md-code-btn" data-md-action="toggle-mermaid-src">查看源码</button>
              <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
            </div>
          </div>
          <div class="md-mermaid-target"><pre class="hljs md-code-pre"><code>${escapeHtml(text)}</code></pre></div>
          <pre class="hljs md-code-pre md-mermaid-src" style="display:none"><code>${escapeHtml(text)}</code></pre>
        </div>`;
      }

      // 2. Graphviz DOT (Text Diagram) — rendered locally via @viz-js/viz WASM
      if (rawLang === "dot" || rawLang === "graphviz") {
        return `<div class="md-special-block md-dot-block" data-dot-b64="${b64}">
          <div class="md-code-header">
            <span class="md-code-lang">graphviz (${escapeHtml(rawLang)})</span>
            <div class="md-code-actions">
              <button type="button" class="md-code-btn" data-md-action="toggle-dot-src">查看源码</button>
              <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
            </div>
          </div>
          <div class="md-dot-target"><pre class="hljs md-code-pre"><code>${escapeHtml(text)}</code></pre></div>
          <pre class="hljs md-code-pre md-dot-src" style="display:none"><code>${escapeHtml(text)}</code></pre>
        </div>`;
      }

      // 3. PlantUML (UML diagrams)
      if (rawLang === "plantuml" || rawLang === "puml" || rawLang === "uml") {
        const encoded = encodePlantUmlHex(text);
        const imgUrl = `https://www.plantuml.com/plantuml/svg/${encoded}`;
        return `<div class="md-special-block md-puml-block">
          <div class="md-code-header">
            <span class="md-code-lang">plantuml</span>
            <div class="md-code-actions">
              <button type="button" class="md-code-btn" data-md-action="toggle-puml-src">查看源码</button>
              <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
            </div>
          </div>
          <div class="md-puml-preview">
            <img src="${imgUrl}" alt="PlantUML Diagram" class="md-zoomable-img" loading="lazy" />
          </div>
          <pre class="hljs md-code-pre md-puml-src" style="display:none"><code>${escapeHtml(text)}</code></pre>
        </div>`;
      }

      // 4. Formula code fence (latex / math / tex)
      if (rawLang === "latex" || rawLang === "math" || rawLang === "tex") {
        let formulaHtml = "";
        try {
          formulaHtml = katex.renderToString(text.trim(), {
            displayMode: true,
            throwOnError: false,
            strict: false,
          });
        } catch {
          formulaHtml = `<pre class="hljs md-code-pre"><code>${escapeHtml(text)}</code></pre>`;
        }
        return `<div class="md-special-block md-formula-block">
          <div class="md-code-header">
            <span class="md-code-lang">formula (${escapeHtml(rawLang)})</span>
            <div class="md-code-actions">
              <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
            </div>
          </div>
          <div class="md-math-block">${formulaHtml}</div>
        </div>`;
      }

      // 5. Data Table (csv / tsv)
      if (rawLang === "csv" || rawLang === "tsv") {
        const tableHtml = renderCsvTableHtml(text, rawLang === "tsv");
        return `<div class="md-special-block md-csv-block">
          <div class="md-code-header">
            <span class="md-code-lang">data table (${escapeHtml(rawLang)})</span>
            <div class="md-code-actions">
              <button type="button" class="md-code-btn" data-md-action="toggle-csv-src">查看源码</button>
              <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
            </div>
          </div>
          <div class="md-csv-preview">${tableHtml}</div>
          <pre class="hljs md-code-pre md-csv-src" style="display:none"><code>${escapeHtml(text)}</code></pre>
        </div>`;
      }

      // 6. Inline SVG fence
      if (rawLang === "svg") {
        const cleanSvg = DOMPurify.sanitize(text, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        return `<div class="md-special-block md-svg-block">
          <div class="md-code-header">
            <span class="md-code-lang">svg</span>
            <div class="md-code-actions">
              <button type="button" class="md-code-btn" data-md-action="toggle-svg-src">查看源码</button>
              <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
            </div>
          </div>
          <div class="md-svg-preview">${cleanSvg}</div>
          <pre class="hljs md-code-pre md-svg-src" style="display:none"><code>${escapeHtml(text)}</code></pre>
        </div>`;
      }

      // 7. HTML fence with optional sandboxed iframe preview
      if (rawLang === "html" || rawLang === "htm") {
        const highlighted = hljs.highlight(text, { language: "xml" }).value;
        return `<div class="md-special-block md-html-block" data-html-b64="${b64}">
          <div class="md-code-header">
            <span class="md-code-lang">html</span>
            <div class="md-code-actions">
              <button type="button" class="md-code-btn" data-md-action="toggle-html-preview">预览 HTML</button>
              <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
            </div>
          </div>
          <pre class="hljs md-code-pre md-html-src"><code>${highlighted}</code></pre>
          <div class="md-html-preview-slot" style="display:none"></div>
        </div>`;
      }

      // 8. Standard syntax-highlighted code / diff block
      const language = rawLang && hljs.getLanguage(rawLang) ? rawLang : "plaintext";
      const highlighted = hljs.highlight(text, { language }).value;
      const displayLang = rawLang || "text";
      return `<div class="md-code-block">
        <div class="md-code-header">
          <span class="md-code-lang">${escapeHtml(displayLang)}</span>
          <div class="md-code-actions">
            <button type="button" class="md-code-btn" data-md-action="copy" data-b64="${b64}">复制</button>
          </div>
        </div>
        <pre class="hljs md-code-pre"><code>${highlighted}</code></pre>
      </div>`;
    },

    blockquote({ tokens }) {
      const inner = this.parser.parse(tokens);
      const alertMatch = inner.match(
        /^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>|\n)?([\s\S]*?)<\/p>/i
      );
      if (alertMatch) {
        const key = alertMatch[1].toUpperCase();
        const meta = ALERT_META[key];
        if (meta) {
          const rest = inner.replace(
            alertMatch[0],
            alertMatch[2]?.trim() ? `<p>${alertMatch[2]}</p>` : ""
          );
          return `<div class="md-alert md-alert-${meta.cls}"><div class="md-alert-title">${meta.label}</div>${rest}</div>`;
        }
      }
      return `<blockquote>${inner}</blockquote>`;
    },

    table(token) {
      let headerHtml = "<tr>";
      for (const cell of token.header) {
        const align = cell.align ? ` style="text-align:${cell.align}"` : "";
        headerHtml += `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
      }
      headerHtml += "</tr>";

      let bodyHtml = "";
      for (const row of token.rows) {
        bodyHtml += "<tr>";
        for (const cell of row) {
          const align = cell.align ? ` style="text-align:${cell.align}"` : "";
          bodyHtml += `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
        }
        bodyHtml += "</tr>";
      }

      return `<div class="md-table-wrap"><table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
    },

    image({ href, title, text }) {
      const safeHref = escapeHtml(href || "");
      const safeAlt = escapeHtml(text || "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${safeHref}" alt="${safeAlt}"${titleAttr} class="md-zoomable-img" loading="lazy" />`;
    },

    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safeHref = escapeHtml(href || "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

const renderedHtml = computed(() => {
  const raw = props.content || "";
  if (!raw.trim()) return "";
  const prepared = preprocessExtendedMarkdown(raw);
  const html = mdEngine.parse(prepared) as string;
  return DOMPurify.sanitize(html, {
    ADD_TAGS: [
      "details",
      "summary",
      "mark",
      "math",
      "semantics",
      "mrow",
      "mi",
      "mo",
      "mn",
      "msup",
      "msub",
      "mfrac",
      "msqrt",
      "mroot",
      "mtext",
      "annotation",
      "button",
      "svg",
      "path",
      "g",
      "rect",
      "circle",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "text",
      "tspan",
      "defs",
      "marker",
      "linearGradient",
      "stop",
    ],
    ADD_ATTR: [
      "open",
      "target",
      "rel",
      "loading",
      "data-mermaid-b64",
      "data-dot-b64",
      "data-html-b64",
      "data-md-action",
      "data-b64",
      "style",
      "viewBox",
      "xmlns",
      "d",
      "fill",
      "stroke",
      "stroke-width",
      "transform",
      "x",
      "y",
      "x1",
      "y1",
      "x2",
      "y2",
      "cx",
      "cy",
      "r",
      "rx",
      "ry",
      "width",
      "height",
      "points",
      "aria-hidden",
    ],
  });
});

async function renderAsyncDiagrams() {
  if (props.streaming || !containerRef.value) return;

  // 1. Render Mermaid blocks
  const mermaidBlocks = containerRef.value.querySelectorAll<HTMLElement>(
    ".md-mermaid-block[data-mermaid-b64]"
  );
  if (mermaidBlocks.length > 0) {
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

      for (const block of mermaidBlocks) {
        const b64 = block.getAttribute("data-mermaid-b64");
        const target = block.querySelector<HTMLElement>(".md-mermaid-target");
        if (!b64 || !target) continue;
        const code = decodeB64(b64).trim();
        if (!code) continue;

        try {
          const id = `md-mmd-${Date.now()}-${++mermaidSeq}`;
          const { svg } = await mermaid.render(id, code);
          target.innerHTML = `<div class="md-mermaid-svg">${svg}</div>`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          target.innerHTML = `<div class="md-mermaid-err">Mermaid 渲染失败（${escapeHtml(msg)}），已显示源码：</div><pre class="hljs md-code-pre"><code>${escapeHtml(code)}</code></pre>`;
        }
      }
    } catch {
      // Keep source fallback
    }
  }

  // 2. Render Graphviz DOT blocks locally via @viz-js/viz
  const dotBlocks = containerRef.value.querySelectorAll<HTMLElement>(
    ".md-dot-block[data-dot-b64]"
  );
  if (dotBlocks.length > 0) {
    try {
      const { instance } = await import("@viz-js/viz");
      const viz = await instance();
      for (const block of dotBlocks) {
        const b64 = block.getAttribute("data-dot-b64");
        const target = block.querySelector<HTMLElement>(".md-dot-target");
        if (!b64 || !target) continue;
        const code = decodeB64(b64).trim();
        if (!code) continue;

        try {
          const svgEl = viz.renderSVGElement(code);
          target.innerHTML = "";
          const wrap = document.createElement("div");
          wrap.className = "md-mermaid-svg";
          wrap.appendChild(svgEl);
          target.appendChild(wrap);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          target.innerHTML = `<div class="md-mermaid-err">Graphviz 渲染失败（${escapeHtml(msg)}），已显示源码：</div><pre class="hljs md-code-pre"><code>${escapeHtml(code)}</code></pre>`;
        }
      }
    } catch {
      // Keep source fallback
    }
  }
}

async function handleContainerClick(event: MouseEvent) {
  const targetNode = event.target as HTMLElement | null;
  if (!targetNode) return;

  // Click image to open gallery lightbox
  if (targetNode.tagName === "IMG" && targetNode.classList.contains("md-zoomable-img")) {
    const src = (targetNode as HTMLImageElement).src;
    if (src) lightboxSrc.value = src;
    return;
  }

  const el = targetNode.closest<HTMLElement>("[data-md-action]");
  if (!el) return;

  const action = el.getAttribute("data-md-action");

  if (action === "copy") {
    const b64 = el.getAttribute("data-b64") || "";
    try {
      await navigator.clipboard.writeText(decodeB64(b64));
      ElMessage.success("已复制代码");
    } catch {
      ElMessage.warning("复制失败，请手动选中复制");
    }
    return;
  }

  const togglePair = (blockSel: string, viewSel: string, srcSel: string, viewText: string) => {
    const block = el.closest(blockSel);
    const view = block?.querySelector<HTMLElement>(viewSel);
    const src = block?.querySelector<HTMLElement>(srcSel);
    if (!view || !src) return;
    const showingSrc = src.style.display !== "none";
    src.style.display = showingSrc ? "none" : "block";
    view.style.display = showingSrc ? "block" : "none";
    el.textContent = showingSrc ? "查看源码" : viewText;
  };

  if (action === "toggle-mermaid-src") {
    togglePair(".md-mermaid-block", ".md-mermaid-target", ".md-mermaid-src", "查看图表");
    return;
  }
  if (action === "toggle-dot-src") {
    togglePair(".md-dot-block", ".md-dot-target", ".md-dot-src", "查看图表");
    return;
  }
  if (action === "toggle-puml-src") {
    togglePair(".md-puml-block", ".md-puml-preview", ".md-puml-src", "查看 UML");
    return;
  }
  if (action === "toggle-csv-src") {
    togglePair(".md-csv-block", ".md-csv-preview", ".md-csv-src", "查看表格");
    return;
  }
  if (action === "toggle-svg-src") {
    togglePair(".md-svg-block", ".md-svg-preview", ".md-svg-src", "查看图像");
    return;
  }

  if (action === "toggle-html-preview") {
    const block = el.closest<HTMLElement>(".md-html-block");
    const src = block?.querySelector<HTMLElement>(".md-html-src");
    const slot = block?.querySelector<HTMLElement>(".md-html-preview-slot");
    const b64 = block?.getAttribute("data-html-b64") || "";
    if (!src || !slot) return;
    const showingPreview = slot.style.display !== "none";
    if (showingPreview) {
      slot.style.display = "none";
      src.style.display = "block";
      el.textContent = "预览 HTML";
    } else {
      if (!slot.querySelector("iframe")) {
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "");
        iframe.className = "md-html-iframe";
        iframe.srcdoc = decodeB64(b64);
        slot.appendChild(iframe);
      }
      slot.style.display = "block";
      src.style.display = "none";
      el.textContent = "查看源码";
    }
  }
}

onMounted(() => {
  void nextTick(renderAsyncDiagrams);
});

watch(
  () => [renderedHtml.value, props.streaming] as const,
  () => {
    void nextTick(renderAsyncDiagrams);
  }
);
</script>

<style scoped>
.md-renderer-shell {
  --md-text: #303133;
  --md-heading: #1f2328;
  --md-muted: #606266;
  --md-border: #e4e7ed;
  --md-border-strong: #dcdfe6;
  --md-surface: #ffffff;
  --md-surface-subtle: #f5f7fa;
  --md-surface-stripe: #fafafa;
  --md-inline-code-bg: #f0f2f5;
  --md-inline-code-fg: #c7254e;
  --md-mark-bg: #fff3b0;
  --md-mark-fg: #303133;
  --md-quote-bg: #f8f9fb;
  --md-link: #409eff;
  --md-alert-note-bg: #ecf5ff;
  --md-alert-tip-bg: #f0f9eb;
  --md-alert-important-bg: #f5f3ff;
  --md-alert-warning-bg: #fdf6ec;
  --md-alert-caution-bg: #fef0f0;
}

@media (prefers-color-scheme: dark) {
  .md-renderer-shell {
    --md-text: #d8dee9;
    --md-heading: #f0f6fc;
    --md-muted: #9aa5b1;
    --md-border: #30363d;
    --md-border-strong: #3b434b;
    --md-surface: #1e2228;
    --md-surface-subtle: #252a32;
    --md-surface-stripe: #22272e;
    --md-inline-code-bg: #2d333b;
    --md-inline-code-fg: #ff9e80;
    --md-mark-bg: #5c4b14;
    --md-mark-fg: #fef3c7;
    --md-quote-bg: #22272e;
    --md-link: #58a6ff;
    --md-alert-note-bg: rgba(64, 158, 255, 0.14);
    --md-alert-tip-bg: rgba(103, 194, 58, 0.14);
    --md-alert-important-bg: rgba(139, 92, 246, 0.15);
    --md-alert-warning-bg: rgba(230, 162, 60, 0.15);
    --md-alert-caution-bg: rgba(245, 108, 108, 0.15);
  }
}

.md-renderer {
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--md-text);
  word-break: break-word;
}

.md-renderer :deep(p) {
  margin: 0 0 8px;
}
.md-renderer :deep(p:last-child) {
  margin-bottom: 0;
}

.md-renderer :deep(h1),
.md-renderer :deep(h2),
.md-renderer :deep(h3),
.md-renderer :deep(h4) {
  margin: 14px 0 8px;
  font-weight: 600;
  color: var(--md-heading);
  line-height: 1.35;
}
.md-renderer :deep(h1) {
  font-size: 18px;
  border-bottom: 1px solid var(--md-border);
  padding-bottom: 4px;
}
.md-renderer :deep(h2) {
  font-size: 16px;
}
.md-renderer :deep(h3) {
  font-size: 14.5px;
}

.md-renderer :deep(ul),
.md-renderer :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}
.md-renderer :deep(li) {
  margin: 3px 0;
}

.md-renderer :deep(code:not(pre code)) {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--md-inline-code-bg);
  color: var(--md-inline-code-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.md-renderer :deep(mark.md-mark) {
  background: var(--md-mark-bg);
  color: var(--md-mark-fg);
  padding: 0 3px;
  border-radius: 3px;
}

.md-renderer :deep(blockquote) {
  margin: 8px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--md-border-strong);
  background: var(--md-quote-bg);
  color: var(--md-muted);
  border-radius: 0 6px 6px 0;
}

/* Collapse (details/summary) */
.md-renderer :deep(details) {
  margin: 8px 0;
  border: 1px solid var(--md-border);
  border-radius: 8px;
  background: var(--md-surface-stripe);
  padding: 6px 12px;
}
.md-renderer :deep(details summary) {
  cursor: pointer;
  font-weight: 600;
  color: var(--md-heading);
  user-select: none;
}
.md-renderer :deep(details[open] summary) {
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--md-border);
}

.md-renderer :deep(a) {
  color: var(--md-link);
  text-decoration: none;
}
.md-renderer :deep(a:hover) {
  text-decoration: underline;
}

.md-renderer :deep(hr) {
  border: none;
  border-top: 1px solid var(--md-border);
  margin: 12px 0;
}

/* Images & Gallery */
.md-renderer :deep(img.md-zoomable-img) {
  max-width: 100%;
  border-radius: 6px;
  cursor: zoom-in;
  border: 1px solid var(--md-border);
  margin: 4px 6px 4px 0;
  vertical-align: middle;
}

.md-lightbox {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  cursor: zoom-out;
}
.md-lightbox-img {
  max-width: 92vw;
  max-height: 90vh;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}

/* Tables */
.md-renderer :deep(.md-table-wrap) {
  overflow-x: auto;
  margin: 10px 0;
  border: 1px solid var(--md-border);
  border-radius: 6px;
}
.md-renderer :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  background: var(--md-surface);
  color: var(--md-text);
}
.md-renderer :deep(th),
.md-renderer :deep(td) {
  padding: 6px 10px;
  border-bottom: 1px solid var(--md-border);
  border-right: 1px solid var(--md-border);
  text-align: left;
}
.md-renderer :deep(th) {
  background: var(--md-surface-subtle);
  font-weight: 600;
  color: var(--md-heading);
}
.md-renderer :deep(tr:nth-child(even) td) {
  background: var(--md-surface-stripe);
}

/* Code / Special blocks */
.md-renderer :deep(.md-code-block),
.md-renderer :deep(.md-special-block) {
  margin: 10px 0;
  border: 1px solid var(--md-border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: var(--md-surface);
}

.md-renderer :deep(.md-code-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 10px;
  background: var(--md-surface-subtle);
  border-bottom: 1px solid var(--md-border);
  font-size: 11.5px;
  color: var(--md-muted);
}

.md-renderer :deep(.md-code-lang) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  text-transform: lowercase;
}

.md-renderer :deep(.md-code-actions) {
  display: flex;
  gap: 8px;
}

.md-renderer :deep(.md-code-btn) {
  border: none;
  background: transparent;
  color: var(--md-link);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0 4px;
}
.md-renderer :deep(.md-code-btn:hover) {
  text-decoration: underline;
}

.md-renderer :deep(.md-code-pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
}

.md-renderer :deep(.md-mermaid-svg),
.md-renderer :deep(.md-svg-preview),
.md-renderer :deep(.md-puml-preview) {
  padding: 12px;
  background: var(--md-surface);
  overflow-x: auto;
  display: flex;
  justify-content: center;
}
.md-renderer :deep(.md-mermaid-svg svg),
.md-renderer :deep(.md-svg-preview svg) {
  max-width: 100%;
  height: auto;
}

.md-renderer :deep(.md-csv-preview) {
  padding: 8px 10px;
}
.md-renderer :deep(.md-csv-preview .md-table-wrap) {
  margin: 0;
}

.md-renderer :deep(.md-mermaid-err) {
  padding: 6px 10px;
  background: var(--md-alert-caution-bg);
  color: #f56c6c;
  font-size: 12px;
}

.md-renderer :deep(.md-html-iframe) {
  width: 100%;
  height: 300px;
  border: none;
  background: #ffffff;
  display: block;
}

/* GitHub / Yuque Highlighter Alerts */
.md-renderer :deep(.md-alert) {
  margin: 10px 0;
  padding: 8px 12px;
  border-radius: 6px;
  border-left: 4px solid #409eff;
  background: var(--md-alert-note-bg);
}
.md-renderer :deep(.md-alert-title) {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 4px;
  color: var(--md-heading);
}
.md-renderer :deep(.md-alert-tip) {
  border-left-color: #67c23a;
  background: var(--md-alert-tip-bg);
}
.md-renderer :deep(.md-alert-important) {
  border-left-color: #8b5cf6;
  background: var(--md-alert-important-bg);
}
.md-renderer :deep(.md-alert-warning) {
  border-left-color: #e6a23c;
  background: var(--md-alert-warning-bg);
}
.md-renderer :deep(.md-alert-caution) {
  border-left-color: #f56c6c;
  background: var(--md-alert-caution-bg);
}

/* KaTeX block math */
.md-renderer :deep(.md-math-block) {
  overflow-x: auto;
  padding: 8px 12px;
  text-align: center;
}
</style>
