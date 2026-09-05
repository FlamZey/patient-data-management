import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { adminToken, deletePatientByCode, generateWorkbook, login, openTextFilter } from "./helpers";

const fixtureMeta = JSON.parse(
  readFileSync(path.join(__dirname, ".e2e-fixture-meta.json"), "utf-8"),
) as { patientCode: string; workbookPath: string };

function oneRowWorkbook(patientCode: string): Buffer {
  return generateWorkbook(
    [
      "import openpyxl",
      "wb = openpyxl.Workbook()",
      "ws = wb.active",
      'ws.append(["Patient ID", "First Name", "Last Name", "Date of Birth", "Gender"])',
      `ws.append(["${patientCode}", "E2E", "TestPatient", "1990-01-15", "Female"])`,
      'wb.save("/app/e2e-tmp.xlsx")',
    ],
    "e2e_generate_tmp.py",
    "e2e-tmp.xlsx",
  );
}

function badHeaderWorkbook(): Buffer {
  return generateWorkbook(
    [
      "import openpyxl",
      "wb = openpyxl.Workbook()",
      "ws = wb.active",
      'ws.append(["Wrong", "Header", "Columns"])',
      'wb.save("/app/e2e-bad-header.xlsx")',
    ],
    "e2e_generate_bad_header.py",
    "e2e-bad-header.xlsx",
  );
}

async function uploadOneRow(page: import("@playwright/test").Page, patientCode: string) {
  await page.getByRole("button", { name: "Import patients (.xlsx)" }).click();
  await page.setInputFiles('input[type="file"]', {
    name: `${patientCode}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: oneRowWorkbook(patientCode),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText(/records processed\./)).toBeVisible({ timeout: 15000 });
  // The dialog stays open to show the summary -- close it so its backdrop
  // doesn't intercept clicks on the table underneath.
  await page.getByRole("button", { name: "Close" }).click();
}

// NOTE: PatientTable has no delete action in the UI at all -- DELETE
// /patients/{id} and the patient.delete permission are fully implemented
// and tested server-side (backend/tests/test_patients.py::TestDeletePatient)
// but nothing in the frontend ever calls it (confirmed: no apiDeletePatient
// wrapper in lib/api.ts, no delete button in PatientTable.tsx). So "delete
// it, confirm it's gone" from the requested create->edit->filter->delete
// journey is done here via a direct API call for cleanup, not through the
// UI -- flagged in the batch summary as a product gap, not silently worked
// around.
test.describe("patient records: upload -> search -> edit -> delete journey", () => {
  let token: string;
  test.beforeAll(async ({ request }) => {
    token = await adminToken(request);
  });

  // Every test in this file uses its own unique patient code, so nothing
  // here needs to run in a fixed order or share state between tests.

  // An uploaded patient is immediately searchable and its detail panel shows the full record.
  test("uploading a workbook makes the new patient searchable and viewable with its full detail panel", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/dashboard");

    await page.getByRole("button", { name: "Import patients (.xlsx)" }).click();
    await page.setInputFiles('input[type="file"]', fixtureMeta.workbookPath);
    await expect(page.getByText(path.basename(fixtureMeta.workbookPath))).toBeVisible();
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText(/records processed\./)).toBeVisible({ timeout: 15000 });
    // The dialog stays open to show the summary -- close it so its backdrop
    // doesn't intercept clicks on the table underneath.
    await page.getByRole("button", { name: "Close" }).click();

    // Search narrows the (potentially 10,000+ row) table down to just this patient.
    await openTextFilter(page, "Patient ID", fixtureMeta.patientCode);
    const row = page.locator("tr").filter({ hasText: fixtureMeta.patientCode });
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row.getByRole("cell", { name: "E2E", exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: "TestPatient", exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Show details" }).click();
    await expect(page.getByText("No additional information on file.")).toBeVisible();

    await deletePatientByCode(page.request, token, fixtureMeta.patientCode);
  });

  // An inline edit is persisted server-side, not just reflected in optimistic client state.
  test("editing a patient inline persists the change and survives a page reload", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard");

    const editCode = `${fixtureMeta.patientCode}-EDIT`;
    await uploadOneRow(page, editCode);

    await openTextFilter(page, "Patient ID", editCode);
    const row = page.locator("tr").filter({ hasText: editCode });
    await expect(row).toBeVisible({ timeout: 5000 });

    await row.getByRole("button", { name: "Edit" }).click();
    // First name is the first of the two plain <input>s in edit mode
    // (first name, last name); getByDisplayValue is a Page-level locator,
    // not available on a row Locator, so target it positionally instead.
    await row.locator("input").first().fill("Updated");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("cell", { name: "Updated", exact: true })).toBeVisible({ timeout: 5000 });

    // Reload to confirm the edit was actually persisted server-side, not
    // just reflected in optimistic client state.
    await page.reload();
    await openTextFilter(page, "Patient ID", editCode);
    const rowAfterReload = page.locator("tr").filter({ hasText: editCode });
    await expect(rowAfterReload.getByRole("cell", { name: "Updated", exact: true })).toBeVisible({ timeout: 5000 });

    await deletePatientByCode(page.request, token, editCode);
  });

  // A whole-file rejection's backend message reaches the UI unmodified.
  test("a backend validation error on upload surfaces verbatim in the frontend", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard");

    // A workbook with the wrong header is a whole-file rejection
    // (PatientImportError), returned as a 422 with a specific detail
    // message -- this confirms that exact backend message reaches the UI,
    // not a generic fallback.
    await page.getByRole("button", { name: "Import patients (.xlsx)" }).click();
    await page.setInputFiles('input[type="file"]', {
      name: "bad-header.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: badHeaderWorkbook(),
    });
    await page.getByRole("button", { name: "Upload" }).click();

    await expect(page.getByText(/Header row does not match the required columns/)).toBeVisible({
      timeout: 10000,
    });
  });
});
