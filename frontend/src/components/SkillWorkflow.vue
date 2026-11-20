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

    <!-- 第一步：模式选择（Skill 模式 / 创造模式 pi-agent 工作台） -->
    <div v-if="activeStep === 0" class="step-one-container">
      <div class="mode-switch-bar">
        <el-radio-group v-model="stepOneMode" size="default">
          <el-radio-button value="creative">创造模式（pi-agent 对话工作台）</el-radio-button>
          <el-radio-button value="skill">Skill 模式（直接生成与编辑）</el-radio-button>
        </el-radio-group>
        <span class="mode-hint">
          {{
            stepOneMode === "skill"
              ? "直接填写需求，使用 skill-creator 生成并编辑完整 Skill"
              : "在版本库上下文中与 pi-agent 自由对话探索、操作仓库或挂载 MCP，随时沉淀为 Skill"
          }}
        </span>
      </div>

      <template v-if="stepOneMode === 'skill'">
      <el-row :gutter="20">
        <el-col :xs="24" :md="9">
          <el-card shadow="never" class="panel-card">
            <template #header>
              <div class="panel-header-row">
                <div class="panel-title">Skill 基本信息与 AI 生成</div>
                <el-button
                  size="small"
                  :type="hasCustomOpenAI ? 'success' : 'default'"
                  plain
                  @click="openOpenaiDialog"
                >
                  {{
                    openaiConfig.modelName
                      ? `模型: ${openaiConfig.modelName}`
                      : "配置 API Key / 模型"
                  }}
                </el-button>
              </div>
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
                <el-input
                  v-model="form.creator"
                  placeholder="例如：Admin"
                  @change="loadUserMcps"
                />
              </el-form-item>

              <el-form-item>
                <template #label>
                  <div class="mcp-label-row">
                    <span>MCP 服务（Streamable HTTP，仅当前创建人可见）</span>
                    <el-button
                      type="primary"
                      link
                      size="small"
                      @click="openAddMcpDialog"
                    >
                      + 添加 MCP
                    </el-button>
                  </div>
                </template>
                <el-select
                  v-model="selectedMcps"
                  multiple
                  filterable
                  collapse-tags
                  collapse-tags-tooltip
                  :loading="loadingMcps"
                  placeholder="选择已注册的 Streamable HTTP MCP（可多选）"
                  style="width: 100%"
                >
                  <el-option
                    v-for="mcp in userMcps"
                    :key="mcp.id"
                    :label="mcp.name"
                    :value="mcp.id"
                  >
                    <div class="mcp-option-row">
                      <span class="mcp-option-name">{{ mcp.name }}</span>
                      <span class="mcp-option-url">{{ mcp.url }}</span>
                      <el-button
                        type="danger"
                        link
                        size="small"
                        @click.stop="handleDeleteMcp(mcp)"
                      >
                        删除
                      </el-button>
                    </div>
                  </el-option>
                  <template #empty>
                    <div class="mcp-empty-tip">
                      暂无个人 MCP，请点击上方「+ 添加 MCP」创建
                    </div>
                  </template>
                </el-select>
              </el-form-item>

              <el-form-item label="AI 生成提示词">
                <el-input
                  v-model="form.prompt"
                  type="textarea"
                  :rows="5"
                  placeholder="输入自定义提示词，例如：生成一个针对 TypeScript 仓库的代码审查 Skill，检查类型安全、异常处理和单测覆盖..."
                />
              </el-form-item>

              <el-form-item>
                <template #label>
                  <div class="timeout-label-row">
                    <span>长任务超时时间（秒，超时自动中断）</span>
                    <el-switch
                      v-model="enableTimeout"
                      :disabled="generating"
                      inline-prompt
                      active-text="开启超时"
                      inactive-text="关闭超时"
                    />
                  </div>
                </template>
                <el-input-number
                  v-if="enableTimeout"
                  v-model="timeoutSeconds"
                  :min="10"
                  :max="600"
                  :step="10"
                  style="width: 100%"
                  :disabled="generating"
                />
                <div v-else class="timeout-disabled-tip">
                  已关闭超时限制，任务将持续运行直到完成或手动中断
                </div>
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
                    {{
                      currentJob.timeoutMs > 0
                        ? `${Math.round(currentJob.timeoutMs / 1000)}s`
                        : "无超时限制"
                    }}
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
                  v-else-if="activeFilePath.toLowerCase().endsWith('.md')"
                  class="vscode-markdown-preview"
                >
                  <MarkdownRenderer :content="activeFileContent" />
                </div>
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
      </template>

      <!-- 创造模式：pi-agent 对话工作台 -->
      <template v-else>
        <el-row :gutter="20">
          <el-col :xs="24" :md="8">
            <el-card shadow="never" class="panel-card">
              <template #header>
                <div class="panel-header-row">
                  <div class="panel-title">
                    {{
                      isCreatingWorkbenchSession || workbenchSessions.length === 0
                        ? "新建工作台会话"
                        : `工作台会话 (${workbenchSessions.length})`
                    }}
                  </div>
                  <el-button
                    size="small"
                    :type="hasCustomOpenAI ? 'success' : 'default'"
                    plain
                    @click="openOpenaiDialog"
                  >
                    {{
                      openaiConfig.modelName
                        ? `模型: ${openaiConfig.modelName}`
                        : "配置 API Key / 模型"
                    }}
                  </el-button>
                </div>
              </template>

              <!-- 初始化 / 新建会话表单 -->
              <el-form
                v-if="isCreatingWorkbenchSession || workbenchSessions.length === 0"
                label-position="top"
              >
                <el-form-item label="当前用户（创建人）">
                  <el-input
                    v-model="form.creator"
                    placeholder="例如：Admin"
                    @change="handleCreatorChange"
                  />
                </el-form-item>

                <el-form-item label="选择权限内的 Git 版本库">
                  <el-select
                    v-model="workbenchRepoId"
                    clearable
                    filterable
                    placeholder="选择一个版本库（可选）"
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

                <el-form-item label="或指定本地工作目录（可选）">
                  <el-input
                    v-model="workbenchCustomCwd"
                    placeholder="留空则使用所选版本库或默认目录"
                  />
                </el-form-item>

                <el-form-item>
                  <template #label>
                    <div class="mcp-label-row">
                      <span>MCP 服务（Streamable HTTP，仅自己可见）</span>
                      <el-button
                        type="primary"
                        link
                        size="small"
                        @click="openAddMcpDialog"
                      >
                        + 添加 MCP
                      </el-button>
                    </div>
                  </template>
                  <el-select
                    v-model="selectedMcps"
                    multiple
                    filterable
                    collapse-tags
                    collapse-tags-tooltip
                    :loading="loadingMcps"
                    placeholder="选择要挂载的 Streamable HTTP MCP"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="mcp in userMcps"
                      :key="mcp.id"
                      :label="mcp.name"
                      :value="mcp.id"
                    >
                      <div class="mcp-option-row">
                        <span class="mcp-option-name">{{ mcp.name }}</span>
                        <span class="mcp-option-url">{{ mcp.url }}</span>
                        <el-button
                          type="danger"
                          link
                          size="small"
                          @click.stop="handleDeleteMcp(mcp)"
                        >
                          删除
                        </el-button>
                      </div>
                    </el-option>
                    <template #empty>
                      <div class="mcp-empty-tip">
                        暂无个人 MCP，请点击上方「+ 添加 MCP」创建
                      </div>
                    </template>
                  </el-select>
                </el-form-item>

                <div class="workbench-actions">
                  <el-button
                    type="primary"
                    :loading="workbenchInitializing"
                    style="flex: 1"
                    @click="handleStartWorkbench"
                  >
                    启动工作台会话
                  </el-button>
                  <el-button
                    v-if="workbenchSessions.length > 0"
                    @click="isCreatingWorkbenchSession = false"
                  >
                    返回列表
                  </el-button>
                </div>
              </el-form>

              <!-- 收缩后的多会话文件夹卡片列表 -->
              <div v-else class="wb-session-list-wrap">
                <div class="wb-session-cards">
                  <div
                    v-for="sess in workbenchSessions"
                    :key="sess.sessionId"
                    :class="[
                      'wb-session-card',
                      { active: workbenchSession?.sessionId === sess.sessionId },
                    ]"
                    @click="selectWorkbenchSession(sess)"
                  >
                    <div class="wb-session-card-top">
                      <div class="wb-session-folder-title">
                        <el-icon><Folder /></el-icon>
                        <span>{{ sess.repoName || folderBasename(sess.cwd) }}</span>
                      </div>
                      <div class="wb-session-card-right">
                        <el-tag
                          size="small"
                          :type="
                            sess.status === 'running'
                              ? 'primary'
                              : sess.status === 'error'
                                ? 'danger'
                                : 'success'
                          "
                        >
                          {{
                            sess.status === "running"
                              ? "执行中"
                              : sess.status === "error"
                                ? "异常"
                                : "就绪"
                          }}
                        </el-tag>
                        <el-button
                          type="danger"
                          link
                          size="small"
                          @click.stop="handleCloseWorkbenchSession(sess.sessionId)"
                        >
                          关闭
                        </el-button>
                      </div>
                    </div>
                    <div class="wb-session-card-path" :title="sess.cwd">
                      {{ sess.cwd }}
                    </div>
                    <div class="wb-session-card-meta">
                      <span>对话 {{ sess.messages.length }} 条</span>
                      <span v-if="sess.mcpServers.length > 0">
                        · MCP {{ sess.mcpServers.length }} 个
                      </span>
                    </div>
                  </div>
                </div>

                <div class="workbench-actions" style="margin-top: 12px">
                  <el-button
                    type="primary"
                    plain
                    style="flex: 1"
                    @click="handleOpenNewWorkbenchForm"
                  >
                    + 新建会话
                  </el-button>
                  <el-button
                    v-if="workbenchSession && workbenchSession.messages.length > 0"
                    type="success"
                    plain
                    :disabled="workbenchSession.status === 'running' || workbenchSending"
                    @click="handleDistillToSkill"
                  >
                    沉淀为 Skill
                  </el-button>
                </div>
              </div>
            </el-card>
          </el-col>

          <el-col :xs="24" :md="16">
            <el-card shadow="never" class="panel-card workbench-chat-card">
              <template #header>
                <div class="workbench-header-wrap">
                  <div class="panel-header-row">
                    <div class="panel-title">
                      pi-agent 实时对话与仓库操作
                    </div>
                    <div class="workbench-header-actions">
                      <el-button
                        v-if="workbenchSession"
                        size="small"
                        plain
                        @click="workbenchTodoDialogVisible = true"
                      >
                        任务清单 ({{ workbenchTodoCount }})
                      </el-button>
                      <el-button
                        v-if="workbenchSession"
                        size="small"
                        :type="workbenchRunningBgCount > 0 ? 'primary' : 'default'"
                        plain
                        @click="workbenchBgDialogVisible = true"
                      >
                        后台命令 ({{ workbenchSession.backgroundCommands?.length || 0 }})
                      </el-button>
                      <el-button
                        size="small"
                        plain
                        @click="workbenchExtDialogVisible = true"
                      >
                        扩展 ({{ enabledExtensionCount }}/{{ workbenchExtensionCatalog.length }})
                      </el-button>
                      <el-button
                        v-if="workbenchSession"
                        size="small"
                        plain
                        @click="workbenchSkillsDialogVisible = true"
                      >
                        Skills ({{ workbenchSession.skills.length }})
                      </el-button>
                      <el-button
                        v-if="workbenchSession"
                        size="small"
                        plain
                        @click="workbenchMcpDialogVisible = true"
                      >
                        MCP ({{ workbenchSession.mcpServers.length }})
                      </el-button>
                      <el-tag
                        v-if="workbenchSession"
                        :type="workbenchSession.status === 'running' ? 'primary' : workbenchSession.status === 'error' ? 'danger' : 'success'"
                        size="small"
                      >
                        {{
                          workbenchSession.status === "running"
                            ? "Agent 执行中..."
                            : workbenchSession.status === "error"
                              ? "执行异常"
                              : "会话就绪"
                        }}
                      </el-tag>
                    </div>
                  </div>
                  <!-- Thinkrail 风格上下文与 Token 统计栏 -->
                  <div v-if="workbenchSession" class="workbench-stats-bar">
                    <span class="stats-pill" title="当前模型（点击修改）" @click="openOpenaiDialog">
                      模型：{{
                        workbenchSession.model
                          ? `${workbenchSession.model.provider}/${workbenchSession.model.id}`
                          : "默认模型"
                      }}
                    </span>
                    <span class="stats-sep">·</span>
                    <span v-if="workbenchSession.stats.tokens.input" class="stats-item">
                      ↑{{ formatCompactTokens(workbenchSession.stats.tokens.input) }}
                    </span>
                    <span v-if="workbenchSession.stats.tokens.output" class="stats-item">
                      ↓{{ formatCompactTokens(workbenchSession.stats.tokens.output) }}
                    </span>
                    <span v-if="workbenchSession.stats.tokens.cacheRead" class="stats-item">
                      R{{ formatCompactTokens(workbenchSession.stats.tokens.cacheRead) }}
                    </span>
                    <span v-if="workbenchSession.stats.cost" class="stats-item">
                      ${{ workbenchSession.stats.cost.toFixed(3) }}
                    </span>
                    <span
                      v-if="workbenchSession.stats.contextUsage"
                      class="stats-context"
                      title="上下文窗口占用"
                    >
                      <span class="context-bar">{{
                        contextBarText(workbenchSession.stats.contextUsage).bar
                      }}</span>
                      {{ contextBarText(workbenchSession.stats.contextUsage).text }}
                    </span>
                  </div>
                </div>
              </template>

              <div class="workbench-chat-history">
                <el-empty
                  v-if="!workbenchSession"
                  description="在左侧选择版本库和 MCP（可选），直接发送消息即可自动启动 pi-agent 对话"
                />
                <template v-else>
                  <div
                    v-if="workbenchSession.messages.length === 0 && workbenchSession.status !== 'running'"
                    class="workbench-welcome"
                  >
                    工作台已就绪！你可以让 AI 检查仓库代码、运行命令、调用已挂载的 MCP 工具，或一起探讨如何设计 Skill。
                  </div>

                  <div
                    v-for="msg in workbenchSession.messages"
                    :key="msg.id"
                    :class="['chat-bubble', msg.role]"
                  >
                    <div class="chat-role">
                      {{ msg.role === "user" ? form.creator || "我" : "pi-agent" }}
                    </div>
                    <details v-if="msg.thinking" class="chat-thinking-box">
                      <summary>思考过程</summary>
                      <pre class="chat-thinking-body">{{ msg.thinking }}</pre>
                    </details>
                    <ToolCallsView
                      v-if="msg.toolCalls && msg.toolCalls.length > 0"
                      :tool-calls="msg.toolCalls"
                      @open-skill="(name) => emit('open-skill', name)"
                    />
                    <div v-else-if="msg.toolLogs && msg.toolLogs.length > 0" class="chat-tool-logs">
                      <div v-for="(log, idx) in msg.toolLogs" :key="idx" class="chat-tool-item">
                        {{ log }}
                      </div>
                    </div>
                    <MarkdownRenderer
                      v-if="msg.role === 'assistant'"
                      class="chat-markdown"
                      :content="msg.content"
                    />
                    <div v-else class="chat-plain">{{ msg.content }}</div>
                  </div>

                  <div
                    v-if="workbenchSession.status === 'running'"
                    class="chat-bubble assistant streaming"
                  >
                    <div class="chat-role">pi-agent（思考与执行中...）</div>
                    <details v-if="workbenchSession.streamingThinking" open class="chat-thinking-box">
                      <summary>正在思考...</summary>
                      <pre class="chat-thinking-body">{{ workbenchSession.streamingThinking }}</pre>
                    </details>
                    <ToolCallsView
                      v-if="workbenchSession.streamingToolCalls && workbenchSession.streamingToolCalls.length > 0"
                      :tool-calls="workbenchSession.streamingToolCalls"
                      @open-skill="(name) => emit('open-skill', name)"
                    />
                    <div
                      v-else-if="workbenchSession.streamingLogs.length > 0"
                      class="chat-tool-logs"
                    >
                      <div
                        v-for="(log, idx) in workbenchSession.streamingLogs"
                        :key="idx"
                        class="chat-tool-item"
                      >
                        {{ log }}
                      </div>
                    </div>
                    <MarkdownRenderer
                      v-if="workbenchSession.streamingText"
                      class="chat-markdown"
                      :content="workbenchSession.streamingText"
                      :streaming="true"
                    />
                  </div>
                </template>
              </div>

              <!-- 交互式提问停靠栏 (ask_user_question) -->
              <QuestionDock
                v-if="workbenchSession?.pendingQuestion"
                :pending-question="workbenchSession.pendingQuestion"
                :submitting="workbenchSubmittingAnswer"
                @submit="handleSubmitQuestionAnswer"
              />

              <!-- 下一步快捷建议 Chips (suggest_next_steps) -->
              <NextStepsBar
                v-if="
                  workbenchSession &&
                  !disabledWorkbenchExtensions.includes('next-steps') &&
                  workbenchSession.nextSteps &&
                  workbenchSession.nextSteps.length > 0
                "
                :steps="workbenchSession.nextSteps"
                :disabled="workbenchSession.status === 'running' || workbenchSending"
                @select="handleSelectNextStep"
              />

              <!-- Thinkrail 风格 Composer 控制栏：模型、思考等级、Skills、MCP -->
              <div class="workbench-composer-toolbar">
                <div class="composer-left-controls">
                  <el-button size="small" plain @click="openOpenaiDialog">
                    模型：{{
                      workbenchSession?.model?.id ||
                      openaiConfig.modelName ||
                      "默认"
                    }}
                  </el-button>
                  <el-select
                    v-model="workbenchThinkingLevel"
                    size="small"
                    style="width: 130px"
                    placeholder="思考等级"
                    @change="handleThinkingLevelChange"
                  >
                    <el-option
                      v-for="lvl in workbenchSession?.availableThinkingLevels || [
                        'off',
                        'minimal',
                        'low',
                        'medium',
                        'high',
                      ]"
                      :key="lvl"
                      :label="`思考: ${lvl}`"
                      :value="lvl"
                    />
                  </el-select>
                  <el-button
                    v-if="workbenchSession"
                    size="small"
                    plain
                    @click="workbenchSkillsDialogVisible = true"
                  >
                    /skill ({{ workbenchSession.skills.length }})
                  </el-button>
                </div>
              </div>

              <div class="workbench-input-bar">
                <el-input
                  v-model="workbenchInput"
                  type="textarea"
                  :rows="3"
                  placeholder="向 pi-agent 提问或下达操作版本库/MCP 的指令（Ctrl+Enter / Cmd+Enter 发送）..."
                  @keydown.ctrl.enter.prevent="handleSendWorkbenchMessage"
                  @keydown.meta.enter.prevent="handleSendWorkbenchMessage"
                />
                <div class="workbench-send-col">
                  <el-button
                    type="primary"
                    :loading="workbenchSending || workbenchSession?.status === 'running'"
                    @click="handleSendWorkbenchMessage"
                  >
                    发送
                  </el-button>
                  <el-button
                    v-if="workbenchSession?.status === 'running'"
                    type="danger"
                    plain
                    @click="handleAbortWorkbench"
                  >
                    中断
                  </el-button>
                </div>
              </div>
            </el-card>
          </el-col>
        </el-row>
      </template>
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

    <el-dialog
      v-model="mcpDialogVisible"
      title="添加 Streamable HTTP MCP"
      width="480px"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-form-item label="归属创建人">
          <el-input :model-value="form.creator || 'Admin'" disabled />
        </el-form-item>
        <el-form-item label="MCP 名称" required>
          <el-input
            v-model="mcpForm.name"
            placeholder="例如：jira-mcp、gitlab-tools"
          />
        </el-form-item>
        <el-form-item label="Streamable HTTP URL" required>
          <el-input
            v-model="mcpForm.url"
            placeholder="例如：https://mcp.example.com/mcp"
          />
        </el-form-item>
        <el-form-item label="请求头 Headers（JSON 对象，可选）">
          <el-input
            v-model="mcpForm.headersText"
            type="textarea"
            :rows="3"
            placeholder='例如：{"Authorization": "Bearer your-token"}'
          />
        </el-form-item>
        <el-form-item label="描述（可选）">
          <el-input
            v-model="mcpForm.description"
            placeholder="简述该 MCP 提供的能力"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mcpDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="savingMcp"
          @click="handleCreateMcp"
        >
          保存并添加到列表
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="openaiDialogVisible"
      title="OpenAI API Key 与模型设置"
      width="500px"
    >
      <el-form label-position="top">
        <el-form-item label="Base URL（兼容 OpenAI 接口地址）">
          <el-input
            v-model="openaiDraft.baseUrl"
            placeholder="例如：https://api.openai.com/v1（留空使用默认）"
            @blur="handleOpenaiCredsBlur"
          />
        </el-form-item>
        <el-form-item label="OpenAI API Key">
          <el-input
            v-model="openaiDraft.apiKey"
            type="password"
            show-password
            placeholder="sk-...（留空则使用后端默认 .env 配置）"
            @blur="handleOpenaiCredsBlur"
          />
        </el-form-item>
        <el-form-item>
          <template #label>
            <div class="model-select-label-row">
              <span>模型名称（Model）</span>
              <el-button
                link
                type="primary"
                size="small"
                :loading="loadingOpenaiModels"
                @click="loadOpenaiModels(true)"
              >
                刷新可用模型 (/models)
              </el-button>
            </div>
          </template>
          <el-select
            v-model="openaiDraft.modelName"
            filterable
            allow-create
            default-first-option
            clearable
            :loading="loadingOpenaiModels"
            placeholder="填写 Base URL 与 API Key 后自动加载，或直接输入模型名"
            style="width: 100%"
          >
            <el-option
              v-for="m in openaiModels"
              :key="m.id"
              :label="m.id"
              :value="m.id"
            >
              <div class="model-option-row">
                <span>{{ m.id }}</span>
                <span v-if="m.ownedBy" class="model-option-owner">{{ m.ownedBy }}</span>
              </div>
            </el-option>
          </el-select>
          <div v-if="loadingOpenaiModels" class="model-status-hint">
            正在从 /models 拉取可用模型列表...
          </div>
          <div v-else-if="openaiModelsError" class="model-status-hint error">
            {{ openaiModelsError }}
          </div>
          <div v-else-if="openaiModels.length > 0" class="model-status-hint success">
            已从 {{ openaiModelsSourceUrl || "当前网关" }} 获取 {{ openaiModels.length }} 个可用模型
          </div>
          <div v-if="openaiModels.length === 0" class="model-quick-picks">
            <span class="quick-label">常用：</span>
            <el-tag
              v-for="m in ['gpt-4o', 'gpt-4.1', 'o3-mini', 'deepseek-chat']"
              :key="m"
              size="small"
              class="quick-tag"
              @click="openaiDraft.modelName = m"
            >
              {{ m }}
            </el-tag>
          </div>
        </el-form-item>
        <el-form-item label="API 模式">
          <el-radio-group v-model="openaiDraft.apiMode" size="small">
            <el-radio-button value="chat">Chat Completions</el-radio-button>
            <el-radio-button value="responses">Responses API</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resetOpenaiConfig">恢复默认</el-button>
        <el-button @click="openaiDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveOpenaiConfig">保存配置</el-button>
      </template>
    </el-dialog>

    <!-- 工作台 Skills 列表弹窗 -->
    <el-dialog
      v-model="workbenchSkillsDialogVisible"
      title="当前会话可用 Skills"
      width="560px"
    >
      <el-input
        v-model="skillSearchQuery"
        placeholder="搜索 Skill 名称或描述..."
        clearable
        style="margin-bottom: 12px"
      />
      <div class="wb-dialog-list">
        <div
          v-for="sk in filteredWorkbenchSkills"
          :key="sk.name"
          class="wb-dialog-item"
        >
          <div class="wb-dialog-item-head">
            <strong>{{ sk.name }}</strong>
            <div style="display: flex; align-items: center; gap: 6px">
              <el-tag size="small" type="info">{{ sk.source }}</el-tag>
              <el-button
                size="small"
                type="primary"
                plain
                @click="insertSkillToken(sk.name)"
              >
                插入 /skill:{{ sk.name }}
              </el-button>
            </div>
          </div>
          <div class="wb-dialog-item-desc">{{ sk.description || "暂无描述" }}</div>
        </div>
        <el-empty v-if="filteredWorkbenchSkills.length === 0" description="没有匹配的 Skill" />
      </div>
    </el-dialog>

    <!-- 工作台 MCP 状态与工具弹窗 -->
    <el-dialog
      v-model="workbenchMcpDialogVisible"
      title="已挂载 MCP 服务与工具"
      width="560px"
    >
      <div class="wb-dialog-list">
        <div
          v-for="srv in workbenchSession?.mcpServers || []"
          :key="srv.id"
          class="wb-dialog-item"
        >
          <div class="wb-dialog-item-head">
            <strong>{{ srv.name }}</strong>
            <el-tag
              size="small"
              :type="
                srv.status === 'connected'
                  ? 'success'
                  : srv.status === 'connecting'
                    ? 'warning'
                    : 'danger'
              "
            >
              {{ srv.status }}
            </el-tag>
          </div>
          <div class="wb-dialog-item-desc">{{ srv.url }}</div>
          <div v-if="srv.tools.length > 0" class="wb-mcp-tools">
            <el-tag v-for="t in srv.tools" :key="t" size="small" effect="plain">
              {{ t }}
            </el-tag>
          </div>
          <div v-else class="wb-dialog-item-desc">暂无已加载工具</div>
        </div>
        <el-empty
          v-if="!workbenchSession || workbenchSession.mcpServers.length === 0"
          description="当前会话未挂载任何 Streamable HTTP MCP"
        />
      </div>
    </el-dialog>
    <!-- 会话任务清单弹窗 (pi-todos) -->
    <TodoPanel
      v-if="workbenchSession"
      v-model:visible="workbenchTodoDialogVisible"
      :todos="workbenchSession.todos"
      @add="handleAddWorkbenchTodo"
      @remove="handleRemoveWorkbenchTodo"
    />

    <!-- 受控后台命令弹窗 (background_command) -->
    <BackgroundCommandsPanel
      v-if="workbenchSession"
      v-model:visible="workbenchBgDialogVisible"
      :commands="workbenchSession.backgroundCommands || []"
      @stop="handleStopWorkbenchBgCommand"
    />

    <!-- 工具扩展开关弹窗 -->
    <ExtensionsDialog
      v-model:visible="workbenchExtDialogVisible"
      :extensions="workbenchExtensionCatalog"
      :disabled-extensions="disabledWorkbenchExtensions"
      @update:disabled-extensions="handleUpdateDisabledExtensions"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { ElButton, ElMessage, ElNotification } from "element-plus";
