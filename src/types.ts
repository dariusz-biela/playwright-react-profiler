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

export interface RootProfileData {
    commitData: CommitData[];
    displayName: string;
    initialTreeBaseDurations: Array<[number, number]>;
    operations: Array<Array<number>>;
    rootID: number;
    snapshots: any[];
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
    /** Directory to store profiling results */
    resultsDir?: string;
    /** How long to wait with no new operations before considering render stable (ms) */
    stableThresholdMs?: number;
    /** How often to poll for stability (ms) */
    pollIntervalMs?: number;
    /** Maximum wait time for render stability (ms) */
    maxWaitMs?: number;
    /** Record change descriptions in profiling data */
    recordChangeDescriptions?: boolean;
}

export interface ReactProfiler {
    start(): Promise<void>;
    stop(): Promise<ProfileExport | null>;
    waitForStable(): Promise<void>;
    isReady(): Promise<boolean>;
    exportProfile(): Promise<ProfileExport | null>;
}
