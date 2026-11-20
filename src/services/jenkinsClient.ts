import { execFileSync } from "node:child_process";

export interface JenkinsConfig {
  baseUrl: string;
  username: string;
  apiToken: string;
}

let cachedDockerToken: string | null = null;

function tryReadLocalDockerJenkinsToken(): string {
  if (cachedDockerToken) return cachedDockerToken;
  const container =
    (process.env.JENKINS_DOCKER_CONTAINER || "ai-pipeline-jenkins").trim();
  try {
    const token = execFileSync(
      "docker",
      ["exec", container, "cat", "/var/jenkins_home/.ai-pipeline-api-token"],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (token) {
      cachedDockerToken = token;
      return token;
    }
  } catch {
    // Container not running or docker unavailable
  }
  return "";
}

export interface JenkinsPipelineXmlOptions {
  description?: string;
  repoUrl: string;
  repoBranch?: string;
  skillName: string;
  skillContentB64?: string;
  taskPrompt?: string;
}

export interface JenkinsExecutionRequest {
  jobName: string;
  /** Optional raw Jenkins config.xml; auto-generated if omitted */
  xml?: string;
  repoUrl?: string;
  repoBranch?: string;
  skillName?: string;
  skillContent?: string;
  taskPrompt?: string;
  parameters?: Record<string, string>;
  waitForCompletion?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onLogUpdate?: (info: {
    jobName: string;
    buildNumber?: number;
    buildUrl?: string;
    logs: string[];
    building: boolean;
  }) => void | Promise<void>;
}

export interface JenkinsExecutionResult {
  jobName: string;
  buildNumber?: number;
  buildUrl?: string;
  queueUrl?: string;
  status: "success" | "failed" | "aborted" | "queued";
  durationMs: number;
  logs: string[];
  xml: string;
}

export function getJenkinsConfig(): JenkinsConfig {
  const baseUrl = (process.env.JENKINS_URL || "http://localhost:8080")
    .trim()
    .replace(/\/+$/, "");
  const username = (process.env.JENKINS_USER || "admin").trim();
  const apiToken =
    (process.env.JENKINS_API_TOKEN || "").trim() ||
    tryReadLocalDockerJenkinsToken() ||
    (process.env.JENKINS_PASSWORD || "").trim();

  if (!apiToken) {
    throw new Error(
      "JENKINS_API_TOKEN is not configured in .env and local Docker Jenkins container is not initialized. Run `bun run jenkins:up` to start and auto-configure Jenkins."
    );
  }

  return { baseUrl, username, apiToken };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a standard Jenkins Pipeline `config.xml` (<flow-definition>) that:
 * 1. Clones the target git repository
 * 2. Executes the Skill directly using the pre-compiled `ai-pipeline` binary
 *    (which embeds built-in skills + the DB-bundled skill with all scripts/references/assets)
 *    so Jenkins results match Creative Mode & local pipeline tests identically.
 */
export function buildJenkinsPipelineXml(
  options: JenkinsPipelineXmlOptions
): string {
  const branch = options.repoBranch || "main";
  const taskPrompt =
    options.taskPrompt ||
    `Apply skill ${options.skillName} on repository.`;
  const skillB64 = options.skillContentB64 || "";
  const escapedPrompt = taskPrompt.replace(/'/g, "'\\''");

  const groovyScript = `pipeline {
    agent any
    stages {
        stage('Git Clone') {
            steps {
                sh '''
                    rm -rf target-repo
                    git clone --branch ${branch} --depth 1 "${options.repoUrl}" target-repo
                '''
            }
        }
        stage('Prepare Skill Fallback') {
            steps {
                sh '''
                    # If the compiled ai-pipeline binary embeds the skill, it will materialize
                    # the full skill package (SKILL.md + scripts + references + assets) automatically.
                    # Only write fallback SKILL.md when no directory exists yet.
                    SKILL_DIR="\${HOME}/.omp/agent/skills/${options.skillName}"
                    if [ ! -f "\${SKILL_DIR}/SKILL.md" ] && [ -n "${skillB64}" ]; then
                        mkdir -p "\${SKILL_DIR}"
                        echo "${skillB64}" | base64 -d > "\${SKILL_DIR}/SKILL.md"
                    fi
                '''
            }
        }
        stage('Run Bundled ai-pipeline Binary') {
            steps {
                dir('target-repo') {
                    sh '''
                        ARCH="$(uname -m)"
                        if [ -n "\${AI_PIPELINE_BIN:-}" ] && [ -x "\${AI_PIPELINE_BIN}" ]; then
                            BIN="\${AI_PIPELINE_BIN}"
                        elif [ "\${ARCH}" = "aarch64" ] || [ "\${ARCH}" = "arm64" ]; then
                            BIN="/opt/ai-pipeline-bin/arm64/ai-pipeline"
                        else
                            BIN="/opt/ai-pipeline-bin/x64/ai-pipeline"
                        fi

                        if [ ! -x "\${BIN}" ] && command -v ai-pipeline >/dev/null 2>&1; then
                            BIN="$(command -v ai-pipeline)"
                        fi

                        if [ -x "\${BIN}" ]; then
                            echo "[Jenkins] Using bundled binary: \${BIN} (arch=\${ARCH})"
                            "\${BIN}" --skill "${options.skillName}" --cwd "$(pwd)" --prompt '${escapedPrompt}'
                        else
                            echo "Error: compiled ai-pipeline binary (\${BIN}) not found on Jenkins agent (arch=\${ARCH})."
                            echo "Please build with: bun run scripts/build-binaries.ts linux-arm64 linux-x64 --skill ${options.skillName}"
                            exit 1
                        fi
                    '''
                }
            }
        }
    }
}`;

  return `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <actions/>
  <description>${escapeXml(options.description || `AI Skill Pipeline for ${options.skillName}`)}</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script>${escapeXml(groovyScript)}</script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>`;
}

function buildAuthHeaders(cfg: JenkinsConfig): Record<string, string> {
  const token = Buffer.from(`${cfg.username}:${cfg.apiToken}`).toString(
    "base64"
  );
  return {
    Authorization: `Basic ${token}`,
  };
}

async function fetchJenkinsCrumb(
  cfg: JenkinsConfig
): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${cfg.baseUrl}/crumbIssuer/api/json`, {
      headers: buildAuthHeaders(cfg),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      crumbRequestField?: string;
      crumb?: string;
    };
    const headers: Record<string, string> = {};
    if (data.crumbRequestField && data.crumb) {
      headers[data.crumbRequestField] = data.crumb;
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      headers.Cookie = setCookie.split(";")[0];
    }
    return headers;
  } catch {
    return {};
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollQueueForBuildNumber(
  cfg: JenkinsConfig,
  queueUrl: string,
  timeoutMs: number
): Promise<{ buildNumber: number; buildUrl: string }> {
  const normalizedQueue = queueUrl.replace(/\/+$/, "");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${normalizedQueue}/api/json`, {
      headers: buildAuthHeaders(cfg),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        cancelled?: boolean;
        executable?: { number?: number; url?: string };
      };
      if (data.cancelled) {
        throw new Error("Jenkins build was cancelled while in queue");
      }
      if (data.executable?.number) {
        return {
          buildNumber: data.executable.number,
          buildUrl:
            data.executable.url ||
            `${cfg.baseUrl}/job/${data.executable.number}`,
        };
      }
    }
    await sleep(1000);
  }

  throw new Error("Timed out waiting for Jenkins build to start from queue");
}

