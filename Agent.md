# Agent.md — 项目技术栈与开发规范指引

本文档用于向后续接手本项目的 AI Coding Agent 说明架构边界、技术选型、关键约束与验证命令。

## 1. 技术栈总览

- **离线参考文档**：`docs/pi-doc/`（收录 134 篇 OMP 官方文档，内网开发直接查阅 `docs/pi-doc/INDEX.md`、`docs/pi-doc/sdk.md`、`docs/pi-doc/skills.md`）
- **运行时与包管理**：Bun (`bun >= 1.3`) + Node.js ESM (`"type": "module"`, TypeScript `ES2022` / `bundler`)
- **AI Agent SDK**：`@oh-my-pi/pi-coding-agent`（固定版本 `18.22.1`，以匹配 macOS ARM64 原生模块 `@oh-my-pi/pi-natives-darwin-arm64@18.22.1`）
- **后端 HTTP**：Node 原生 `node:http` 无框架分层架构（`routes` -> `controllers` -> `services` -> `repositories` -> `db`）
- **数据库**：PostgreSQL（使用 `pg` 连接池，启动时通过 `src/db/postgres.ts` 自动建表与初始化种子数据）
- **遥测与可观测性**：OpenTelemetry (`@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-proto`)，接入 `createAgentSession({ telemetry })`
- **前端**：Vue 3 (`<script setup lang="ts">`) + Vite + Element Plus + `@element-plus/icons-vue` + `marked` + `highlight.js`

---

## 2. 后端分层约定 (`src/`)

新增或修改后端功能时，必须严格遵守以下目录层级，禁止将业务逻辑直接堆在入口文件中：

- `src/types/`：纯 TypeScript 类型与接口定义
- `src/config/`：环境变量模型解析（`envModel.ts`）与 OpenTelemetry 遥测初始化（`telemetry.ts`）
- `src/db/`：PostgreSQL 连接池、DDL 建表与启动种子数据（`postgres.ts`）
- `src/repositories/`：数据持久化层，负责 PostgreSQL 查询及 `~/.omp/agent/skills` 本地文件同步
- `src/services/`：核心业务编排（AI Skill 生成、Skill 运行、长任务中断/重启、批量流水线、Jenkins XML 客户端）
- `src/controllers/`：HTTP 入参解析、参数校验与调用 `services`
- `src/routes/`：路由匹配（`router.ts`）与通用响应/CORS 工具（`httpUtils.ts`）

---

## 3. 关键业务与技术约束

1. **OMP SDK 导入规范**：
   - 统一使用 `createAgentSession`、`SessionManager`、`discoverSkills`、`discoverAuthStorage`、`ModelRegistry`。
   - `discoverAuthStorage()` 为异步函数，必须 `await`。
   - `discoverSkills(cwd)` 接收工作目录字符串，返回 `{ skills, warnings }`。
2. **OpenAI 双模式支持 (`src/config/envModel.ts`)**：
   - 通过 `OPENAI_API_MODE` 切换 `chat`（`openai-completions`）与 `responses`（`openai-responses`），使用 `ModelRegistry.registerProvider()` 注册并注入 `createAgentSession`。
3. **长任务中断与重启 (`src/services/generationJobService.ts`)**：
   - 中断生成必须调用 `session.abort({ goalReason: "interrupted", reason })`，并同步更新内存态与 PostgreSQL `generation_jobs` 表。
4. **流水线测试校验 (`src/controllers/pipelineController.ts`)**：
   - 第三步执行流水线测试时，必须校验相关应用非空，且 Git 版本库 **有且必须选够 10 个**；仅全部测试成功后才允许发布。
5. **Jenkins 第三方调用 (`src/services/jenkinsClient.ts`)**：
   - 支持直接传递 `config.xml` 或自动生成 `<flow-definition>` XML，需处理 Jenkins Crumb（CSRF）与 Basic Auth，并在 Jenkins 中通过 `pi-agent` 执行当前 Skill。
6. **前端交互约定 (`frontend/src/components/SkillWorkflow.vue`)**：
   - 第一步右侧编辑器禁止使用分屏模式，仅保留 `VS Code 预览` 与 `编辑` 切换，需展示文件目录树并支持 `.zip` 下载。
   - 顶部步骤条需支持已到达步骤的点击切换。

---

## 4. 变更后的必跑验证命令

每次修改后端或前端代码后，必须运行以下命令确认无编译与类型错误：

```bash
# 后端 TypeScript 类型检查
./node_modules/.bin/tsc --noEmit

# 前端 Vite 生产构建检查
./frontend/node_modules/.bin/vite build frontend
```
