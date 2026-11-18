export interface JenkinsConfig {
  baseUrl: string;
  username: string;
  apiToken: string;
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
  const apiToken = (process.env.JENKINS_API_TOKEN || "").trim();

  if (!apiToken) {
    throw new Error(
      "JENKINS_API_TOKEN is not configured in .env; cannot authenticate with Jenkins."
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
 * 2. Places the Skill SKILL.md into ~/.omp/agent/skills/<skillName>/SKILL.md
 * 3. Executes the Skill in the cloned repository using pi-agent (`omp` / `@oh-my-pi/pi-coding-agent`)
 */
export function buildJenkinsPipelineXml(
  options: JenkinsPipelineXmlOptions
): string {
  const branch = options.repoBranch || "main";
  const taskPrompt =
    options.taskPrompt ||
    `Use skill ${options.skillName} to inspect and execute the workflow on this repository.`;
  const skillB64 = options.skillContentB64 || "";

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
        stage('Prepare Skill') {
            steps {
                sh '''
                    mkdir -p "\${HOME}/.omp/agent/skills/${options.skillName}"
                    if [ -n "${skillB64}" ]; then
                        echo "${skillB64}" | base64 -d > "\${HOME}/.omp/agent/skills/${options.skillName}/SKILL.md"
                    fi
                '''
            }
        }
        stage('Run pi-agent With Skill') {
            steps {
                dir('target-repo') {
                    sh '''
                        AI_BIN="\${AI_PIPELINE_BIN:-ai-pipeline}"
                        if command -v "\${AI_BIN}" >/dev/null 2>&1; then
                            "\${AI_BIN}" run --skill "${options.skillName}" --cwd "$(pwd)" --prompt "${taskPrompt.replace(/'/g, "'\\''")}"
                        elif command -v omp >/dev/null 2>&1; then
                            omp --print "/skill:${options.skillName} ${taskPrompt.replace(/'/g, "'\\''")}"
                        else
                            echo "Error: pre-compiled ai-pipeline binary or omp CLI not found on Jenkins agent"
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
    if (data.crumbRequestField && data.crumb) {
      return { [data.crumbRequestField]: data.crumb };
    }
    return {};
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

  if (!wait || !queueUrl) {
    return {
      jobName: req.jobName,
      queueUrl,
      status: "queued",
      durationMs: Date.now() - start,
      logs: [`[Jenkins] Job "${req.jobName}" queued: ${queueUrl ?? "triggered"}`],
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
  let finalStatus: "success" | "failed" | "aborted" = "failed";
  let consoleText = "";

  while (Date.now() < deadline) {
    const build = await getJenkinsBuildStatus(req.jobName, buildNumber);
    consoleText = build.consoleText;
    if (!build.building) {
      if (build.result === "SUCCESS") finalStatus = "success";
      else if (build.result === "ABORTED") finalStatus = "aborted";
      else finalStatus = "failed";
      break;
    }
    await sleep(2000);
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
