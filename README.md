# node:test Explorer

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

## Publishing

```sh
pnpm publish:pre-release
```

## Releasing

Update `package.json` and `CHANGELOG.md`, commit the changes, then run:

```sh
pnpm release:pre-release
```
