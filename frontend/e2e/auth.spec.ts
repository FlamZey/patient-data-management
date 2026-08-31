import { test, expect } from "@playwright/test";
import { expectLoginFailure, login } from "./helpers";

// Full login/logout/session journeys against the real backend + database --
// exercises the real JWT access token + httponly refresh cookie flow
// (backend/app/routers/auth.py), not a mocked one.
test.describe("authentication", () => {
  // Logging in with valid demo credentials reaches the dashboard.
  test("logging in with valid credentials reaches the dashboard", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("link", { name: "Patients & records" })).toBeVisible();
  });

  // An unknown email shows the same generic message a wrong password would, without revealing which is wrong.
  test("an unknown email shows the same generic invalid-credentials message", async ({ page }) => {
    await page.goto("/login");
    await expectLoginFailure(page, "no-such-e2e-account@example.com", "whatever-not-real-123", "Invalid email or password");
    await expect(page).toHaveURL(/\/login$/);
  });

  // Visiting a protected route while logged out redirects to login instead of rendering the page.
  test("visiting a protected route while logged out redirects to login", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });

  // The session survives a full page reload via the httponly refresh cookie, without re-entering credentials.
  test("the session survives a full page reload via the refresh cookie", async ({ page }) => {
    await login(page);

    await page.reload();

    // The in-memory access token doesn't survive a reload by design (see
    // docs/security.md) -- only the httponly cookie does, so this proves
    // the silent-refresh-on-load path actually restores the session rather
    // than bouncing back to the login form.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("link", { name: "Patients & records" })).toBeVisible();
  });

  // Logging out clears the session and going back to a protected route redirects to login again.
  test("logging out clears the session and revisiting a protected route redirects to login", async ({ page }) => {
    await login(page);

    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });

  // Already being logged in and visiting the login page bounces straight to the dashboard instead of showing the form again.
  test("already being logged in and visiting login bounces straight to the dashboard", async ({ page }) => {
    await login(page);

    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
