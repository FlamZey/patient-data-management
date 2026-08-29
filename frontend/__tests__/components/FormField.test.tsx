import { render, screen } from "@testing-library/react";

import Field, { inputClass } from "@/components/FormField";

describe("components/FormField", () => {
  describe("inputClass", () => {
    // Uses the border color for a field with no error.
    it("uses the neutral border color for a field with no error", () => {
      expect(inputClass(false)).toContain("border-border");
      expect(inputClass(false)).not.toContain("border-danger");
    });

    // Switches to the danger border color when there is an error.
    it("switches to the danger border color when there is an error", () => {
      expect(inputClass(true)).toContain("border-danger");
    });
  });

  describe("Field", () => {
    // Renders the label and the child input.
    it("renders the label and the child input", () => {
      render(
        <Field label="Email">
          <input aria-label="Email" />
        </Field>,
      );
      expect(screen.getByText("Email")).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // Shows the error message instead of the hint when both are provided.
    it("shows the error message instead of the hint when both are provided", () => {
      render(
        <Field label="Email" error="Invalid email" hint="We'll never share it">
          <input />
        </Field>,
      );
      expect(screen.getByText("Invalid email")).toBeInTheDocument();
      expect(screen.queryByText("We'll never share it")).not.toBeInTheDocument();
    });

    // Shows the hint when there is no error.
    it("shows the hint when there is no error", () => {
      render(
        <Field label="Email" hint="We'll never share it">
          <input />
        </Field>,
      );
      expect(screen.getByText("We'll never share it")).toBeInTheDocument();
    });

    // Renders neither an error nor a hint when both are omitted.
    it("renders neither an error nor a hint when both are omitted", () => {
      const { container } = render(
        <Field label="Email">
          <input />
        </Field>,
      );
      expect(container.querySelectorAll("p")).toHaveLength(0);
    });
  });
});
