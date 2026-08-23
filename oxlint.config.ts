import { strictRules } from "@2h2d/oxlint-config/strict-rules";
import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  jsPlugins: [
    {
      name: "2h2d",
      specifier: "@2h2d/oxlint-config/plugin",
    },
  ],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "warn",
  },
  rules: {
    ...strictRules,
    // A spread followed by reverse creates one intentional snapshot; toReversed would copy twice.
    "unicorn/no-array-reverse": "off",
    // Release tooling sorts fresh, locally owned arrays without allocating a redundant copy.
    "unicorn/no-array-sort": "off",
  },
  env: {
    builtin: true,
  },
  options: {
    reportUnusedDisableDirectives: "error",
    typeAware: true,
    typeCheck: true,
  },
});
