# playwright-react-profiler

Playwright extension for automated React DevTools profiling. Captures React render profiles programmatically using the real DevTools pipeline — headless or headed. Outputs profiles importable directly into React DevTools.

## Architecture

Uses the same multi-process architecture as the real React DevTools extension:

```
MAIN world (page thread):     backend.js
                               react-devtools-core: hook + Agent + Bridge via postMessage
ISOLATED world (page thread):  proxy.js
                               Relays postMessage <-> chrome.runtime port
Service Worker (off thread):   frontend.js
                               react-devtools-inline: Store, ProfilerStore + prepareProfilingDataExport
```

The extension is built from the published `react-devtools-core` and `react-devtools-inline` npm packages (pinned to a stable release), so exported profiles import into a same-versioned official React DevTools extension with zero mapping.

Key benefits:
- **Real DevTools pipeline** — Store + ProfilerStore produce identical export format as DevTools "Export" button
- **Off-thread processing** — Store operations processing runs in a service worker, not on the page's main thread
- **Shadow element map** — tracks all fiber elements (including unmounted) for complete name resolution
- **Component filters** — host components (div, span, svg) filtered out, matching DevTools defaults

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/dariusz-biela/playwright-react-profiler.git
cd playwright-react-profiler
npm install
```

Both `dist/` (compiled TypeScript) and `devtools-extension/` (built Chrome extension) ship pre-built — no extra build step needed.

> **Rebuilding from source (development only):**
> - **TypeScript**: `npm run build` recompiles `src/*.ts` into `dist/`.
> - **DevTools extension**: if you modify `src/backend.js` or `src/frontend.js`, or want to upgrade to a newer React DevTools version (bump `react-devtools-core` / `react-devtools-inline` in `package.json`):
>   ```bash
>   npm run build-devtools
>   ```
>   This bundles `backend.js` and `frontend.js` from the npm `react-devtools-*` packages into `devtools-extension/` with esbuild (no submodule, no native React build). To import the resulting profiles into the official extension without errors, that extension must be the **same major/minor version** as the pinned packages.

### 2. Use in your project

```json
{
  "devDependencies": {
    "playwright-react-profiler": "file:../playwright-react-profiler"
  }
}
```

### 3. Write a profiling test

```typescript
import {test, expect} from 'playwright-react-profiler';
import fs from 'fs';

test('profile page load', async ({page, profiler}) => {
    await page.goto('http://localhost:3000');
    await profiler.start();
    await profiler.waitForStable();
    const profile = await profiler.stop();

    expect(profile).not.toBeNull();
    fs.writeFileSync('profile.json', JSON.stringify(profile, null, 2));
});
```

### 4. Run

```bash
# Headless
npx playwright test profile.spec.ts

# Headed (visible browser)
npx playwright test profile.spec.ts --headed
```

## Configuration

### Profiler config via fixture

```typescript
import {test} from 'playwright-react-profiler';

test.use({
    profilerConfig: {
        stableThresholdMs: 2000, // ms with no new commits = stable
        maxWaitMs: 30000,        // max wait before timeout
    },
});
```

## API

### `test` (extended Playwright test)

Extends `@playwright/test` with a `profiler` fixture. Launches a persistent Chromium context with the React DevTools extension loaded automatically.

### `profiler` fixture

| Method | Description |
|--------|-------------|
| `profiler.start()` | Start profiling (waits for React renderer to be ready) |
| `profiler.stop()` | Stop profiling and return profile export |
| `profiler.waitForStable()` | Wait until no new React commits for `stableThresholdMs` |
| `profiler.isReady()` | Check if React renderer is connected |
| `profiler.exportProfile()` | Export current profile without stopping |

### `launchProfilingContext(userDataDir, overrides?)`

Launch a persistent Chromium context with the DevTools extension and profiling flags. Use for setups with saved auth or custom browser configuration.

```typescript
import {launchProfilingContext, createProfiler} from 'playwright-react-profiler';

const context = await launchProfilingContext('./.browser-data', {
    headless: true,
    viewport: {width: 1440, height: 900},
});

const page = context.pages()[0] ?? (await context.newPage());
const profiler = createProfiler(page);
```

### `createProfiler(page, config?)`

Create a profiler instance for manual control outside the fixture system.

### `RECOMMENDED_PROFILING_ARGS`

Chrome flags applied automatically:

```
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
```

Without these, headless Chrome throttles renderer work in unfocused windows, distorting timings and React scheduling.

### `analyzeResults(profiles, wallClockTimes?)`

Analyze an array of profile exports:

```typescript
import {analyzeResults, formatAnalysis} from 'playwright-react-profiler';

const analysis = analyzeResults(profiles);
console.log(formatAnalysis(analysis));
```

## How It Works

1. **Extension loading** — Chrome loads the DevTools extension via `--load-extension`. At `document_start`, `backend.js` calls `react-devtools-core`'s `initialize()` to install `__REACT_DEVTOOLS_GLOBAL_HOOK__` (seeded with the default component filters), then `connectWithCustomMessagingProtocol()` to wire an Agent + Bridge over the postMessage transport.

2. **Bridge transport** — `backend.js` (MAIN world) communicates with `frontend.js` (service worker) through `proxy.js` (ISOLATED world). Messages flow via `window.postMessage` -> `chrome.runtime` port.

3. **Profiling** — When `profiler.start()` is called, the page sends a command through the proxy to the service worker, which tells ProfilerStore to start profiling. The Agent relays profiling status to all React renderers.

4. **Operations buffering** — During profiling, `backend.js` buffers Bridge operations instead of sending them per-commit via postMessage. They are flushed in one burst when profiling stops, before profilingData arrives.

5. **Export** — `prepareProfilingDataExport()` (same function as DevTools "Export" button) produces the final JSON. A shadow element map enriches snapshots with elements that were mounted and unmounted during profiling.

6. **Stability detection** — Monitors `onCommitFiberRoot` hook. When no new commits arrive for `stableThresholdMs`, rendering is considered stable.

## Running Multiple Iterations

There are two ways to run a profiling test multiple times. Each has trade-offs.

### Option A: `--repeat-each` (separate browser per iteration)

Playwright launches a fresh browser context for each repeat. Every iteration goes through full setup: navigation, app hydration, warm-up cycle.

```bash
npx playwright test my-profile-test --repeat-each=20
```

**Pros:**
- More stable and realistic timings — each iteration starts from a clean state
- No accumulated side effects between iterations (memory pressure, state store growth)
- Closer to what a real user experiences on each page visit

**Cons:**
- Significantly slower — browser launch + navigation + warm-up overhead per iteration (e.g. ~9s per iteration vs ~2s)
- Requires shared-folder logic to accumulate results across independent test runs

### Option B: Internal loop (single browser, multiple measurements)

A `for` loop inside one test case. Browser stays open, app stays loaded.

```typescript
for (let i = 1; i <= ITERATIONS; i++) {
    await profiler.start();
    // ... trigger interaction ...
    await profiler.waitForStable();
    const profile = await profiler.stop();
}
```

**Pros:**
- Much faster — no browser/navigation overhead between iterations
- Simpler result collection — all profiles available in one array

**Cons:**
- Later iterations tend to be faster due to V8 JIT compiler optimizations — the JS engine progressively optimizes hot code paths, so iteration 10 may be measurably faster than iteration 1
- Accumulated state (cached data, DOM nodes, memory) can drift from realistic conditions

### Recommendation

Use **`--repeat-each`** when you need accurate absolute numbers (regression detection, before/after comparison). Use **internal loop** when you need fast relative comparison and can tolerate JIT bias (e.g. comparing two code paths in the same run).

## Performance

`recordChangeDescriptions` is intentionally disabled. It causes ~10s overhead on large apps (19k+ fibers) by diffing props/state for every component on each commit. Without it, profiler overhead is ~270ms and commit batching patterns closely match manual DevTools profiling.

## Requirements

- React app running in **development** or **profiling** mode (production builds strip DevTools support)
- Playwright >= 1.30
- Node.js >= 16
- Chrome/Chromium (extensions require `channel: 'chromium'`)

## Project Structure

```
playwright-react-profiler/
├── src/
│   ├── index.ts          # Main exports
│   ├── fixture.ts        # Playwright test fixture
│   ├── profiler.ts       # Core profiling logic
│   ├── analyze.ts        # Profile analysis utilities
│   ├── types.ts          # TypeScript types
│   ├── backend.js        # Extension entry: MAIN world (react-devtools-core)
│   ├── frontend.js       # Extension entry: service worker (react-devtools-inline)
│   └── vendor/
│       └── prepareProfilingDataExport.js  # Vendored export transform (not re-exported by npm)
├── devtools-extension/   # Pre-built Chrome extension (committed)
│   ├── manifest.json     # Manifest V3 with service worker
│   ├── proxy.js          # ISOLATED world relay (plain JS)
│   ├── backend.js        # Bundled from react-devtools-core (MIT, Meta)
│   ├── frontend.js       # Bundled from react-devtools-inline (MIT, Meta)
│   └── LICENSE           # Meta/React MIT license for bundled files
├── scripts/
│   └── build-devtools.mjs # Bundles the extension from npm react-devtools-* via esbuild
└── dist/                 # Compiled TypeScript output (committed)
```

## License

MIT

The pre-built DevTools extension files (`devtools-extension/backend.js`, `frontend.js`) are bundled from the [react-devtools-core](https://www.npmjs.com/package/react-devtools-core) and [react-devtools-inline](https://www.npmjs.com/package/react-devtools-inline) npm packages (from [facebook/react](https://github.com/facebook/react)), licensed under MIT by Meta Platforms, Inc. See `devtools-extension/LICENSE` for details.
