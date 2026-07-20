# Changelog

All notable changes to this extension are documented here.

## Unreleased

- Update transitive packaging dependencies to address known security vulnerabilities.

## 0.0.10 - 2026-07-20

- Support Node.js 22.19 and newer for native TypeScript test execution.

## 0.0.9 - 2026-05-20

- Declared limited Restricted Mode support: static test discovery remains available, but running tests is blocked until the workspace is trusted.
- Declared virtual workspaces unsupported.
- Trimmed generated type declarations and source maps from packaged VSIX files.
- Split the refresh command contribution into separate category and title fields.
- Discover tests on activation so gutter run buttons appear without opening Test Explorer first.
- Restored rich failure messages for non-JSON-serializable thrown values and added fallback failure locations from Node test events.

## 0.0.8 - 2026-05-20

- Tightened default VSIX ignore rules for local files and generated artifacts.
- Aligned VS Code API typings with the declared minimum VS Code engine version.

## 0.0.7 - 2026-05-20

- Renamed the Marketplace display name to `Modern node:test Explorer`.

## 0.0.6 - 2026-05-20

- Added Marketplace extension icon.

## 0.0.5 - 2026-05-20

- Added local release automation for tagging, GitHub Release creation, checksums, and Marketplace publishing.
- Added all supported native-platform VSIX packaging targets.
- Moved generated VSIX artifacts under `artifacts/vsix/`.

## 0.0.4 - 2026-05-20

- Added parsed failure stack traces so VS Code can navigate to failure locations from test results.
- Improved failure messages by preferring the underlying thrown error over Node's wrapper error.

## 0.0.3 - 2026-05-20

- Preserved `Error.message`, `Error.stack`, and `Error.cause` in the custom Node test reporter.
- Replaced generic failed-test messages with the actual thrown error details when available.

## 0.0.2 - 2026-05-20

- Removed local reference-directory assumptions from workspace discovery.

## 0.0.1 - 2026-05-20

- Initial pre-release for `darwin-arm64`.
- Added static discovery for ESM `node:test` test files.
- Added VS Code Test Explorer integration with per-test run buttons.
- Added Node 24 native TypeScript test execution.
- Added configurable Node executable via `vscode-node-test-explorer.nodePath`.
