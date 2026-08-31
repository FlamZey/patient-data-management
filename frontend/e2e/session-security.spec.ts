import { test, expect } from "@playwright/test";
import { API_URL, adminToken, fieldInput, login } from "./helpers";

// Two session-invalidation behaviours that, until now, only backend tests
// covered. Both are the same underlying rule -- an access token is checked
// against the live account on every request, and the refresh token that would
// mint a new one is revoked -- but the thing worth proving end to end is that
// the *browser* actually ends up signed out, not merely that the API says 401.
//
// Both use throwaway accounts. Suspending or changing the password of a demo
// account would break every other spec in the suite, the same reasoning the
// account-lockout test in zz-adversarial.spec.ts already follows.

const DEMO_PASSWORD = "ChangeMe123!";
const VICTIM_PASSWORD = "ValidPass123!";

test.describe("session invalidation", () => {
  let token: string;
  let standardRoleId: number;
  let locationId: number;

  test.beforeAll(async ({ request }) => {
    token = await adminToken(request);
    const auth = { Authorization: `Bearer ${token}` };

    // The least-privileged role by name, not by position -- these accounts
    // only ever need to sign in, and a throwaway shouldn't be an administrator.
    const roles = await (await request.get(`${API_URL}/roles`, { headers: auth })).json();
    standardRoleId = roles.find((role: { name: string }) => role.name === "user").id;
    const locations = await (await request.get(`${API_URL}/locations`, { headers: auth })).json();
    locationId = locations[0].id;
  });

  // Returns the created account's id so the test can act on it as the admin.
  async function createVictim(
    request: import("@playwright/test").APIRequestContext,
    label: string,
  ): Promise<{ email: string; id: string }> {
    const email = `e2e-${label}-${Date.now()}@example.com`;
    const res = await request.post(`${API_URL}/users`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        email,
        username: email.split("@")[0],
        password: VICTIM_PASSWORD,
        first_name: "Session",
        last_name: "Victim",
        role_id: standardRoleId,
        location_id: locationId,
      },
    });
    expect(res.status()).toBe(201);
    return { email, id: (await res.json()).id };
  }

  // get_current_user rechecks account status on every request, and suspending
  // also revokes the account's refresh tokens (backend/app/routers/users.py) --
  // so a signed-in session can't survive by rotating its cookie.
  test("suspending an account ends its live browser session", async ({ page, request }) => {
    const victim = await createVictim(request, "suspend");

    await login(page, victim.email, VICTIM_PASSWORD);
    await expect(page).toHaveURL(/\/home$/);

    // Capture the session's current refresh cookie before it is revoked, so
    // the server-side half can be asserted directly rather than inferred from
    // where the browser ends up.
    const cookieBefore = (await page.context().cookies()).find((c) => c.name === "refresh_token");
    expect(cookieBefore).toBeDefined();

    const suspend = await request.patch(`${API_URL}/users/${victim.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { status: "suspended" },
    });
    expect(suspend.status()).toBe(200);

    // The captured cookie is dead server-side: not merely refused, revoked.
    const refused = await request.post(`${API_URL}/auth/refresh`, {
      headers: { Cookie: `refresh_token=${cookieBefore!.value}` },
    });
    expect(refused.status()).toBe(401);

    // ...and the browser follows. Any navigation re-runs the session restore,
    // which now fails, so the app clears local state and redirects to /login
    // rather than leaving a tab that looks signed in.
    await page.goto("/home");
    await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
  });

  // Changing a password revokes every refresh token for that user and clears
  // the cookie, so every other session -- including one an attacker had --
  // dies at the moment the real owner reacts.
  test("changing a password revokes the session and signs the browser out", async ({ page, request }) => {
    const victim = await createVictim(request, "pwchange");
    const newPassword = "BrandNewPass456!";

    await login(page, victim.email, VICTIM_PASSWORD);
    await page.goto("/settings");

    // A SECOND, independent session for the same account, established through
    // the API so it lives outside this browser context entirely.
    //
    // This is the only way to assert the server-side effect honestly. The
    // browser's own cookie is a false witness: after a successful change the
    // page calls logout() on a timer, which revokes that cookie regardless --
    // so asserting on it passes even when password-change revocation is
    // deleted outright (verified: it did). Logout can't reach this one, so a
    // 401 here can only mean the password change revoked every session.
    const otherSession = await request.post(`${API_URL}/auth/login`, {
      data: { email: victim.email, password: VICTIM_PASSWORD },
    });
    expect(otherSession.ok()).toBeTruthy();
    const otherCookie = otherSession
      .headers()
      ["set-cookie"].split(";")[0]
      .replace("refresh_token=", "");

    // Password is edited through its own dialog, opened by the pencil icon
    // next to it (settings/page.tsx) rather than a permanently-visible form.
    await page.getByRole("button", { name: "Edit password" }).click();

    // fieldInput, not getByLabel: components/FormField.tsx renders <label> as a
    // plain sibling with no htmlFor, so Playwright can't associate the two --
    // the same limitation helpers.ts documents for UserFormDialog.
    await fieldInput(page, "Current password").fill(VICTIM_PASSWORD);
    await fieldInput(page, "New password").fill(newPassword);
    await fieldInput(page, "Confirm new password").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(
      page.getByText("Password changed. Signing you out for security — please sign in again."),
    ).toBeVisible({ timeout: 10000 });

    // The OTHER session is dead too. That is the security property: changing a
    // password ends every session for the account, not just the tab that did
    // it -- which is what makes it a usable response to a stolen credential.
    const refused = await request.post(`${API_URL}/auth/refresh`, {
      headers: { Cookie: `refresh_token=${otherCookie}` },
    });
    expect(refused.status()).toBe(401);

    // The page signs itself out shortly after the message (a deliberate delay
    // so the message is readable).
    await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
  });

  // A control for both tests above: an untouched account's session survives
  // exactly the navigation that ends a suspended one, so the redirects above
  // are caused by the revocation rather than by anything routine.
  test("an untouched session survives the same navigation", async ({ page }) => {
    await login(page, "user.au@example.com", DEMO_PASSWORD);
    await page.goto("/home");
    await expect(page).toHaveURL(/\/home$/);
    await page.reload();
    await expect(page).toHaveURL(/\/home$/);
  });
});
