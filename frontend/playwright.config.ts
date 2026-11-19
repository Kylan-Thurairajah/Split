import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.SPLIT_WEB_URL ?? 'http://localhost:8081',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.SPLIT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.SPLIT_CHROMIUM_PATH } }
      : {}),
  },
});
