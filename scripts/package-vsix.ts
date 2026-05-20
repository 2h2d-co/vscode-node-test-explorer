import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  private?: boolean;
  description?: string;
  type?: string;
  main?: string;
  activationEvents?: string[];
  contributes?: unknown;
  engines?: { vscode?: string };
  dependencies?: Record<string, string>;
};

const root = process.cwd();
const staging = join(root, ".vscode-vsix-staging");
const preRelease = process.argv.includes("--pre-release");
const publish = process.argv.includes("--publish");
const parsedPackage: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

if (!isExtensionPackage(parsedPackage)) {
  throw new Error("package.json is missing required extension manifest fields.");
}

const rootPackage = parsedPackage;
const astGrepVersion = rootPackage.dependencies?.["@ast-grep/napi"];

if (!astGrepVersion) {
  throw new Error("package.json must declare @ast-grep/napi as a runtime dependency.");
}

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(join(root, "dist"), join(staging, "dist"), { recursive: true });
await cp(join(root, "README.md"), join(staging, "README.md"));
await cp(join(root, "CHANGELOG.md"), join(staging, "CHANGELOG.md"));
await cp(join(root, "LICENSE"), join(staging, "LICENSE"));
await writeFile(
  join(staging, "package.json"),
  `${JSON.stringify(
    {
      name: rootPackage.name,
      displayName: rootPackage.displayName,
      version: rootPackage.version,
      publisher: rootPackage.publisher,
      license: rootPackage.license,
      repository: rootPackage.repository,
      categories: rootPackage.categories,
      keywords: rootPackage.keywords,
      extensionKind: rootPackage.extensionKind,
      description: rootPackage.description,
      type: rootPackage.type,
      main: rootPackage.main,
      activationEvents: rootPackage.activationEvents,
      contributes: rootPackage.contributes,
      engines: rootPackage.engines,
      dependencies: {
        "@ast-grep/napi": astGrepVersion,
      },
    },
    null,
    2,
  )}\n`,
);
await writeFile(join(staging, ".vscodeignore"), "src/**\nscripts/**\n*.tsbuildinfo\n");

await run(
  "npm",
  [
    "install",
    "--omit=dev",
    "--include=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ],
  staging,
);

const target = vsixTarget();
const vsixPath = join(root, `${rootPackage.name}-${rootPackage.version}-${target}.vsix`);
const packageArgs = ["package", "--target", target, "--out", vsixPath];
if (preRelease) {
  packageArgs.push("--pre-release");
}
await run("vsce", packageArgs, staging);

console.log(`Packaged ${vsixPath}`);

if (publish) {
  const publishArgs = ["publish", "--packagePath", vsixPath];
  if (preRelease) {
    publishArgs.push("--pre-release");
  }
  await run("vsce", publishArgs, staging);
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

function vsixTarget(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "darwin-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "linux-arm64";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "linux-x64";
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return "win32-arm64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "win32-x64";
  }

  throw new Error(`Unsupported VSIX target for ${process.platform}/${process.arch}.`);
}
