import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.join(__dirname, "../..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// Runs once before the whole E2E suite. This suite runs against the real
// docker-compose stack (db + backend + frontend) on the ports docs/README.md
// describes, not against mocks -- so this step makes sure that stack is
// actually up, its demo accounts exist, and there's a fresh, uniquely-coded
// patient upload fixture no other test run could have already claimed.
//
// Deliberately NOT resetting/truncating the database: doing so would also
// wipe whatever patient/user data already lives in the shared dev database,
// which is destructive to state this suite doesn't own. Isolation instead
// comes from every test creating its own uniquely-named/coded rows (a
// per-run timestamp suffix) and, where practical, deleting them again as
// part of the test itself -- see patient-crud.spec.ts and
// user-management-crud.spec.ts.
export default async function globalSetup() {
  const backendUrl = "http://localhost:8000";

  let reachable = false;
  for (let attempt = 0; attempt < 10 && !reachable; attempt += 1) {
    try {
      const res = await fetch(`${backendUrl}/health`);
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!reachable) {
    throw new Error(
      `Backend at ${backendUrl} is not reachable. Run "docker compose up" first (see README.md's E2E instructions).`,
    );
  }

  // Idempotent -- only fills in whatever demo rows (roles/locations/teams/
  // permissions/DEMO_USERS) are missing, never duplicates or errors against
  // an already-seeded database. Guarantees admin.us@example.com exists with
  // the password every spec below logs in with, regardless of what else is
  // in this database.
  execSync("docker compose exec -T backend python -m app.seed", {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  // A run-unique patient code (timestamp-based) so this run's upload fixture
  // can never collide with another patient already in the shared database,
  // across repeated runs or parallel workers.
  const patientCode = `E2E-${Date.now()}`;

  // Written as a real .py file on the host (bind-mounted into the backend
  // container at the same relative path) and run by its filename, rather
  // than inlined as a `python -c "<multi-line string>"` argument -- cmd.exe
  // (Windows' default shell for child_process) mangles a quoted argument
  // containing literal newlines, silently truncating/splitting it instead
  // of erroring, which made an earlier version of this file appear to
  // "succeed" (exit 0, no thrown error) while never actually writing the
  // fixture.
  writeFileSync(
    path.join(BACKEND_DIR, "e2e_generate_fixture.py"),
    [
      "import openpyxl",
      "wb = openpyxl.Workbook()",
      "ws = wb.active",
      'ws.append(["Patient ID", "First Name", "Last Name", "Date of Birth", "Gender"])',
      `ws.append(["${patientCode}", "E2E", "TestPatient", "1990-01-15", "Female"])`,
      'wb.save("/app/e2e-fixture.xlsx")',
      "",
    ].join("\n"),
  );
  execSync("docker compose exec -T backend python e2e_generate_fixture.py", {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  // Handed to the specs via a small JSON file rather than an env var, so
  // it's trivially readable from any spec file without wiring it through
  // Playwright's config.
  writeFileSync(
    path.join(__dirname, ".e2e-fixture-meta.json"),
    JSON.stringify({
      patientCode,
      workbookPath: path.join(BACKEND_DIR, "e2e-fixture.xlsx"),
    }),
  );
}
