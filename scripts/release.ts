import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

import { vsixTargets } from "./vsix-targets.ts";

type ExtensionPackage = {
  name: string;
  version: string;
};

const root = process.cwd();
const artifactDir = join(root, "artifacts", "vsix");
const releaseArgs = process.argv.slice(2);
const preRelease = releaseArgs.includes("--pre-release");
const publishMarketplace = releaseArgs.includes("--publish-marketplace");

for (const arg of releaseArgs) {
  if (arg !== "--pre-release" && arg !== "--publish-marketplace") {
    throw new Error(`Unknown option ${arg}`);
  }
}

const parsedPackage: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!isExtensionPackage(parsedPackage)) {
  throw new Error("package.json is missing required release fields.");
}

const version = parsedPackage.version;
const tag = `v${version}`;
const releaseNotes = await changelogEntry(version);

await ensureCleanGitStatus();
await ensureTagDoesNotExist(tag);
await run("pnpm", ["check"], root);
await run("pnpm", ["compile"], root);
await run(
  "node",
  [
    "scripts/package-vsix.ts",
    "--all-targets",
    "--out-dir",
    artifactDir,
    ...(preRelease ? ["--pre-release"] : []),
  ],
  root,
);

const artifactPaths = vsixTargets.map((target) =>
  join(artifactDir, `${parsedPackage.name}-${version}-${target.name}.vsix`),
);
await Promise.all(artifactPaths.map((artifactPath) => stat(artifactPath)));

const checksumPaths: string[] = [];
for (const artifactPath of artifactPaths) {
  // oxlint-disable-next-line no-await-in-loop -- writing checksums next to deterministic artifact names.
  checksumPaths.push(await writeSha256File(artifactPath));
}

await run("git", ["tag", tag], root);
await run("git", ["push"], root);
await run("git", ["push", "origin", tag], root);
await run(
  "gh",
  [
    "release",
    "create",
    tag,
    ...artifactPaths,
    ...checksumPaths,
    "--title",
    tag,
    "--notes",
    releaseNotes,
    ...(preRelease ? ["--prerelease"] : []),
  ],
  root,
);

if (publishMarketplace) {
  await run(
    "vsce",
    ["publish", ...(preRelease ? ["--pre-release"] : []), "--packagePath", ...artifactPaths],
    root,
  );
}

async function changelogEntry(releaseVersion: string): Promise<string> {
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  const heading = new RegExp(`^## ${escapeRegExp(releaseVersion)}(?:\\s+-\\s+.*)?$`, "m");
  const match = heading.exec(changelog);
  if (!match) {
    throw new Error(`CHANGELOG.md is missing a section for ${releaseVersion}.`);
  }

  const start = match.index + match[0].length;
  const nextHeading = changelog.slice(start).search(/^## /m);
  const entry = changelog.slice(start, nextHeading === -1 ? undefined : start + nextHeading).trim();
  if (!entry) {
    throw new Error(`CHANGELOG.md section for ${releaseVersion} is empty.`);
  }
  return entry;
}

async function ensureCleanGitStatus(): Promise<void> {
  const status = await output("git", ["status", "--porcelain"], root);
  if (status.trim().length > 0) {
    throw new Error(`Commit or stash changes before releasing:\n${status}`);
  }
}

async function ensureTagDoesNotExist(releaseTag: string): Promise<void> {
  const localTagExists = await exitsSuccessfully(
    "git",
    ["rev-parse", "--verify", `refs/tags/${releaseTag}`],
    root,
  );
  if (localTagExists) {
    throw new Error(`Local tag ${releaseTag} already exists.`);
  }

  const remoteTagExists = await exitsSuccessfully(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${releaseTag}`],
    root,
  );
  if (remoteTagExists) {
    throw new Error(`Remote tag ${releaseTag} already exists.`);
  }
}

async function writeSha256File(artifactPath: string): Promise<string> {
  const content = await readFile(artifactPath);
  const checksum = createHash("sha256").update(content).digest("hex");
  const checksumPath = `${artifactPath}.sha256`;
  await writeFile(checksumPath, `${checksum}  ${basename(artifactPath)}\n`);
  return checksumPath;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(command: string, commandArgs: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${commandArgs.join(" ")} exited with ${code ?? "no code"}`));
      }
    });
  });
}

function output(command: string, commandArgs: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            stderr.trim() || `${command} ${commandArgs.join(" ")} exited with ${code ?? "no code"}`,
          ),
        );
      }
    });
  });
}

function exitsSuccessfully(command: string, commandArgs: string[], cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}
