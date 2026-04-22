import {defineConfig} from '@playwright/test';

export default defineConfig({
    testDir: '.',
    timeout: 120_000,
    use: {
        baseURL: 'http://localhost:3000',
        ignoreHTTPSErrors: true,
        viewport: {width: 1440, height: 900},
    },
    projects: [
        {
            name: 'headless',
            use: {headless: true},
        },
        {
            name: 'headed',
            use: {headless: false},
        },
    ],
});
