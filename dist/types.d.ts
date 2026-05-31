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
    updaters: Array<{
        id: number;
        displayName: string | null;
    }> | null;
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
    stop(): Promise<ProfileExport | null>;
    waitForStable(): Promise<void>;
    isReady(): Promise<boolean>;
    exportProfile(): Promise<ProfileExport | null>;
}
