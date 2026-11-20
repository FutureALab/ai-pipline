import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CONTAINER_NAME = "ai-pipeline-jenkins";
const JENKINS_URL = (process.env.JENKINS_URL || "http://localhost:8080").replace(
  /\/+$/,
  ""
);
const ENV_PATH = path.resolve(process.cwd(), ".env");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upsertEnvVar(filePath: string, key: string, value: string): void {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  const updated = regex.test(existing)
    ? existing.replace(regex, line)
    : `${existing.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(filePath, updated, "utf-8");
}

async function waitForToken(timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = execFileSync(
        "docker",
        [
          "exec",
          CONTAINER_NAME,
          "cat",
          "/var/jenkins_home/.ai-pipeline-api-token",
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();

      if (token) {
        // Also verify Jenkins HTTP endpoint responds
        const res = await fetch(`${JENKINS_URL}/login`).catch(() => null);
        if (res && res.ok) {
          return token;
        }
      }
    } catch {
      // Container still initializing
    }
    await sleep(3000);
  }
  throw new Error(
    `Timed out waiting for Jenkins (${CONTAINER_NAME}) to initialize and generate API token.`
  );
}

async function main(): Promise<void> {
  console.log("[Jenkins Setup] Ensuring dist/bin directories exist...");
  fs.mkdirSync(path.resolve(process.cwd(), "dist/bin/linux-arm64"), {
    recursive: true,
  });
  fs.mkdirSync(path.resolve(process.cwd(), "dist/bin/linux-x64"), {
    recursive: true,
  });

  console.log(
    "[Jenkins Setup] Building and starting Jenkins container via docker compose..."
  );
  execFileSync("docker", ["compose", "up", "-d", "--build", "jenkins"], {
    stdio: "inherit",
  });

  console.log(
    "[Jenkins Setup] Waiting for Jenkins initialization & auto-generated API token..."
  );
  const token = await waitForToken();

  upsertEnvVar(ENV_PATH, "JENKINS_URL", JENKINS_URL);
  upsertEnvVar(ENV_PATH, "JENKINS_USER", process.env.JENKINS_USER || "admin");
  upsertEnvVar(ENV_PATH, "JENKINS_API_TOKEN", token);

  console.log(
    `[Jenkins Setup] Ready! JENKINS_API_TOKEN has been written to ${ENV_PATH}`
  );
  console.log(
    `[Jenkins Setup] Jenkins UI: ${JENKINS_URL} (user: ${process.env.JENKINS_USER || "admin"}, password: ${process.env.JENKINS_PASSWORD || "admin123"})`
  );
}

main().catch((err) => {
  console.error(
    "[Jenkins Setup ERROR]",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
