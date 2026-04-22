import {test as base, chromium, BrowserContext} from '@playwright/test';
import {createProfiler, resolveExtensionDir, RECOMMENDED_PROFILING_ARGS} from './profiler';
import {ProfilerConfig, ReactProfiler} from './types';

export type ProfilerFixtures = {
    profiler: ReactProfiler;
    profilerConfig: ProfilerConfig;
};

function getExtensionArgs(extensionDir: string): string[] {
    return [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
}

/**
 * Extended Playwright test with React profiler fixture.
 *
 * Launches a persistent Chromium context with the React DevTools extension
 * loaded via --load-extension. The extension installs the DevTools hook and
 * activates the backend as content scripts — no manual addInitScript needed.
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
export const test = base.extend<ProfilerFixtures>({
    profilerConfig: [{}, {option: true}],

    context: async ({}, use) => {
        const extensionDir = resolveExtensionDir();
        const context = await chromium.launchPersistentContext('', {
            args: [...RECOMMENDED_PROFILING_ARGS, ...getExtensionArgs(extensionDir)],
        });
        await use(context);
        await context.close();
    },

    profiler: async ({page, profilerConfig}, use) => {
        const profilerInstance = createProfiler(page, profilerConfig);
        await use(profilerInstance);
    },
});

export {expect} from '@playwright/test';