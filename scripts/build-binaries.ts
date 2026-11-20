import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initDatabase } from "../src/db/database.js";
import type { EmbeddedSkillPackage } from "../src/generated/embeddedSkills.js";
import { getSkillCard, listSkillFiles } from "../src/repositories/skillRepository.js";
import {
  extractDescriptionFromMarkdown,
  normalizeSkillName,
  readSkillDirectoryFiles,
} from "../src/repositories/skillStorage.js";

interface BuildTarget {
  name: string;
  bunTarget: string;
  outDir: string;
  binaryName: string;
  nativePkg: string;
  nativeFile: string;
}

const TARGETS: Record<string, BuildTarget> = {
  "linux-x64": {
    name: "linux-x64",
    bunTarget: "bun-linux-x64",
    outDir: "dist/bin/linux-x64",
    binaryName: "ai-pipeline",
    nativePkg: "@oh-my-pi/pi-natives-linux-x64",
    nativeFile: "pi_natives.linux-x64.node",
  },
  "linux-arm64": {
    name: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    outDir: "dist/bin/linux-arm64",
    binaryName: "ai-pipeline",
    nativePkg: "@oh-my-pi/pi-natives-linux-arm64",
    nativeFile: "pi_natives.linux-arm64.node",
  },
  "darwin-arm64": {
    name: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    outDir: "dist/bin/darwin-arm64",
    binaryName: "ai-pipeline",
    nativePkg: "@oh-my-pi/pi-natives-darwin-arm64",
    nativeFile: "pi_natives.darwin-arm64.node",
  },
  "darwin-x64": {
    name: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    outDir: "dist/bin/darwin-x64",
    binaryName: "ai-pipeline",
    nativePkg: "@oh-my-pi/pi-natives-darwin-x64",
    nativeFile: "pi_natives.darwin-x64.node",
  },
  "win32-x64": {
    name: "win32-x64",
    bunTarget: "bun-windows-x64",
    outDir: "dist/bin/win32-x64",
    binaryName: "ai-pipeline.exe",
    nativePkg: "@oh-my-pi/pi-natives-win32-x64",
    nativeFile: "pi_natives.win32-x64.node",
  },
};

const GENERATED_FILE_PATH = path.resolve(
  process.cwd(),
  "src/generated/embeddedSkills.ts"
);

const NATIVES_PKG_DIR = path.resolve(
  process.cwd(),
  "node_modules/@oh-my-pi/pi-natives"
);
const NATIVES_NATIVE_DIR = path.join(NATIVES_PKG_DIR, "native");
const EMBEDDED_ADDON_JS_PATH = path.join(NATIVES_NATIVE_DIR, "embedded-addon.js");

const DEFAULT_GENERATED_STUB = `import type { SkillFileEntry } from "../types/skill.js";

export interface EmbeddedSkillPackage {
  skillName: string;
  source: "builtin" | "database";
  description: string;
  files: SkillFileEntry[];
}

// Populated automatically by scripts/build-binaries.ts during binary compilation.
export const EMBEDDED_SKILLS: readonly EmbeddedSkillPackage[] = [];
`;

function readNativesVersion(): string {
  const pkgPath = path.join(NATIVES_PKG_DIR, "package.json");
  const raw = fs.readFileSync(pkgPath, "utf-8");
  const parsed = JSON.parse(raw) as { version?: string };
  if (!parsed.version) {
    throw new Error(`Could not determine @oh-my-pi/pi-natives version from ${pkgPath}`);
  }
  return parsed.version;
}

function listNodeFilesInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".node"))
    .sort()
    .map((f) => path.join(dir, f));
}

function inferNativeVariant(filename: string): "modern" | "baseline" | "default" {
  if (filename.includes("-modern.")) return "modern";
  if (filename.includes("-baseline.")) return "baseline";
  return "default";
}

