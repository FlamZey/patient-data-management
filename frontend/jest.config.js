const nextJest = require("next/jest")({ dir: "./" });

const customJestConfig = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testEnvironment: "jest-environment-jsdom",
  moduleDirectories: ["node_modules", "<rootDir>"],
  // e2e/ holds Playwright specs (run via `npm run test:e2e`), not Jest ones.
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/e2e/"],
};

module.exports = nextJest(customJestConfig);