import { Marked } from "marked";
import hljs from "highlight.js";
import BackgroundCommandsPanel from "./workbench/BackgroundCommandsPanel.vue";
import ExtensionsDialog from "./workbench/ExtensionsDialog.vue";
import MarkdownRenderer from "./workbench/MarkdownRenderer.vue";
import NextStepsBar from "./workbench/NextStepsBar.vue";
import QuestionDock from "./workbench/QuestionDock.vue";
import TodoPanel from "./workbench/TodoPanel.vue";
import ToolCallsView from "./workbench/ToolCallsView.vue";
import {
  abortGenerationJob,
  abortWorkbenchSession,
  addWorkbenchTodo,
  closeWorkbenchSession,
  createUserMcp,
  createWorkbenchSession,
  deleteUserMcp,
  fetchCatalog,
  fetchGenerationJob,
  fetchOpenAIModels,
  fetchSkillDetail,
  fetchUserMcps,
  fetchWorkbenchExtensions,
  fetchWorkbenchSession,
  fetchWorkbenchSessions,
  getSkillDownloadUrl,
  publishSkill,
  removeWorkbenchTodo,
  restartGenerationJob,
  runTestPipeline,
  sendWorkbenchMessage,
  setWorkbenchThinking,
  startGenerationJob,
  stopWorkbenchBgCommand,
  submitWorkbenchQuestionAnswer,
  updateSkill,
  type AppCatalogItem,
  type GenerationJobSnapshot,
  type GenerationJobStatus,
  type OpenAIModelItem,
  type OpenAIOverrideConfig,
  type RepoCatalogItem,
  type RepoPipelineRun,
  type SkillFileEntry,
  type UserMcpServer,
  type UserQuestionSubmission,
  type WorkbenchExtensionDescriptor,
  type WorkbenchSessionSnapshot,
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
  (e: "open-skill", skillName: string): void;
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
const stepOneMode = ref<"skill" | "creative">(
  props.initialSkillName ? "skill" : "creative"
);
const isNewSkill = ref(!props.initialSkillName);
const editorMode = ref<"preview" | "edit">("preview");

const generating = ref(false);
const submitting = ref(false);
const testing = ref(false);
const publishing = ref(false);
const enableTimeout = ref(false);
const timeoutSeconds = ref(120);
const currentJob = ref<GenerationJobSnapshot | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let jenkinsLogTimer: ReturnType<typeof setInterval> | null = null;
let workbenchTimer: ReturnType<typeof setInterval> | null = null;

const workbenchRepoId = ref<string>("");
const workbenchCustomCwd = ref<string>("");
const workbenchSessions = ref<WorkbenchSessionSnapshot[]>([]);
const workbenchSession = ref<WorkbenchSessionSnapshot | null>(null);
const isCreatingWorkbenchSession = ref<boolean>(true);
const workbenchInput = ref<string>("");
const workbenchInitializing = ref(false);
const workbenchSending = ref(false);
const workbenchThinkingLevel = ref<string>("medium");
const workbenchSkillsDialogVisible = ref(false);
const workbenchMcpDialogVisible = ref(false);
const skillSearchQuery = ref<string>("");

const filteredWorkbenchSkills = computed(() => {
  const list = workbenchSession.value?.skills ?? [];
  const q = skillSearchQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
  );
});

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
const userMcps = ref<UserMcpServer[]>([]);
const selectedMcps = ref<string[]>([]);
const loadingMcps = ref(false);
const mcpDialogVisible = ref(false);
const savingMcp = ref(false);
const mcpForm = reactive({
  name: "",
  url: "",
  headersText: "",
  description: "",
});
const OPENAI_STORAGE_KEY = "ai_pipeline_openai_config";
const openaiDialogVisible = ref(false);
const openaiConfig = reactive<OpenAIOverrideConfig>({
  apiKey: "",
  modelName: "",
  baseUrl: "",
  apiMode: "chat",
});
const openaiDraft = reactive<OpenAIOverrideConfig>({
  apiKey: "",
  modelName: "",
  baseUrl: "",
  apiMode: "chat",
});
const openaiModels = ref<OpenAIModelItem[]>([]);
const loadingOpenaiModels = ref(false);
const openaiModelsError = ref("");
const openaiModelsSourceUrl = ref("");
let openaiModelsRequestSeq = 0;
let lastFetchedModelsKey = "";
let openaiModelsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const hasCustomOpenAI = computed(() =>
  Boolean(
    openaiConfig.apiKey?.trim() ||
      openaiConfig.modelName?.trim() ||
      openaiConfig.baseUrl?.trim()
  )
);
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

