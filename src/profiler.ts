import fs from 'fs';
import path from 'path';
import {BrowserContext, chromium, Page} from '@playwright/test';
import {ProfileExport, ProfilerConfig, ReactProfiler} from './types';

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
    resultsDir: './results',
    stableThresholdMs: 2000,
    pollIntervalMs: 100,
    maxWaitMs: 30000,
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
        async start(): Promise<void> {
            const ready = await waitForProfilerReady(page);
            if (!ready) throw new Error('React DevTools profiler not ready — no renderer found');

            await page.evaluate(async () => {
                await (window as any).__REACT_PROFILER__.startProfiling();
            });
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
    const {args: overrideArgs, ignoreHTTPSErrors, channel, ...rest} = overrides;
    const context = await chromium.launchPersistentContext(userDataDir, {
        ignoreHTTPSErrors: ignoreHTTPSErrors ?? true,
        channel: channel ?? 'chromium',
        args: [...RECOMMENDED_PROFILING_ARGS, ...getExtensionArgs(extensionDir), ...(overrideArgs ?? [])],
        ...rest,
    });

    return context;
}
