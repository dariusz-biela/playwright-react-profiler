/**
 * Vendored from react-devtools-shared/src/devtools/views/Profiler/utils.js.
 *
 * This is the exact function behind React DevTools' "Export" button. It is NOT
 * re-exported by the published react-devtools-inline package (it lives in an
 * internal Profiler view module), so we vendor it verbatim.
 *
 * It is a pure transform: ProfilingDataFrontend (in-memory, with Maps) ->
 * ProfilingDataExport (serializable, Maps flattened to entry arrays). The shape
 * and the version byte (PROFILER_EXPORT_VERSION = 5) are identical in
 * react-devtools-core@7.0.1 / react-devtools-inline@7.0.1, so the output imports
 * into a matching React DevTools 7.0.x extension with zero mapping.
 *
 * Pinned to: react-devtools 7.0.1 (PROFILER_EXPORT_VERSION = 5).
 */

const PROFILER_EXPORT_VERSION = 5;

export function prepareProfilingDataExport(profilingDataFrontend) {
  const timelineData = profilingDataFrontend.timelineData.map(
    ({
      batchUIDToMeasuresMap,
      componentMeasures,
      duration,
      flamechart,
      internalModuleSourceToRanges,
      laneToLabelMap,
      laneToReactMeasureMap,
      nativeEvents,
      networkMeasures,
      otherUserTimingMarks,
      reactVersion,
      schedulingEvents,
      snapshots,
      snapshotHeight,
      startTime,
      suspenseEvents,
      thrownErrors,
    }) => ({
      // Most of the data is safe to serialize as-is,
      // but we need to convert the Maps to nested Arrays.
      batchUIDToMeasuresKeyValueArray: Array.from(batchUIDToMeasuresMap.entries()),
      componentMeasures,
      duration,
      flamechart,
      internalModuleSourceToRanges: Array.from(internalModuleSourceToRanges.entries()),
      laneToLabelKeyValueArray: Array.from(laneToLabelMap.entries()),
      laneToReactMeasureKeyValueArray: Array.from(laneToReactMeasureMap.entries()),
      nativeEvents,
      networkMeasures,
      otherUserTimingMarks,
      reactVersion,
      schedulingEvents,
      snapshots,
      snapshotHeight,
      startTime,
      suspenseEvents,
      thrownErrors,
    }),
  );

  const dataForRoots = [];
  profilingDataFrontend.dataForRoots.forEach(
    ({commitData, displayName, initialTreeBaseDurations, operations, rootID, snapshots}) => {
      dataForRoots.push({
        commitData: commitData.map(
          ({
            changeDescriptions,
            duration,
            effectDuration,
            fiberActualDurations,
            fiberSelfDurations,
            passiveEffectDuration,
            priorityLevel,
            timestamp,
            updaters,
          }) => ({
            changeDescriptions: changeDescriptions != null ? Array.from(changeDescriptions.entries()) : null,
            duration,
            effectDuration,
            fiberActualDurations: Array.from(fiberActualDurations.entries()),
            fiberSelfDurations: Array.from(fiberSelfDurations.entries()),
            passiveEffectDuration,
            priorityLevel,
            timestamp,
            updaters,
          }),
        ),
        displayName,
        initialTreeBaseDurations: Array.from(initialTreeBaseDurations.entries()),
        operations,
        rootID,
        snapshots: Array.from(snapshots.entries()),
      });
    },
  );

  return {
    version: PROFILER_EXPORT_VERSION,
    dataForRoots,
    timelineData,
  };
}
