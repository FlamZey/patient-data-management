import { test, expect } from "@playwright/test";

// The root route ("/") never renders content of its own -- it's a thin
// client component (app/page.tsx) that waits for the session check to
// resolve, then bounces to /home (authenticated) or /login (not). This
// replaces the file's previous version, which asserted on
// "Next.js + FastAPI + PostgreSQL" placeholder text from the original
// project scaffold that app/page.tsx no longer renders at all.
test.describe("root route", () => {
  // Visiting the root route while logged out redirects to login.
  test("visiting the root route while logged out redirects to login", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });
});
