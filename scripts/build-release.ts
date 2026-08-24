import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isString, parseJsonObject } from "./lib/json.ts";
import { parseReleaseVersion } from "./lib/release-version.ts";
import { vsixTargets } from "./vsix-targets.ts";

type PackageJson = {
  name: string;
  version: string;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseVersion = process.argv[2];
const outputArgument = process.argv[3];

process.env["TZ"] = "UTC";

if (!releaseVersion || !outputArgument || process.argv.length !== 4) {
  throw new Error("Usage: node scripts/build-release.ts RELEASE_VERSION OUTPUT_DIRECTORY");
}

const parsedVersion = parseReleaseVersion(releaseVersion);
const sourceDateEpoch = process.env["SOURCE_DATE_EPOCH"];
if (!sourceDateEpoch || !/^[0-9]+$/.test(sourceDateEpoch)) {
  throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
}

const output = isAbsolute(outputArgument) ? outputArgument : join(root, outputArgument);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) {
  throw new Error(`Release output directory must be empty: ${output}`);
}

const manifest = parsePackageJson(await readFile(join(root, "package.json"), "utf8"));
if (manifest.name !== "vscode-node-test-explorer") {
  throw new Error(`Unexpected extension name: ${manifest.name}`);
}
if (manifest.version !== parsedVersion.extensionVersion) {
  throw new Error(
    `Extension version ${manifest.version} does not match release ${releaseVersion}.`,
  );
}

run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "."], root);

const packageArgs = [
  join(root, "scripts", "package-vsix.ts"),
  "--all-targets",
  "--out-dir",
  output,
];
if (parsedVersion.prerelease) {
  packageArgs.push("--pre-release");
}
run(process.execPath, packageArgs, root);

const expectedFiles = vsixTargets
  .map((target) => `${manifest.name}-${parsedVersion.extensionVersion}-${target.name}.vsix`)
  .sort();
const actualFiles = (await readdir(output)).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Unexpected VSIX artifacts:\nexpected ${expectedFiles.join(", ")}\nactual ${actualFiles.join(", ")}`,
  );
}

const manifestLines: string[] = [];
for (const name of expectedFiles) {
  const contents = await readFile(join(output, name));
  const digest = createHash("sha256").update(contents).digest("hex");
  manifestLines.push(`${digest}  ${name}`);
}
const releaseManifest = `${manifestLines.join("\n")}\n`;
const manifestPath = join(output, "release-manifest.sha256");
await writeFile(manifestPath, releaseManifest);
const manifestDigest = createHash("sha256").update(releaseManifest).digest("hex");

console.log(`Release manifest: ${manifestPath}`);
console.log(`Release manifest SHA-256: ${manifestDigest}`);

function parsePackageJson(contents: string): PackageJson {
  const value = parseJsonObject(contents, "package.json");
  const name = value["name"];
  const version = value["version"];
  if (!isString(name) || !isString(version)) {
    throw new Error("package.json is missing a valid name or version.");
  }
  return { name, version };
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}.`);
  }
}
