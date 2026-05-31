import fs from 'fs';
import path from 'path';
import {ProfileExport} from './types';

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

function median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Map fiber id -> component display name. Names come from the baseline
 * `snapshots` plus the `shadowElements` sidecar, which also covers components
 * that mounted and unmounted mid-profile and are absent from the baseline.
 */
function buildNameMap(profile: ProfileExport): Map<number, string> {
    const names = new Map<number, string>();
    for (const root of profile.dataForRoots) {
        for (const [fiberId, node] of root.snapshots) {
            if (node.displayName) {
                names.set(fiberId, node.displayName);
            }
        }
    }
    for (const [fiberId, element] of profile.shadowElements ?? []) {
        if (element.displayName && !names.has(fiberId)) {
            names.set(fiberId, element.displayName);
        }
    }
    return names;
}

export function analyzeResults(profiles: ProfileExport[], wallClockTimes?: number[]): AnalysisResult {
    const componentDurations = new Map<string, number[]>();
    let totalCommits = 0;
    let totalDuration = 0;

    for (const profile of profiles) {
        const nameMap = buildNameMap(profile);
        for (const root of profile.dataForRoots) {
            totalCommits += root.commitData.length;
            for (const commit of root.commitData) {
                totalDuration += commit.duration;
                for (const [fiberId, selfDuration] of commit.fiberSelfDurations ?? []) {
                    const name = nameMap.get(fiberId) ?? `fiber_${fiberId}`;
                    const list = componentDurations.get(name) ?? [];
                    list.push(selfDuration);
                    componentDurations.set(name, list);
                }
            }
        }
    }

    const topComponents = [...componentDurations.entries()]
        .map(([name, durations]) => ({
            name,
            medianSelfDuration: median(durations),
            totalSelfDuration: durations.reduce((a, b) => a + b, 0),
            renderCount: durations.length,
        }))
        .sort((a, b) => b.totalSelfDuration - a.totalSelfDuration)
        .slice(0, 20);

    return {
        commitCount: totalCommits,
        totalRenderDuration: totalDuration,
        wallClockMs: wallClockTimes ? median(wallClockTimes) : undefined,
        topComponents,
    };
}

export function formatAnalysis(analysis: AnalysisResult): string {
    const lines: string[] = [];

    lines.push(`Commits: ${analysis.commitCount}`);
    lines.push(`Total render duration: ${analysis.totalRenderDuration.toFixed(1)}ms`);
    if (analysis.wallClockMs) {
        lines.push(`Wall clock (median): ${analysis.wallClockMs.toFixed(1)}ms`);
    }

    if (analysis.topComponents.length > 0) {
        lines.push('');
        lines.push('Top components by total self-duration:');
        lines.push(`${'Component'.padEnd(30)} Total(ms)  Median(ms)  Renders`);
        lines.push(`${'-'.repeat(30)} ---------  ----------  -------`);
        for (const c of analysis.topComponents) {
            lines.push(
                `${c.name.padEnd(30)} ${c.totalSelfDuration.toFixed(2).padStart(9)}  ${c.medianSelfDuration.toFixed(2).padStart(10)}  ${String(c.renderCount).padStart(7)}`
            );
        }
    }

    return lines.join('\n');
}

// CLI entry point
if (require.main === module) {
    const inputFile = process.argv[2];
    if (!inputFile) {
        console.error('Usage: ts-node analyze.ts <profile.json>');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
    const profiles: ProfileExport[] = Array.isArray(data) ? data : [data];
    const analysis = analyzeResults(profiles);
    console.log(formatAnalysis(analysis));
}
