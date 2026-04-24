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
}

export interface ReactProfiler {
    start(): Promise<void>;
    stop(): Promise<ProfileExport | null>;
    waitForStable(): Promise<void>;
    isReady(): Promise<boolean>;
    exportProfile(): Promise<ProfileExport | null>;
}