async function loadUserMcps() {
  const owner = form.creator.trim() || "Admin";
  loadingMcps.value = true;
  try {
    const res = await fetchUserMcps(owner);
    userMcps.value = Array.isArray(res.mcps) ? res.mcps : [];
    const validIds = new Set(userMcps.value.map((m) => m.id));
    selectedMcps.value = selectedMcps.value.filter((id) => validIds.has(id));
  } catch {
    // 找不到 MCP 或未配置时不报错，安静置空且不默认选中
    userMcps.value = [];
    selectedMcps.value = [];
  } finally {
    loadingMcps.value = false;
  }
}

function renderMarkdownText(raw: string): string {
  return marked.parse(raw || "") as string;
}

function formatCompactTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 9_950) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 999_500) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function contextBarText(usage: {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}): { bar: string; text: string } {
  const filled =
    usage.percent === null
      ? 0
      : Math.round(Math.min(100, Math.max(0, usage.percent)) / 20);
  const cw = formatCompactTokens(usage.contextWindow);
  return {
    bar: `${"▰".repeat(filled)}${"▱".repeat(5 - filled)}`,
    text:
      usage.percent === null
        ? `?/${cw}`
        : `${usage.percent.toFixed(1)}%/${cw}`,
  };
}

async function handleThinkingLevelChange(level: string) {
  if (!workbenchSession.value) return;
  try {
    const { session } = await setWorkbenchThinking(
      workbenchSession.value.sessionId,
      level
    );
    workbenchSession.value = session;
    ElMessage.success(`思考等级已切换为 ${level}`);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "切换思考等级失败");
  }
}

