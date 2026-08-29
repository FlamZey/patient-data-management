import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
import { ApiError } from "@/lib/api";
import type { PatientRead, UserRead } from "@/lib/types";

const EDIT_PERMISSION = { id: 1, code: "patient.edit", resource: "patient", action: "edit", description: null };

function makeUser(permissions: typeof EDIT_PERMISSION[] = [EDIT_PERMISSION]): UserRead {
  return {
    id: "u1", email: "a@b.com", username: "a", first_name: "A", last_name: "B", status: "active",
    failed_login_count: 0, locked_until: null, last_login_at: null, password_changed_at: null,
    role: { id: 1, name: "manager", display_name: "Manager", parent_role_id: null, description: null, is_active: true, permissions },
    location: { id: 1, code: "US", name: "United States", is_active: true },
    team: null,
  };
}

function makePatient(overrides: Partial<PatientRead> = {}): PatientRead {
  return {
    id: "p1", patient_code: "P-001", first_name: "Ada", last_name: "Lovelace",
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

function setUser(user: UserRead | null) {
  useAuthMock.mockReturnValue({ currentUser: user });
}

describe("components/PatientTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUser(makeUser());
    apiGetPatientsMock.mockResolvedValue({ items: [makePatient()], total: 1 });
    // jsdom has no scrollIntoView -- DataTableCard calls it when a row's
    // detail panel opens.
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  // Loads and renders a table row for each patient returned by the server.
  it("loads and renders a table row for each patient returned by the server", async () => {
    render(<PatientTable />);
    expect(await screen.findByText("P-001")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Lovelace")).toBeInTheDocument();
  });

  // Shows a retry button and reloads when the initial load fails.
  it("shows a retry button and reloads when the initial load fails", async () => {
    apiGetPatientsMock.mockRejectedValueOnce(new Error("network down"));
    render(<PatientTable />);
    const retry = await screen.findByRole("button", { name: "Retry" });

    apiGetPatientsMock.mockResolvedValueOnce({ items: [makePatient()], total: 1 });
    fireEvent.click(retry);
    expect(await screen.findByText("P-001")).toBeInTheDocument();
  });

  // Hides the actions column entirely for a user without patient.edit.
  it("hides the actions column entirely for a user without patient.edit", async () => {
    setUser(makeUser([]));
    render(<PatientTable />);
    await screen.findByText("P-001");
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  // Sends a debounced patient code filter to the server instead of one request per keystroke.
  it("sends a debounced patient code filter to the server", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    render(<PatientTable />);
    await screen.findByText("P-001");
    apiGetPatientsMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Filter by Patient ID" }));
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.change(input, { target: { value: "P" } });
    fireEvent.change(input, { target: { value: "P-" } });
    fireEvent.change(input, { target: { value: "P-0" } });

    // No request yet -- still within the debounce window.
    expect(apiGetPatientsMock).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => expect(apiGetPatientsMock).toHaveBeenCalledTimes(1));
    expect(apiGetPatientsMock).toHaveBeenCalledWith(expect.objectContaining({ patient_code: "P-0" }));
    jest.useRealTimers();
  });

  // Unchecking every gender option short circuits to zero rows instead of sending an empty filter.
  it("unchecking every gender option short circuits to zero rows instead of querying the server", async () => {
    render(<PatientTable />);
    await screen.findByText("P-001");
    apiGetPatientsMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Filter by Gender" }));
    fireEvent.click(screen.getByLabelText("(Select All)")); // fully checked -> unchecks all

    await waitFor(() => expect(screen.getByText("No patients found.")).toBeInTheDocument());
    // The short-circuit in loadPatients returns early -- no request sent for zero-gender.
    expect(apiGetPatientsMock).not.toHaveBeenCalled();
  });

  // Sends only the narrowed gender values, omitting the param entirely when every option is checked.
  it("sends only the narrowed gender values when the checklist is narrowed", async () => {
    render(<PatientTable />);
    await screen.findByText("P-001");
    apiGetPatientsMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Filter by Gender" }));
    fireEvent.click(screen.getByLabelText("Male")); // uncheck just Male

    await waitFor(() => expect(apiGetPatientsMock).toHaveBeenCalled());
    expect(apiGetPatientsMock).toHaveBeenCalledWith(
      expect.objectContaining({ gender: ["Female", "Other", "Prefer not to say"] }),
    );
  });

  // Clicking a sortable column header sorts by that column via the server.
  it("clicking a sortable column header sorts by that column via the server", async () => {
    render(<PatientTable />);
    await screen.findByText("P-001");
    apiGetPatientsMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "First Name" }));

    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenCalledWith(expect.objectContaining({ sort_by: "first_name", sort_dir: "asc" })),
    );
  });

  // Requests the next page and resets to page 1 when a filter changes afterward.
  it("requests the next page and resets to page 1 when a filter changes afterward", async () => {
    apiGetPatientsMock.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, i) => makePatient({ id: `p${i}`, patient_code: `P-${i}` })),
      total: 60,
    });
    render(<PatientTable />);
    await screen.findByText("P-0");
    apiGetPatientsMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(apiGetPatientsMock).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })));

    apiGetPatientsMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Filter by Gender" }));
    fireEvent.click(screen.getByLabelText("Male"));

    await waitFor(() => expect(apiGetPatientsMock).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })));
  });

  // Reloads when refreshSignal changes, e.g. after a parent-driven upload.
  it("reloads when refreshSignal changes", async () => {
    const { rerender } = render(<PatientTable refreshSignal={0} />);
    await screen.findByText("P-001");
    expect(apiGetPatientsMock).toHaveBeenCalledTimes(1);

    rerender(<PatientTable refreshSignal={1} />);
    await waitFor(() => expect(apiGetPatientsMock).toHaveBeenCalledTimes(2));
  });

  describe("inline editing", () => {
    // Entering edit mode swaps first/last name to inputs seeded with the row's current values.
    it("entering edit mode swaps first and last name to inputs seeded with the row's current values", async () => {
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      expect(screen.getByDisplayValue("Ada")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Lovelace")).toBeInTheDocument();
    });

    // Save stays enabled for a draft that's already valid (the date/gender error paths are
    // UI-unreachable backstops -- DatePickerField and the gender <select> only ever offer
    // valid values, per validateDraft's own comment).
    it("save stays enabled for a draft seeded from a valid existing row", async () => {
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });

    // The gender select only offers the closed set of valid options.
    it("the gender select only offers the closed set of valid options", async () => {
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      // Scope past the footer's page-size <select>, the other combobox on screen.
      const row = screen.getByRole("button", { name: "Save" }).closest("tr")!;
      const genderSelect = within(row).getByRole("combobox");
      const optionLabels = within(genderSelect)
        .getAllByRole("option")
        .map((option) => option.textContent);
      expect(optionLabels).toEqual(["Male", "Female", "Other", "Prefer not to say"]);
    });

    // Saving with no changed fields sends an empty patch and the row shows the server response.
    it("saves changed fields and reflects the server's returned row", async () => {
      const user = userEvent.setup();
      apiPatchPatientMock.mockResolvedValue(makePatient({ first_name: "Grace" }));
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const firstNameInput = screen.getByDisplayValue("Ada");
      await user.clear(firstNameInput);
      await user.type(firstNameInput, "Grace");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(apiPatchPatientMock).toHaveBeenCalledWith("p1", { first_name: "Grace" }));
      expect(await screen.findByText("Grace")).toBeInTheDocument();
    });

    // Rolls back to the original row and shows a not found message when the save fails with a 404.
    it("rolls back to the original row and shows a not found message when the save fails with a 404", async () => {
      const user = userEvent.setup();
      apiPatchPatientMock.mockRejectedValue(new ApiError(404));
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const firstNameInput = screen.getByDisplayValue("Ada");
      await user.clear(firstNameInput);
      await user.type(firstNameInput, "Grace");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This patient no longer exists. Refresh to update the list.",
      );
      expect(screen.getByText("Ada")).toBeInTheDocument();
    });

    // Rolls back and shows a generic error message for a non-404 save failure.
    it("rolls back and shows a generic error message for a non-404 save failure", async () => {
      const user = userEvent.setup();
      apiPatchPatientMock.mockRejectedValue(new Error("network down"));
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const firstNameInput = screen.getByDisplayValue("Ada");
      await user.clear(firstNameInput);
      await user.type(firstNameInput, "Grace");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Could not save changes. Please try again.");
    });

    // Cancel discards the draft and leaves the row unchanged.
    it("cancel discards the draft and leaves the row unchanged", async () => {
      const user = userEvent.setup();
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const firstNameInput = screen.getByDisplayValue("Ada");
      await user.clear(firstNameInput);
      await user.type(firstNameInput, "Someone Else");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.getByText("Ada")).toBeInTheDocument();
      expect(apiPatchPatientMock).not.toHaveBeenCalled();
    });
  });

  describe("expandable detail panel", () => {
    // Shows the no additional information message when every optional field is empty.
    it("shows the no additional information message when every optional field is empty", async () => {
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Show details" }));

      expect(screen.getByText("No additional information on file.")).toBeInTheDocument();
    });

    // Groups populated optional fields into labeled sections and skips empty groups.
    it("groups populated optional fields into labeled sections and skips empty groups", async () => {
      apiGetPatientsMock.mockResolvedValue({
        items: [makePatient({ city: "Springfield", allergies: ["Penicillin"], height_in: 68 })],
        total: 1,
      });
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Show details" }));

      expect(screen.getByText("Address")).toBeInTheDocument();
      expect(screen.getByText("Springfield")).toBeInTheDocument();
      expect(screen.getByText("Penicillin")).toBeInTheDocument();
      expect(screen.getByText("68 in")).toBeInTheDocument();
      // "Contact" has no populated fields for this patient -- must not render.
      expect(screen.queryByText("Contact")).not.toBeInTheDocument();
    });

    // Toggling the button again collapses the panel.
    it("toggling the button again collapses the panel", async () => {
      render(<PatientTable />);
      await screen.findByText("P-001");
      fireEvent.click(screen.getByRole("button", { name: "Show details" }));
      expect(screen.getByText("No additional information on file.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
      expect(screen.queryByText("No additional information on file.")).not.toBeInTheDocument();
    });
  });
});
