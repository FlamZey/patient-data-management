import { render } from "@testing-library/react";

import Spinner from "@/components/Spinner";

describe("components/Spinner", () => {
  // Renders an svg hidden from assistive tech since it carries no independent meaning.
  it("renders an svg hidden from assistive tech", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  // Defaults to the small size class.
  it("defaults to the small size class", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector("svg")?.className.baseVal).toContain("h-4 w-4");
  });

  // Applies each size prop's matching class.
  it.each([
    ["xs", "h-3.5 w-3.5"],
    ["sm", "h-4 w-4"],
    ["md", "h-5 w-5"],
  ] as const)("applies the %s size class", (size, expectedClass) => {
    const { container } = render(<Spinner size={size} />);
    expect(container.querySelector("svg")?.className.baseVal).toContain(expectedClass);
  });

  // Appends a caller supplied className for text color.
  it("appends a caller supplied className for text color", () => {
    const { container } = render(<Spinner className="text-danger" />);
    expect(container.querySelector("svg")?.className.baseVal).toContain("text-danger");
  });
});
