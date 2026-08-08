import { test, expect } from "@playwright/test";

test("home page loads and shows heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Next.js \+ FastAPI \+ PostgreSQL/i)).toBeVisible();
});

test("home page shows loading or empty state", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText(/No items yet|Loading items|Couldn't reach the API/i)
  ).toBeVisible();
});