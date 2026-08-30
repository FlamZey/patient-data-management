import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiGetPatientsMock = jest.fn();
const apiPatchPatientMock = jest.fn();
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super("failed");
      this.status = status;
    }
  },
  apiGetPatients: (...args: unknown[]) => apiGetPatientsMock(...args),
  apiPatchPatient: (...args: unknown[]) => apiPatchPatientMock(...args),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import PatientTable from "@/components/PatientTable";
import type { PatientRead, UserRead } from "@/lib/types";

const EDIT_PERMISSION = { id: 1, code: "patient.edit", resource: "patient", action: "edit", description: null };

function makeUser(): UserRead {
  return {
    id: "u1", email: "a@b.com", username: "a", first_name: "A", last_name: "B", status: "active",
    failed_login_count: 0, locked_until: null, last_login_at: null, password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    role: { id: 1, name: "manager", display_name: "Manager", parent_role_id: null, description: null, is_active: true, permissions: [EDIT_PERMISSION] },
    location: { id: 1, code: "US", name: "United States", is_active: true },
    team: null,
  };
}

function makePatient(overrides: Partial<PatientRead> = {}): PatientRead {
  return {
    id: overrides.id ?? "p1", patient_code: "P-001", first_name: "Ada", last_name: "Lovelace",
    date_of_birth: "1990-01-15", gender: "Female",
    street_address: null, city: null, state: null, zip_code: null, phone: null, email: null,
    emergency_contact_name: null, emergency_contact_relationship: null, emergency_contact_phone: null,
    preferred_language: null, race_ethnicity: null, marital_status: null, occupation: null,
    insurance_provider: null, policy_number: null, pcp_name: null, care_department: null,
    registration_date: null, last_visit_date: null, preferred_pharmacy: null, blood_type: null,
    height_in: null, weight_lbs: null, systolic_bp: null, diastolic_bp: null,
    allergies: null, current_medications: null, chronic_conditions: null, immunization_history: null,
    smoking_status: null, alcohol_use: null,
    uploaded_by: "u1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  } as PatientRead;
}

function rowFor(code: string): HTMLTableRowElement {
  const row = screen.getByText(code).closest("tr");
  if (!row) throw new Error(`no <tr> for ${code}`);
  return row as HTMLTableRowElement;
}

// The row entrance animation (animate-rise-in, staggered via animationDelay)
// is a CSS animation on a mounted <tr>. It replays in exactly two cases:
// the class gets removed and re-added, or the <tr> is remounted. So these
// tests assert on DOM node identity and on the class staying put -- that is
// what actually determines whether a user sees the row re-enter.
describe("integration: PatientTable row entrance animation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthMock.mockReturnValue({ currentUser: makeUser() });
    apiGetPatientsMock.mockResolvedValue({ items: [makePatient()], total: 1 });
    // jsdom has no scrollIntoView or element-level scrollBy -- DataTableCard
    // calls both when a row's detail panel opens.
    HTMLElement.prototype.scrollIntoView = jest.fn();
    HTMLElement.prototype.scrollBy = jest.fn();
  });

  it("rows carry the staggered entrance animation on first load", async () => {
    apiGetPatientsMock.mockResolvedValue({
      items: [makePatient({ id: "p1", patient_code: "P-001" }), makePatient({ id: "p2", patient_code: "P-002" })],
      total: 2,
    });
    render(<PatientTable />);
    await screen.findByText("P-001");

    expect(rowFor("P-001")).toHaveClass("animate-rise-in");
    expect(rowFor("P-002")).toHaveClass("animate-rise-in");
    // Second row starts one stagger step later than the first.
    expect(rowFor("P-001").style.animationDelay).toBe("0s");
    expect(rowFor("P-002").style.animationDelay).toBe("0.04s");
  });

  it("opening and closing a row's details never re-enters the row", async () => {
    render(<PatientTable />);
    await screen.findByText("P-001");
    const before = rowFor("P-001");

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    await screen.findByRole("button", { name: "Hide details" });
    // Same DOM node, and the class never left it -- so no replay.
    expect(rowFor("P-001")).toBe(before);
    expect(rowFor("P-001")).toHaveClass("animate-rise-in");

    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    await screen.findByRole("button", { name: "Show details" });
    expect(rowFor("P-001")).toBe(before);
    expect(rowFor("P-001")).toHaveClass("animate-rise-in");
  });

  it("entering, cancelling, and saving an edit never re-enters the row", async () => {
    apiPatchPatientMock.mockResolvedValue(makePatient({ first_name: "Grace" }));
    render(<PatientTable />);
    await screen.findByText("P-001");
    const before = rowFor("P-001");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Cancel" });
    expect(rowFor("P-001")).toBe(before);
    expect(rowFor("P-001")).toHaveClass("animate-rise-in");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Edit" });
    expect(rowFor("P-001")).toBe(before);
    expect(rowFor("P-001")).toHaveClass("animate-rise-in");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Ada"), { target: { value: "Grace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Edit" });
    expect(rowFor("P-001")).toBe(before);
    expect(rowFor("P-001")).toHaveClass("animate-rise-in");
  });

  it("does not re-enter the outgoing rows while the next page is still loading", async () => {
    apiGetPatientsMock.mockResolvedValue({
      items: [makePatient({ id: "p1", patient_code: "P-001" })],
      total: 60,
    });
    render(<PatientTable />);
    await screen.findByText("P-001");
    const outgoing = rowFor("P-001");

    // Hold page 2's response open so the outgoing page stays on screen --
    // `page` has already advanced while `rows` still holds page 1.
    let resolvePage2: (value: { items: PatientRead[]; total: number }) => void = () => {};
    apiGetPatientsMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePage2 = resolve;
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }), expect.anything()),
    );

    // The row still showing is the same node it was -- it must not have
    // remounted (and replayed its entrance) just because `page` changed.
    expect(rowFor("P-001")).toBe(outgoing);

    resolvePage2({ items: [makePatient({ id: "p2", patient_code: "P-002" })], total: 60 });
    await screen.findByText("P-002");

    // Now the new page's rows are genuinely new nodes, so they do animate.
    expect(rowFor("P-002")).not.toBe(outgoing);
    expect(rowFor("P-002")).toHaveClass("animate-rise-in");
  });
});
