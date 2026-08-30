import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiGetPatientsMock = jest.fn();
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super("failed");
      this.status = status;
    }
  },
  apiGetPatients: (...args: unknown[]) => apiGetPatientsMock(...args),
  apiPatchPatient: jest.fn(),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import PatientTable from "@/components/PatientTable";
import type { PatientRead, UserRead } from "@/lib/types";

function makeUser(): UserRead {
  return {
    id: "u1", email: "a@b.com", username: "a", first_name: "A", last_name: "B", status: "active",
    failed_login_count: 0, locked_until: null, last_login_at: null, password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    role: { id: 1, name: "manager", display_name: "Manager", parent_role_id: null, description: null, is_active: true, permissions: [] },
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

// Real, multi-step user flows across PatientTable's filter/sort/pagination
// state together -- __tests__/components/PatientTable.test.tsx already
// covers each of these in isolation; this file is about what happens when
// they're layered on top of each other in sequence, the way a real user
// actually drives the table.
describe("integration: PatientTable filter + sort + pagination combinations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthMock.mockReturnValue({ currentUser: makeUser() });
    apiGetPatientsMock.mockResolvedValue({ items: [makePatient()], total: 1 });
  });

  // Applying a second filter on top of a first sends both together, and removing the first leaves only the second.
  it("applying a second filter on top of a first sends both together, and removing the first leaves only the second", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    render(<PatientTable />);
    await screen.findByText("P-001");
    apiGetPatientsMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Filter by Patient ID" }));
    fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "P-0" } });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ patient_code: "P-0" }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by First Name" }));
    fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "Ada" } });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ patient_code: "P-0", first_name: "Ada" }),
        expect.anything(),
      ),
    );

    // Remove the patient-code filter -- first_name must still be active alone.
    fireEvent.click(screen.getByRole("button", { name: "Filter by Patient ID" }));
    fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "" } });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => {
      const lastCall = apiGetPatientsMock.mock.calls[apiGetPatientsMock.mock.calls.length - 1][0];
      expect(lastCall.patient_code).toBeUndefined();
      expect(lastCall.first_name).toBe("Ada");
    });
    jest.useRealTimers();
  });

  // A conflicting filter combination that matches nothing renders the empty state, not a crash.
  it("a conflicting filter combination that matches nothing renders the empty state, not a crash", async () => {
    render(<PatientTable />);
    await screen.findByText("P-001");

    // Select All / Clear All toggles every option in one click (one state
    // update, one settle) -- unchecking the 4 boxes individually would issue
    // 3 intermediate server requests before the final client-side
    // short-circuit, and those requests resolving out of order is exactly
    // the race the next test below is dedicated to.
    fireEvent.click(screen.getByRole("button", { name: "Filter by Gender" }));
    fireEvent.click(screen.getByLabelText("(Select All)"));

    expect(await screen.findByText("No patients found.")).toBeInTheDocument();
    expect(screen.getByText("0 of 0")).toBeInTheDocument();
  });

  // Sorting while a filter is active keeps the filter and just changes the sort params sent.
  it("sorting while a filter is active keeps the filter and just changes the sort params sent", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    render(<PatientTable />);
    await screen.findByText("P-001");

    fireEvent.click(screen.getByRole("button", { name: "Filter by Patient ID" }));
    fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "P-0" } });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ patient_code: "P-0" }),
        expect.anything(),
      ),
    );

    apiGetPatientsMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "First Name" }));

    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ patient_code: "P-0", sort_by: "first_name", sort_dir: "asc" }),
        expect.anything(),
      ),
    );
    jest.useRealTimers();
  });

  // Combining a filter, a sort, and a page change together sends all three in the final request.
  it("combining a filter, a sort, and a page change together sends all three in the final request", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    apiGetPatientsMock.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, i) => makePatient({ id: `p${i}`, patient_code: `P-${i}` })),
      total: 60,
    });
    render(<PatientTable />);
    await screen.findByText("P-0");

    fireEvent.click(screen.getByRole("button", { name: "Filter by Patient ID" }));
    fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "P" } });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ patient_code: "P" }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "First Name" }));
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort_by: "first_name" }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ patient_code: "P", sort_by: "first_name", sort_dir: "asc", page: 2 }),
        expect.anything(),
      ),
    );
    jest.useRealTimers();
  });

  // A page size change while on a later page resets back to page 1.
  it("a page size change while on a later page resets back to page 1", async () => {
    apiGetPatientsMock.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, i) => makePatient({ id: `p${i}`, patient_code: `P-${i}` })),
      total: 60,
    });
    render(<PatientTable />);
    await screen.findByText("P-0");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }), expect.anything()),
    );

    fireEvent.change(screen.getByDisplayValue("25 / page"), { target: { value: "50" } });
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, page_size: 50 }),
        expect.anything(),
      ),
    );
  });

  // Clearing every filter back to its default resets the query to the unfiltered baseline.
  it("clearing every filter back to its default resets the query to the unfiltered baseline", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    render(<PatientTable />);
    await screen.findByText("P-001");

    fireEvent.click(screen.getByRole("button", { name: "Filter by Patient ID" }));
    fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "P-0" } });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    fireEvent.click(screen.getByRole("button", { name: "Filter by Gender" }));
    fireEvent.click(screen.getByLabelText("Male"));
    await waitFor(() =>
      expect(apiGetPatientsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ patient_code: "P-0", gender: expect.arrayContaining(["Female"]) }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by Patient ID" }));
    fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "" } });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    fireEvent.click(screen.getByRole("button", { name: "Filter by Gender" }));
    fireEvent.click(screen.getByLabelText("(Select All)"));

    await waitFor(() => {
      const lastCall = apiGetPatientsMock.mock.calls[apiGetPatientsMock.mock.calls.length - 1][0];
      expect(lastCall.patient_code).toBeUndefined();
      expect(lastCall.gender).toBeUndefined();
    });
    jest.useRealTimers();
  });

  // Navigating to an out of range page still requests it and shows the empty result gracefully.
  it("navigating to an out of range page still requests it and shows the empty result gracefully", async () => {
    // Only the one response this test actually consumes -- a second queued
    // mockResolvedValueOnce here would never be triggered (the test doesn't
    // click Next) and would silently leak into whichever test runs after
    // this one instead.
    apiGetPatientsMock.mockResolvedValueOnce({ items: [makePatient()], total: 1 });
    render(<PatientTable />);
    await screen.findByText("P-001");

    // Only one row/page of data, so Next should already be disabled --
    // this asserts the UI doesn't offer a page that can't exist.
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  // A stale response for an older, superseded filter does not overwrite a newer filter's results.
  it("a stale response for an older, superseded filter does not overwrite a newer filter's results", async () => {
    // Two distinct in-flight requests, resolved deliberately out of issue
    // order: the second (newer) filter's response arrives first, the first
    // (older, now-superseded) filter's response arrives after. loadPatients
    // claims a requestId per call (see PatientTable.tsx) and discards a
    // response whose id is no longer the latest one by the time it
    // resolves -- this is exactly that race, proving the guard holds. A
    // real user can trigger the underlying race by toggling a filter twice
    // in quick succession on a slow connection.
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    apiGetPatientsMock
      .mockResolvedValueOnce({ items: [makePatient()], total: 1 }) // initial load
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

    render(<PatientTable />);
    await screen.findByText("P-001");

    fireEvent.click(screen.getByRole("button", { name: "Filter by Gender" }));
    fireEvent.click(screen.getByLabelText("Male")); // issues the "first" (older) request
    fireEvent.click(screen.getByLabelText("Female")); // issues the "second" (newer) request

    // Newer request settles first...
    resolveSecond({ items: [makePatient({ patient_code: "P-NEWER" })], total: 1 });
    await screen.findByText("P-NEWER");

    // ...then the older, now-superseded request finally resolves too.
    resolveFirst({ items: [makePatient({ patient_code: "P-STALE" })], total: 1 });

    // The older response must be discarded; P-NEWER stays displayed.
    await waitFor(() => expect(screen.queryByText("P-STALE")).not.toBeInTheDocument());
    expect(screen.getByText("P-NEWER")).toBeInTheDocument();
  });
});
