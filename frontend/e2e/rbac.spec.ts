import { test, expect } from "@playwright/test";
import { API_URL, login, openTextFilter } from "./helpers";

// Role-based access control, exercised against real seeded accounts.
//
// Every other spec in this suite signs in as the admin, so nothing else
// verifies what a manager or a standard user actually gets. The unit tests
// can't cover this either: they mock useAuth, so they assert the UI reacts to
// a hand-written permission array rather than to the one the backend really
// issues. This file is the only place the whole chain runs end to end --
// seeded role_permissions in Postgres -> /auth/me -> frontend gating ->
// backend enforcement.
//
// The demo accounts (see backend/app/seed.py's DEMO_USERS) already span every
// role, so nothing here creates rows; the only mutation is one profile edit,
// restored immediately.
//
// Kept to exactly two sign-ins. POST /auth/login is rate limited to 10/minute
// per IP and the whole suite shares that budget -- which the account-lockout
// test in zz-adversarial.spec.ts also depends on -- so the manager's UI and
// API assertions are one test reusing one session rather than two tests.

const DEMO_PASSWORD = "ChangeMe123!";
const MANAGER_EMAIL = "manager.in@example.com";
const PEER_MANAGER_EMAIL = "manager.eu@example.com";
const STANDARD_USER_EMAIL = "user.us@example.com";
const ADMIN_EMAIL = "admin.us@example.com";

// The single table row matching a just-applied email filter.
async function onlyRowFor(page: import("@playwright/test").Page, email: string) {
  await openTextFilter(page, "Email", email);
  const row = page.locator("table tbody tr").first();
  await expect(row.getByText(email)).toBeVisible({ timeout: 5000 });
  return row;
}

test.describe("role-based access control", () => {
  // The standard role holds no permissions at all -- see DEFAULT_ROLE_PERMISSIONS.
  test("a standard user gets no privileged navigation and is redirected away from privileged routes", async ({
    page,
  }) => {
    await login(page, STANDARD_USER_EMAIL, DEMO_PASSWORD);

    // Each nav link is gated on the permission its page requires, so neither
    // should render at all.
    await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Manage Users" })).toHaveCount(0);

    // Typing the URL directly must not route around the missing link: each
    // page re-checks the permission itself and sends them back to /home.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/home$/, { timeout: 10000 });

    await page.goto("/manage-users");
    await expect(page).toHaveURL(/\/home$/, { timeout: 10000 });

    // Settings is self-service, so it stays reachable -- proving the redirects
    // above are permission-specific rather than a blanket lockout.
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings$/);
  });

  // A manager holds user.view and user.edit, but not role.assign, user.suspend
  // or user.create.
  test("a manager sees the user table but neither the privileged controls nor the authority behind them", async ({
    page,
  }) => {
    await login(page, MANAGER_EMAIL, DEMO_PASSWORD);

    await expect(page.getByRole("link", { name: "Manage Users" })).toBeVisible();
    await page.goto("/manage-users");
    await expect(page.getByRole("button", { name: "Filter by Email" })).toBeVisible({ timeout: 10000 });

    // Creating an account also assigns it a role, which a manager may not do.
    await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);

    // --- a row below them: editable, but only the non-privileged fields ---
    const subordinate = await onlyRowFor(page, STANDARD_USER_EMAIL);
    await subordinate.getByRole("button", { name: "Edit" }).click();

    // Four selects would mean Role and Status are editable too. A manager gets
    // exactly two -- Location and Team -- while Role stays plain text and
    // Status stays a badge, matching what the API would accept from them.
    await expect(subordinate.getByRole("combobox")).toHaveCount(2);
    await subordinate.getByRole("button", { name: "Cancel" }).click();

    // --- a peer and a senior: no edit affordance at all ---
    // Authority runs strictly downward, so neither is administrable no matter
    // which permissions the manager holds.
    const peer = await onlyRowFor(page, PEER_MANAGER_EMAIL);
    await expect(peer.getByRole("button", { name: "Edit" })).toHaveCount(0);

    const senior = await onlyRowFor(page, ADMIN_EMAIL);
    await expect(senior.getByRole("button", { name: "Edit" })).toHaveCount(0);

    // --- and the boundary behind the UI ---
    // Everything above proves only what is *offered*. These calls bypass the
    // frontend to prove what is *allowed*.
    //
    // The token comes from POST /auth/refresh, exchanging this context's
    // httponly cookie, rather than a second POST /auth/login: refresh isn't
    // rate limited, while login draws on the budget described at the top of
    // this file. page.request shares the browser context's cookie jar, which
    // is why these assertions live here rather than in their own test -- a
    // separate test would get a fresh context with no cookie to exchange.
    const refreshRes = await page.request.post(`${API_URL}/auth/refresh`);
    expect(refreshRes.ok()).toBeTruthy();
    const auth = { Authorization: `Bearer ${(await refreshRes.json()).access_token}` };

    const listRes = await page.request.get(`${API_URL}/users?email=${STANDARD_USER_EMAIL}`, { headers: auth });
    const target = (await listRes.json()).items[0];
    const rolesRes = await page.request.get(`${API_URL}/roles`, { headers: auth });
    const adminRole = (await rolesRes.json()).find((role: { name: string }) => role.name === "admin");

    // Positive control first: the manager CAN edit an ordinary field on this
    // same user. Without it, every refusal below would also pass if the
    // endpoint were simply broken for managers.
    const allowed = await page.request.patch(`${API_URL}/users/${target.id}`, {
      headers: auth,
      data: { first_name: "Renamed" },
    });
    expect(allowed.status()).toBe(200);
    // Restore the seeded value -- this suite doesn't own the demo data.
    await page.request.patch(`${API_URL}/users/${target.id}`, { headers: auth, data: { first_name: "Uma" } });

    // role_id needs role.assign; status needs user.suspend. Neither is granted.
    for (const body of [{ role_id: adminRole.id }, { status: "suspended" }]) {
      const res = await page.request.patch(`${API_URL}/users/${target.id}`, { headers: auth, data: body });
      expect(res.status()).toBe(403);
    }

    // A privileged field smuggled in beside an allowed one rejects the whole
    // request -- authorization runs before anything is written.
    const smuggled = await page.request.patch(`${API_URL}/users/${target.id}`, {
      headers: auth,
      data: { last_name: "Trojan", role_id: adminRole.id },
    });
    expect(smuggled.status()).toBe(403);

    const unchanged = await (await page.request.get(`${API_URL}/users/${target.id}`, { headers: auth })).json();
    expect(unchanged.role.name).toBe("user");
    expect(unchanged.status).toBe("active");
    expect(unchanged.last_name).not.toBe("Trojan");

    // Creating and deleting accounts are admin-only outright.
    const create = await page.request.post(`${API_URL}/users`, {
      headers: auth,
      data: {
        email: "should-not-exist@example.com",
        username: "should-not-exist",
        password: "ValidPass123!",
        first_name: "No",
        last_name: "Way",
        role_id: adminRole.id,
        location_id: 1,
      },
    });
    expect(create.status()).toBe(403);
    expect((await page.request.delete(`${API_URL}/users/${target.id}`, { headers: auth })).status()).toBe(403);
  });
});