async function ensureNativeAddonFiles(
  target: BuildTarget,
  version: string
): Promise<string[]> {
  const pkgDir = path.resolve(process.cwd(), "node_modules", target.nativePkg);
  let nodeFiles = listNodeFilesInDir(pkgDir);
  if (nodeFiles.length > 0) {
    return nodeFiles;
  }

  console.log(
    `[BUILD] Native addon for ${target.name} not found locally; downloading ${target.nativePkg}@${version}...`
  );
  await fsp.mkdir(pkgDir, { recursive: true });

  const pkgBaseName = target.nativePkg.split("/")[1]; // e.g. pi-natives-linux-arm64
  const npmRegistry = (
    process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org"
  ).replace(/\/+$/, "");
  const tarballUrl = `${npmRegistry}/${target.nativePkg}/-/${pkgBaseName}-${version}.tgz`;

  try {
    const res = await fetch(tarballUrl, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${tarballUrl}`);
    }
    const tgzBuf = Buffer.from(await res.arrayBuffer());
    const tmpTgz = path.join(
      os.tmpdir(),
      `${pkgBaseName}-${version}-${Date.now()}.tgz`
    );
    await fsp.writeFile(tmpTgz, tgzBuf);
    try {
      execFileSync("tar", ["-xzf", tmpTgz, "-C", pkgDir, "--strip-components=1"], {
        stdio: "pipe",
      });
    } finally {
      await fsp.rm(tmpTgz, { force: true }).catch(() => {});
    }
    nodeFiles = listNodeFilesInDir(pkgDir);
    if (nodeFiles.length > 0) {
      console.log(
        `[BUILD] Downloaded & cached ${nodeFiles.map((f) => path.basename(f)).join(", ")} -> ${pkgDir}`
      );
      return nodeFiles;
    }
  } catch (err) {
    console.warn(
      `[WARN] Failed to fetch npm tarball (${tarballUrl}): ${err instanceof Error ? err.message : err}`
    );
  }

  // Fallback: download directly from oh-my-pi GitHub release
  const ghUrl = `https://github.com/can1357/oh-my-pi/releases/download/v${version}/${target.nativeFile}`;
  try {
    console.log(`[BUILD] Trying GitHub release fallback: ${ghUrl}`);
    const res = await fetch(ghUrl, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${ghUrl}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(pkgDir, target.nativeFile);
    await fsp.writeFile(dest, buf);
    nodeFiles = listNodeFilesInDir(pkgDir);
    if (nodeFiles.length > 0) {
      console.log(`[BUILD] Downloaded native addon -> ${dest}`);
      return nodeFiles;
    }
  } catch (err) {
    console.warn(
      `[WARN] GitHub release fallback also failed: ${err instanceof Error ? err.message : err}`
    );
  }

  return [];
}

function parseCliArgs(rawArgs: string[]): {
  targetKeys: string[];
  skillNames: string[];
} {
  const targetKeys: string[] = [];
  const skillNames: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--skill" || arg === "--skills") {
      const next = rawArgs[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value after ${arg}`);
      }
      i += 1;
      for (const part of next.split(",")) {
        const clean = part.trim();
        if (clean) skillNames.push(normalizeSkillName(clean));
      }
      continue;
    }
    if (arg.startsWith("--skill=") || arg.startsWith("--skills=")) {
      const val = arg.slice(arg.indexOf("=") + 1);
      for (const part of val.split(",")) {
        const clean = part.trim();
        if (clean) skillNames.push(normalizeSkillName(clean));
      }
      continue;
    }
    targetKeys.push(arg);
  }

  return {
    targetKeys,
    skillNames: [...new Set(skillNames)],
  };
}

async function collectBuiltinSkills(): Promise<EmbeddedSkillPackage[]> {
  const builtinRoot = path.resolve(process.cwd(), "resource", "builtin-skills");
  const entries = await fsp
    .readdir(builtinRoot, { withFileTypes: true })
    .catch(() => []);

  const packages: EmbeddedSkillPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(builtinRoot, entry.name);
    const files = await readSkillDirectoryFiles(skillDir);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    if (!skillMd) continue;

    const skillName = normalizeSkillName(entry.name);
    packages.push({
      skillName,
      source: "builtin",
      description: extractDescriptionFromMarkdown(skillMd.content, skillName),
      files,
    });
  }

  return packages.sort((a, b) => a.skillName.localeCompare(b.skillName));
}

async function collectDatabaseSkills(
  skillNames: string[]
): Promise<EmbeddedSkillPackage[]> {
  if (skillNames.length === 0) return [];

  console.log(
    `\n[BUILD] Loading requested skill(s) from database: ${skillNames.join(", ")}`
  );
  await initDatabase();

  const packages: EmbeddedSkillPackage[] = [];
  for (const name of skillNames) {
    const files = await listSkillFiles(name);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    if (files.length === 0 || !skillMd) {
      throw new Error(
        `Requested skill "${name}" was not found in database (missing SKILL.md). Please verify the skill name before building.`
      );
    }
    const card = await getSkillCard(name).catch(() => null);
    packages.push({
      skillName: name,
      source: "database",
      description:
        card?.description ||
        extractDescriptionFromMarkdown(skillMd.content, name),
      files,
    });
  }

  return packages;
}

async function writeEmbeddedSkillsModule(
  packages: EmbeddedSkillPackage[]
): Promise<void> {
  await fsp.mkdir(path.dirname(GENERATED_FILE_PATH), { recursive: true });
  const content = `import type { SkillFileEntry } from "../types/skill.js";

export interface EmbeddedSkillPackage {
  skillName: string;
  source: "builtin" | "database";
  description: string;
  files: SkillFileEntry[];
}

// Auto-generated at build time by scripts/build-binaries.ts
export const EMBEDDED_SKILLS: readonly EmbeddedSkillPackage[] = ${JSON.stringify(
    packages,
    null,
    2
  )};
`;
  await fsp.writeFile(GENERATED_FILE_PATH, content, "utf-8");
}

async function buildOne(
  target: BuildTarget,
  nativesVersion: string
): Promise<void> {
  const outDirAbs = path.resolve(process.cwd(), target.outDir);
  const outFile = path.join(outDirAbs, target.binaryName);
  fs.mkdirSync(outDirAbs, { recursive: true });

  const nativeFiles = await ensureNativeAddonFiles(target, nativesVersion);
  const originalEmbeddedAddonJs = fs.existsSync(EMBEDDED_ADDON_JS_PATH)
    ? await fsp.readFile(EMBEDDED_ADDON_JS_PATH, "utf-8")
    : null;
  const tempZstFiles: string[] = [];

  try {
    if (nativeFiles.length > 0 && originalEmbeddedAddonJs !== null) {
      const importLines: string[] = [];
      const fileEntries: string[] = [];

      for (let idx = 0; idx < nativeFiles.length; idx++) {
        const srcPath = nativeFiles[idx];
        const filename = path.basename(srcPath);
        const rawBytes = await fsp.readFile(srcPath);
        const compressed = Bun.zstdCompressSync(rawBytes);
        const zstFilename = `${filename}.zst`;
        const zstDest = path.join(NATIVES_NATIVE_DIR, zstFilename);
        await fsp.writeFile(zstDest, compressed);
        tempZstFiles.push(zstDest);

        const variant = inferNativeVariant(filename);
        importLines.push(
          `import zstd${idx} from "./${zstFilename}" with { type: "file" };`
        );
        fileEntries.push(
          `    { variant: ${JSON.stringify(variant)}, filename: ${JSON.stringify(filename)}, size: ${rawBytes.byteLength}, zstdPath: zstd${idx} },`
        );
      }

      const embeddedAddonModule = `${importLines.join("\n")}

export const embeddedAddon = {
  platformTag: ${JSON.stringify(target.name)},
  version: ${JSON.stringify(nativesVersion)},
  files: [
${fileEntries.join("\n")}
  ],
};
`;
      await fsp.writeFile(EMBEDDED_ADDON_JS_PATH, embeddedAddonModule, "utf-8");
      console.log(
        `[BUILD] Embedded ${nativeFiles.length} native addon(s) into ${target.name} binary (${nativeFiles.map((f) => path.basename(f)).join(", ")})`
      );
    } else {
      console.warn(
        `[WARN] Could not embed native addon for ${target.name}; target machine will need ${target.nativeFile} on disk.`
      );
    }

    console.log(
      `\n[BUILD] Compiling ${target.name} (${target.bunTarget}) -> ${outFile}`
    );
    execFileSync(
      "bun",
      [
        "build",
        "--compile",
        "--external",
        "omp-legacy-pi-modules",
        `--target=${target.bunTarget}`,
        "src/main.ts",
        "--outfile",
        outFile,
      ],
      { stdio: "inherit" }
    );

    // Also copy raw .node file(s) alongside the binary as secondary fallback
    for (const srcPath of nativeFiles) {
      const nativeDest = path.join(outDirAbs, path.basename(srcPath));
      fs.copyFileSync(srcPath, nativeDest);
      console.log(`[BUILD] Copied native addon -> ${nativeDest}`);
    }
  } finally {
    if (originalEmbeddedAddonJs !== null) {
      await fsp.writeFile(
        EMBEDDED_ADDON_JS_PATH,
        originalEmbeddedAddonJs,
        "utf-8"
      );
    }
    for (const zstFile of tempZstFiles) {
      await fsp.rm(zstFile, { force: true }).catch(() => {});
    }
  }
}

async function runBuild(): Promise<void> {
  const { targetKeys, skillNames } = parseCliArgs(process.argv.slice(2));
  const nativesVersion = readNativesVersion();

  const selected =
    targetKeys.length === 0 || targetKeys.includes("all")
      ? Object.values(TARGETS)
      : targetKeys.map((key) => {
          const t = TARGETS[key];
          if (!t) {
            throw new Error(
              `Unknown target "${key}". Available: ${Object.keys(TARGETS).join(", ")}, all`
            );
          }
          return t;
        });

  const builtinPackages = await collectBuiltinSkills();
  const dbPackages = await collectDatabaseSkills(skillNames);

  // Merge by skillName (database skill overrides builtin if same name)
  const mergedMap = new Map<string, EmbeddedSkillPackage>();
  for (const pkg of builtinPackages) {
    mergedMap.set(pkg.skillName, pkg);
  }
  for (const pkg of dbPackages) {
    mergedMap.set(pkg.skillName, pkg);
  }
  const mergedPackages = [...mergedMap.values()];

  console.log(
    `[BUILD] Embedding ${mergedPackages.length} skill(s) into binary:`
  );
  for (const pkg of mergedPackages) {
    console.log(
      `  - ${pkg.skillName} [${pkg.source}] (${pkg.files.length} file(s))`
    );
  }

  try {
    await writeEmbeddedSkillsModule(mergedPackages);
    for (const target of selected) {
      await buildOne(target, nativesVersion);
    }
    console.log("\n[DONE] Compilation finished.");
  } finally {
    // Always restore stub so git working tree stays clean
    await fsp.writeFile(GENERATED_FILE_PATH, DEFAULT_GENERATED_STUB, "utf-8");
    await closeDatabase().catch(() => {});
  }
}

runBuild().catch((err) => {
  console.error("[BUILD ERROR]", err instanceof Error ? err.message : err);
  process.exit(1);
});
