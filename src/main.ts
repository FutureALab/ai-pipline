import { decryptSecret, encryptSecret } from "./config/crypto.js";
import { createLogger, getLogConfigSummary } from "./config/logger.js";
import { getEmbeddedSkills } from "./repositories/embeddedSkills.js";
import { listSkillsInDefaultDir } from "./repositories/skillStorage.js";
import { startServer } from "./server.js";
import { generateSkillFromPrompt } from "./services/skillGenerator.js";
import { runSkillInRepo } from "./services/skillRunner.js";
import type { SkillScope } from "./types/skill.js";

const log = createLogger("main");

process.on("uncaughtException", (err) => {
  log.fatal({ err }, "Uncaught exception, process exiting");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error({ err }, "Unhandled promise rejection");
});

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function printUsage(): void {
  process.stdout.write(`Usage:
  ai-pipeline --skill <skill-name> [--cwd <repo-dir>] [--prompt "<task>"] [--model <provider/model>]
  ai-pipeline run --skill <skill-name> [--cwd <repo-dir>] [--prompt "<task>"] [--model <provider/model>]
  ai-pipeline generate --prompt "<prompt>" [--name <skill-name>] [--scope global|project] [--cwd <dir>] [--model <provider/model>]
  ai-pipeline list [--scope global|project] [--cwd <dir>]
  ai-pipeline serve [--port 3000]
  ai-pipeline encrypt <plaintext>
  ai-pipeline decrypt <ENC(...)>
`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const firstArg = rawArgs[0];
  const startedAt = Date.now();

  if (!firstArg || firstArg === "-h" || firstArg === "--help") {
    printUsage();
    process.exit(0);
  }

  // Allow invoking the compiled binary directly with flags (e.g. ./ai-pipeline --skill foo --cwd /path --prompt "...")
  const isDirectRun = firstArg.startsWith("-");
  const command = isDirectRun ? "run" : firstArg;
  const args = isDirectRun ? rawArgs : rawArgs.slice(1);

  log.info(
    {
      command,
      cwd: process.cwd(),
      log: getLogConfigSummary(),
    },
    "CLI command started"
  );

  switch (command) {
    case "generate": {
      const prompt = getArg(args, "--prompt");
      const skillName = getArg(args, "--name");
      const scope = (getArg(args, "--scope") as SkillScope) || "global";
      const cwd = getArg(args, "--cwd") || process.cwd();
      const modelPattern = getArg(args, "--model");

      if (!prompt) {
        log.error("Missing required argument: --prompt");
        printUsage();
        process.exit(1);
      }

      log.info(
        { skillName: skillName || "(auto)", scope, cwd, modelPattern },
        "Generating skill from prompt"
      );

      const result = await generateSkillFromPrompt({
        userPrompt: prompt,
        skillName,
        scope,
        cwd,
        modelPattern,
        onDelta: (chunk) => process.stdout.write(chunk),
        onProgress: (msg) => log.info({ progress: msg }, "Skill generation progress"),
      });

      process.stdout.write("\n");
      log.info(
        {
          skillName: result.saved.skillName,
          filePath: result.saved.filePath,
          fileCount: result.files.length,
          durationMs: Date.now() - startedAt,
        },
        "Skill generated and saved"
      );
      break;
    }

    case "run": {
      const skillName = getArg(args, "--skill");
      const cwd = getArg(args, "--cwd") || process.cwd();
      const taskPrompt = getArg(args, "--prompt");
      const modelPattern = getArg(args, "--model");

      if (!skillName) {
        log.error("Missing required argument: --skill");
        printUsage();
        process.exit(1);
      }

      log.info({ skillName, cwd, modelPattern }, "Running skill in repository");

      const result = await runSkillInRepo({
        skillName,
        cwd,
        taskPrompt,
        modelPattern,
        onDelta: (chunk) => process.stdout.write(chunk),
      });

      process.stdout.write("\n");
      log.info(
        {
          skillName: result.skillName,
          cwd: result.cwd,
          durationMs: result.durationMs,
        },
        "Skill execution completed"
      );
      break;
    }

    case "list": {
      const scope = (getArg(args, "--scope") as SkillScope) || "global";
      const cwd = getArg(args, "--cwd") || process.cwd();
      const embedded = getEmbeddedSkills();
      const diskSkills = await listSkillsInDefaultDir(scope, cwd);

      log.info(
        {
          scope,
          cwd,
          embeddedCount: embedded.length,
          diskCount: diskSkills.length,
        },
        "Listed skills"
      );

      if (embedded.length > 0) {
        process.stdout.write(`Embedded in binary (${embedded.length}):\n`);
        for (const s of embedded) {
          process.stdout.write(
            `  - ${s.skillName} [embedded:${s.source}] (${s.files.length} file(s))\n`
          );
        }
      }

      if (diskSkills.length === 0) {
        if (embedded.length === 0) {
          process.stdout.write(`No skills found in ${scope} default directory.\n`);
        }
      } else {
        process.stdout.write(`Disk (${scope}, ${diskSkills.length}):\n`);
        for (const s of diskSkills) {
          process.stdout.write(`  - ${s.skillName} (${s.filePath})\n`);
        }
      }
      break;
    }

    case "serve": {
      const port = Number(getArg(args, "--port") || process.env.PORT || 3000);
      await startServer(port);
      break;
    }

    case "encrypt": {
      const plaintext = args[0];
      if (!plaintext) {
        log.error("Missing plaintext argument for encrypt");
        printUsage();
        process.exit(1);
      }
      process.stdout.write(`${encryptSecret(plaintext)}\n`);
      break;
    }

    case "decrypt": {
      const ciphertext = args[0];
      if (!ciphertext) {
        log.error("Missing ciphertext argument for decrypt");
        printUsage();
        process.exit(1);
      }
      process.stdout.write(`${decryptSecret(ciphertext)}\n`);
      break;
    }

    default:
      log.error({ command }, "Unknown CLI command");
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  log.fatal({ err }, "Command failed with fatal error");
  process.exit(1);
});