function insertSkillToken(name: string) {
  const token = `/skill:${name} `;
  workbenchInput.value = workbenchInput.value
    ? `${workbenchInput.value.trimEnd()} ${token}`
    : token;
  workbenchSkillsDialogVisible.value = false;
}

function stopWorkbenchPolling() {
  if (workbenchTimer !== null) {
    clearInterval(workbenchTimer);
    workbenchTimer = null;
  }
}

function folderBasename(dirPath: string): string {
  const parts = dirPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || dirPath || "workspace";
}

function upsertWorkbenchSessionInList(session: WorkbenchSessionSnapshot) {
  const idx = workbenchSessions.value.findIndex(
    (s) => s.sessionId === session.sessionId
  );
  if (idx >= 0) {
    workbenchSessions.value[idx] = session;
  } else {
    workbenchSessions.value.unshift(session);
  }
}

async function loadWorkbenchSessions() {
  const owner = form.creator.trim() || "Admin";
  try {
    const res = await fetchWorkbenchSessions(owner);
    workbenchSessions.value = Array.isArray(res.sessions) ? res.sessions : [];
    if (workbenchSessions.value.length > 0) {
      isCreatingWorkbenchSession.value = false;
      const currentExists =
        workbenchSession.value &&
        workbenchSessions.value.some(
          (s) => s.sessionId === workbenchSession.value!.sessionId
        );
      if (!currentExists) {
        workbenchSession.value = workbenchSessions.value[0];
        workbenchThinkingLevel.value =
          workbenchSession.value.thinkingLevel || "medium";
      }
    } else {
      workbenchSession.value = null;
      isCreatingWorkbenchSession.value = true;
    }
  } catch {
    workbenchSessions.value = [];
  }
}

