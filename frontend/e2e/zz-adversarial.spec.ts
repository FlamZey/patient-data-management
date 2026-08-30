import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { API_URL, adminToken, expectLoginFailure, fieldInput, login } from "./helpers";

const REPO_ROOT = path.join(__dirname, "../..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// Real bad-actor-shaped interactions against the running app -- at least
// one adversarial scenario per major flow, exercised against the actual
// backend/database so "only one record was created" is verified server-side,
// not just inferred from the UI.
test.describe("adversarial: rapid double interactions", () => {
  let token: string;
  test.beforeAll(async ({ request }) => {
    token = await adminToken(request);
  });

  // Double clicking Create user rapidly creates exactly one user server-side, not two.
  test("double clicking Create user rapidly creates exactly one user server-side", async ({ page, request }) => {
    await login(page);
    await page.goto("/manage-users");

    const suffix = Date.now();
    const email = `e2e-dup-submit-${suffix}@example.com`;
    const username = `e2e-dup-submit-${suffix}`;

    await page.getByRole("button", { name: "Add user" }).click();
    await fieldInput(page, "First name").fill("Rapid");
    await fieldInput(page, "Last name").fill("Clicker");
    await fieldInput(page, "Email").fill(email);
    await fieldInput(page, "Username").fill(username);
    await fieldInput(page, "Password").fill("ValidPass123!");
    // By label, and the least-privileged role -- see user-management-crud.spec.ts.
    await fieldInput(page, "Role").selectOption({ label: "User" });
    await fieldInput(page, "Location").selectOption({ index: 1 });

    const submit = page.getByRole("button", { name: "Create user" });
    // Two raw mouse clicks at the button's coordinates, back to back, with
    // none of Locator.click()'s actionability waiting in between -- that
    // waiting is exactly what would make a second `.click()` call just sit
    // there until the (now-disabled, then unmounted-on-success) button
    // becomes actionable again, which proves nothing about a genuine race.
    // page.mouse.dblclick fires both at the OS/browser event level, the
    // closest simulation available of an actual double click.
    const box = (await submit.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    const res = await request.get(`${API_URL}/users?email=${email}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { items } = await res.json();
    const matches = items.filter((u: { email: string }) => u.email === email);
    expect(matches).toHaveLength(1);
  });

  // Double clicking Upload rapidly on the same file only processes it once server-side.
  test("double clicking Upload rapidly on the same file only processes it once server-side", async ({
    page,
    request,
  }) => {
    await login(page);
    await page.goto("/dashboard");

    const patientCode = `E2E-DBLCLICK-${Date.now()}`;
    const scriptPath = path.join(BACKEND_DIR, "e2e_generate_dblclick.py");
    writeFileSync(
      scriptPath,
      [
        "import openpyxl",
        "wb = openpyxl.Workbook()",
        "ws = wb.active",
        'ws.append(["Patient ID", "First Name", "Last Name", "Date of Birth", "Gender"])',
        `ws.append(["${patientCode}", "Rapid", "Clicker", "1990-01-15", "Male"])`,
        'wb.save("/app/e2e-dblclick.xlsx")',
        "",
      ].join("\n"),
    );
    execSync("docker compose exec -T backend python e2e_generate_dblclick.py", { cwd: REPO_ROOT });
    const buffer = readFileSync(path.join(BACKEND_DIR, "e2e-dblclick.xlsx"));

    await page.setInputFiles('input[type="file"]', {
      name: "dblclick.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    });

    const uploadButton = page.getByRole("button", { name: "Upload" });
    const box = (await uploadButton.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByText(/records processed\./)).toBeVisible({ timeout: 15000 });

    const res = await request.get(`${API_URL}/patients?patient_code=${patientCode}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { items } = await res.json();
    // The backend's patient_code column is UNIQUE, so even a genuine
    // double-submit race would fail its second insert with an integrity
    // error rather than silently duplicating -- this confirms exactly one
    // row exists either way.
    expect(items).toHaveLength(1);

    for (const patient of items) {
      await request.delete(`${API_URL}/patients/${patient.id}`, { headers: { Authorization: `Bearer ${token}` } });
    }
  });

  // Five rapid failed logins against a real (non-demo) account lock it, and the sixth attempt is rejected even with the correct password.
  test("five rapid failed logins lock the account, rejecting even the correct password on the sixth attempt", async ({
    page,
    request,
  }) => {
    // Uses a dedicated throwaway account, not admin.us -- locking the
    // shared demo admin would break every other spec in this suite for the
    // 15-minute lockout window.
    const suffix = Date.now();
    const email = `e2e-lockout-${suffix}@example.com`;
    const username = `e2e-lockout-${suffix}`;
    const password = "ValidPass123!";

    const rolesRes = await request.get(`${API_URL}/roles`, { headers: { Authorization: `Bearer ${token}` } });
    const roles = await rolesRes.json();
    const locationsRes = await request.get(`${API_URL}/locations`, { headers: { Authorization: `Bearer ${token}` } });
    const locations = await locationsRes.json();
    await request.post(`${API_URL}/users`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        email,
        username,
        password,
        first_name: "Lockout",
        last_name: "Test",
        role_id: roles[0].id,
        location_id: locations[0].id,
      },
    });

    await page.goto("/login");
    // Every attempt goes through expectLoginFailure rather than raw fill/click/
    // expect. POST /auth/login is rate-limited to 10/minute per IP and this
    // whole suite shares one IP, so by the time this spec runs the window can
    // already be spent -- a 429 renders LoginForm's generic fallback, not the
    // message being asserted, and the test fails for a reason that has nothing
    // to do with account lockout. The helper retries once past the window.
    //
    // A retried attempt is harmless here: a 429 never reaches the login logic,
    // so it doesn't consume one of the five failures, and the 15-minute lockout
    // outlasts the helper's 65-second wait.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Either message is acceptable -- the fifth failure is the one that locks
      // the account, and whether that response reports bad credentials or the
      // lockout is an implementation detail of the same request.
      await expectLoginFailure(page, email, "wrong-password-on-purpose", /Invalid email or password|Account locked/);
    }

    // The correct password now, which must still be refused.
    await expectLoginFailure(page, email, password, "Account locked. Try again later.");
    await expect(page).toHaveURL(/\/login$/);
  });
});
