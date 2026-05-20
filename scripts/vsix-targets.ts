export type VsixTargetName =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "alpine-arm64"
  | "alpine-x64"
  | "win32-arm64"
  | "win32-x64";

export type VsixTarget = {
  name: VsixTargetName;
  npmOs: string;
  npmCpu: string;
  npmLibc?: string;
  astGrepPackage: string;
};

export const vsixTargets: readonly VsixTarget[] = [
  {
    name: "darwin-arm64",
    npmOs: "darwin",
    npmCpu: "arm64",
    astGrepPackage: "napi-darwin-arm64",
  },
  {
    name: "darwin-x64",
    npmOs: "darwin",
    npmCpu: "x64",
    astGrepPackage: "napi-darwin-x64",
  },
  {
    name: "linux-arm64",
    npmOs: "linux",
    npmCpu: "arm64",
    npmLibc: "glibc",
    astGrepPackage: "napi-linux-arm64-gnu",
  },
  {
    name: "linux-x64",
    npmOs: "linux",
    npmCpu: "x64",
    npmLibc: "glibc",
    astGrepPackage: "napi-linux-x64-gnu",
  },
  {
    name: "alpine-arm64",
    npmOs: "linux",
    npmCpu: "arm64",
    npmLibc: "musl",
    astGrepPackage: "napi-linux-arm64-musl",
  },
  {
    name: "alpine-x64",
    npmOs: "linux",
    npmCpu: "x64",
    npmLibc: "musl",
    astGrepPackage: "napi-linux-x64-musl",
  },
  {
    name: "win32-arm64",
    npmOs: "win32",
    npmCpu: "arm64",
    astGrepPackage: "napi-win32-arm64-msvc",
  },
  {
    name: "win32-x64",
    npmOs: "win32",
    npmCpu: "x64",
    astGrepPackage: "napi-win32-x64-msvc",
  },
];

export function vsixTargetByName(name: string): VsixTarget | undefined {
  return vsixTargets.find((target) => target.name === name);
}

export function currentVsixTarget(): VsixTarget {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return requiredVsixTarget("darwin-arm64");
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return requiredVsixTarget("darwin-x64");
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return requiredVsixTarget("linux-arm64");
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return requiredVsixTarget("linux-x64");
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return requiredVsixTarget("win32-arm64");
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return requiredVsixTarget("win32-x64");
  }

  throw new Error(`Unsupported VSIX target for ${process.platform}/${process.arch}.`);
}

function requiredVsixTarget(name: VsixTargetName): VsixTarget {
  const target = vsixTargetByName(name);
  if (!target) {
    throw new Error(`Missing VSIX target metadata for ${name}.`);
  }
  return target;
}