export async function resolveJenkinsQueueItem(queueUrl: string): Promise<{
  cancelled: boolean;
  buildNumber?: number;
  buildUrl?: string;
  why?: string;
}> {
  const cfg = getJenkinsConfig();
  const normalizedQueue = queueUrl.replace(/\/+$/, "");
  const res = await fetch(`${normalizedQueue}/api/json`, {
    headers: buildAuthHeaders(cfg),
  });
  if (!res.ok) {
    return { cancelled: false };
  }
  const data = (await res.json()) as {
    cancelled?: boolean;
    why?: string;
    executable?: { number?: number; url?: string };
  };
  return {
    cancelled: Boolean(data.cancelled),
    buildNumber: data.executable?.number,
    buildUrl: data.executable?.url,
    why: data.why,
  };
}

export async function getJenkinsBuildStatus(
  jobName: string,
  buildNumber: number
): Promise<{
  building: boolean;
  result: string | null;
  duration: number;
  url: string;
  consoleText: string;
}> {
  const cfg = getJenkinsConfig();
  const encodedJob = encodeURIComponent(jobName);
  const headers = buildAuthHeaders(cfg);

  const [statusRes, logRes] = await Promise.all([
    fetch(`${cfg.baseUrl}/job/${encodedJob}/${buildNumber}/api/json`, {
      headers,
    }),
    fetch(`${cfg.baseUrl}/job/${encodedJob}/${buildNumber}/consoleText`, {
      headers,
    }),
  ]);

  if (!statusRes.ok) {
    throw new Error(
      `Failed to query Jenkins build #${buildNumber}: ${statusRes.status} ${statusRes.statusText}`
    );
  }

  const statusData = (await statusRes.json()) as {
    building: boolean;
    result: string | null;
    duration: number;
    url: string;
  };
  const consoleText = logRes.ok ? await logRes.text() : "";

  return {
    building: statusData.building,
    result: statusData.result,
    duration: statusData.duration,
    url: statusData.url,
    consoleText,
  };
}

/**
 * Create or update a Jenkins job with the given config.xml, trigger execution,
 * optionally wait for completion, and return status + console logs.
 */
