export interface FiberDuration {
    fiberId: number;
    name: string;
    selfDuration: number;
}

export interface CommitData {
    changeDescriptions: Map<number, any> | null;
    duration: number;
    effectDuration: number | null;
    fiberActualDurations: Array<[number, number]>;
    fiberSelfDurations: Array<[number, number]>;
    passiveEffectDuration: number | null;
    priorityLevel: string | null;
    timestamp: number;
    updaters: Array<{id: number; displayName: string | null}> | null;
}

export interface SnapshotNode {
    id: number;
    children: number[];
    displayName: string | null;
    hocDisplayNames: string[] | null;
    key: string | number | null;
    type: number;
    compiledWithForget: boolean;
}

export interface RootProfileData {
    commitData: CommitData[];
    displayName: string;
    initialTreeBaseDurations: Array<[number, number]>;
    operations: Array<Array<number>>;
    rootID: number;
    snapshots: Array<[number, SnapshotNode]>;
}

export interface ProfileExport {
    version: 5;
    dataForRoots: RootProfileData[];
    timelineData: any[];
    /**
     * Non-standard sidecar (not part of the React DevTools export format, and
     * ignored by DevTools import). Every element seen during profiling, keyed by
     * fiber id, including components that mounted and unmounted mid-session and
     * are therefore absent from the baseline `snapshots`. Lets offline analysis
     * resolve names without replaying operations.
     */
    shadowElements?: Array<[number, {displayName: string | null; type: number}]>;
}

export interface ProfileResult {
    profile: ProfileExport | null;
    wallClockMs: number;
    commitCount: number;
    totalRenderDuration: number;
}

export interface ProfilerConfig {
    stableThresholdMs?: number;
    maxWaitMs?: number;
    /**
     * Default for {@link StartProfilingOptions.recordChangeDescriptions} on every
     * `profiler.start()` from this instance. A per-call `start({...})` overrides it.
     */
    recordChangeDescriptions?: boolean;
}

export interface StartProfilingOptions {
    /**
     * Record why each component rendered — the "Record why each component
     * rendered while profiling" toggle in React DevTools. Populates each
     * commit's `changeDescriptions`.
     *
     * Defaults to `false` to keep profiling overhead minimal. It is safe to
     * leave off for timing work: recorded render durations are unaffected
     * (change-description computation runs outside React's measured render
     * phase, so the commit structure is identical with it on or off). Turn it
     * on when you need to know *why* a component re-rendered (e.g. which prop,
     * state, or hook changed).
     */
    recordChangeDescriptions?: boolean;
}

export interface ReactProfiler {
    start(options?: StartProfilingOptions): Promise<void>;
    /**
     * Reload the page and start profiling before React mounts, capturing the
     * initial render — the DevTools "Reload and profile" button. Use this
     * instead of {@link ReactProfiler.start} to measure app startup, where the
     * mount has already finished by the time `start()` could run.
     *
     * Resolves once the reloaded page has a React renderer attached under active
     * profiling. Follow with {@link ReactProfiler.waitForStable} and
     * {@link ReactProfiler.stop} exactly as for a normal profiling run.
     */
    reloadAndProfile(options?: StartProfilingOptions): Promise<void>;
    stop(): Promise<ProfileExport | null>;
    waitForStable(): Promise<void>;
    isReady(): Promise<boolean>;
    exportProfile(): Promise<ProfileExport | null>;
}
