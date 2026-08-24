import { spawn, spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { currentVsixTarget, vsixTargetByName, vsixTargets } from "./vsix-targets.ts";
import type { VsixTarget } from "./vsix-targets.ts";

type ExtensionPackage = {
  name: string;
  displayName?: string;
  version: string;
  publisher?: string;
  license?: string;
  repository?: { type: string; url: string };
  categories?: string[];
  keywords?: string[];
  extensionKind?: string[];
  capabilities?: unknown;
  private?: boolean;
  description?: string;
  icon?: string;
  type?: string;
  main?: string;
  activationEvents?: string[];
  contributes?: unknown;
  engines?: { vscode?: string };
  dependencies?: Record<string, string>;
};

type PackageOptions = {
  preRelease: boolean;
  publish: boolean;
  targets: readonly VsixTarget[];
  outDir: string;
};

const root = process.cwd();
const staging = join(root, ".vscode-vsix-staging");
const options = packageOptions(process.argv.slice(2));
const outputDir = isAbsolute(options.outDir) ? options.outDir : join(root, options.outDir);
const parsedPackage: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

if (!isExtensionPackage(parsedPackage)) {
  throw new Error("package.json is missing required extension manifest fields.");
}

const rootPackage = parsedPackage;
const astGrepVersion = rootPackage.dependencies?.["@ast-grep/napi"];
const configuredMinimumReleaseAgeDays = await readMinimumReleaseAgeDays();
const temporaryReleaseAgeOverrideExpiresAt = Date.parse("2026-08-14T15:38:00Z");
if (configuredMinimumReleaseAgeDays !== 7) {
  throw new Error("pnpm-workspace.yaml must enforce the seven-day minimum release age.");
}
if (Date.now() >= temporaryReleaseAgeOverrideExpiresAt) {
  throw new Error(
    "temporary npm minimum release-age override expired; use the configured seven-day policy.",
  );
}
const minimumReleaseAgeDays = 3;
const npmPath = await resolveNpmPath();

if (!astGrepVersion) {
  throw new Error("package.json must declare @ast-grep/napi as a runtime dependency.");
}

const packagedVsixPaths: string[] = [];
for (const target of options.targets) {
  const vsixPath = await packageTarget(rootPackage, astGrepVersion, target, options.preRelease);
  packagedVsixPaths.push(vsixPath);
}

if (options.publish) {
  const publishArgs = ["publish", "--skip-duplicate"];
  if (options.preRelease) {
    publishArgs.push("--pre-release");
  }
  publishArgs.push("--packagePath", ...packagedVsixPaths);
  await run("vsce", publishArgs, root);
}

async function packageTarget(
  manifest: ExtensionPackage,
  packageAstGrepVersion: string,
  target: VsixTarget,
  preRelease: boolean,
): Promise<string> {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await cp(join(root, "dist"), join(staging, "dist"), { recursive: true });
  await cp(join(root, "README.md"), join(staging, "README.md"));
  await cp(join(root, "CHANGELOG.md"), join(staging, "CHANGELOG.md"));
  await cp(join(root, "LICENSE"), join(staging, "LICENSE"));
  if (manifest.icon) {
    await mkdir(join(staging, dirname(manifest.icon)), { recursive: true });
    await cp(join(root, manifest.icon), join(staging, manifest.icon));
  }
  await writeFile(
    join(staging, "package.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        publisher: manifest.publisher,
        license: manifest.license,
        repository: manifest.repository,
        categories: manifest.categories,
        keywords: manifest.keywords,
        extensionKind: manifest.extensionKind,
        capabilities: manifest.capabilities,
        description: manifest.description,
        icon: manifest.icon,
        type: manifest.type,
        main: manifest.main,
        activationEvents: manifest.activationEvents,
        contributes: manifest.contributes,
        engines: manifest.engines,
        dependencies: {
          "@ast-grep/napi": packageAstGrepVersion,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(staging, ".vscodeignore"),
    "src/**\nscripts/**\n*.tsbuildinfo\n**/*.d.ts\n**/*.js.map\n",
  );

  const npmInstallArgs = [
    "install",
    "--omit=dev",
    "--include=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    `--min-release-age=${minimumReleaseAgeDays}`,
    `--os=${target.npmOs}`,
    `--cpu=${target.npmCpu}`,
  ];
  if (target.npmLibc) {
    npmInstallArgs.push(`--libc=${target.npmLibc}`);
  }
  await run(npmPath, npmInstallArgs, staging);
  await access(join(staging, "node_modules", "@ast-grep", target.astGrepPackage));

  await mkdir(outputDir, { recursive: true });
  const vsixPath = join(outputDir, `${manifest.name}-${manifest.version}-${target.name}.vsix`);
  const packageArgs = ["package", "--target", target.name, "--out", vsixPath];
  if (preRelease) {
    packageArgs.push("--pre-release");
  }
  await run("vsce", packageArgs, staging);

  console.log(`Packaged ${vsixPath}`);
  return vsixPath;
}

function packageOptions(args: readonly string[]): PackageOptions {
  const targetNames: string[] = [];
  let allTargets = false;
  let preRelease = false;
  let publish = false;
  let outDir = "artifacts/vsix";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      throw new Error("Missing command line option.");
    }
    if (arg === "--all-targets") {
      allTargets = true;
    } else if (arg === "--pre-release") {
      preRelease = true;
    } else if (arg === "--publish") {
      publish = true;
    } else if (arg === "--out-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--out-dir requires a directory path.");
      }
      outDir = value;
      index += 1;
    } else if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
    } else if (arg === "--target") {
      const targetName = args[index + 1];
      if (!targetName) {
        throw new Error("--target requires a VSIX target name.");
      }
      targetNames.push(targetName);
      index += 1;
    } else if (arg.startsWith("--target=")) {
      targetNames.push(arg.slice("--target=".length));
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }

  if (allTargets && targetNames.length > 0) {
    throw new Error("Use either --all-targets or --target, not both.");
  }

  const targets = allTargets
    ? vsixTargets
    : targetNames.length > 0
      ? targetNames.map((name) => {
          const target = vsixTargetByName(name);
          if (!target) {
            throw new Error(`Unsupported VSIX target ${name}.`);
          }
          return target;
        })
      : [currentVsixTarget()];

  return { preRelease, publish, targets, outDir };
}

function isExtensionPackage(value: unknown): value is ExtensionPackage {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string"
  );
}

async function readMinimumReleaseAgeDays(): Promise<number> {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const minutesText = /^minimumReleaseAge:\s*([0-9]+)\s*$/m.exec(workspace)?.[1];
  const minutes = Number(minutesText);
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes % (24 * 60) !== 0) {
    throw new Error("pnpm-workspace.yaml minimumReleaseAge must be a positive whole day.");
  }
  return minutes / (24 * 60);
}

async function resolveNpmPath(): Promise<string> {
  const configuredPath = process.env["RELEASE_NPM_PATH"];
  const candidate = configuredPath ?? runOutput("mise", ["which", "npm"], root);
  if (!isAbsolute(candidate)) {
    throw new Error(`npm path must be absolute: ${candidate}`);
  }
  const resolvedPath = await realpath(candidate);
  const version = runOutput(resolvedPath, ["--version"], root);
  const major = Number(version.split(".", 1)[0]);
  if (!Number.isSafeInteger(major) || major < 11) {
    throw new Error(
      `npm 11 or newer is required for minimum release-age enforcement; got ${version}.`,
    );
  }
  return resolvedPath;
}

function runOutput(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}.`);
  }
  return result.stdout.trim();
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "no code"}`));
      }
    });
  });
}
