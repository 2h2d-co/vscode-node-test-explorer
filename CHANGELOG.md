# Changelog

All notable changes to this extension are documented here.

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
