// jest.config.js has to stay CommonJS -- this is Next's own documented
// pattern for wiring up next/jest, and it must synchronously
// module.exports the config for Jest to load it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextJest = require("next/jest")({ dir: "./" });

const customJestConfig = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testEnvironment: "jest-environment-jsdom",
  moduleDirectories: ["node_modules", "<rootDir>"],
  // Mirrors tsconfig.json's "@/*" path alias -- next/jest doesn't pick
  // this up automatically.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // e2e/ holds Playwright specs (run via `npm run test:e2e`), not Jest ones.
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/e2e/"],
  collectCoverageFrom: [
    "app/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    "lib/**/*.{ts,tsx}",
    "!**/*.d.ts",
    "!app/layout.tsx",
  ],
};

module.exports = nextJest(customJestConfig);