async function handleCreatorChange() {
  await Promise.all([loadUserMcps(), loadWorkbenchSessions()]);
}

function selectWorkbenchSession(sess: WorkbenchSessionSnapshot) {
  workbenchSession.value = sess;
  workbenchThinkingLevel.value = sess.thinkingLevel || "medium";
  if (sess.status === "running") {
    beginWorkbenchPolling(sess.sessionId);
  } else {
    stopWorkbenchPolling();
  }
}

function handleOpenNewWorkbenchForm() {
  workbenchRepoId.value = "";
  workbenchCustomCwd.value = "";
  isCreatingWorkbenchSession.value = true;
}

async function handleCloseWorkbenchSession(sessionId: string) {
  try {
    await closeWorkbenchSession(sessionId);
    workbenchSessions.value = workbenchSessions.value.filter(
      (s) => s.sessionId !== sessionId
    );
    if (workbenchSession.value?.sessionId === sessionId) {
      stopWorkbenchPolling();
      workbenchSession.value = workbenchSessions.value[0] ?? null;
    }
    if (workbenchSessions.value.length === 0) {
      isCreatingWorkbenchSession.value = true;
    }
    ElMessage.success("已关闭工作台会话");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "关闭会话失败");
  }
}

const notifiedSavedSkillCallIds = new Set<string>();

function notifySkillDistilled(skillName: string) {
  const handle = ElNotification({
    title: "Skill 沉淀完成",
    type: "success",
    duration: 3000,
    message: h(
      "div",
      { style: "display: flex; flex-direction: column; gap: 8px;" },
      [
        h(
          "div",
          { style: "font-size: 13px; color: #303133; line-height: 1.5;" },
          `新 Skill「${skillName}」已生成并出现在卡片页面中。`
        ),
        h("div", { style: "display: flex; justify-content: flex-end;" }, [
          h(
            ElButton,
            {
              type: "primary",
              size: "small",
              onClick: () => {
                handle.close();
                emit("open-skill", skillName);
              },
            },
            () => "立即跳转"
          ),
        ]),
      ]
    ),
  });
}

function checkAndNotifySavedSkills(session: WorkbenchSessionSnapshot) {
  const candidates = [
    ...(session.streamingToolCalls ?? []),
    ...(session.messages[session.messages.length - 1]?.toolCalls ?? []),
  ];
  for (const tc of candidates) {
    if (
      tc.toolName === "save_skill" &&
      tc.status === "completed" &&
      !tc.isError &&
      !notifiedSavedSkillCallIds.has(tc.toolCallId)
    ) {
      notifiedSavedSkillCallIds.add(tc.toolCallId);
      const skillName =
        typeof tc.details?.skillName === "string" && tc.details.skillName.trim()
          ? tc.details.skillName.trim()
          : typeof tc.args?.skillName === "string"
            ? tc.args.skillName.trim()
            : "";
      if (skillName) {
        notifySkillDistilled(skillName);
      }
    }
  }
}

function beginWorkbenchPolling(sessionId: string) {
  stopWorkbenchPolling();
  workbenchTimer = setInterval(async () => {
    try {
      const { session } = await fetchWorkbenchSession(sessionId);
      workbenchSession.value = session;
      upsertWorkbenchSessionInList(session);
      checkAndNotifySavedSkills(session);
      if (session.status !== "running") {
        stopWorkbenchPolling();
      }
    } catch {
      stopWorkbenchPolling();
    }
  }, 800);
}

function getCustomOpenaiPayload(): OpenAIOverrideConfig | undefined {
  if (!hasCustomOpenAI.value) return undefined;
  return {
    ...(openaiConfig.apiKey?.trim() ? { apiKey: openaiConfig.apiKey.trim() } : {}),
    ...(openaiConfig.modelName?.trim()
      ? { modelName: openaiConfig.modelName.trim() }
      : {}),
    ...(openaiConfig.baseUrl?.trim() ? { baseUrl: openaiConfig.baseUrl.trim() } : {}),
    ...(openaiConfig.apiMode ? { apiMode: openaiConfig.apiMode } : {}),
  };
}

