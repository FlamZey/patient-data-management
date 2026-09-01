import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { API_URL, deletePatientByCode, login } from "./helpers";

const REPO_ROOT = path.join(__dirname, "../..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// The analytics report is heavily unit-tested (lib/analytics.ts, stats.ts,
// segmentation.ts, insights.ts and its section components), but every one of
// those tests feeds it a hand-built dataset. Nothing exercised it against the real
// GET /patients/analytics-dataset, which streams NDJSON progress events and
// then a de-identified columnar payload. That gap hides exactly one class of
// bug: the server's projection drifting from what the charts expect, which no
// amount of frontend unit testing can catch.
//
// This spec covers both halves in one sign-in:
//   - the UI actually renders against the real payload, and
//   - the payload really is de-identified, which is a security contract
//     (docs/security.md) that until now had no end-to-end assertion at all.

// Distinct per run so a shared dev database can't collide, and so the exact
// row count this spec uploads is knowable.
const RUN = Date.now();
const PATIENT_CODES = [`E2E-ANALYTICS-${RUN}-A`, `E2E-ANALYTICS-${RUN}-B`, `E2E-ANALYTICS-${RUN}-C`];

// Names and dates that must NEVER appear in the analytics payload -- asserted
// against the real response below.
const IDENTIFIABLE_FIRST_NAME = "Analyticsfirstname";
const IDENTIFIABLE_LAST_NAME = "Analyticslastname";
const EXACT_DOB = "1985-03-22";

// Built in the backend container, which already has openpyxl -- same approach
// and the same cmd.exe caveat as patient-crud.spec.ts's generateWorkbook.
function analyticsWorkbook(): Buffer {
  const rows = PATIENT_CODES.map(
    (code, index) =>
      `ws.append(["${code}", "${IDENTIFIABLE_FIRST_NAME}", "${IDENTIFIABLE_LAST_NAME}", ` +
      `"${EXACT_DOB}", "${index % 2 === 0 ? "Female" : "Male"}"])`,
  );
  const script = [
    "import openpyxl",
    "wb = openpyxl.Workbook()",
    "ws = wb.active",
    'ws.append(["Patient ID", "First Name", "Last Name", "Date of Birth", "Gender"])',
    ...rows,
    'wb.save("/app/e2e-analytics.xlsx")',
  ];
  writeFileSync(path.join(BACKEND_DIR, "e2e_generate_analytics.py"), script.join("\n") + "\n");
  execSync("docker compose exec -T backend python e2e_generate_analytics.py", { cwd: REPO_ROOT });
  return readFileSync(path.join(BACKEND_DIR, "e2e-analytics.xlsx"));
}

test.describe("patient analytics", () => {
  test("renders against the real analytics endpoint, whose payload carries no identifiers", async ({
    page,
  }) => {
    // Decrypting every in-scope row server-side plus rendering the charts is
    // slower than a typical page interaction, and the upload has to finish
    // first.
    test.slow();

    await login(page);
    await page.goto("/dashboard");

    // --- upload something for the analysis to describe ---
    await page.getByRole("button", { name: "Import patients (.xlsx)" }).click();
    await page.setInputFiles('input[type="file"]', {
      name: "analytics.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: analyticsWorkbook(),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText(/records processed\./)).toBeVisible({ timeout: 30000 });

    // --- Data analysis is its own route now, not a section of /dashboard ---
    // The report is a single read-only scroll that fetches on mount: no
    // collapse to open, no tabs to switch, no target to pick.
    await page.goto("/data-analysis");

    // Waiting on rendered content proves the stream reached its terminal
    // "done" line and the dataset parsed -- while loading the page shows only
    // a spinner, and on failure only an error plus Retry.
    await expect(page.getByRole("heading", { name: "Field coverage" })).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("No patient records to analyse yet. Upload a workbook first.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);

    // --- further sections, to prove the payload feeds more than one consumer ---
    // All of them are on the page at once now, so this needs no interaction.
    await expect(page.getByRole("heading", { name: "Data quality" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gender split" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /What's associated with/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Cohort comparison/ })).toBeVisible();

    // --- the de-identification contract, asserted on the wire ---
    // Read the endpoint directly rather than inferring from the rendered page:
    // the UI simply never displays a name, so it could not distinguish "the
    // server withheld it" from "the client ignored it". Token comes from
    // /auth/refresh (not rate limited) so this costs no extra login.
    const refreshRes = await page.request.post(`${API_URL}/auth/refresh`);
    expect(refreshRes.ok()).toBeTruthy();
    const token = (await refreshRes.json()).access_token as string;
    const auth = { Authorization: `Bearer ${token}` };

    const datasetRes = await page.request.get(`${API_URL}/patients/analytics-dataset`, { headers: auth });
    expect(datasetRes.ok()).toBeTruthy();
    const body = await datasetRes.text();

    // NDJSON: progress lines, then exactly one terminal "done" line.
    const events = body
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const done = events.filter((event) => event.type === "done");
    expect(done).toHaveLength(1);
    expect(events.some((event) => event.type === "progress")).toBeTruthy();

    // Positive control: the identifiers ARE retrievable through the ordinary
    // patient endpoint, which proves they reached the database and that the
    // "not.toContain" assertions below are actually withholding something
    // rather than passing because the upload quietly did nothing.
    const patientsRes = await page.request.get(`${API_URL}/patients?patient_code=${PATIENT_CODES[0]}`, {
      headers: auth,
    });
    const patientsBody = await patientsRes.text();
    expect(patientsBody).toContain(IDENTIFIABLE_FIRST_NAME);
    expect(patientsBody).toContain(EXACT_DOB);

    // Nothing that identifies a patient may appear anywhere in the payload --
    // not the names or the exact date of birth we just uploaded, and not the
    // patient codes either.
    expect(body).not.toContain(IDENTIFIABLE_FIRST_NAME);
    expect(body).not.toContain(IDENTIFIABLE_LAST_NAME);
    expect(body).not.toContain(EXACT_DOB);
    for (const code of PATIENT_CODES) {
      expect(body).not.toContain(code);
    }

    // ...while the fields the charts actually consume ARE present, so the
    // assertions above can't pass merely because the payload came back empty.
    const dataset = done[0] as {
      total: number;
      columns: Record<string, unknown[]>;
      categories: Record<string, string[]>;
      quality: Record<string, number>;
    };
    expect(dataset.total).toBeGreaterThanOrEqual(PATIENT_CODES.length);
    expect(dataset.columns.age.length).toBe(dataset.total);
    expect(dataset.columns.gender.length).toBe(dataset.total);
    expect(Object.keys(dataset.quality)).toEqual(
      expect.arrayContaining(["duplicate_identity_groups", "dates_before_birth", "unreadable_rows"]),
    );

    // Date of birth is emitted as an integer age, never the date itself.
    expect(dataset.columns.age.every((age) => age === null || Number.isInteger(age))).toBeTruthy();

    // --- cleanup: this suite doesn't own the shared database ---
    for (const code of PATIENT_CODES) {
      await deletePatientByCode(page.request, token, code);
    }
  });
});
