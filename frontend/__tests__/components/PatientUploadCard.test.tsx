import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  apiUploadFileWithProgress: (...args: unknown[]) => apiUploadFileWithProgressMock(...args),
}));

// The card owns its own patient.create check, so it reads the signed-in user
// -- mocked here so these tests can render it without an AuthProvider.
const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import PatientUploadCard from "@/components/PatientUploadCard";
import { ApiError } from "@/lib/api";

const CREATE_PERMISSION = {
  id: 1,
  code: "patient.create",
  resource: "patient",
  action: "create",
  description: null,
};

// A signed-in user holding the given permissions, shaped like UserRead.
function authedUser(permissions: unknown[] = [CREATE_PERMISSION]) {
  return {
    currentUser: {
      id: "u1",
      email: "a@b.com",
      username: "a",
      first_name: "A",
      last_name: "B",
      status: "active",
      failed_login_count: 0,
      locked_until: null,
      last_login_at: null,
      password_changed_at: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      role: {
        id: 1,
        name: "manager",
        display_name: "Manager",
        parent_role_id: null,
        description: null,
        is_active: true,
        permissions,
      },
      location: { id: 1, code: "US", name: "United States", is_active: true },
      team: null,
    },
  };
}

function makeFile(name: string, bytes: number, type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
  const file = new File([new Uint8Array(bytes)], name, { type });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

function fileInput() {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

// Opens the dialog from the trigger button -- every interaction below
// happens inside it, so this is the shared first step almost every test needs.
async function renderAndOpen() {
  const user = userEvent.setup();
  render(<PatientUploadCard />);
  await user.click(screen.getByRole("button", { name: "Import patients (.xlsx)" }));
}

describe("components/PatientUploadCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default actor can upload; the gating tests below override this.
    useAuthMock.mockReturnValue(authedUser());
  });

  // --- permission gating ---------------------------------------------------
  // POST /patients/upload requires patient.create, so a caller without it is
  // offered nothing. The backend refuses regardless -- this is about not
  // showing a control whose only possible outcome is a 403.

  // Renders nothing without patient.create.
  it("renders nothing when the user lacks patient.create", () => {
    useAuthMock.mockReturnValue(authedUser([]));
    const { container } = render(<PatientUploadCard />);
    expect(container).toBeEmptyDOMElement();
  });

  // A different patient permission is not enough.
  it("renders nothing when the user holds only patient.edit", () => {
    useAuthMock.mockReturnValue(
      authedUser([{ id: 2, code: "patient.edit", resource: "patient", action: "edit", description: null }]),
    );
    const { container } = render(<PatientUploadCard />);
    expect(container).toBeEmptyDOMElement();
  });

  // Renders nothing when auth has not resolved yet.
  it("renders nothing before the session resolves", () => {
    useAuthMock.mockReturnValue({ currentUser: null });
    const { container } = render(<PatientUploadCard />);
    expect(container).toBeEmptyDOMElement();
  });

  // Renders just the trigger button with patient.create -- no dialog until clicked.
  it("renders the Import button, with no dialog, when the user holds patient.create", () => {
    render(<PatientUploadCard />);
    expect(screen.getByRole("button", { name: "Import patients (.xlsx)" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Clicking the trigger opens the dialog with an empty drop zone and no selected-file preview.
  it("opens the dialog with an empty drop zone and no selected-file preview", async () => {
    await renderAndOpen();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a patient upload file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
  });

  // Closing and reopening the dialog starts fresh -- a file picked in a prior
  // open doesn't linger, since UploadDialog only mounts while open.
  it("starts fresh on reopen -- a previously selected file does not linger", async () => {
    const user = userEvent.setup();
    await renderAndOpen();
    fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
    await screen.findByText("patients.xlsx");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import patients (.xlsx)" }));
    expect(screen.queryByText("patients.xlsx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a patient upload file" })).toBeInTheDocument();
  });

  // Closes on backdrop click but not on a click inside the dialog itself.
  it("closes on backdrop click but not on a click inside the dialog itself", async () => {
    const user = userEvent.setup();
    await renderAndOpen();

    await user.click(screen.getByText("Import patients"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Selecting a valid file via the hidden input shows the file preview with its name and size.
  it("selecting a valid file shows the file preview with its name and size", async () => {
    await renderAndOpen();
    const file = makeFile("patients.xlsx", 2048);
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByText("patients.xlsx")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  // Rejects a disallowed file extension with a client-side error and keeps the drop zone empty.
  it("rejects a disallowed file extension with a client-side error", async () => {
    await renderAndOpen();
    const file = makeFile("patients.csv", 1024);
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Only .xlsx and .xls files are accepted.");
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
  });

  // Rejects a file over the 10mb limit with a client-side error before any network request.
  it("rejects a file over the 10mb limit with a client-side error before any network request", async () => {
    await renderAndOpen();
    const file = makeFile("huge.xlsx", 10 * 1024 * 1024 + 1);
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("File exceeds the 10MB upload limit.");
    expect(apiUploadFileWithProgressMock).not.toHaveBeenCalled();
  });

  // Rejects an empty (zero byte) file's extension the same as any other name that doesn't match, or accepts it if the extension is valid.
  it("accepts a zero byte file with a valid extension, deferring content validation to the server", async () => {
    await renderAndOpen();
    const file = makeFile("empty.xlsx", 0);
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByText("empty.xlsx")).toBeInTheDocument();
    expect(screen.getByText("0 B")).toBeInTheDocument();
  });

  // Highlights the drop zone while a file is dragged over it and un-highlights on drag leave.
  it("highlights the drop zone while dragging over it and un-highlights on drag leave", async () => {
    await renderAndOpen();
    const dropZone = screen.getByRole("button", { name: "Choose a patient upload file" });

    fireEvent.dragOver(dropZone);
    expect(dropZone.className).toContain("border-accent");

    fireEvent.dragLeave(dropZone);
    expect(dropZone.className).not.toContain("border-accent");
  });

  // Dropping a file selects it the same as picking it through the file input.
  it("dropping a file selects it the same as picking it through the file input", async () => {
    await renderAndOpen();
    const dropZone = screen.getByRole("button", { name: "Choose a patient upload file" });
    const file = makeFile("dropped.xlsx", 512);

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    expect(await screen.findByText("dropped.xlsx")).toBeInTheDocument();
  });

  // Remove clears the selected file and returns to the empty drop zone.
  it("remove clears the selected file and returns to the empty drop zone", async () => {
    await renderAndOpen();
    fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
    await screen.findByText("patients.xlsx");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.queryByText("patients.xlsx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a patient upload file" })).toBeInTheDocument();
  });

  // Enter activates the drop zone's file picker like a real button.
  it("enter activates the drop zone's file picker like a real button", async () => {
    await renderAndOpen();
    const dropZone = screen.getByRole("button", { name: "Choose a patient upload file" });
    const clickSpy = jest.spyOn(fileInput(), "click");

    fireEvent.keyDown(dropZone, { key: "Enter" });

    expect(clickSpy).toHaveBeenCalled();
  });

  // Space activates the drop zone's file picker like a real button.
  it("space activates the drop zone's file picker like a real button", async () => {
    await renderAndOpen();
    const dropZone = screen.getByRole("button", { name: "Choose a patient upload file" });
    const clickSpy = jest.spyOn(fileInput(), "click");

    fireEvent.keyDown(dropZone, { key: " " });

    expect(clickSpy).toHaveBeenCalled();
  });

  describe("uploading", () => {
    // Shows an indeterminate progress state before the first server progress event arrives.
    it("shows an indeterminate progress state before the first server progress event arrives", async () => {
      let resolveUpload!: (value: unknown) => void;
      apiUploadFileWithProgressMock.mockReturnValue(new Promise((resolve) => (resolveUpload = resolve)));
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));

      expect(await screen.findByText("Starting...")).toBeInTheDocument();
      resolveUpload({ accepted: 1, rejected: [], upload_id: "u1" });
      await waitFor(() => expect(screen.queryByText("Starting...")).not.toBeInTheDocument());
    });

    // Shows validating and saving phase progress with processed of total counts.
    it("shows validating and saving phase progress with processed of total counts", async () => {
      apiUploadFileWithProgressMock.mockImplementation(async (_path, _file, onProgress) => {
        onProgress({ phase: "validating", processed: 5, total: 10 });
        onProgress({ phase: "saving", processed: 8, total: 10 });
        return { accepted: 10, rejected: [], upload_id: "u1" };
      });
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));

      await waitFor(() => expect(screen.getByText("10 of 10 records processed.")).toBeInTheDocument());
    });

    // Disables upload and hides remove while a request is in flight, preventing a duplicate submit.
    it("disables upload and hides remove while a request is in flight", async () => {
      let resolveUpload!: (value: unknown) => void;
      apiUploadFileWithProgressMock.mockReturnValue(new Promise((resolve) => (resolveUpload = resolve)));
      const user = userEvent.setup();
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");

      const uploadButton = screen.getByRole("button", { name: "Upload" });
      await user.click(uploadButton);
      // A second, rapid click on the now-"Uploading..." button must not fire
      // a second request -- it's disabled the instant isUploading flips true.
      await user.click(screen.getByRole("button", { name: "Uploading..." }));

      expect(apiUploadFileWithProgressMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();

      resolveUpload({ accepted: 1, rejected: [], upload_id: "u1" });
      await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
    });

    // Shows the accepted total and clears the file on a fully successful upload, notifying the caller.
    it("shows the accepted total and clears the file on a fully successful upload, notifying the caller", async () => {
      const onUploaded = jest.fn();
      const user = userEvent.setup();
      apiUploadFileWithProgressMock.mockResolvedValue({ accepted: 3, rejected: [], upload_id: "u1" });
      render(<PatientUploadCard onUploaded={onUploaded} />);
      await user.click(screen.getByRole("button", { name: "Import patients (.xlsx)" }));
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));

      expect(await screen.findByText("3 of 3 records processed.")).toBeInTheDocument();
      expect(screen.queryByText("patients.xlsx")).not.toBeInTheDocument();
      expect(onUploaded).toHaveBeenCalledWith({ accepted: 3, rejected: [], upload_id: "u1" });
      // The dialog stays open showing the summary -- the caller closes it.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Shows an expandable list of rejected rows, capped and captioned once it exceeds the render cap.
    it("shows an expandable list of rejected rows, capped once it exceeds the render limit", async () => {
      const rejected = Array.from({ length: 150 }, (_, i) => ({
        row: i + 2,
        field: "Patient ID",
        reason: "Duplicate Patient ID within this file.",
      }));
      apiUploadFileWithProgressMock.mockResolvedValue({ accepted: 0, rejected, upload_id: "u1" });
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));

      const toggle = await screen.findByRole("button", { name: "Show 150 issues" });
      fireEvent.click(toggle);

      expect(screen.getAllByText(/Duplicate Patient ID within this file\./)).toHaveLength(100);
      expect(screen.getByText("Showing the first 100 of 150 issues.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Hide 150 issues" }));
      expect(screen.queryByText("Showing the first 100 of 150 issues.")).not.toBeInTheDocument();
    });

    // Uses singular issue wording for exactly one rejected row.
    it("uses singular issue wording for exactly one rejected row", async () => {
      apiUploadFileWithProgressMock.mockResolvedValue({
        accepted: 1,
        rejected: [{ row: 2, field: "Gender", reason: "Gender is required." }],
        upload_id: "u1",
      });
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));

      expect(await screen.findByRole("button", { name: "Show 1 issue" })).toBeInTheDocument();
    });

    // Shows the server-provided detail message on a whole-file rejection and clears the file.
    it("shows the server-provided detail message on a whole-file rejection and clears the file", async () => {
      apiUploadFileWithProgressMock.mockRejectedValue(
        new ApiError(422, { detail: "Header row does not match the required columns." }),
      );
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Header row does not match the required columns.");
      expect(screen.queryByText("patients.xlsx")).not.toBeInTheDocument();
    });

    // Shows a generic error message when the failure carries no detail.
    it("shows a generic error message when the failure carries no detail", async () => {
      apiUploadFileWithProgressMock.mockRejectedValue(new Error("network down"));
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Could not process this file. Please try again.");
    });

    // A rapid double click on Upload after the button is already replaced does not fire twice.
    it("a rapid double click on upload fires only one request", async () => {
      apiUploadFileWithProgressMock.mockResolvedValue({ accepted: 1, rejected: [], upload_id: "u1" });
      await renderAndOpen();
      fireEvent.change(fileInput(), { target: { files: [makeFile("patients.xlsx", 1024)] } });
      await screen.findByText("patients.xlsx");

      const uploadButton = screen.getByRole("button", { name: "Upload" });
      fireEvent.click(uploadButton);
      fireEvent.click(uploadButton);

      await waitFor(() => expect(apiUploadFileWithProgressMock).toHaveBeenCalledTimes(1));
    });
  });

  describe("template preview dialog", () => {
    // Opens the preview dialog from the header eye icon.
    it("opens the preview dialog from the header eye icon", async () => {
      const user = userEvent.setup();
      await renderAndOpen();
      await user.click(screen.getByRole("button", { name: "Preview template" }));

      expect(screen.getAllByRole("dialog")).toHaveLength(2); // the import dialog, plus this one on top of it
      expect(screen.getByText("patient-upload-template.xlsx")).toBeInTheDocument();
    });

    // Shows the required column letters and the one example row.
    it("shows the required column letters and the one example row", async () => {
      const user = userEvent.setup();
      await renderAndOpen();
      await user.click(screen.getByRole("button", { name: "Preview template" }));

      expect(screen.getByText("Patient ID")).toBeInTheDocument();
      expect(screen.getByText("P-0001")).toBeInTheDocument();
    });

    // Expands and collapses the optional columns list.
    it("expands and collapses the optional columns list", async () => {
      const user = userEvent.setup();
      await renderAndOpen();
      await user.click(screen.getByRole("button", { name: "Preview template" }));

      await user.click(screen.getByRole("button", { name: /Show 31 optional columns/ }));
      expect(screen.getByText(/Street Address/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Hide 31 optional columns/ }));
      expect(screen.queryByText(/Street Address/)).not.toBeInTheDocument();
    });

    // Close button dismisses just the preview, leaving the import dialog open underneath.
    it("close button dismisses the preview but leaves the import dialog open", async () => {
      const user = userEvent.setup();
      await renderAndOpen();
      await user.click(screen.getByRole("button", { name: "Preview template" }));

      // Two "Close" buttons exist now (one per stacked dialog) -- scope to
      // the preview, the second (topmost) one in DOM order.
      const previewDialog = screen.getAllByRole("dialog")[1];
      await user.click(within(previewDialog).getByRole("button", { name: "Close" }));

      expect(screen.getAllByRole("dialog")).toHaveLength(1); // just the import dialog
    });
  });
});
