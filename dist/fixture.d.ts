import { ProfilerConfig, ReactProfiler } from './types';
export type ProfilerFixtures = {
    profiler: ReactProfiler;
    profilerConfig: ProfilerConfig;
};
/**
 * Extended Playwright test with React profiler fixture.
 *
 * Launches a persistent Chromium context with the React DevTools extension
 * loaded via --load-extension. The extension installs the DevTools hook and
 * activates the backend as content scripts - no manual addInitScript needed.
 *
 * Chrome extensions require a persistent context, so the `context` fixture
 * is overridden to use `chromium.launchPersistentContext`.
 *
 * Usage:
 *   import { test } from 'playwright-react-profiler';
 *
 *   test('my page load', async ({ page, profiler }) => {
 *     await page.goto('/my-page');
 *     await profiler.start();
 *     await profiler.waitForStable();
 *     const profile = await profiler.stop();
 *   });
 */
export declare const test: import("@playwright/test").TestType<import("@playwright/test").PlaywrightTestArgs & import("@playwright/test").PlaywrightTestOptions & ProfilerFixtures, import("@playwright/test").PlaywrightWorkerArgs & import("@playwright/test").PlaywrightWorkerOptions>;
export { expect } from '@playwright/test';
