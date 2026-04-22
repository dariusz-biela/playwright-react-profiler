# playwright-react-profiler

Playwright extension for automated React DevTools profiling. Captures React render profiles programmatically — headless or headed — in any React project. Outputs profiles importable directly into React DevTools.

## Features

- **Zero app code changes** — injects React DevTools hook via Playwright's `addInitScript`
- **Auto-injection** — default `test` fixture wires the hook into every browser context automatically
- **Accurate timings** — required Chrome profiling flags (`--disable-*-throttling`) applied automatically
- **Headless & headed** — works in both modes, no Chrome extension needed
- **Playwright fixture** — drop-in `test` extension with `profiler` fixture
- **DevTools-compatible output** — exported profiles open directly in React DevTools Profiler tab
- **Configurable stability detection** — waits for React renders to settle before stopping
- **Any React project** — no framework-specific dependencies

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/user/playwright-react-profiler.git
cd playwright-react-profiler
git submodule update --init --recursive
npm install
```

### 2. Build React DevTools (one-time)

```bash
npm run build-devtools
```

This builds `installHook.js` and `react_devtools_backend_compact.js` from the `react-source` submodule into `devtools-build/`.

Alternatively, place pre-built files manually:

```bash
mkdir -p devtools-build
cp /path/to/installHook.js devtools-build/
cp /path/to/react_devtools_backend_compact.js devtools-build/
```

### 3. Build the library

```bash
npm run build
```

### 4. Use in your project

From your project, reference the cloned repo as a local dependency:

```bash
# In your project's package.json
npm install --save-dev /path/to/playwright-react-profiler
```

Or use a relative `file:` path in `package.json`:

```json
{
  "devDependencies": {
    "playwright-react-profiler": "file:../playwright-react-profiler"
  }
}
```

### 5. Write a profiling test

```typescript
// profile.spec.ts
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

### 6. Run

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
        stableThresholdMs: 2000, // ms with no new operations = stable
        pollIntervalMs: 100,     // poll frequency
        maxWaitMs: 30000,        // max wait before timeout
        recordChangeDescriptions: true,
    },
});
```

### Playwright config

```typescript
// playwright.config.ts
import {defineConfig} from '@playwright/test';

export default defineConfig({
    timeout: 120_000,
    use: {
        baseURL: 'http://localhost:3000',
        ignoreHTTPSErrors: true,
    },
    projects: [
        {name: 'headless', use: {headless: true}},
        {name: 'headed', use: {headless: false}},
    ],
});
```

## API

### `test` (extended Playwright test)

Extends `@playwright/test` with a `profiler` fixture automatically available in every test.

### `profiler` fixture

| Method | Description |
|--------|-------------|
| `profiler.start()` | Activate backend (if needed) and start recording |
| `profiler.stop()` | Stop recording and return profile |
| `profiler.waitForStable()` | Wait until no new React operations for `stableThresholdMs` |
| `profiler.isReady()` | Check if backend is activated and renderer connected |
| `profiler.exportProfile()` | Export current profile without stopping |

### `launchProfilingContext(userDataDir, overrides?)`

Convenience wrapper around `chromium.launchPersistentContext` for setups with saved auth (or any pre-launched, persistent profile). Applies `RECOMMENDED_PROFILING_ARGS`, defaults `ignoreHTTPSErrors: true`, and injects the React DevTools hook in one call.

```typescript
import {launchProfilingContext, createProfiler} from 'playwright-react-profiler';

const context = await launchProfilingContext('./user-data', {
    headless: false,
    viewport: {width: 1440, height: 900},
});

const page = context.pages()[0] ?? (await context.newPage());
const profiler = createProfiler(page);
```

### `RECOMMENDED_PROFILING_ARGS`

Chrome flags required for accurate profiling:

```
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
```

Without them, headless Chrome throttles renderer work in unfocused windows — wall-clock numbers drift and React scheduling changes. The default `test` fixture merges these into `launchOptions` automatically; `launchProfilingContext` merges them into persistent-context args. Only spread them into your own `launchOptions.args` if you are launching the browser outside both paths.

### `injectDevToolsHook(context)`

Low-level primitive: installs `installHook.js` on a `BrowserContext` via `addInitScript`. Both the default `test` fixture and `launchProfilingContext` call this internally. Use directly only when you construct a context through a path neither of those covers.

```typescript
import {chromium} from '@playwright/test';
import {injectDevToolsHook, RECOMMENDED_PROFILING_ARGS, createProfiler} from 'playwright-react-profiler';

const context = await chromium.launchPersistentContext('./user-data', {
    headless: false,
    args: [...RECOMMENDED_PROFILING_ARGS],
});
await injectDevToolsHook(context);

const page = context.pages()[0];
const profiler = createProfiler(page);
```

> **Why this matters:** `installHook.js` must run before React initializes. It is added via `context.addInitScript`, which only applies to pages created from that context after the script is registered. If you create a context manually and skip this step, React will never attach to `__REACT_DEVTOOLS_GLOBAL_HOOK__` and `profiler.start()` will fail with `No React renderer found`.

### `createProfiler(page, config?)`

Create a profiler instance for manual control outside the fixture system.

### `analyzeResults(profiles, wallClockTimes?)`

Analyze an array of profile exports:

```typescript
import {analyzeResults, formatAnalysis} from 'playwright-react-profiler';

const analysis = analyzeResults(profiles);
console.log(formatAnalysis(analysis));
```

## How It Works

1. **Hook injection** — Before React loads, `installHook.js` is injected via `addInitScript`. This installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` which React connects to during initialization.

2. **Backend activation** — When `profiler.start()` is called, the compact backend is loaded and an Agent is created that bridges React's renderer to profiling controls.

3. **Profiling** — Uses the same internal APIs as React DevTools Profiler tab: `startProfiling()`, `stopProfiling()`, `getProfilingData()`.

4. **Stability detection** — Monitors React operation count. When no new operations arrive for `stableThresholdMs`, rendering is considered stable.

## Requirements

- React app running in **development** or **profiling** mode (production builds strip DevTools support)
- Playwright >= 1.30
- Node.js >= 16

## Project Structure

```
playwright-react-profiler/
├── src/
│   ├── index.ts       # Main exports
│   ├── fixture.ts     # Playwright test fixture
│   ├── profiler.ts    # Core profiling logic
│   ├── analyze.ts     # Profile analysis utilities
│   └── types.ts       # TypeScript types
├── react-source/      # Git submodule (facebook/react)
├── devtools-build/    # Built DevTools files (gitignored)
├── scripts/
│   └── build-devtools.sh
└── example/
    ├── playwright.config.ts
    └── profile.spec.ts
```

## License

MIT
