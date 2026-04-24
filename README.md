# playwright-react-profiler

Playwright extension for automated React DevTools profiling. Captures React render profiles programmatically using the real DevTools pipeline — headless or headed. Outputs profiles importable directly into React DevTools.

## Architecture

Uses the same multi-process architecture as the real React DevTools extension:

```
MAIN world (page thread):     installHook.js + backend.js
                               Agent, initBackend, Bridge via postMessage
ISOLATED world (page thread):  proxy.js
                               Relays postMessage <-> chrome.runtime port
Service Worker (off thread):   frontend.js
                               Store, ProfilerStore, prepareProfilingDataExport
```

Key benefits:
- **Real DevTools pipeline** — Store + ProfilerStore produce identical export format as DevTools "Export" button
- **Off-thread processing** — Store operations processing runs in a service worker, not on the page's main thread
- **Shadow element map** — tracks all fiber elements (including unmounted) for complete name resolution
- **Component filters** — host components (div, span, svg) filtered out, matching DevTools defaults

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/TODO/playwright-react-profiler.git
cd playwright-react-profiler
npm install
```

### 2. Build the library

```bash
npm run build
```

The DevTools extension (`devtools-extension/`) ships pre-built — no extra setup needed.

> **Rebuilding the extension (development only):**
> If you need to modify the extension source (`src/backend.js`, `src/frontend.js`) or upgrade to a newer React DevTools version:
> ```bash
> git clone --depth 1 https://github.com/facebook/react.git react-source
> npm run build-devtools
> ```
> This rebuilds `installHook.js`, `backend.js`, and `frontend.js` from `react-source` into `devtools-extension/`.

### 3. Use in your project

```json
{
  "devDependencies": {
    "playwright-react-profiler": "file:../playwright-react-profiler"
  }
}
```

### 4. Write a profiling test

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

### 5. Run

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
        pollIntervalMs: 100,     // poll frequency
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

1. **Extension loading** — Chrome loads the DevTools extension via `--load-extension`. At `document_start`, `installHook.js` installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` and `backend.js` creates an Agent connected to the hook.

2. **Bridge transport** — `backend.js` (MAIN world) communicates with `frontend.js` (service worker) through `proxy.js` (ISOLATED world). Messages flow via `window.postMessage` -> `chrome.runtime` port.

3. **Profiling** — When `profiler.start()` is called, the page sends a command through the proxy to the service worker, which tells ProfilerStore to start profiling. The Agent relays profiling status to all React renderers.

4. **Operations buffering** — During profiling, `backend.js` buffers Bridge operations instead of sending them per-commit via postMessage. They are flushed in one burst when profiling stops, before profilingData arrives.

5. **Export** — `prepareProfilingDataExport()` (same function as DevTools "Export" button) produces the final JSON. A shadow element map enriches snapshots with elements that were mounted and unmounted during profiling.

6. **Stability detection** — Monitors `onCommitFiberRoot` hook. When no new commits arrive for `stableThresholdMs`, rendering is considered stable.

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
│   ├── backend.js        # Extension source: MAIN world (Agent, Bridge)
│   └── frontend.js       # Extension source: service worker (Store, ProfilerStore)
├── devtools-extension/   # Pre-built Chrome extension (committed)
│   ├── manifest.json     # Manifest V3 with service worker
│   ├── proxy.js          # ISOLATED world relay (plain JS)
│   ├── installHook.js    # Built from react-source (MIT, Meta)
│   ├── backend.js        # Built from react-source (MIT, Meta)
│   ├── frontend.js       # Built from react-source (MIT, Meta)
│   └── LICENSE           # Meta/React MIT license for built files
├── react-source/         # Git submodule (facebook/react) — dev only
├── scripts/
│   └── build-devtools.sh # Rebuilds extension from react-source
└── dist/                 # Compiled TypeScript output
```

## License

MIT

The pre-built DevTools extension files (`devtools-extension/installHook.js`, `backend.js`, `frontend.js`) contain code from [facebook/react](https://github.com/facebook/react), licensed under MIT by Meta Platforms, Inc. See `devtools-extension/LICENSE` for details.
