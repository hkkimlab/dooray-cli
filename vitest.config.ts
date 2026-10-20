import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // institution.ts drives a real browser through an organization sign-in page; covered by manual runs only.
      exclude: ["src/bin.ts", "src/sso/institution.ts"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 75 },
    },
  },
});
