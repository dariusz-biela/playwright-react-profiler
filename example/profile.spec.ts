import fs from 'fs';
import path from 'path';
import {test, expect} from '../src';

// Override profiler config if needed
test.use({
    profilerConfig: {
        stableThresholdMs: 2000,
        maxWaitMs: 30000,
    },
});

test.describe('React Profiling', () => {
    test('profile page load', async ({page, profiler}) => {
        // Navigate to your app
        await page.goto('/');

        // Activate profiler and start recording
        await profiler.start();

        // Wait for React renders to settle
        await profiler.waitForStable();

        // Stop and export
        const profile = await profiler.stop();

        expect(profile).not.toBeNull();
        expect(profile!.dataForRoots.length).toBeGreaterThan(0);

        // Save profile (importable in React DevTools)
        const resultsDir = path.resolve(__dirname, 'results');
        fs.mkdirSync(resultsDir, {recursive: true});

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(resultsDir, `profile-page-load-${timestamp}.json`);
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));

        console.log(`Profile saved: ${filePath}`);
    });

    test('profile user interaction', async ({page, profiler}) => {
        await page.goto('/');

        // Wait for initial load
        await profiler.start();
        await profiler.waitForStable();
        await profiler.stop();

        // Now profile a specific interaction
        await profiler.start();

        // Perform interaction (customize for your app)
        await page.click('button[data-testid="some-button"]');

        await profiler.waitForStable();
        const profile = await profiler.stop();

        expect(profile).not.toBeNull();
        console.log(`Commits after interaction: ${profile!.dataForRoots[0]?.commitData.length}`);
    });
});