export async function executeJenkinsJobWithXml(
  req: JenkinsExecutionRequest
): Promise<JenkinsExecutionResult> {
  const start = Date.now();
  const cfg = getJenkinsConfig();
  const encodedJob = encodeURIComponent(req.jobName);
  const authHeaders = buildAuthHeaders(cfg);
  const crumbHeaders = await fetchJenkinsCrumb(cfg);

  const xml =
    req.xml?.trim() ||
    buildJenkinsPipelineXml({
      repoUrl: req.repoUrl || "",
      repoBranch: req.repoBranch,
      skillName: req.skillName || "custom-skill",
      skillContentB64: req.skillContent
        ? Buffer.from(req.skillContent, "utf-8").toString("base64")
        : "",
      taskPrompt: req.taskPrompt,
    });

  // 1. Check whether job exists
  const checkRes = await fetch(`${cfg.baseUrl}/job/${encodedJob}/api/json`, {
    headers: authHeaders,
  });

  const xmlHeaders = {
    ...authHeaders,
    ...crumbHeaders,
    "Content-Type": "application/xml; charset=utf-8",
  };

  if (checkRes.status === 404) {
    const createRes = await fetch(
      `${cfg.baseUrl}/createItem?name=${encodedJob}`,
      {
        method: "POST",
        headers: xmlHeaders,
        body: xml,
      }
    );
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      throw new Error(
        `Failed to create Jenkins job "${req.jobName}": ${createRes.status} ${errText}`
      );
    }
  } else if (checkRes.ok) {
    const updateRes = await fetch(
      `${cfg.baseUrl}/job/${encodedJob}/config.xml`,
      {
        method: "POST",
        headers: xmlHeaders,
        body: xml,
      }
    );
    if (!updateRes.ok) {
      const errText = await updateRes.text().catch(() => "");
      throw new Error(
        `Failed to update Jenkins job "${req.jobName}" config.xml: ${updateRes.status} ${errText}`
      );
    }
  } else {
    throw new Error(
      `Failed to query Jenkins job "${req.jobName}": ${checkRes.status} ${checkRes.statusText}`
    );
  }

  // 2. Trigger build (with parameters if provided)
  const hasParams =
    req.parameters && Object.keys(req.parameters).length > 0;
  const triggerEndpoint = hasParams
    ? `${cfg.baseUrl}/job/${encodedJob}/buildWithParameters`
    : `${cfg.baseUrl}/job/${encodedJob}/build`;

  const triggerRes = await fetch(triggerEndpoint, {
    method: "POST",
    headers: {
      ...authHeaders,
      ...crumbHeaders,
      ...(hasParams
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    ...(hasParams
      ? { body: new URLSearchParams(req.parameters).toString() }
      : {}),
  });

  if (!triggerRes.ok && triggerRes.status !== 201) {
    const errText = await triggerRes.text().catch(() => "");
    throw new Error(
      `Failed to trigger Jenkins job "${req.jobName}": ${triggerRes.status} ${errText}`
    );
  }

  const queueUrl = triggerRes.headers.get("location") || undefined;
  const wait = req.waitForCompletion !== false;
  const timeoutMs = req.timeoutMs ?? 180_000;

  if (!wait) {
    let buildNumber: number | undefined;
    let buildUrl: string | undefined;
    if (queueUrl) {
      try {
        const queued = await pollQueueForBuildNumber(cfg, queueUrl, 1_500);
        buildNumber = queued.buildNumber;
        buildUrl = queued.buildUrl;
      } catch {
        // Build is still queued in Jenkins; background sync will resolve buildNumber from queueUrl
      }
    }
    return {
      jobName: req.jobName,
      buildNumber,
      buildUrl,
      queueUrl,
      status: "queued",
      durationMs: Date.now() - start,
      logs: [
        `[Jenkins] Job "${req.jobName}" triggered${buildNumber ? ` (#${buildNumber})` : " (queued)"}`,
        ...(buildUrl ? [`[Jenkins] Build URL: ${buildUrl}`] : []),
        ...(queueUrl ? [`[Jenkins] Queue URL: ${queueUrl}`] : []),
      ],
      xml,
    };
  }

  if (!queueUrl) {
    return {
      jobName: req.jobName,
      status: "queued",
      durationMs: Date.now() - start,
      logs: [`[Jenkins] Job "${req.jobName}" triggered`],
      xml,
    };
  }

  // 3. Poll queue -> build number -> completion
  const { buildNumber, buildUrl } = await pollQueueForBuildNumber(
    cfg,
    queueUrl,
    Math.min(timeoutMs, 60_000)
  );

  const deadline = start + timeoutMs;
  const pollIntervalMs = req.pollIntervalMs ?? 3000;
  let finalStatus: "success" | "failed" | "aborted" = "failed";
  let consoleText = "";

  while (Date.now() < deadline) {
    const build = await getJenkinsBuildStatus(req.jobName, buildNumber);
    consoleText = build.consoleText;
    await req.onLogUpdate?.({
      jobName: req.jobName,
      buildNumber,
      buildUrl: build.url || buildUrl,
      logs: consoleText ? consoleText.split("\n") : [],
      building: build.building,
    });
    if (!build.building) {
      if (build.result === "SUCCESS") finalStatus = "success";
      else if (build.result === "ABORTED") finalStatus = "aborted";
      else finalStatus = "failed";
      break;
    }
    await sleep(pollIntervalMs);
  }

  return {
    jobName: req.jobName,
    buildNumber,
    buildUrl,
    queueUrl,
    status: finalStatus,
    durationMs: Date.now() - start,
    logs: consoleText ? consoleText.split("\n") : [],
    xml,
  };
}
