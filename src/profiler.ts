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
 *
 * The default `test` fixture applies these automatically via `launchOptions`.
 * For custom launch paths (e.g. `chromium.launchPersistentContext`), spread
 * them into your `args` — or use `launchProfilingContext`, which does it for you.
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

export function resolveDevToolsBuildDir(): string {
    // Check local devtools-build first
    const localBuild = path.resolve(__dirname, '..', 'devtools-build');
    if (fs.existsSync(path.join(localBuild, 'installHook.js'))) {
        return localBuild;
    }

    // Check react-source submodule build output
    const submoduleBuild = path.resolve(
        __dirname,
        '..',
        'react-source',
        'packages',
        'react-devtools-extensions',
        'chrome',
        'build',
        'unpacked',
        'build'
    );
    if (fs.existsSync(path.join(submoduleBuild, 'installHook.js'))) {
        return submoduleBuild;
    }

    throw new Error(
        'React DevTools build not found. Run: npm run build-devtools\n' +
            'Or place installHook.js + react_devtools_backend_compact.js in devtools-build/'
    );
}

export function getInstallHookCode(): string {
    const buildDir = resolveDevToolsBuildDir();
    return fs.readFileSync(path.join(buildDir, 'installHook.js'), 'utf-8');
}

function getBackendCode(): string {
    const buildDir = resolveDevToolsBuildDir();
    return fs.readFileSync(path.join(buildDir, 'react_devtools_backend_compact.js'), 'utf-8');
}

async function activateBackend(page: Page): Promise<boolean> {
    const backendCode = getBackendCode();
    await page.evaluate(backendCode);

    return page.evaluate(() => {
        const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return false;

        const backend = hook.backends.get('compact');
        if (!backend) return false;

        const {Agent, Bridge, initBackend} = backend;
        const operationsLog: Array<Array<number>> = [];

        const bridge = new Bridge({
            listen() {
                return () => {};
            },
            send(event: string, payload: any) {
                if (event === 'operations') {
                    operationsLog.push(Array.from(payload));
                }
            },
        });

        const agent = new Agent(bridge, false, () => {});
        initBackend(hook, agent, window, false);

        (window as any).__PROFILER_AGENT__ = {
            agent,
            operationsLog,

            startProfiling(recordChangeDescriptions = true) {
                operationsLog.length = 0;
                for (const rendererID in agent.rendererInterfaces) {
                    const renderer = agent.rendererInterfaces[rendererID];
                    renderer.startProfiling(recordChangeDescriptions, false);
                }
            },

            stopProfiling() {
                for (const rendererID in agent.rendererInterfaces) {
                    const renderer = agent.rendererInterfaces[rendererID];
                    renderer.stopProfiling();
                }
            },

            getRendererCount() {
                return Object.keys(agent.rendererInterfaces).length;
            },

            exportProfile() {
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
                            operations: operationsLog.slice(),
                            rootID: rootData.rootID,
                            snapshots: [],
                        });
                    }
                }

                return {version: 5, dataForRoots, timelineData: []};
            },
        };

        return true;
    });
}

async function waitForBackendReady(page: Page, timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(() => {
            const ctrl = (window as any).__PROFILER_AGENT__;
            return ctrl && ctrl.getRendererCount() > 0;
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
            // Always check — page context resets after navigation
            const agentExists = await page.evaluate(() => !!(window as any).__PROFILER_AGENT__);
            if (!agentExists) {
                const ok = await activateBackend(page);
                if (!ok) throw new Error('Failed to activate React DevTools backend');
                const ready = await waitForBackendReady(page);
                if (!ready) throw new Error('No React renderer found');
            }

            await page.evaluate((recordChanges) => {
                (window as any).__PROFILER_AGENT__.startProfiling(recordChanges);
            }, cfg.recordChangeDescriptions);
        },

        async stop(): Promise<ProfileExport | null> {
            await page.evaluate(() => {
                (window as any).__PROFILER_AGENT__.stopProfiling();
            });
            return this.exportProfile();
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
                        const ctrl = (window as any).__PROFILER_AGENT__;
                        ctrl?.__restoreOpsLog?.();
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
                            const ctrl = (window as any).__PROFILER_AGENT__;
                            if (!ctrl) return;
                            const origPush = ctrl.operationsLog.push.bind(ctrl.operationsLog);
                            ctrl.operationsLog.push = (...args: any[]) => {
                                const result = origPush(...args);
                                (window as any)[name]();
                                return result;
                            };
                            ctrl.__restoreOpsLog = () => {
                                ctrl.operationsLog.push = origPush;
                            };
                        }, cbName),
                    )
                    .then(() => {
                        // Start initial stability timer — if no commits arrive, resolve after threshold
                        timer = setTimeout(done, cfg.stableThresholdMs);
                    })
                    .catch(reject);
            });
        },

        async isReady(): Promise<boolean> {
            return page.evaluate(() => {
                const ctrl = (window as any).__PROFILER_AGENT__;
                return !!(ctrl && ctrl.getRendererCount() > 0);
            });
        },

        async exportProfile(): Promise<ProfileExport | null> {
            return page.evaluate(() => {
                const ctrl = (window as any).__PROFILER_AGENT__;
                if (!ctrl) return null;
                return ctrl.exportProfile();
            });
        },
    };
}

export type LaunchProfilingContextOptions = LaunchPersistentContextOptions;

/**
 * Launch a persistent Chromium context wired for React profiling.
 *
 * Convenience wrapper around `chromium.launchPersistentContext` that:
 *   1. Merges `RECOMMENDED_PROFILING_ARGS` into `args` (required for accurate timings).
 *   2. Defaults `ignoreHTTPSErrors: true` (dev servers commonly use self-signed certs).
 *   3. Installs the React DevTools hook via `addInitScript` before any page loads.
 *
 * Use this when you need a persistent browser profile (saved auth, cookies, etc.).
 * For standard test runs without persistence, the default `test` fixture already
 * applies the recommended args automatically — no helper needed.
 */
export async function launchProfilingContext(userDataDir: string, overrides: LaunchProfilingContextOptions = {}): Promise<BrowserContext> {
    const {args: overrideArgs, ignoreHTTPSErrors, ...rest} = overrides;
    const context = await chromium.launchPersistentContext(userDataDir, {
        ignoreHTTPSErrors: ignoreHTTPSErrors ?? true,
        args: [...RECOMMENDED_PROFILING_ARGS, ...(overrideArgs ?? [])],
        ...rest,
    });

    const hookCode = getInstallHookCode();
    await context.addInitScript(hookCode);

    return context;
}
