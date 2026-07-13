# Modern node:test Explorer

VS Code Test Explorer integration for modern `node:test` projects.

## Features

- Discovers tests statically without executing test files.
- Shows discovered tests in VS Code's Test Explorer.
- Adds editor run buttons for discovered tests.
- Runs tests with Node's native `node --test` runner.
- Supports native TypeScript execution in Node.js.

## Requirements

- VS Code 1.100 or newer.
- Node 24 available to the extension for test execution.
- ESM test files.
- A local, non-virtual workspace.
- A trusted workspace for running tests.

## Supported test files

The extension discovers tests in:

- `*.test.js`
- `*.test.mjs`
- `*.test.ts`
- `*.test.mts`
- `*.spec.js`
- `*.spec.mjs`
- `*.spec.ts`
- `*.spec.mts`

It intentionally supports only modern ESM `node:test` projects. CommonJS, legacy transpilers, compatibility loaders, TSX, and non-Node test frameworks are outside this extension's scope.

## Workspace Trust and virtual workspaces

In Restricted Mode, the extension can discover tests but will not run them because `node:test` executes workspace code. Trust the workspace before running tests.

Virtual workspaces are not supported because discovery and execution require local file paths and a Node process in the workspace extension host.

## Node path

Test execution uses the `vscode-node-test-explorer.nodePath` setting and defaults to `node` from `PATH`.

If VS Code cannot resolve Node 24 from `PATH`, set an absolute path:

```json
{
  "vscode-node-test-explorer.nodePath": "/path/to/node"
}
```

The extension does not discover or activate version managers.

## Development

Use the local `mise.toml`:

```sh
mise trust
mise install
pnpm install
pnpm compile
pnpm package
pnpm package:pre-release
pnpm package:pre-release:all
```

Generated VSIX files are written under `artifacts/vsix/`.

`mise.toml` pins Node and pnpm and adds `node_modules/.bin` to `PATH`.

## Releasing

Update `package.json` and `CHANGELOG.md`, create and push the matching `v<version>` release tag, and let the release workflow validate, package, publish to the VS Code Marketplace, and create the GitHub release. Prerelease versions are published with the Marketplace prerelease flag.
