import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	timeout: 60000,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://localhost:5173",
		trace: "on-first-retry",
		actionTimeout: 10000,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "pnpm run dev",
		url: "http://localhost:5173",
		reuseExistingServer: true,
		timeout: 15000,
	},
});
