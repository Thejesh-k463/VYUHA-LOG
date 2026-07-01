import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build/output directories not covered by the defaults above — without these,
    // ESLint recurses into compiled bundle output (e.g. the Next.js server copy
    // embedded in the Tauri build dir) and lints it as if it were source.
    "src-tauri/**",
    "desktop-dist/**",
    "data/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
