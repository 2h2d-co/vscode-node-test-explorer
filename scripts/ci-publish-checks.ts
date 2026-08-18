import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type PackageJson = {
  name: string;
  version: string;
};

type CiRelease = {
  expectedDigest: string;
  extensionVersion: string;
  prerelease: boolean;
  releaseVersion: string;
  sourceDateEpoch: string;
};

const packageJsonPath = resolve(process.cwd(), "package.json");
const parsedPackage: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (!isPackageJson(parsedPackage)) {
  throw new Error(`Missing or invalid package name/version in ${packageJsonPath}`);
}
if (process.argv.length > 2) {
  throw new Error("ci-publish-checks.ts does not accept arguments.");
}

const release = assertCiReleaseGitState(parsedPackage.version);
writeGithubOutput("expected_digest", release.expectedDigest);
writeGithubOutput("extension_version", release.extensionVersion);
writeGithubOutput("prerelease", String(release.prerelease));
writeGithubOutput("release_version", release.releaseVersion);
writeGithubOutput("source_date_epoch", release.sourceDateEpoch);

console.log(
  `Validated CI release for ${parsedPackage.name}@${release.releaseVersion} ` +
    `(extension version ${release.extensionVersion}, prerelease ${release.prerelease}).`,
);

function assertCiReleaseGitState(extensionVersion: string): CiRelease {
  const eventName = getRequiredEnv("GITHUB_EVENT_NAME");
  const ref = getRequiredEnv("GITHUB_REF");
  const sha = getRequiredEnv("GITHUB_SHA");

  if (getRequiredEnv("GITHUB_ACTIONS") !== "true") {
    throw new Error("Refusing release because GITHUB_ACTIONS is not true.");
  }
  if (eventName !== "push") {
    throw new Error(`Refusing release for event "${eventName}".`);
  }
  const tagMatch =
    /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      ref,
    );
  const tagExtensionVersion = tagMatch?.[1];
  if (!tagExtensionVersion) {
    throw new Error(`Refusing release from invalid tag ref "${ref}".`);
  }
  if (tagExtensionVersion !== extensionVersion) {
    throw new Error(
      `Release tag version ${tagExtensionVersion} does not match extension version ${extensionVersion}.`,
    );
  }

  const releaseTag = ref.slice("refs/tags/".length);
  const releaseTagRef = `refs/tags/${releaseTag}`;
  if (!gitSucceeds(["rev-parse", "--verify", "--quiet", `${releaseTagRef}^{commit}`])) {
    throw new Error(`Refusing release because tag "${releaseTag}" does not exist.`);
  }
  if (runGit(["cat-file", "-t", releaseTagRef]) !== "commit") {
    throw new Error(`Refusing release because tag "${releaseTag}" is not lightweight.`);
  }

  const tagCommit = runGit(["rev-parse", `${releaseTagRef}^{commit}`]);
  if (runGit(["rev-parse", "HEAD"]) !== tagCommit) {
    throw new Error(`Refusing release because tag "${releaseTag}" does not point at HEAD.`);
  }
  if (runGit(["rev-parse", `${sha}^{commit}`]) !== tagCommit) {
    throw new Error(`Refusing release because GITHUB_SHA does not match tag "${releaseTag}".`);
  }
  if (!gitSucceeds(["merge-base", "--is-ancestor", tagCommit, "origin/main"])) {
    throw new Error(
      `Refusing release because tag "${releaseTag}" does not point to a commit on origin/main.`,
    );
  }

  const subject = runGit(["log", "-1", "--pretty=%s", tagCommit]);
  if (subject !== `release: ${releaseTag}`) {
    throw new Error(
      `Refusing release because commit subject "${subject}" does not match release: ${releaseTag}.`,
    );
  }
  runGit([
    "-c",
    "gpg.format=ssh",
    "-c",
    "gpg.ssh.allowedSignersFile=.github/release-signers",
    "verify-commit",
    tagCommit,
  ]);
  const expectedDigest = runGit([
    "log",
    "-1",
    "--format=%(trailers:key=Release-Manifest-SHA256,valueonly)",
    tagCommit,
  ]);
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error("Release commit is missing a valid Release-Manifest-SHA256 trailer.");
  }

  const sourceDateEpoch = runGit(["show", "-s", "--format=%ct", `${tagCommit}^`]);
  if (!/^[0-9]+$/.test(sourceDateEpoch)) {
    throw new Error("Could not derive SOURCE_DATE_EPOCH from the release commit parent.");
  }

  return {
    expectedDigest,
    extensionVersion,
    prerelease: tagMatch[2] !== undefined,
    releaseVersion: releaseTag.slice(1),
    sourceDateEpoch,
  };
}

function isPackageJson(value: unknown): value is PackageJson {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    "version" in value &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

function writeGithubOutput(name: string, value: string): void {
  appendFileSync(getRequiredEnv("GITHUB_OUTPUT"), `${name}=${value}\n`);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", shell: false });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout.trim();
}

function gitSucceeds(args: string[]): boolean {
  const result = spawnSync("git", args, { stdio: "ignore" });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}
