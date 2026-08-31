import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiGetPatientsMock = jest.fn();
const apiUploadFileWithProgressMock = jest.fn();
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown = null) {
      super("failed");
      this.status = status;
      this.body = body;
    }
  },
  apiGetPatients: (...args: unknown[]) => apiGetPatientsMock(...args),
  apiPatchPatient: jest.fn(),
  apiUploadFileWithProgress: (...args: unknown[]) => apiUploadFileWithProgressMock(...args),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import PatientTable from "@/components/PatientTable";
import type { PatientRead, UserRead } from "@/lib/types";

const EDIT_PERMISSION = { id: 1, code: "patient.edit", resource: "patient", action: "edit", description: null };
// The upload dialog is gated on patient.create -- uploading a batch of records
// is a create, not an edit of existing ones (see backend/app/routers/patients.py).
const CREATE_PERMISSION = { id: 2, code: "patient.create", resource: "patient", action: "create", description: null };

function makeUser(): UserRead {
  return {
    id: "u1", email: "a@b.com", username: "a", first_name: "A", last_name: "B", status: "active",
    failed_login_count: 0, locked_until: null, last_login_at: null, password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    role: { id: 1, name: "manager", display_name: "Manager", parent_role_id: null, description: null, is_active: true, permissions: [EDIT_PERMISSION, CREATE_PERMISSION] },
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

function makeFile(name: string, bytes: number) {
  const file = new File([new Uint8Array(bytes)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

function fileInput() {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

// Opens the Import dialog from the table's toolbar -- every test below needs
// the dialog open before the drop zone's file input exists in the DOM at all.
async function openImportDialog() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Import patients (.xlsx)" }));
}

describe("integration: patient table import -> reload flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthMock.mockReturnValue({ currentUser: makeUser() });
  });

  // A successful upload triggers the table to reload and shows the new patient, without a page navigation.
  it("a successful upload triggers the table to reload and shows the new patient", async () => {
    apiGetPatientsMock
      .mockResolvedValueOnce({ items: [makePatient()], total: 1 })
      .mockResolvedValueOnce({ items: [makePatient(), makePatient({ id: "p2", patient_code: "P-002", first_name: "Grace", last_name: "Hopper" })], total: 2 });
    apiUploadFileWithProgressMock.mockResolvedValue({ accepted: 1, rejected: [], upload_id: "u1" });

    render(<PatientTable />);
    await screen.findByText("P-001");
    expect(apiGetPatientsMock).toHaveBeenCalledTimes(1);

    await openImportDialog();
    fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
    await screen.findByText("patients.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await screen.findByText("1 of 1 records processed.");
    await waitFor(() => expect(apiGetPatientsMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("P-002")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
  });

  // A failed upload leaves the table exactly as it was, with no reload triggered.
  it("a failed upload leaves the table exactly as it was, with no reload triggered", async () => {
    apiGetPatientsMock.mockResolvedValue({ items: [makePatient()], total: 1 });
    apiUploadFileWithProgressMock.mockRejectedValue(new Error("network down"));

    render(<PatientTable />);
    await screen.findByText("P-001");
    apiGetPatientsMock.mockClear();

    await openImportDialog();
    fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
    await screen.findByText("patients.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not process this file. Please try again.");
    expect(apiGetPatientsMock).not.toHaveBeenCalled();
    expect(screen.getByText("P-001")).toBeInTheDocument();
  });

  // Double clicking upload rapidly still only creates one upload request and one table reload.
  it("double clicking upload rapidly still only creates one upload request and one table reload", async () => {
    apiGetPatientsMock.mockResolvedValue({ items: [makePatient()], total: 1 });
    apiUploadFileWithProgressMock.mockResolvedValue({ accepted: 1, rejected: [], upload_id: "u1" });

    render(<PatientTable />);
    await screen.findByText("P-001");
    apiGetPatientsMock.mockClear();

    await openImportDialog();
    fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
    await screen.findByText("patients.xlsx");

    const uploadButton = screen.getByRole("button", { name: "Upload" });
    fireEvent.click(uploadButton);
    fireEvent.click(uploadButton); // the button is disabled the instant the first click starts uploading

    await waitFor(() => expect(apiUploadFileWithProgressMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiGetPatientsMock).toHaveBeenCalledTimes(1));
  });

  // Starting an upload then unmounting the whole table before it resolves does not throw.
  it("starting an upload then unmounting the whole table before it resolves does not throw", async () => {
    apiGetPatientsMock.mockResolvedValue({ items: [makePatient()], total: 1 });
    let resolveUpload!: (value: unknown) => void;
    apiUploadFileWithProgressMock.mockReturnValue(new Promise((resolve) => (resolveUpload = resolve)));

    const { unmount } = render(<PatientTable />);
    await screen.findByText("P-001");

    await openImportDialog();
    fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
    await screen.findByText("patients.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(() => unmount()).not.toThrow();
    // Resolving after unmount must not throw either -- UploadDialog's
    // setState calls land on an already-unmounted component.
    expect(() => resolveUpload({ accepted: 1, rejected: [], upload_id: "u1" })).not.toThrow();
  });
});
