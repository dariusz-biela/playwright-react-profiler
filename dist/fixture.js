"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expect = exports.test = void 0;
const test_1 = require("@playwright/test");
const profiler_1 = require("./profiler");
function getExtensionArgs(extensionDir) {
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
exports.test = test_1.test.extend({
    profilerConfig: [{}, { option: true }],
    context: async ({}, use) => {
        const extensionDir = (0, profiler_1.resolveExtensionDir)();
        const context = await test_1.chromium.launchPersistentContext('', {
            channel: 'chromium',
            args: [...profiler_1.RECOMMENDED_PROFILING_ARGS, ...getExtensionArgs(extensionDir)],
        });
        await use(context);
        await context.close();
    },
    profiler: async ({ page, profilerConfig }, use) => {
        const profilerInstance = (0, profiler_1.createProfiler)(page, profilerConfig);
        await use(profilerInstance);
    },
});
var test_2 = require("@playwright/test");
Object.defineProperty(exports, "expect", { enumerable: true, get: function () { return test_2.expect; } });
