import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, fieldInput, login, openTextFilter } from "./helpers";

function uniqueUser() {
  const suffix = Date.now();
  return {
    email: `e2e-${suffix}@example.com`,
    username: `e2e-${suffix}`,
    firstName: "E2E",
    lastName: `User${suffix}`,
  };
}

test.describe("user management: create -> edit -> suspend journey", () => {
  test("creating a user makes them searchable, editable, and suspendable, all persisting across reload", async ({
    page,
  }) => {
    const user = uniqueUser();

    await login(page);
    await page.goto("/manage-users");

    // --- create ---
    await page.getByRole("button", { name: "Add user" }).click();
    await fieldInput(page, "First name").fill(user.firstName);
    await fieldInput(page, "Last name").fill(user.lastName);
    await fieldInput(page, "Email").fill(user.email);
    await fieldInput(page, "Username").fill(user.username);
    await fieldInput(page, "Password").fill("ValidPass123!");
    // Role/Location are required selects with no default -- pick the first
    // real option in each (index 0 is the blank "Select..." placeholder).
    await fieldInput(page, "Role").selectOption({ index: 1 });
    await fieldInput(page, "Location").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Create user" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // --- search ---
    await openTextFilter(page, "Name", user.lastName);
    // A positional locator, not `.filter({ hasText })`: the search above
    // already narrows the table to this one user server-side, but once
    // Edit is clicked below, this row's name/email/username all become
    // <input>s -- an input's value isn't part of an element's textContent,
    // so a `hasText` filter keyed on visible text stops matching the very
    // moment edit mode starts. Position is stable across that transition;
    // content isn't.
    const row = page.locator("table tbody tr").first();
    await expect(row.getByText(user.email)).toBeVisible({ timeout: 5000 });
    await expect(row.getByText("active", { exact: true })).toBeVisible();

    // --- edit ---
    await row.getByRole("button", { name: "Edit" }).click();
    const updatedLastName = `${user.lastName}-Updated`;
    // Last name is the second of the two name inputs in edit mode.
    await row.locator("input").nth(1).fill(updatedLastName);
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("cell", { name: `${user.firstName} ${updatedLastName}` })).toBeVisible({
      timeout: 5000,
    });

    // --- suspend (this app's "delete" -- a soft delete via status, see
    // UserManagementTable's own comment: no separate delete-gated action) ---
    await row.getByRole("button", { name: "Edit" }).click();
    // Column order is name/email/username/role/location/team/status, so the
    // status select is the last of the row's four <select>s while editing.
    await row.locator("select").last().selectOption("suspended");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText("suspended", { exact: true })).toBeVisible({ timeout: 5000 });

    // --- confirm the suspension persisted server-side, not just optimistically ---
    await page.reload();
    await openTextFilter(page, "Name", updatedLastName);
    const rowAfterReload = page.locator("table tbody tr").first();
    await expect(rowAfterReload.getByText("suspended", { exact: true })).toBeVisible({ timeout: 5000 });
  });

  // A duplicate email on create surfaces the backend's exact 409 conflict message.
  test("a duplicate email on create surfaces the backend's exact conflict message", async ({ page }) => {
    await login(page);
    await page.goto("/manage-users");

    await page.getByRole("button", { name: "Add user" }).click();
    const suffix = Date.now();
    await fieldInput(page, "First name").fill("Dup");
    await fieldInput(page, "Last name").fill("Licate");
    // Deliberately reuse a known-seeded email (see backend/app/seed.py's
    // DEMO_USERS) to trigger a real 409 from the backend.
    await fieldInput(page, "Email").fill(ADMIN_EMAIL);
    await fieldInput(page, "Username").fill(`dup-${suffix}`);
    await fieldInput(page, "Password").fill("ValidPass123!");
    await fieldInput(page, "Role").selectOption({ index: 1 });
    await fieldInput(page, "Location").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Create user" }).click();

    await expect(page.getByText("This email is already in use.")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("dialog")).toBeVisible(); // stays open so the user can correct it
  });
});
