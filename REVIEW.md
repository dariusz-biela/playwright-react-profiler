# Code Review: playwright-react-profiler

## Overall Assessment

Architecture is solid — 3-layer design (backend -> proxy -> frontend), clean TS types, comprehensive README, cohesive API with both fixture and manual modes. One critical bug found, several vibe coding leftovers.

## Critical

### 1. Bug: `frontend.js:153-158` — forEach index used as fiber ID

```javascript
commit.fiberActualDurations.forEach((dur, fiberId) =>
    allFiberIds.add(fiberId),
);
```

`fiberActualDurations` is `Array<[number, number]>` (pairs of `[fiberId, duration]`). `forEach` callback gives `(element, index)` — so `fiberId` here is the **array index**, not the actual fiber ID. Snapshot enrichment adds elements by wrong IDs.

**Fix:**
```javascript
commit.fiberActualDurations.forEach(([fiberId]) => allFiberIds.add(fiberId));
```

Same issue for `fiberSelfDurations` on line 157.

### 2. `analyze.ts:43-46` — fiber IDs instead of component names

```typescript
const key = `fiber_${_fiberId}`;
```

Comment says "We don't have name mapping in raw export" — but `ProfileExport` includes `snapshots` with `displayName`. The shadow element map in `frontend.js` enriches snapshots for exactly this purpose. This looks like an early version that was never updated after snapshot enrichment was added. Output shows `fiber_123` instead of `MyComponent`, making analysis results nearly useless.

**Fix:** Look up `displayName` from `profile.dataForRoots[].snapshots` by fiber ID.

## Medium

### 3. `analyze.ts:26` — unused `percentile()` function

Defined but never called anywhere. Leftover from refactor or "just in case" addition.

### 4. Duplicated `getExtensionArgs()` function

Identical implementation exists in both `fixture.ts:10` and `profiler.ts:38`. Should be defined once in `profiler.ts` and imported in `fixture.ts`.

### 5. `package.json:36` + `README.md:30` — placeholder `TODO` URL

```json
"url": "https://github.com/TODO/playwright-react-profiler"
```

Typical vibe coding artifact — generated and never updated.

## Low

### 6. Files tracked in git but listed in `.gitignore`

These were likely added before the ignore rules:
- `.DS_Store`
- `test-results/.last-run.json` (contains `"status": "failed"`)
- `dist/` directory (compiled output)

**Fix:** `git rm --cached` for all of them.

### 7. `fixture.ts:37` — empty destructuring

```typescript
context: async ({}, use) => {
```

Works but looks odd. Minor style inconsistency.

## Summary Table

| # | File | Severity | Type |
|---|------|----------|------|
| 1 | `frontend.js:153-158` | Critical | Bug — wrong fiber IDs in snapshot enrichment |
| 2 | `analyze.ts:43-46` | Critical | Missing feature — no name resolution from snapshots |
| 3 | `analyze.ts:26` | Medium | Dead code — unused `percentile()` |
| 4 | `fixture.ts` + `profiler.ts` | Medium | Duplication — `getExtensionArgs()` |
| 5 | `package.json` + `README.md` | Medium | Placeholder — `TODO` in repo URL |
| 6 | `.DS_Store`, `test-results/`, `dist/` | Low | Git hygiene — tracked but gitignored |
| 7 | `fixture.ts:37` | Low | Style — empty destructuring |
