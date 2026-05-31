import fs from 'fs';
import path from 'path';
import {BrowserContext, chromium, Page} from '@playwright/test';
import {ProfileExport, ProfilerConfig, ReactProfiler, StartProfilingOptions} from './types';

type LaunchPersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/**
 * Chrome flags required for accurate profiling.
 *
 * Without these, headless Chrome throttles timers and background work in the
 * renderer when the window is not focused. That distorts wall-clock measurements
 * and changes React's scheduling behavior.
 */
export const RECOMMENDED_PROFILING_ARGS: readonly string[] = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
];

const DEFAULT_CONFIG: Required<ProfilerConfig> = {
    stableThresholdMs: 2000,
    maxWaitMs: 30000,
    recordChangeDescriptions: false,
};

/**
 * Resolve the path to the React DevTools extension directory.
 */
export function resolveExtensionDir(): string {
    const localExt = path.resolve(__dirname, '..', 'devtools-extension');
    if (fs.existsSync(path.join(localExt, 'manifest.json'))) {
        return localExt;
    }

    throw new Error('React DevTools extension not found.\nRun: npm run build-devtools');
}

function getExtensionArgs(extensionDir: string): string[] {
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
function purgeExtensionServiceWorkerCache(userDataDir: string): void {
    if (!userDataDir) {
        // Empty userDataDir => Playwright uses a throwaway temp profile that
        // never persists a cache, so there is nothing to purge.
        return;
    }
    const swRoots = [path.join(userDataDir, 'Default', 'Service Worker'), path.join(userDataDir, 'Service Worker')];
    for (const root of swRoots) {
        for (const sub of ['ScriptCache', 'Database']) {
            try {
                fs.rmSync(path.join(root, sub), {recursive: true, force: true});
            } catch {
                // Best-effort: an absent or locked cache is fine — the worker re-registers regardless.
            }
        }
    }
}

async function waitForProfilerReady(page: Page, timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(async () => {
            const profiler = (window as any).__REACT_PROFILER__;
            if (!profiler) return false;
            return profiler.isReady();
        });
        if (ready) return true;
        await page.waitForTimeout(200);
    }
    return false;
}

