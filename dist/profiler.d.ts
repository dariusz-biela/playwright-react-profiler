import { BrowserContext, chromium, Page } from '@playwright/test';
import { ProfilerConfig, ReactProfiler } from './types';
type LaunchPersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
/**
 * Chrome flags required for accurate profiling.
 *
 * Without these, headless Chrome throttles timers and background work in the
 * renderer when the window is not focused. That distorts wall-clock measurements
 * and changes React's scheduling behavior.
 */
export declare const RECOMMENDED_PROFILING_ARGS: readonly string[];
/**
 * Resolve the path to the React DevTools extension directory.
 */
export declare function resolveExtensionDir(): string;
export declare function getExtensionArgs(extensionDir: string): string[];
export declare function createProfiler(page: Page, config?: ProfilerConfig): ReactProfiler;
export type LaunchProfilingContextOptions = LaunchPersistentContextOptions;
/**
 * Launch a persistent Chromium context with the React DevTools extension.
 * Uses channel: 'chromium' (system Chrome) for headless extension support.
 */
export declare function launchProfilingContext(userDataDir: string, overrides?: LaunchProfilingContextOptions): Promise<BrowserContext>;
export {};
