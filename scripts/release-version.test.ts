import assert from "node:assert/strict";
import test from "node:test";

import { isValidReleaseMetadataFiles } from "./lib/release-version.ts";

test("accepts release metadata for new versions and stable promotions", () => {
  assert.equal(isValidReleaseMetadataFiles(["package.json"], true), true);
  assert.equal(isValidReleaseMetadataFiles(["CHANGELOG.md", "package.json"], false), true);
  assert.equal(isValidReleaseMetadataFiles(["CHANGELOG.md"], false), true);
});

test("rejects missing and unexpected release metadata", () => {
  assert.equal(isValidReleaseMetadataFiles([], true), false);
  assert.equal(isValidReleaseMetadataFiles([], false), false);
  assert.equal(isValidReleaseMetadataFiles(["CHANGELOG.md"], true), false);
  assert.equal(isValidReleaseMetadataFiles(["package.json"], false), false);
  assert.equal(isValidReleaseMetadataFiles(["CHANGELOG.md", "README.md"], false), false);
});
