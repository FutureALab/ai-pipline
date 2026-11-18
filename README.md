# AI Skill 流水线工作台 (`ai-pipline2`)

基于 **OMP (`@oh-my-pi/pi-coding-agent`) SDK**、**Bun + TypeScript**、**Vue 3 + Element Plus** 与 **PostgreSQL / OpenTelemetry / Jenkins** 构建的自定义 Skill 生成、编辑、流水线测试与发布平台。

---

## 核心功能

1. **AI Skill 生成与默认目录管理**
   - 支持通过自定义提示词调用 AI（兼容 OpenAI Chat Completions API 与 Responses API）生成符合 OMP 规范的 `SKILL.md` 及附属脚本。
   - 自动写入 OMP 默认目录 `~/.omp/agent/skills/<skill-name>/` 并同步至 PostgreSQL。
   - 支持长任务异步生成、实时流式预览、超时自动中断、手动中断与一键重新启动。
2. **前后端分离可视化工作台**
   - **卡片列表页**：展示 Skill 名称、简介、创建人、创建时间与当前进度条。
   - **第一步（生成与编辑）**：左右两栏布局，右侧支持文件目录树（`SKILL.md`、`scripts/` 等）、VS Code 风格预览/源码编辑及 `.zip` 打包下载。
   - **第三步（测试与发布）**：支持顶部步骤条切换，应用与 Git 版本库下拉多选（严格校验必选 10 个版本库），支持模拟、本地 Git Clone、Jenkins 远程 XML 调用三种测试模式及终端日志查看，全部测试通过后可发布。
3. **Jenkins 第三方 XML 调用**
   - 支持直接传递 `config.xml` 或自动生成 Pipeline XML，通过 Jenkins REST API 创建/更新 Job、触发构建、轮询结果并拉取控制台日志，在 Jenkins 中使用 `pi-agent` 执行当前 Skill。
4. **OpenTelemetry AI Trace 遥测**
   - 接入 `@oh-my-pi/pi-coding-agent` 原生 GenAI 语义遥测，采集模型调用、Token、耗时与业务标签，持久化至 PostgreSQL (`ai_trace_spans`) 与 `data/traces.jsonl`，支持 OTLP 上报至 Jaeger。

---

## 目录结构

```text
.
├── docker-compose.yml            # PostgreSQL、Redis、Jaeger、Jenkins 周边中间件编排
├── docs/
│   └── pi-doc/                   # OMP 官方离线文档镜像（共 134 篇，索引见 INDEX.md）
├── resource/
│   └── Jenkinsfile               # Jenkins 声明式流水线模板
├── .env / .env.example           # 模型、数据库、遥测与 Jenkins 环境配置
├── src/                          # 后端源码（分层架构）
│   ├── types/                    # 领域与接口类型定义
│   ├── config/                   # OpenAI 环境模型解析、OpenTelemetry 遥测配置
│   ├── db/                       # PostgreSQL 连接池、建表与种子数据初始化
│   ├── repositories/             # 本地 Skill 目录读写与 PostgreSQL 数据访问
│   ├── services/                 # Skill 生成/运行、长任务管理、流水线与 Jenkins 客户端
│   ├── controllers/              # HTTP 请求处理器
│   ├── routes/                   # 路由分发与响应封装
│   ├── server.ts                 # HTTP 服务启动入口
│   └── main.ts                   # CLI 入口（generate | run | list | serve）
└── frontend/                     # 前端源码（Vue 3 + Vite + Element Plus）
    ├── vite.config.ts            # Vite 配置与 /api 代理
    └── src/
        ├── api.ts                # 后端 REST API 封装
        ├── App.vue               # 主视图切换
        └── components/
            ├── SkillCardGrid.vue # Skill 卡片列表页
            └── SkillWorkflow.vue # 分步向导（编辑/目录预览/下载/测试/发布）
```

---

## 快速启动

### 1. 启动周边中间件

```bash
docker compose up -d
```

- PostgreSQL: `localhost:5432`（库名 `ai_pipeline`，账号/密码 `postgres` / `postgres`）
- Jaeger UI: `http://localhost:16686`（OTLP HTTP 端口 `4318`）
- Jenkins UI: `http://localhost:8080`

### 2. 配置环境变量

编辑 [.env](file:///Users/hanxuelei/typescript_project/ai-pipline2/.env)，按需填写：
- OpenAI 模型：`OPENAI_API_MODE`（`chat` 或 `responses`）、`OPENAI_BASE_URL`、`OPENAI_MODEL_NAME`、`OPENAI_API_KEY`
- PostgreSQL：`DATABASE_URL`、`DB_INIT_SEED=true`
- OpenTelemetry：`OTEL_ENABLED=true`、`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- Jenkins：`JENKINS_URL`、`JENKINS_USER`、`JENKINS_API_TOKEN`

### 3. 安装依赖并启动前后端

```bash
# 安装后端与前端依赖
bun install
bun install --cwd frontend

# 启动后端服务（自动建表、初始化种子数据与遥测）
bun src/main.ts serve --port 3000

# 另开终端启动前端开发服务器 (http://localhost:5173)
cd frontend && bun run dev
```

---

## 构建与类型检查

```bash
# 后端 TypeScript 检查
./node_modules/.bin/tsc --noEmit

# 前端生产构建
./frontend/node_modules/.bin/vite build frontend
```

---

## 主要 API 接口

- `GET /health`：健康检查与数据库连接状态
- `GET /api/skills` / `GET /api/skills/:name` / `PUT /api/skills/:name`：Skill 卡片列表、详情文件树与保存提交
- `GET /api/skills/:name/download`：下载 Skill 完整目录 `.zip`
- `POST /api/skills/generate/start` & `GET /api/skills/generate/jobs/:jobId`：启动异步长任务生成与轮询
- `POST /api/skills/generate/jobs/:jobId/abort` & `/restart`：中断与重启 AI 生成任务
- `GET /api/catalog` & `POST /api/skills/:name/test-pipeline` & `POST /api/skills/:name/publish`：应用/仓库目录、10 仓库流水线测试与发布
- `POST /api/jenkins/execute` & `GET /api/jenkins/jobs/:jobName/:buildNumber`：第三方直接传递 XML 触发 Jenkins 任务及查询构建日志
- `GET /api/traces` & `GET /api/traces/:traceId`：查询 AI Trace 遥测数据
