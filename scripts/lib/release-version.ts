export type ReleaseVersion = {
  extensionVersion: string;
  prerelease: boolean;
};

export function parseReleaseVersion(version: string): ReleaseVersion {
  const match =
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  const extensionVersion = match?.[1];
  if (!extensionVersion) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return { extensionVersion, prerelease: match[2] !== undefined };
}

export function isValidReleaseMetadataFiles(
  files: readonly string[],
  prerelease: boolean,
): boolean {
  return (
    (prerelease && files.length === 1 && files[0] === "package.json") ||
    (!prerelease &&
      files[0] === "CHANGELOG.md" &&
      (files.length === 1 || (files.length === 2 && files[1] === "package.json")))
  );
}
