import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isString, parseJsonObject } from "./lib/json.ts";
import type { JsonObject } from "./lib/json.ts";
import { isValidReleaseMetadataFiles, parseReleaseVersion } from "./lib/release-version.ts";

type PackageJson = JsonObject & {
  name: string;
  version: string;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExecPath = process.env["npm_execpath"] ?? "";
if (!pnpmExecPath) {
  throw new Error("Run this command through pnpm so npm_execpath is available.");
}

const releaseArguments = process.argv.slice(2);
if (releaseArguments[0] === "--") {
  releaseArguments.shift();
}
const releaseVersion = releaseArguments[0] ?? "";
if (!releaseVersion || releaseArguments.length !== 1) {
  throw new Error("Usage: pnpm release -- RELEASE_VERSION");
}
const parsedVersion = parseReleaseVersion(releaseVersion);
const releaseTag = `v${releaseVersion}`;

await createRelease();

async function createRelease(): Promise<void> {
  const npmPath = await requireLockedToolchain();
  requireCleanMain();
  git(["fetch", "--quiet", "--tags", "origin", "main"]);

  const head = gitOutput(["rev-parse", "HEAD"]);
  const originMain = gitOutput(["rev-parse", "origin/main"]);
  if (head !== originMain) {
    throw new Error(`HEAD ${head} does not match origin/main ${originMain}.`);
  }
  if (gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}`])) {
    throw new Error(`Release tag ${releaseTag} already exists.`);
  }
  if (gitSucceeds(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${releaseTag}`])) {
    throw new Error(`Remote release tag ${releaseTag} already exists.`);
  }

  await updatePackageVersion(parsedVersion.extensionVersion);
  if (!parsedVersion.prerelease) {
    await updateStableChangelog(parsedVersion.extensionVersion);
  }
  git(["add", "package.json"]);
  if (!parsedVersion.prerelease) {
    git(["add", "CHANGELOG.md"]);
  }
  assertStagedReleaseFiles(parsedVersion.prerelease);

  const sourceDateEpoch = gitOutput(["show", "-s", "--format=%ct", "HEAD"]);
  const localDigest = await buildReleaseFromIndex(sourceDateEpoch, npmPath);
  git([
    "commit",
    "-S",
    "-m",
    `release: ${releaseTag}`,
    "-m",
    `Release-Manifest-SHA256: ${localDigest}`,
  ]);

  const releaseCommit = gitOutput(["rev-parse", "HEAD"]);
  verifyReleaseCommit(releaseCommit, localDigest);
  const committedSourceDateEpoch = gitOutput(["show", "-s", "--format=%ct", "HEAD^"]);
  if (committedSourceDateEpoch !== sourceDateEpoch) {
    throw new Error("Release source date changed while creating the release commit.");
  }
  const committedDigest = await buildReleaseFromIndex(committedSourceDateEpoch, npmPath);
  if (committedDigest !== localDigest) {
    throw new Error(
      `VSIX release is not reproducible: ${localDigest} does not match ${committedDigest}.`,
    );
  }

  git(["tag", releaseTag]);
  if (gitOutput(["cat-file", "-t", `refs/tags/${releaseTag}`]) !== "commit") {
    throw new Error(`Release tag ${releaseTag} is not lightweight.`);
  }
  if (gitOutput(["rev-parse", `refs/tags/${releaseTag}^{commit}`]) !== releaseCommit) {
    throw new Error(`Release tag ${releaseTag} does not point to ${releaseCommit}.`);
  }

  console.log(`Created signed release commit ${releaseCommit}.`);
  console.log(`Created lightweight tag ${releaseTag}.`);
  console.log(`Locally attested release manifest SHA-256: ${localDigest}`);
  console.log(`Push with: git push --atomic origin main ${releaseTag}`);
}

async function requireLockedToolchain(): Promise<string> {
  const expectedNode = await realpath(runOutput("mise", ["which", "node"], root));
  const actualNode = await realpath(process.execPath);
  if (actualNode !== expectedNode) {
    throw new Error(
      `Release Node.js ${actualNode} does not match locked tool ${expectedNode}; run mise install --locked and restart the command.`,
    );
  }

  const expectedPnpm = await realpath(runOutput("mise", ["which", "pnpm"], root));
  const actualPnpm = await realpath(pnpmExecPath);
  if (actualPnpm !== expectedPnpm) {
    throw new Error(
      `Release pnpm ${actualPnpm} does not match locked tool ${expectedPnpm}; run mise install --locked and restart the command.`,
    );
  }

  return realpath(runOutput("mise", ["which", "npm"], root));
}

