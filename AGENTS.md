# vscode-node-tests Project Instructions

vscode-node-tests is a VS Code Test Explorer extension for modern ESM `node:test` projects.

## Conventions

- Format commit messages according to [Conventional Commits](https://www.conventionalcommits.org/).
- Maintain `CHANGELOG.md` using the [Keep a Changelog](https://keepachangelog.com/) style.
- Run `pnpm check` before committing meaningful code changes.
- Add changelog entries for changes whose commit would be `feat:` or `fix:`; keep entries under `Unreleased` until a release is made.
- Create releases from clean, synchronized `main` with:

  ```sh
  pnpm release -- X.Y.Z
  pnpm release -- X.Y.Z-alpha.0
  ```

- The release command updates the numeric extension version, leaves prerelease changes under
  `Unreleased`, reproducibly builds all target-specific VSIX files, records the canonical release
  manifest digest in an SSH-signed `release: vX.Y.Z[-CHANNEL.N]` commit, rebuilds the committed
  tree, and creates the matching lightweight tag.
- Push the commit and tag atomically:

  ```sh
  git push --atomic origin main vX.Y.Z
  ```

- Do not create annotated or signed tag objects. Release authorization comes from the signed commit
  and its manifest digest, while the matching tag must remain lightweight.
