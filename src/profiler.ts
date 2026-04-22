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
 * and changes React's scheduling behavior — the profile you capture no longer
 * reflects what a user would experience.
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
    recordChangeDescriptions: true,
};

/**
 * Resolve the path to the React DevTools extension directory.
 *
 * The extension is loaded via Chrome's `--load-extension` flag and contains:
 *   - installHook.js — installs __REACT_DEVTOOLS_GLOBAL_HOOK__ before React loads
 *   - react_devtools_backend_compact.js — registers the DevTools backend
 *   - profiler-bridge.js — auto-activates backend and exposes profiling API
 */
export function resolveExtensionDir(): string {
    const localExt = path.resolve(__dirname, '..', 'devtools-extension');
    if (fs.existsSync(path.join(localExt, 'manifest.json'))) {
        return localExt;
    }

    throw new Error(
        'React DevTools extension not found.\n' +
            'Run: npm run build-devtools\n' +
            'Or place extension files in devtools-extension/',
    );
}

function getExtensionArgs(extensionDir: string): string[] {
    return [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
}

async function waitForProfilerReady(page: Page, timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(() => {
            const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook || !hook.__profilerAgent__) return false;
            return Object.keys(hook.__profilerAgent__.rendererInterfaces).length > 0;
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

            await page.evaluate((recordChanges) => {
                const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
                const agent = hook.__profilerAgent__;
                for (const rendererID in agent.rendererInterfaces) {
                    agent.rendererInterfaces[rendererID].startProfiling(recordChanges, false);
                }
            }, cfg.recordChangeDescriptions);
        },

        async stop(): Promise<ProfileExport | null> {
            return page.evaluate(() => {
                const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
                const agent = hook?.__profilerAgent__;
                if (!agent) return null;

                const dataForRoots: any[] = [];
                for (const rendererID in agent.rendererInterfaces) {
                    const renderer = agent.rendererInterfaces[rendererID];
                    renderer.stopProfiling();
                    let profilingData: any;
                    try {
                        profilingData = renderer.getProfilingData();
                    } catch {
                        continue;
                    }
                    for (const rootData of profilingData.dataForRoots) {
                        dataForRoots.push({
                            commitData: rootData.commitData,
                            displayName: rootData.displayName,
                            initialTreeBaseDurations: rootData.initialTreeBaseDurations,
                            operations: rootData.operations ?? [],
                            rootID: rootData.rootID,
                            snapshots: [],
                        });
                    }
                }
                return {version: 5 as const, dataForRoots, timelineData: []};
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
            return page.evaluate(() => {
                const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
                if (!hook || !hook.__profilerAgent__) return false;
                return Object.keys(hook.__profilerAgent__.rendererInterfaces).length > 0;
            });
        },

        async exportProfile(): Promise<ProfileExport | null> {
            return page.evaluate(() => {
                const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
                const agent = hook?.__profilerAgent__;
                if (!agent) return null;

                const dataForRoots: any[] = [];
                for (const rendererID in agent.rendererInterfaces) {
                    const renderer = agent.rendererInterfaces[rendererID];
                    let profilingData: any;
                    try {
                        profilingData = renderer.getProfilingData();
                    } catch {
                        continue;
                    }
                    for (const rootData of profilingData.dataForRoots) {
                        dataForRoots.push({
                            commitData: rootData.commitData,
                            displayName: rootData.displayName,
                            initialTreeBaseDurations: rootData.initialTreeBaseDurations,
                            operations: rootData.operations ?? [],
                            rootID: rootData.rootID,
                            snapshots: [],
                        });
                    }
                }
                return {version: 5 as const, dataForRoots, timelineData: []};
            });
        },
    };
}

export type LaunchProfilingContextOptions = LaunchPersistentContextOptions;

/**
 * Launch a persistent Chromium context wired for React profiling.
 *
 * Loads the React DevTools extension via Chrome's --load-extension flag,
 * which runs hook installation and backend activation as content scripts
 * (off the page's main JS thread for setup, minimal main-thread footprint).
 *
 * Also applies RECOMMENDED_PROFILING_ARGS to prevent timer throttling.
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