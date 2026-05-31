"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECOMMENDED_PROFILING_ARGS = void 0;
exports.resolveExtensionDir = resolveExtensionDir;
exports.createProfiler = createProfiler;
exports.launchProfilingContext = launchProfilingContext;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const test_1 = require("@playwright/test");
/**
 * Chrome flags required for accurate profiling.
 *
 * Without these, headless Chrome throttles timers and background work in the
 * renderer when the window is not focused. That distorts wall-clock measurements
 * and changes React's scheduling behavior.
 */
exports.RECOMMENDED_PROFILING_ARGS = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
];
const DEFAULT_CONFIG = {
    stableThresholdMs: 2000,
    maxWaitMs: 30000,
};
/**
 * Resolve the path to the React DevTools extension directory.
 */
function resolveExtensionDir() {
    const localExt = path_1.default.resolve(__dirname, '..', 'devtools-extension');
    if (fs_1.default.existsSync(path_1.default.join(localExt, 'manifest.json'))) {
        return localExt;
    }
    throw new Error('React DevTools extension not found.\nRun: npm run build-devtools');
}
function getExtensionArgs(extensionDir) {
    return [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
}
/**
 * Remove the persisted extension service-worker cache so a freshly built
 * extension is always used.
 *
 * Chrome stores the MV3 service worker (devtools-extension/frontend.js) as
 * compiled bytecode in `Service Worker/ScriptCache` and its registration in
 * `Service Worker/Database`. In a persistent profile a stale compiled worker
 * keeps running even after frontend.js is rebuilt on disk — edits silently
 * appear to have no effect (the root cause of confusing "nothing changed"
 * iteration on this tool).
 *
 * Both must be cleared together: deleting only ScriptCache leaves the
 * registration pointing at a now-missing bytecode resource, which stops the
 * worker from starting at all. Clearing ScriptCache + Database forces the
 * extension (and the app) to re-register their workers from disk on the next
 * launch. The app's CacheStorage and saved auth (cookies, localStorage) are
 * left intact, so profiling behavior is unchanged — only stale extension code
 * is evicted.
 */
function purgeExtensionServiceWorkerCache(userDataDir) {
    if (!userDataDir) {
        // Empty userDataDir => Playwright uses a throwaway temp profile that
        // never persists a cache, so there is nothing to purge.
        return;
    }
    const swRoots = [path_1.default.join(userDataDir, 'Default', 'Service Worker'), path_1.default.join(userDataDir, 'Service Worker')];
    for (const root of swRoots) {
        for (const sub of ['ScriptCache', 'Database']) {
            try {
                fs_1.default.rmSync(path_1.default.join(root, sub), { recursive: true, force: true });
            }
            catch {
                // Best-effort: an absent or locked cache is fine — the worker re-registers regardless.
            }
        }
    }
}
async function waitForProfilerReady(page, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(async () => {
            const profiler = window.__REACT_PROFILER__;
            if (!profiler)
                return false;
            return profiler.isReady();
        });
        if (ready)
            return true;
        await page.waitForTimeout(200);
    }
    return false;
}
function createProfiler(page, config) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    let stableCallId = 0;
    return {
        async start() {
            const ready = await waitForProfilerReady(page);
            if (!ready)
                throw new Error('React DevTools profiler not ready — no renderer found');
            await page.evaluate(async () => {
                await window.__REACT_PROFILER__.startProfiling();
            });
        },
        async stop() {
            return page.evaluate(async () => {
                const profiler = window.__REACT_PROFILER__;
                if (!profiler)
                    return null;
                await profiler.stopProfiling();
                return profiler.exportProfilingData();
            });
        },
        async waitForStable() {
            const cbName = `__profilerStableCb_${++stableCallId}`;
            return new Promise((resolve, reject) => {
                let timer;
                let resolved = false;
                const done = () => {
                    if (resolved)
                        return;
                    resolved = true;
                    clearTimeout(deadlineTimer);
                    clearTimeout(timer);
                    page.evaluate(() => {
                        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
                        if (hook?.__restoreOnCommitFiberRoot__) {
                            hook.__restoreOnCommitFiberRoot__();
                            delete hook.__restoreOnCommitFiberRoot__;
                        }
                    }).catch(() => { });
                    resolve();
                };
                const deadlineTimer = setTimeout(done, cfg.maxWaitMs);
                const onCommit = () => {
                    clearTimeout(timer);
                    timer = setTimeout(done, cfg.stableThresholdMs);
                };
                page.exposeFunction(cbName, onCommit)
                    .then(() => page.evaluate((name) => {
                    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
                    if (!hook)
                        return;
                    const origFn = hook.onCommitFiberRoot;
                    hook.onCommitFiberRoot = function (...args) {
                        if (origFn)
                            origFn.apply(hook, args);
                        window[name]();
                    };
                    hook.__restoreOnCommitFiberRoot__ = () => {
                        hook.onCommitFiberRoot = origFn;
                    };
                }, cbName))
                    .then(() => {
                    timer = setTimeout(done, cfg.stableThresholdMs);
                })
                    .catch(reject);
            });
        },
        async isReady() {
            return page.evaluate(async () => {
                const profiler = window.__REACT_PROFILER__;
                if (!profiler)
                    return false;
                return profiler.isReady();
            });
        },
        async exportProfile() {
            return page.evaluate(async () => {
                const profiler = window.__REACT_PROFILER__;
                if (!profiler)
                    return null;
                return profiler.exportProfilingData();
            });
        },
    };
}
/**
 * Launch a persistent Chromium context with the React DevTools extension.
 * Uses channel: 'chromium' (system Chrome) for headless extension support.
 */
async function launchProfilingContext(userDataDir, overrides = {}) {
    const extensionDir = resolveExtensionDir();
    purgeExtensionServiceWorkerCache(userDataDir);
    const { args: overrideArgs, ignoreHTTPSErrors, channel, ...rest } = overrides;
    const context = await test_1.chromium.launchPersistentContext(userDataDir, {
        ignoreHTTPSErrors: ignoreHTTPSErrors ?? true,
        channel: channel ?? 'chromium',
        args: [...exports.RECOMMENDED_PROFILING_ARGS, ...getExtensionArgs(extensionDir), ...(overrideArgs ?? [])],
        ...rest,
    });
    return context;
}
