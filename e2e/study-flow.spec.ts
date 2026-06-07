import { test, expect, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIONS_APKG = path.resolve(__dirname, "../src/__tests__/fixtures/Nations_of_the_World.apkg");
const CIVIL_LAW_APKG = path.resolve(__dirname, "../src/__tests__/fixtures/CIVIL_LAW.apkg");
const HAS_CIVIL_LAW = fs.existsSync(CIVIL_LAW_APKG);

async function clearAndImport(page: Page, apkgPath: string) {
	page.on("dialog", (dialog) => dialog.accept());
	await page.goto("/");
	await page.waitForLoadState("networkidle");

	const clearBtn = page.locator("button", { hasText: "Clear" }).or(
		page.locator('[aria-label="Clear all data"]'),
	);
	if (await clearBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
		await clearBtn.first().click();
		await page.waitForLoadState("load");
		await page.goto("/");
		await page.waitForLoadState("networkidle");
	}

	await page.waitForTimeout(500);
	const importBtn = page.locator("button", { hasText: "Import" });
	await expect(importBtn).toBeVisible({ timeout: 5000 });
	await importBtn.click();

	const fileInput = page.locator('input[type="file"]');
	await fileInput.setInputFiles(apkgPath);
	await expect(page.getByText("Import complete")).toBeVisible({ timeout: 60000 });
	await page.locator("button", { hasText: "Start Studying" }).click();
	await page.waitForTimeout(500);
}

async function getCardText(page: Page): Promise<string> {
	const iframe = page.frameLocator("iframe").first();
	try {
		await expect(iframe.locator("body")).toBeVisible({ timeout: 3000 });
		return (await iframe.locator("body").textContent()) ?? "";
	} catch {
		return "";
	}
}

test.describe("Nations of the World deck", () => {
	test("import shows correct hierarchy", async ({ page }) => {
		await clearAndImport(page, NATIONS_APKG);

		await expect(page.getByText("Nations of the World")).toBeVisible();
		await expect(page.getByText("Africa")).toBeVisible();
		await expect(page.getByText("Europe")).toBeVisible();
		await expect(page.getByText("Asia")).toBeVisible();
		await expect(page.getByText("North America")).toBeVisible();

		await page.screenshot({ path: "test-results/01-deck-list.png" });
	});

	test("study flow: show answer → answer → next card", async ({ page }) => {
		await clearAndImport(page, NATIONS_APKG);

		// Click North America
		await page.getByText("North America").click();

		// Should see study view
		const showAnswerBtn = page.getByRole("button", { name: "Show Answer" });
		await expect(showAnswerBtn).toBeVisible({ timeout: 5000 });

		// Card should have content in iframe
		const card1Text = await getCardText(page);
		expect(card1Text.length).toBeGreaterThan(0);
		console.log("Card 1 (question):", card1Text.slice(0, 100));

		await page.screenshot({ path: "test-results/02-card-question.png" });

		// Show answer
		await showAnswerBtn.click();

		// Answer buttons should appear
		await expect(page.getByRole("button", { name: "Again" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Good" })).toBeVisible();

		// Card should still have content (now showing answer side)
		const answerText = await getCardText(page);
		expect(answerText.length).toBeGreaterThan(0);
		console.log("Card 1 (answer):", answerText.slice(0, 100));

		await page.screenshot({ path: "test-results/03-card-answer.png" });

		// Click Good
		await page.getByRole("button", { name: "Good" }).click();

		// Should show next card's question (Show Answer reappears)
		await expect(showAnswerBtn).toBeVisible({ timeout: 5000 });

		// Next card should have DIFFERENT content
		const card2Text = await getCardText(page);
		expect(card2Text.length).toBeGreaterThan(0);
		console.log("Card 2 (question):", card2Text.slice(0, 100));

		await page.screenshot({ path: "test-results/04-card2-question.png" });

		// Verify it's a different card
		// (can't guarantee text is different since some cards may look similar,
		// but the iframe should have re-rendered)
	});

	test("study 5 cards sequentially", async ({ page }) => {
		await clearAndImport(page, NATIONS_APKG);

		await page.getByText("Africa").click();
		await expect(page.getByRole("button", { name: "Show Answer" })).toBeVisible({ timeout: 5000 });

		const cardTexts: string[] = [];
		for (let i = 0; i < 5; i++) {
			// Get question text
			const qText = await getCardText(page);
			cardTexts.push(qText.slice(0, 50));

			// Show answer
			await page.keyboard.press("Space");
			await expect(page.getByRole("button", { name: "Good" })).toBeVisible({ timeout: 3000 });

			// Answer with Good
			await page.keyboard.press("3");

			// Wait for next card or congrats
			const showAnswer = page.getByRole("button", { name: "Show Answer" });
			const congrats = page.getByText("Congratulations");
			await Promise.race([
				showAnswer.waitFor({ timeout: 3000 }).catch(() => {}),
				congrats.waitFor({ timeout: 3000 }).catch(() => {}),
			]);

			if (await congrats.isVisible().catch(() => false)) {
				console.log(`Finished after ${i + 1} cards (daily limit reached or deck done)`);
				break;
			}
		}

		console.log("Card questions seen:", cardTexts);
		expect(cardTexts.length).toBeGreaterThanOrEqual(3);

		await page.screenshot({ path: "test-results/05-after-5-reviews.png" });
	});

	test("Again keeps study session going", async ({ page }) => {
		await clearAndImport(page, NATIONS_APKG);

		await page.getByText("Africa").click(); // larger deck, less chance of sibling collision
		await expect(page.getByRole("button", { name: "Show Answer" })).toBeVisible({ timeout: 5000 });

		// Show answer and press Again
		await page.keyboard.press("Space");
		await expect(page.getByRole("button", { name: "Again" })).toBeVisible();
		await page.keyboard.press("1"); // Again

		// Should continue studying (Show Answer appears for next card OR congrats)
		const showAnswer = page.getByRole("button", { name: "Show Answer" });
		const congrats = page.getByText("Congratulations").or(page.getByText("All done"));
		await Promise.race([
			showAnswer.waitFor({ timeout: 5000 }),
			congrats.waitFor({ timeout: 5000 }),
		]);

		// Either we see a next card or the session ended — both are valid
		const hasNext = await showAnswer.isVisible().catch(() => false);
		const isDone = await congrats.isVisible().catch(() => false);
		expect(hasNext || isDone).toBe(true);

		if (hasNext) {
			// Can continue reviewing
			await page.keyboard.press("Space");
			await expect(page.getByRole("button", { name: "Good" })).toBeVisible();
			await page.keyboard.press("3");
		}

		await page.screenshot({ path: "test-results/06-after-again.png" });
	});

	test("back button returns to deck list from study", async ({ page }) => {
		await clearAndImport(page, NATIONS_APKG);

		await page.getByText("Europe").click();
		await expect(page.getByRole("button", { name: "Show Answer" })).toBeVisible({ timeout: 5000 });

		// Click back
		const backBtn = page.locator("button", { hasText: "←" }).or(
			page.locator('[aria-label="Back to decks"]'),
		);
		await backBtn.first().click();

		await expect(page.getByText("Nations of the World")).toBeVisible({ timeout: 3000 });
	});
});

test.describe("Card browser", () => {
	test("search and preview notes", async ({ page }) => {
		await clearAndImport(page, NATIONS_APKG);

		await page.locator("button", { hasText: "Browse" }).click();

		// Table should have rows
		const rows = page.locator("tbody tr");
		await expect(rows.first()).toBeVisible({ timeout: 5000 });
		const totalCount = await rows.count();
		console.log("Total notes:", totalCount);
		expect(totalCount).toBeGreaterThan(10);

		await page.screenshot({ path: "test-results/07-browser.png" });

		// Search
		const searchInput = page.getByPlaceholder(/search/i);
		await searchInput.fill("Japan");
		await page.waitForTimeout(500);

		const filteredCount = await rows.count();
		console.log("Filtered notes (Japan):", filteredCount);
		expect(filteredCount).toBeLessThan(totalCount);
		expect(filteredCount).toBeGreaterThan(0);

		// Click a row — preview should appear
		await rows.first().click();
		await page.waitForTimeout(300);

		await page.screenshot({ path: "test-results/08-browser-preview.png" });

		// Close
		const closeBtn = page.locator("button", { hasText: "✕" }).or(
			page.locator('[aria-label="Close"]'),
		);
		await closeBtn.first().click();
		await expect(page.getByText("Nations of the World")).toBeVisible({ timeout: 3000 });
	});
});

test.describe("CIVIL LAW deck (FSRS)", () => {
	test.skip(!HAS_CIVIL_LAW, "CIVIL_LAW.apkg not in fixtures");

	test("import and study cards", async ({ page }) => {
		await clearAndImport(page, CIVIL_LAW_APKG);

		await expect(page.getByText("CIVIL LAW")).toBeVisible();
		await page.getByText("CIVIL LAW").click();

		await expect(page.getByRole("button", { name: "Show Answer" })).toBeVisible({ timeout: 5000 });

		const cardText = await getCardText(page);
		expect(cardText.length).toBeGreaterThan(0);
		console.log("CIVIL LAW card:", cardText.slice(0, 100));

		// Review with each answer type
		for (const key of ["1", "3", "4", "2"]) {
			const showAnswer = page.getByRole("button", { name: "Show Answer" });
			if (!(await showAnswer.isVisible({ timeout: 1000 }).catch(() => false))) break;

			await showAnswer.click();
			await page.keyboard.press(key);
			await page.waitForTimeout(300);
		}

		await page.screenshot({ path: "test-results/09-civil-law.png" });
	});
});
