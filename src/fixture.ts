import {test as base, BrowserContext} from '@playwright/test';
import type {LaunchOptions} from '@playwright/test';
import {createProfiler, getInstallHookCode, RECOMMENDED_PROFILING_ARGS} from './profiler';
import {ProfilerConfig, ReactProfiler} from './types';

export type ProfilerFixtures = {
    profiler: ReactProfiler;
    profilerConfig: ProfilerConfig;
};

/**
 * Extended Playwright test with React profiler fixture.
 *
 * The `context` fixture is overridden to auto-inject the React DevTools hook
 * via `addInitScript` before any page loads. This is required because
 * `installHook.js` must run before React initializes; otherwise React will
 * not register with `__REACT_DEVTOOLS_GLOBAL_HOOK__` and profiling will fail
 * with "No React renderer found".
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
export const test = base.extend<ProfilerFixtures, {launchOptions: LaunchOptions}>({
    profilerConfig: [{}, {option: true}],

    // Merge RECOMMENDED_PROFILING_ARGS into launchOptions at the worker scope.
    // Without these Chrome flags, background-tab throttling distorts timings and
    // React scheduling. Any user-provided launchOptions.args still take effect.
    launchOptions: [
        async ({launchOptions}, use) => {
            const existingArgs = launchOptions?.args ?? [];
            const merged: LaunchOptions = {
                ...launchOptions,
                args: [...RECOMMENDED_PROFILING_ARGS, ...existingArgs],
            };
            await use(merged);
        },
        {scope: 'worker'},
    ],

    context: async ({context}, use) => {
        await injectDevToolsHook(context);
        await use(context);
    },

    profiler: async ({page, profilerConfig}, use) => {
        const profilerInstance = createProfiler(page, profilerConfig);
        await use(profilerInstance);
    },
});

export {expect} from '@playwright/test';

/**
 * Creates a BrowserContext with React DevTools hook pre-installed.
 * Use this for custom context setups (persistent contexts, auth state, etc.)
 */
export async function injectDevToolsHook(context: BrowserContext): Promise<void> {
    const hookCode = getInstallHookCode();
    await context.addInitScript(hookCode);
}
