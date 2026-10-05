import { defineConfig, devices } from '@playwright/test';
const localChromium = process.env.CHROMIUM_EXECUTABLE;
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: '../../.cache/playwright-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  projects: localChromium
    ? [
        {
          name: 'chromium',
          use: {
            ...devices['Desktop Chrome'],
            launchOptions: { executablePath: localChromium },
          },
        },
        {
          name: 'android-chromium',
          use: {
            ...devices['Pixel 7'],
            launchOptions: { executablePath: localChromium },
          },
        },
      ]
    : [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        { name: 'ios-webkit', use: { ...devices['iPhone 13'] } },
        { name: 'android-chromium', use: { ...devices['Pixel 7'] } },
      ],
});