const EXTENSIONS_STORAGE_KEY = "workbench_disabled_extensions_v1";
const workbenchTodoDialogVisible = ref(false);
const workbenchBgDialogVisible = ref(false);
const workbenchExtDialogVisible = ref(false);
const workbenchSubmittingAnswer = ref(false);
const workbenchExtensionCatalog = ref<WorkbenchExtensionDescriptor[]>([]);
const disabledWorkbenchExtensions = ref<string[]>([]);

const workbenchTodoCount = computed(() => {
  const todos = workbenchSession.value?.todos;
  if (!todos) return 0;
  const groupCount = todos.groups.reduce((sum, g) => sum + g.items.length, 0);
  return groupCount + todos.loose.length;
});

const workbenchRunningBgCount = computed(() => {
  return (workbenchSession.value?.backgroundCommands ?? []).filter(
    (c) => c.status === "running"
  ).length;
});

const enabledExtensionCount = computed(() => {
  const disabled = new Set(disabledWorkbenchExtensions.value);
  return workbenchExtensionCatalog.value.filter((ext) => !disabled.has(ext.id))
    .length;
});

function loadSavedDisabledExtensions() {
  try {
    const raw = localStorage.getItem(EXTENSIONS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      disabledWorkbenchExtensions.value = parsed.filter(
        (id): id is string => typeof id === "string"
      );
    }
  } catch {
    // Ignore invalid storage
  }
}

function handleUpdateDisabledExtensions(next: string[]) {
  disabledWorkbenchExtensions.value = next;
  localStorage.setItem(EXTENSIONS_STORAGE_KEY, JSON.stringify(next));
}

async function handleSubmitQuestionAnswer(payload: UserQuestionSubmission) {
  if (!workbenchSession.value) return;
  workbenchSubmittingAnswer.value = true;
  try {
    const { session } = await submitWorkbenchQuestionAnswer(
      workbenchSession.value.sessionId,
      payload
    );
    workbenchSession.value = session;
    upsertWorkbenchSessionInList(session);
    beginWorkbenchPolling(session.sessionId);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "提交回答失败");
  } finally {
    workbenchSubmittingAnswer.value = false;
  }
}

async function handleSelectNextStep(prompt: string) {
  workbenchInput.value = prompt;
  await handleSendWorkbenchMessage();
}

async function handleAddWorkbenchTodo(title: string) {
  if (!workbenchSession.value) return;
  try {
    const { session } = await addWorkbenchTodo(
      workbenchSession.value.sessionId,
      { title }
    );
    workbenchSession.value = session;
    upsertWorkbenchSessionInList(session);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "添加待办失败");
  }
}

async function handleRemoveWorkbenchTodo(itemId: string) {
  if (!workbenchSession.value) return;
  try {
    const { session } = await removeWorkbenchTodo(
      workbenchSession.value.sessionId,
      itemId
    );
    workbenchSession.value = session;
    upsertWorkbenchSessionInList(session);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "删除待办失败");
  }
}

async function handleStopWorkbenchBgCommand(commandId: string) {
  if (!workbenchSession.value) return;
  try {
    const { session } = await stopWorkbenchBgCommand(
      workbenchSession.value.sessionId,
      commandId
    );
    workbenchSession.value = session;
    upsertWorkbenchSessionInList(session);
    ElMessage.info("已请求停止后台命令");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "停止后台命令失败");
  }
}

async function handleStartWorkbench(): Promise<WorkbenchSessionSnapshot | null> {
  workbenchInitializing.value = true;
  stopWorkbenchPolling();
  try {
    const { session } = await createWorkbenchSession({
      owner: form.creator.trim() || "Admin",
      repoId: workbenchRepoId.value || undefined,
      customCwd: workbenchCustomCwd.value.trim() || undefined,
      selectedMcps: selectedMcps.value,
      disabledExtensions: disabledWorkbenchExtensions.value,
      openaiConfig: getCustomOpenaiPayload(),
      thinkingLevel: workbenchThinkingLevel.value,
    });
    workbenchSession.value = session;
    upsertWorkbenchSessionInList(session);
    isCreatingWorkbenchSession.value = false;
    workbenchThinkingLevel.value = session.thinkingLevel || "medium";
    ElMessage.success("pi-agent 工作台会话已启动");
    return session;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "启动工作台失败");
    return null;
  } finally {
    workbenchInitializing.value = false;
  }
}

async function handleSendWorkbenchMessage() {
  const msg = workbenchInput.value.trim();
  if (!msg) return;

  workbenchSending.value = true;
  try {
    if (!workbenchSession.value) {
      const created = await handleStartWorkbench();
      if (!created) return;
    }
    if (!workbenchSession.value) return;
    const { session } = await sendWorkbenchMessage(
      workbenchSession.value.sessionId,
      msg
    );
    workbenchSession.value = session;
    upsertWorkbenchSessionInList(session);
    workbenchInput.value = "";
    beginWorkbenchPolling(session.sessionId);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "发送消息失败");
  } finally {
    workbenchSending.value = false;
  }
}

async function handleAbortWorkbench() {
  if (!workbenchSession.value) return;
  try {
    const { session } = await abortWorkbenchSession(
      workbenchSession.value.sessionId
    );
    workbenchSession.value = session;
    stopWorkbenchPolling();
    ElMessage.warning("已中断当前对话轮次");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "中断失败");
  }
}

async function handleDistillToSkill() {
  if (!workbenchSession.value) return;
  if (workbenchSession.value.status === "running" || workbenchSending.value) {
    ElMessage.warning("当前会话正在执行中，请等待本轮完成后再沉淀为 Skill");
    return;
  }
  if (
    workbenchSession.value.disabledExtensions?.includes("skill-distiller")
  ) {
    ElMessage.warning(
      "当前会话已禁用「直接沉淀 Skill (save_skill)」扩展，请在扩展开关中启用后新建会话"
    );
    return;
  }

  const distillPrompt =
    "请总结我们在当前会话中的探索过程、验证过的命令/脚本以及最佳实践，直接调用 `save_skill` 工具生成并保存一个完整、可复用的 Skill（包含规范的 kebab-case 名称、清晰描述、带 YAML frontmatter 的完整 SKILL.md，以及所需的 scripts/references/assets 附属文件）。如果还有关键边界或命名需要确认，可先调用 `ask_user_question` 询问我。";

  workbenchSending.value = true;
  try {
    const { session } = await sendWorkbenchMessage(
      workbenchSession.value.sessionId,
      distillPrompt
    );
    workbenchSession.value = session;
    upsertWorkbenchSessionInList(session);
    beginWorkbenchPolling(session.sessionId);
    ElMessage.success("已指令 pi-agent 直接调用 save_skill 工具生成 Skill");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "触发沉淀 Skill 失败");
  } finally {
    workbenchSending.value = false;
  }
}

function openAddMcpDialog() {
  mcpForm.name = "";
  mcpForm.url = "";
  mcpForm.headersText = "";
  mcpForm.description = "";
  mcpDialogVisible.value = true;
}

async function handleCreateMcp() {
  const owner = form.creator.trim() || "Admin";
  if (!mcpForm.name.trim() || !mcpForm.url.trim()) {
    ElMessage.warning("请填写 MCP 名称和 Streamable HTTP URL");
    return;
  }
  let headers: Record<string, string> | undefined;
  if (mcpForm.headersText.trim()) {
    try {
      const parsed = JSON.parse(mcpForm.headersText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        ElMessage.warning("请求头 Headers 必须是 JSON 对象");
        return;
      }
      headers = parsed as Record<string, string>;
    } catch {
      ElMessage.warning("请求头 Headers JSON 格式不正确");
      return;
    }
  }
  savingMcp.value = true;
  try {
    const { mcp } = await createUserMcp({
      owner,
      name: mcpForm.name.trim(),
      url: mcpForm.url.trim(),
      headers,
      description: mcpForm.description.trim(),
    });
    await loadUserMcps();
    if (!selectedMcps.value.includes(mcp.id)) {
      selectedMcps.value.push(mcp.id);
    }
    mcpDialogVisible.value = false;
    ElMessage.success(`MCP "${mcp.name}" 已保存并勾选`);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "保存 MCP 失败");
  } finally {
    savingMcp.value = false;
  }
}

