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
    // Immutable map projections must not be replaced with mutations based on incomplete alias analysis.
    "oxc/no-map-spread": "off",
    // Nested function identity and lexical locality can be intentional even without captured values.
    "unicorn/consistent-function-scoping": "off",
    // A spread followed by reverse creates one intentional snapshot; toReversed would copy twice.
    "unicorn/no-array-reverse": "off",
    // Release tooling sorts fresh, locally owned arrays without allocating a redundant copy.
    "unicorn/no-array-sort": "off",
    // A bare empty export can define module semantics; the native rule removes only redundant ones.
    "unicorn/require-module-specifiers": "off",
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
