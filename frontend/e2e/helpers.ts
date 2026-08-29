import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const ADMIN_EMAIL = "admin.us@example.com";
export const ADMIN_PASSWORD = "ChangeMe123!";
export const API_URL = "http://localhost:8000";

// POST /auth/login is rate-limited to 10/minute per IP (see
// docs/security.md), and this whole suite's tests all share one IP against
// one backend. A burst of tests each logging in (or deliberately failing
// login, as the account-lockout adversarial test does) can trip that limit
// well within the suite's own run -- when that happens the login response
// is a 429, which LoginForm has no specific message for and falls back to
// its generic "Something went wrong" text, leaving the page on /login even
// though the credentials were correct. Retrying after the fixed window
// clears (up to 65s, comfortably past slowapi's 60s window) makes the
// suite self-healing under that real constraint instead of flaking.
export async function login(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page).toHaveURL(/\/home$/, { timeout: 5000 });
      return;
    } catch {
      if (attempt === 1) throw new Error(`Login for ${email} did not reach /home after a retry past the rate-limit window.`);
      await page.waitForTimeout(65_000);
    }
  }
}

// Attempts a login expected to FAIL (wrong password, unknown email, ...)
// and waits for the given failure message -- retrying the whole attempt
// once, past the same shared login rate limit described above, if the
// message shown was instead the generic fallback a 429 produces. Unlike
// login() this doesn't navigate away first, since the caller may already be
// mid-flow (e.g. an account-lockout test whose next attempt must land on
// the same page as the previous one).
export async function expectLoginFailure(page: Page, email: string, password: string, expectedMessage: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    try {
      await expect(page.getByText(expectedMessage)).toBeVisible({ timeout: 5000 });
      return;
    } catch {
      if (attempt === 1) throw new Error(`Never saw "${expectedMessage}" after a retry past the rate-limit window.`);
      await page.waitForTimeout(65_000);
    }
  }
}

// components/FormField.tsx (used by UserFormDialog) renders `<label>` as a
// plain sibling of its input/select, not wrapping it and with no htmlFor/id
// -- so Playwright's getByLabel() can't resolve it (same limitation the
// unit tests hit; see __tests__/components/UserFormDialog.test.tsx's own
// getFieldInput helper). Locate the same way: the label's following-sibling
// input/select. LoginForm's own labels, by contrast, ARE properly wired via
// htmlFor/id, so plain getByLabel works there (see login() above).
export function fieldInput(page: Page, labelText: string) {
  return page.locator(
    `xpath=//label[normalize-space(text())="${labelText}"]/following-sibling::*[self::input or self::select][1]`,
  );
}

// Opens a column's text-filter popover and types into it, retrying the
// click a couple times if the popover doesn't appear -- observed
// intermittently in this suite (rare enough not to reproduce on demand)
// right after an upload's refreshSignal-triggered table reload lands at
// nearly the same moment as the click. useColumnFilterPopover
// (ColumnFilters.tsx) closes the popover on any window "scroll" event
// (capture phase), and that reload re-rendering ~10,000+ candidate rows is
// exactly the kind of layout churn that could fire one; retrying the click
// is a pragmatic guard against that race rather than a fix for it.
export async function openTextFilter(page: Page, columnLabel: string, value: string) {
  const trigger = page.getByRole("button", { name: `Filter by ${columnLabel}` });
  const input = page.getByPlaceholder("Filter...");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await trigger.click();
    try {
      await input.waitFor({ state: "visible", timeout: 3000 });
      await input.fill(value);
      return;
    } catch {
      if (attempt === 2) throw new Error(`Filter popover for "${columnLabel}" never opened after 3 attempts.`);
    }
  }
}

// One admin token per call, cached by the caller (typically in a
// test.beforeAll) rather than fetched fresh per test -- every call is
// itself a POST /auth/login against the same shared rate limit described
// above, so tests that just need a bearer token for cleanup/setup should
// request one once per file, not once per test.
export async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  if (!res.ok()) {
    throw new Error(`Admin token request failed (${res.status()}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

export async function deletePatientByCode(request: APIRequestContext, token: string, patientCode: string) {
  const listRes = await request.get(`${API_URL}/patients?patient_code=${patientCode}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { items } = await listRes.json();
  for (const patient of items) {
    await request.delete(`${API_URL}/patients/${patient.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
