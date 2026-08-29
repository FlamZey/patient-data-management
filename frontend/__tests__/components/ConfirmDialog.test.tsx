import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ConfirmDialog from "@/components/ConfirmDialog";

function setup(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <ConfirmDialog
      title="Suspend this user?"
      description="They will lose access immediately."
      confirmLabel="Suspend"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe("components/ConfirmDialog", () => {
  // Renders the title, description, and confirm label.
  it("renders the title, description, and confirm label", () => {
    setup();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Suspend this user?")).toBeInTheDocument();
    expect(screen.getByText("They will lose access immediately.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeInTheDocument();
  });

  // Does not render an error message by default.
  it("does not render an error message by default", () => {
    setup();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Renders the error message when provided.
  it("renders the error message when provided", () => {
    setup({ error: "Could not suspend this user." });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not suspend this user.");
  });

  // Calls onConfirm when the confirm button is clicked.
  it("calls onConfirm when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole("button", { name: "Suspend" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // Calls onCancel when the cancel button is clicked.
  it("calls onCancel when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // Calls onCancel when clicking the backdrop.
  it("calls onCancel when clicking the backdrop", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("alertdialog").parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // Does not call onCancel when clicking inside the dialog panel.
  it("does not call onCancel when clicking inside the dialog panel", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByText("Suspend this user?"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  // Calls onCancel when Escape is pressed.
  it("calls onCancel when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // Ignores non-Escape key presses.
  it("ignores non-Escape key presses", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.keyboard("{Enter}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  // Removes the Escape key listener on unmount.
  it("removes the Escape key listener on unmount", async () => {
    const user = userEvent.setup();
    const { onCancel, } = setup();
    const removeSpy = jest.spyOn(document, "removeEventListener");
    const { unmount } = render(
      <ConfirmDialog
        title="t"
        description="d"
        confirmLabel="c"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    removeSpy.mockRestore();
    // sanity: the first dialog's handler is unaffected by the second unmount
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  // Shows 'Working...' and disables both buttons while confirming.
  it("shows 'Working...' and disables both buttons while confirming", () => {
    setup({ isConfirming: true });
    expect(screen.getByRole("button", { name: "Working..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
