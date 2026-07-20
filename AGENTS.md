# vscode-node-tests Project Instructions

vscode-node-tests is a VS Code Test Explorer extension for modern ESM `node:test` projects.

## Conventions

- Format commit messages according to [Conventional Commits](https://www.conventionalcommits.org/).
- Maintain `CHANGELOG.md` using the [Keep a Changelog](https://keepachangelog.com/) style.
- Run `pnpm check` before committing meaningful code changes.
- Add changelog entries for changes whose commit would be `feat:` or `fix:`; keep entries under `Unreleased` until a release is made.
- Release commits should do the following:
  - update the package version;
  - move `Unreleased` changelog entries into the new release section;
  - commit with `release: vX.Y.Z` as the commit message;
  - tag the release with the matching `vX.Y.Z` tag.