export function createProfiler(page: Page, config?: ProfilerConfig): ReactProfiler {
    const cfg = {...DEFAULT_CONFIG, ...config};
    let stableCallId = 0;

    return {
        async start(options: StartProfilingOptions = {}): Promise<void> {
            const ready = await waitForProfilerReady(page);
            if (!ready) throw new Error('React DevTools profiler not ready — no renderer found');

            const startOptions: Required<StartProfilingOptions> = {
                recordChangeDescriptions: options.recordChangeDescriptions ?? cfg.recordChangeDescriptions,
            };
            await page.evaluate(async (opts) => {
                await (window as any).__REACT_PROFILER__.startProfiling(opts);
            }, startOptions);
        },

        async reloadAndProfile(options: StartProfilingOptions = {}): Promise<void> {
            const recordChangeDescriptions = options.recordChangeDescriptions ?? cfg.recordChangeDescriptions;

            // Persist the reload-and-profile request in sessionStorage (same keys
            // as real DevTools). It survives the reload and is read by backend.js
            // at document_start, so profiling starts before React mounts.
            await page.evaluate((opts) => {
                sessionStorage.setItem('React::DevTools::reloadAndProfile', 'true');
                sessionStorage.setItem('React::DevTools::recordChangeDescriptions', opts.recordChangeDescriptions ? 'true' : 'false');
                sessionStorage.setItem('React::DevTools::recordTimeline', 'false');
            }, {recordChangeDescriptions});

            await page.reload({waitUntil: 'domcontentloaded', timeout: cfg.maxWaitMs});

            // store.roots stays empty while profiling (operations are buffered and
            // only flushed on stop), so isReady() — which checks store.roots — is
            // useless here. Instead confirm the page-world hook has an attached
            // renderer (the mount is being recorded)...
            await page.waitForFunction(
                () => {
                    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
                    return Boolean(hook?.renderers && hook.renderers.size > 0);
                },
                undefined,
                {timeout: cfg.maxWaitMs},
            );

            // ...then confirm the off-thread ProfilerStore has entered profiling
            // state, so a subsequent stop() yields data. Each poll is bounded so a
            // not-yet-connected service worker can't hang the evaluate.
            const deadline = Date.now() + cfg.maxWaitMs;
            while (Date.now() < deadline) {
                const profiling = await page.evaluate(async () => {
                    const profiler = (window as any).__REACT_PROFILER__;
                    if (!profiler) return false;
                    return Promise.race([profiler.isProfiling(), new Promise((resolve) => setTimeout(() => resolve(false), 500))]);
                });
                if (profiling) return;
                await page.waitForTimeout(200);
            }
            throw new Error('reloadAndProfile: profiling did not activate after reload (service worker not connected?)');
        },

        async stop(): Promise<ProfileExport | null> {
            return page.evaluate(async () => {
                const profiler = (window as any).__REACT_PROFILER__;
                if (!profiler) return null;
                await profiler.stopProfiling();
                return profiler.exportProfilingData();
            });
        },

        async waitForStable(): Promise<void> {
            const cbName = `__profilerStableCb_${++stableCallId}`;

            return new Promise<void>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout>;
                let resolved = false;

                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(deadlineTimer);
                    clearTimeout(timer);
                    page.evaluate(() => {
                        const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
                        if (hook?.__restoreOnCommitFiberRoot__) {
                            hook.__restoreOnCommitFiberRoot__();
                            delete hook.__restoreOnCommitFiberRoot__;
                        }
                    }).catch(() => {});
                    resolve();
                };

                const deadlineTimer = setTimeout(done, cfg.maxWaitMs);

                const onCommit = () => {
                    clearTimeout(timer);
                    timer = setTimeout(done, cfg.stableThresholdMs);
                };

                page.exposeFunction(cbName, onCommit)
                    .then(() =>
                        page.evaluate((name) => {
                            const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
                            if (!hook) return;
                            const origFn = hook.onCommitFiberRoot;
                            hook.onCommitFiberRoot = function (...args: any[]) {
                                if (origFn) origFn.apply(hook, args);
                                (window as any)[name]();
                            };
                            hook.__restoreOnCommitFiberRoot__ = () => {
                                hook.onCommitFiberRoot = origFn;
                            };
                        }, cbName),
                    )
                    .then(() => {
                        timer = setTimeout(done, cfg.stableThresholdMs);
                    })
                    .catch(reject);
            });
        },

        async isReady(): Promise<boolean> {
            return page.evaluate(async () => {
                const profiler = (window as any).__REACT_PROFILER__;
                if (!profiler) return false;
                return profiler.isReady();
            });
        },

        async exportProfile(): Promise<ProfileExport | null> {
            return page.evaluate(async () => {
                const profiler = (window as any).__REACT_PROFILER__;
                if (!profiler) return null;
                return profiler.exportProfilingData();
            });
        },
    };
}

export type LaunchProfilingContextOptions = LaunchPersistentContextOptions;

/**
 * Launch a persistent Chromium context with the React DevTools extension.
 * Uses channel: 'chromium' (system Chrome) for headless extension support.
 */
export async function launchProfilingContext(userDataDir: string, overrides: LaunchProfilingContextOptions = {}): Promise<BrowserContext> {
    const extensionDir = resolveExtensionDir();
    purgeExtensionServiceWorkerCache(userDataDir);
    const {args: overrideArgs, ignoreHTTPSErrors, channel, ...rest} = overrides;
    const context = await chromium.launchPersistentContext(userDataDir, {
        ignoreHTTPSErrors: ignoreHTTPSErrors ?? true,
        channel: channel ?? 'chromium',
        args: [...RECOMMENDED_PROFILING_ARGS, ...getExtensionArgs(extensionDir), ...(overrideArgs ?? [])],
        ...rest,
    });

    return context;
}
