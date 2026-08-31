// ESLint 9 flat config for the Plutus frontend.
// Scope: src/**/*.ts(x). Type-aware rules are intentionally off — the
// typecheck npm script (tsc -b --noEmit) owns type errors.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Wire payloads are validated at the API boundary; allow explicit any
      // in the thin fetch layer without ceremony.
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
