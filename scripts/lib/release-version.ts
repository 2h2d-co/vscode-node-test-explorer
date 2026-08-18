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
