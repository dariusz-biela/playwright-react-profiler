import { ProfileExport } from './types';
interface ComponentStats {
    name: string;
    medianSelfDuration: number;
    totalSelfDuration: number;
    renderCount: number;
}
interface AnalysisResult {
    commitCount: number;
    totalRenderDuration: number;
    wallClockMs?: number;
    topComponents: ComponentStats[];
}
export declare function analyzeResults(profiles: ProfileExport[], wallClockTimes?: number[]): AnalysisResult;
export declare function formatAnalysis(analysis: AnalysisResult): string;
export {};
