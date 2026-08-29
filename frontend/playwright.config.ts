import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // E2E specs hit the real backend/db, not mocks -- generous timeouts so a
  // slow encrypt/decrypt pass or a cold container doesn't flake the suite.
  // 100s comfortably covers helpers.ts's login() retry path, which can wait
  // up to 65s for the shared login rate limit's window to clear.
  timeout: 100_000,
  expect: { timeout: 10_000 },
  // Serialized rather than the default multi-worker parallelism: POST
  // /auth/login is rate-limited to 10/minute per IP (see docs/security.md),
  // and every worker shares this same host's IP against the same backend --
  // running spec files in parallel multiplies concurrent login attempts
  // against that one shared limit and reliably trips it.
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
  },
});