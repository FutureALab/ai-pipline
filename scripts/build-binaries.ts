import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

function buildOne(target: BuildTarget): void {
  const outDirAbs = path.resolve(process.cwd(), target.outDir);
  const outFile = path.join(outDirAbs, target.binaryName);
  fs.mkdirSync(outDirAbs, { recursive: true });

  console.log(`\n[BUILD] Compiling ${target.name} (${target.bunTarget}) -> ${outFile}`);
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

  const nativeSrc = path.resolve(
    process.cwd(),
    "node_modules",
    target.nativePkg,
    target.nativeFile
  );
  if (fs.existsSync(nativeSrc)) {
    const nativeDest = path.join(outDirAbs, target.nativeFile);
    fs.copyFileSync(nativeSrc, nativeDest);
    console.log(`[BUILD] Copied native addon -> ${nativeDest}`);
  } else {
    console.warn(
      `[WARN] Native addon not found locally: ${nativeSrc} (target machine may download or require it alongside the binary)`
    );
  }
}

const args = process.argv.slice(2);
const selected =
  args.length === 0 || args.includes("all")
    ? Object.values(TARGETS)
    : args.map((key) => {
        const t = TARGETS[key];
        if (!t) {
          throw new Error(
            `Unknown target "${key}". Available: ${Object.keys(TARGETS).join(", ")}, all`
          );
        }
        return t;
      });

for (const target of selected) {
  buildOne(target);
}

console.log("\n[DONE] Compilation finished.");