async function handleDeleteMcp(mcp: UserMcpServer) {
  const owner = form.creator.trim() || "Admin";
  try {
    await deleteUserMcp(mcp.id, owner);
    selectedMcps.value = selectedMcps.value.filter((id) => id !== mcp.id);
    await loadUserMcps();
    ElMessage.success(`已删除 MCP "${mcp.name}"`);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "删除 MCP 失败");
  }
}

function loadSavedOpenaiConfig() {
  try {
    const raw = localStorage.getItem(OPENAI_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as OpenAIOverrideConfig;
    openaiConfig.apiKey = parsed.apiKey || "";
    openaiConfig.modelName = parsed.modelName || "";
    openaiConfig.baseUrl = parsed.baseUrl || "";
    openaiConfig.apiMode = parsed.apiMode === "responses" ? "responses" : "chat";
  } catch {
    // Ignore invalid stored config
  }
}

async function loadOpenaiModels(force = false) {
  const apiKey = openaiDraft.apiKey?.trim() || "";
  const baseUrl = openaiDraft.baseUrl?.trim() || "";
  const apiMode = openaiDraft.apiMode === "responses" ? "responses" : "chat";

  if (!force && (!apiKey || (baseUrl && !/^https?:\/\/.+/i.test(baseUrl)))) {
    return;
  }

  const cacheKey = `${baseUrl}|${apiKey}|${apiMode}`;
  if (!force && cacheKey === lastFetchedModelsKey && openaiModels.value.length > 0) {
    return;
  }

  const seq = ++openaiModelsRequestSeq;
  loadingOpenaiModels.value = true;
  openaiModelsError.value = "";
  try {
    const res = await fetchOpenAIModels({
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      apiMode,
    });
    if (seq !== openaiModelsRequestSeq) return;
    openaiModels.value = res.models;
    openaiModelsSourceUrl.value = res.baseUrl;
    lastFetchedModelsKey = cacheKey;
    if (
      res.models.length > 0 &&
      !openaiDraft.modelName?.trim()
    ) {
      openaiDraft.modelName = res.models[0].id;
    }
  } catch (err) {
    if (seq !== openaiModelsRequestSeq) return;
    openaiModels.value = [];
    openaiModelsSourceUrl.value = "";
    const msg =
      err instanceof Error && err.message && err.message !== "Not Found"
        ? err.message
        : "未能自动获取可用模型列表，请检查 Base URL 与 API Key，或直接手动输入模型名";
    openaiModelsError.value = msg;
    if (force) {
      ElMessage.warning(msg);
    }
  } finally {
    if (seq === openaiModelsRequestSeq) {
      loadingOpenaiModels.value = false;
    }
  }
}

function handleOpenaiCredsBlur() {
  if (openaiModelsDebounceTimer) {
    clearTimeout(openaiModelsDebounceTimer);
    openaiModelsDebounceTimer = null;
  }
  const apiKey = openaiDraft.apiKey?.trim() || "";
  const baseUrl = openaiDraft.baseUrl?.trim() || "";
  if (apiKey && (!baseUrl || /^https?:\/\/.+/i.test(baseUrl))) {
    void loadOpenaiModels(false);
  }
}

watch(
  () => [openaiDialogVisible.value, openaiDraft.baseUrl, openaiDraft.apiKey] as const,
  ([visible, baseUrl, apiKey]) => {
    if (openaiModelsDebounceTimer) {
      clearTimeout(openaiModelsDebounceTimer);
      openaiModelsDebounceTimer = null;
    }
    if (!visible) return;
    const cleanKey = (apiKey || "").trim();
    const cleanUrl = (baseUrl || "").trim();
    if (!cleanKey || (cleanUrl && !/^https?:\/\/.+/i.test(cleanUrl))) return;
    openaiModelsDebounceTimer = setTimeout(() => {
      void loadOpenaiModels(false);
    }, 600);
  }
);

function openOpenaiDialog() {
  openaiDraft.apiKey = openaiConfig.apiKey || "";
  openaiDraft.modelName = openaiConfig.modelName || "";
  openaiDraft.baseUrl = openaiConfig.baseUrl || "";
  openaiDraft.apiMode = openaiConfig.apiMode || "chat";
  openaiModelsError.value = "";
  openaiDialogVisible.value = true;
  if (openaiDraft.apiKey.trim()) {
    void loadOpenaiModels(false);
  }
}

function saveOpenaiConfig() {
  openaiConfig.apiKey = openaiDraft.apiKey?.trim() || "";
  openaiConfig.modelName = openaiDraft.modelName?.trim() || "";
  openaiConfig.baseUrl = openaiDraft.baseUrl?.trim() || "";
  openaiConfig.apiMode = openaiDraft.apiMode === "responses" ? "responses" : "chat";
  localStorage.setItem(OPENAI_STORAGE_KEY, JSON.stringify(openaiConfig));
  openaiDialogVisible.value = false;
  ElMessage.success("OpenAI API Key 与模型配置已保存");
}

function resetOpenaiConfig() {
  openaiDraft.apiKey = "";
  openaiDraft.modelName = "";
  openaiDraft.baseUrl = "";
  openaiDraft.apiMode = "chat";
  openaiConfig.apiKey = "";
  openaiConfig.modelName = "";
  openaiConfig.baseUrl = "";
  openaiConfig.apiMode = "chat";
  localStorage.removeItem(OPENAI_STORAGE_KEY);
  openaiDialogVisible.value = false;
  ElMessage.info("已恢复使用后端默认 OpenAI 配置");
}

onMounted(async () => {
  loadSavedOpenaiConfig();
  loadSavedDisabledExtensions();
  fetchWorkbenchExtensions()
    .then((res) => {
      workbenchExtensionCatalog.value = res.extensions || [];
    })
    .catch(() => {});
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
      selectedMcps.value = detail.card.selectedMcps ?? [];
      pipelineRuns.value = detail.card.pipelineRuns;
      if (detail.card.pipelineRuns.length > 0) {
        activeLogRepoId.value = detail.card.pipelineRuns[0].repoId;
      }
      if (detail.card.currentStep >= 2) {
        maxReachedStep.value = 2;
      }
      if (detail.card.status === "testing") {
        startJenkinsLogSync();
      }
      // 点击卡片默认进入第一步
      activeStep.value = 0;
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : "加载 Skill 详情失败");
    }
  }

  await Promise.all([loadUserMcps(), loadWorkbenchSessions()]);
});

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onUnmounted(() => {
  stopPolling();
  stopJenkinsLogSync();
  stopWorkbenchPolling();
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
    const customOpenai = hasCustomOpenAI.value
      ? {
          ...(openaiConfig.apiKey?.trim() ? { apiKey: openaiConfig.apiKey.trim() } : {}),
          ...(openaiConfig.modelName?.trim() ? { modelName: openaiConfig.modelName.trim() } : {}),
          ...(openaiConfig.baseUrl?.trim() ? { baseUrl: openaiConfig.baseUrl.trim() } : {}),
          ...(openaiConfig.apiMode ? { apiMode: openaiConfig.apiMode } : {}),
        }
      : undefined;

    const { job } = await startGenerationJob({
      skillName: form.skillName || undefined,
      description: form.description || undefined,
      creator: form.creator || "Admin",
      selectedMcps: selectedMcps.value,
      openaiConfig: customOpenai,
      prompt: form.prompt,
      timeoutMs: enableTimeout.value ? timeoutSeconds.value * 1000 : 0,
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
      timeoutMs: enableTimeout.value ? timeoutSeconds.value * 1000 : 0,
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
      selectedMcps: selectedMcps.value,
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

function stopJenkinsLogSync() {
  if (jenkinsLogTimer !== null) {
    clearInterval(jenkinsLogTimer);
    jenkinsLogTimer = null;
  }
}

function startJenkinsLogSync() {
  stopJenkinsLogSync();
  if (!form.skillName.trim()) return;
  jenkinsLogTimer = setInterval(async () => {
    try {
      const detail = await fetchSkillDetail(form.skillName);
      if (detail.card.pipelineRuns && detail.card.pipelineRuns.length > 0) {
        pipelineRuns.value = detail.card.pipelineRuns;
        if (!activeLogRepoId.value) {
          activeLogRepoId.value = detail.card.pipelineRuns[0].repoId;
        }
      }
      if (!testing.value && detail.card.status !== "testing") {
        stopJenkinsLogSync();
      }
    } catch {
      // Ignore transient polling errors
    }
  }, 3000);
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
  startJenkinsLogSync();
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
    stopJenkinsLogSync();
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
  --vsc-sidebar-bg: #f8f9fb;
  --vsc-sidebar-fg: #303133;
  --vsc-sidebar-hover: #edf2f7;
  --vsc-sidebar-active-bg: #ecf5ff;
  --vsc-sidebar-active-fg: #409eff;
  --vsc-surface-bg: #ffffff;
  --vsc-surface-fg: #303133;
  --vsc-border: #e4e7ed;
  --vsc-muted: #909399;

  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 12px;
  height: 520px;
}

@media (prefers-color-scheme: dark) {
  .vscode-explorer-layout {
    --vsc-sidebar-bg: #181b20;
    --vsc-sidebar-fg: #c9d1d9;
    --vsc-sidebar-hover: #21262d;
    --vsc-sidebar-active-bg: #1f3a5f;
    --vsc-sidebar-active-fg: #ffffff;
    --vsc-surface-bg: #1e2228;
    --vsc-surface-fg: #e6edf3;
    --vsc-border: #30363d;
    --vsc-muted: #8b949e;
  }
}

.vscode-sidebar {
  border: 1px solid var(--vsc-border);
  border-radius: 6px;
  background: var(--vsc-sidebar-bg);
  color: var(--vsc-sidebar-fg);
  overflow-y: auto;
  padding: 8px 4px;
}

.sidebar-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--vsc-muted);
  padding: 4px 10px 8px;
}

.vscode-sidebar :deep(.el-tree) {
  background: transparent;
  color: var(--vsc-sidebar-fg);
}

.vscode-sidebar :deep(.el-tree-node__content:hover) {
  background: var(--vsc-sidebar-hover);
}

.vscode-sidebar :deep(.el-tree--highlight-current .el-tree-node.is-current > .el-tree-node__content) {
  background: var(--vsc-sidebar-active-bg);
  color: var(--vsc-sidebar-active-fg);
  font-weight: 600;
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
  color: var(--vsc-muted);
}

.vscode-main {
  height: 100%;
  min-width: 0;
}

.vscode-textarea {
  width: 100%;
  height: 100%;
  resize: none;
  border: 1px solid var(--vsc-border);
  border-radius: 6px;
  padding: 14px;
  background: var(--vsc-surface-bg);
  color: var(--vsc-surface-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  outline: none;
}

.vscode-markdown-preview {
  height: 100%;
  overflow-y: auto;
  border: 1px solid var(--vsc-border);
  border-radius: 6px;
  padding: 16px 20px;
  background: var(--vsc-surface-bg);
  color: var(--vsc-surface-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.65;
  box-sizing: border-box;
}

.vscode-markdown-preview :deep(pre.hljs.code-file-preview) {
  margin: 0;
  min-height: 100%;
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  box-sizing: border-box;
}

.empty-preview {
  color: var(--vsc-muted);
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

.mcp-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}

.mcp-option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.mcp-option-name {
  font-weight: 500;
  color: #1f2937;
}

.mcp-option-url {
  flex: 1;
  font-size: 12px;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-empty-tip {
  padding: 10px 12px;
  font-size: 12px;
  color: #6b7280;
  text-align: center;
}

.panel-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.model-select-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.model-option-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.model-option-owner {
  font-size: 11px;
  color: #909399;
}

.model-status-hint {
  display: block;
  width: 100%;
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
  line-height: 1.45;
}

.model-status-hint.success {
  color: #67c23a;
}

.model-status-hint.error {
  color: #f56c6c;
}

.model-quick-picks {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.quick-label {
  font-size: 12px;
  color: #6b7280;
}

.quick-tag {
  cursor: pointer;
}

.timeout-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}

.timeout-disabled-tip {
  width: 100%;
  padding: 6px 12px;
  border-radius: 4px;
  background: #f3f4f6;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.5;
}

.mode-switch-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}

.mode-hint {
  font-size: 13px;
  color: #6b7280;
}

.workbench-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.workbench-session-meta {
  margin-top: 12px;
  padding: 10px 12px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 12px;
  color: #4b5563;
  line-height: 1.6;
  word-break: break-all;
}

.workbench-chat-card {
  display: flex;
  flex-direction: column;
}

.workbench-chat-history {
  min-height: 360px;
  max-height: 520px;
  overflow-y: auto;
  padding: 12px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.workbench-welcome {
  color: #4b5563;
  font-size: 13px;
  padding: 12px;
  background: #eff6ff;
  border-radius: 6px;
}

.chat-bubble {
  padding: 10px 14px;
  border-radius: 8px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
}

.chat-bubble.user {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.chat-bubble.streaming {
  border-style: dashed;
  border-color: #60a5fa;
}

.chat-role {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 6px;
}

.chat-plain {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.6;
}

.chat-markdown {
  font-size: 13px;
  line-height: 1.6;
}

.chat-tool-logs {
  margin-bottom: 8px;
  padding: 6px 10px;
  background: #1e1e1e;
  color: #9cdcfe;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.chat-tool-item {
  line-height: 1.5;
}

.workbench-input-bar {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.workbench-send-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 88px;
  flex-shrink: 0;
}

.workbench-send-col :deep(.el-button) {
  width: 100%;
  margin-left: 0;
}

.workbench-header-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.workbench-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workbench-stats-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #6b7280;
}

.stats-pill {
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  background: #f3f4f6;
  color: #374151;
}

.stats-pill:hover {
  background: #e5e7eb;
}

.stats-context {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.context-bar {
  color: #409eff;
  letter-spacing: 1px;
}

.workbench-composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  gap: 8px;
}

.composer-left-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.chat-thinking-box {
  margin-bottom: 8px;
  padding: 6px 10px;
  background: #f3f4f6;
  border-radius: 4px;
  font-size: 12px;
  color: #4b5563;
}

.chat-thinking-box summary {
  cursor: pointer;
  font-weight: 500;
}

.chat-thinking-body {
  margin: 6px 0 0;
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  max-height: 180px;
  overflow-y: auto;
}

.wb-dialog-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 400px;
  overflow-y: auto;
}

.wb-dialog-item {
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f9fafb;
}

.wb-dialog-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.wb-dialog-item-desc {
  font-size: 12px;
  color: #6b7280;
}

.wb-mcp-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.wb-session-list-wrap {
  display: flex;
  flex-direction: column;
}

.wb-session-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 460px;
  overflow-y: auto;
}

.wb-session-card {
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #ffffff;
  cursor: pointer;
  transition: all 0.15s ease;
}

.wb-session-card:hover {
  border-color: #93c5fd;
  background: #f8fafc;
}

.wb-session-card.active {
  border-color: #409eff;
  background: #eff6ff;
}

.wb-session-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.wb-session-folder-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
  color: #1f2937;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-session-card-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.wb-session-card-path {
  font-size: 12px;
  color: #6b7280;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}

.wb-session-card-meta {
  font-size: 11px;
  color: #9ca3af;
}
</style>