function requireCleanMain(): void {
  if (gitOutput(["branch", "--show-current"]) !== "main") {
    throw new Error("Releases must be created from main.");
  }
  if (gitOutput(["status", "--porcelain"]) !== "") {
    throw new Error("Releases require a clean worktree and index.");
  }
}

async function updatePackageVersion(extensionVersion: string): Promise<void> {
  const packagePath = join(root, "package.json");
  const manifest = parsePackageJson(await readFile(packagePath, "utf8"));
  manifest.version = extensionVersion;
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function updateStableChangelog(extensionVersion: string): Promise<void> {
  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8");
  const heading = "## Unreleased";
  const headingIndex = changelog.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error("CHANGELOG.md must contain an Unreleased section.");
  }
  const bodyStart = headingIndex + heading.length;
  const remaining = changelog.slice(bodyStart);
  const nextHeading = /^## /m.exec(remaining);
  if (!nextHeading || nextHeading.index === undefined) {
    throw new Error("CHANGELOG.md must contain a prior release after Unreleased.");
  }
  const unreleased = remaining.slice(0, nextHeading.index).trim();
  if (!unreleased) {
    throw new Error("CHANGELOG.md Unreleased section is empty.");
  }
  const releaseDate = new Date().toISOString().slice(0, 10);
  const prefix = changelog.slice(0, headingIndex);
  const previousReleases = remaining.slice(nextHeading.index);
  const updated =
    `${prefix}${heading}\n\n` +
    `## ${extensionVersion} - ${releaseDate}\n\n${unreleased}\n\n` +
    previousReleases;
  await writeFile(changelogPath, updated);
}

function assertStagedReleaseFiles(prerelease: boolean): void {
  const files = gitOutput(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).sort();
  if (!isValidReleaseMetadataFiles(files, prerelease)) {
    throw new Error(`Release metadata changed unexpected files: ${files.join(", ")}`);
  }
}

async function buildReleaseFromIndex(sourceDateEpoch: string, npmPath: string): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vscode-node-tests-release-"));
  const source = join(temporaryRoot, "source");
  const output = join(temporaryRoot, "vsix");
  await mkdir(source);

  try {
    git(["checkout-index", "--all", "--force", `--prefix=${source}/`]);
    run(pnpmExecPath, ["install", "--frozen-lockfile", "--ignore-scripts"], source);
    const executablePath = [
      join(source, "node_modules", ".bin"),
      dirname(process.execPath),
      process.env["PATH"] ?? "",
    ].join(":");
    run(
      process.execPath,
      [join(source, "scripts", "build-release.ts"), releaseVersion, output],
      source,
      {
        ...process.env,
        PATH: executablePath,
        RELEASE_NPM_PATH: npmPath,
        SOURCE_DATE_EPOCH: sourceDateEpoch,
        TZ: "UTC",
      },
    );
    const manifest = await readFile(join(output, "release-manifest.sha256"));
    return createHash("sha256").update(manifest).digest("hex");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyReleaseCommit(commit: string, digest: string): void {
  git([
    "-c",
    "gpg.format=ssh",
    "-c",
    `gpg.ssh.allowedSignersFile=${join(root, ".github", "release-signers")}`,
    "verify-commit",
    commit,
  ]);
  if (gitOutput(["log", "-1", "--pretty=%s", commit]) !== `release: ${releaseTag}`) {
    throw new Error("Release commit subject is invalid.");
  }
  const trailer = gitOutput([
    "log",
    "-1",
    "--format=%(trailers:key=Release-Manifest-SHA256,valueonly)",
    commit,
  ]);
  if (trailer !== digest) {
    throw new Error(`Release commit manifest digest ${trailer} does not match ${digest}.`);
  }
}

function parsePackageJson(contents: string): PackageJson {
  const value = parseJsonObject(contents, "package.json");
  if (!isPackageJson(value)) {
    throw new Error("package.json is missing a valid name or version.");
  }
  return value;
}

function isPackageJson(value: JsonObject): value is PackageJson {
  return isString(value["name"]) && isString(value["version"]);
}

function git(args: string[]): void {
  run("git", args, root);
}

function gitOutput(args: string[]): string {
  return runOutput("git", args, root);
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

function gitSucceeds(args: string[]): boolean {
  const result = spawnSync("git", args, { cwd: root, stdio: "ignore" });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}.`);
  }
}
