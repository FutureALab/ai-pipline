import { listSkillsInDefaultDir } from "./repositories/skillStorage.js";
import { startServer } from "./server.js";
import { generateSkillFromPrompt } from "./services/skillGenerator.js";
import { runSkillInRepo } from "./services/skillRunner.js";
import type { SkillScope } from "./types/skill.js";

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function printUsage(): void {
  console.log(`Usage:
  bun run src/main.ts generate --prompt "<prompt>" [--name <skill-name>] [--scope global|project] [--cwd <dir>] [--model <provider/model>]
  bun run src/main.ts run --skill <skill-name> --cwd <repo-dir> [--prompt "<task>"] [--model <provider/model>]
  bun run src/main.ts list [--scope global|project] [--cwd <dir>]
  bun run src/main.ts serve [--port 3000]`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "generate": {
      const prompt = getArg(args, "--prompt");
      const skillName = getArg(args, "--name");
      const scope = (getArg(args, "--scope") as SkillScope) || "global";
      const cwd = getArg(args, "--cwd") || process.cwd();
      const modelPattern = getArg(args, "--model");

      if (!prompt) {
        console.error("Error: --prompt is required");
        printUsage();
        process.exit(1);
      }

      const result = await generateSkillFromPrompt({
        userPrompt: prompt,
        skillName,
        scope,
        cwd,
        modelPattern,
        onDelta: (chunk) => process.stdout.write(chunk),
      });

      console.log(
        `\n\n[OK] Skill "${result.saved.skillName}" saved to ${result.saved.filePath}`
      );
      break;
    }

    case "run": {
      const skillName = getArg(args, "--skill");
      const cwd = getArg(args, "--cwd") || process.cwd();
      const taskPrompt = getArg(args, "--prompt");
      const modelPattern = getArg(args, "--model");

      if (!skillName) {
        console.error("Error: --skill is required");
        printUsage();
        process.exit(1);
      }

      const result = await runSkillInRepo({
        skillName,
        cwd,
        taskPrompt,
        modelPattern,
        onDelta: (chunk) => process.stdout.write(chunk),
      });

      console.log(
        `\n\n[OK] Skill "${result.skillName}" finished in ${result.durationMs}ms (cwd: ${result.cwd})`
      );
      break;
    }

    case "list": {
      const scope = (getArg(args, "--scope") as SkillScope) || "global";
      const cwd = getArg(args, "--cwd") || process.cwd();
      const skills = await listSkillsInDefaultDir(scope, cwd);

      if (skills.length === 0) {
        console.log(`No skills found in ${scope} default directory.`);
      } else {
        for (const s of skills) {
          console.log(`- ${s.skillName} (${s.filePath})`);
        }
      }
      break;
    }

    case "serve": {
      const port = Number(getArg(args, "--port") || process.env.PORT || 3000);
      await startServer(port);
      break;
    }

    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("[ERROR]", err instanceof Error ? err.message : err);
  process.exit(1);
});
