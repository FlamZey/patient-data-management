import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import Button from "@/components/Button";

describe("components/Button", () => {
  it("renders children and defaults to a primary, medium, type=button button", () => {
    render(<Button>Click me</Button>);
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toContain("bg-accent");
    expect(button.className).toContain("px-4 py-2");
  });

  it.each([
    ["primary", "bg-accent"],
    ["secondary", "border-border"],
    ["danger", "bg-danger"],
    ["accent-outline", "border-accent/40"],
    ["danger-outline", "border-danger/40"],
  ] as const)("applies %s variant classes", (variant, expectedClass) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole("button").className).toContain(expectedClass);
  });

  it.each([
    ["xs", "px-2.5"],
    ["sm", "px-3"],
    ["md", "px-4"],
    ["lg", "px-6"],
  ] as const)("applies %s size classes", (size, expectedClass) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole("button").className).toContain(expectedClass);
  });

  it("applies fullWidth class when requested", () => {
    render(<Button fullWidth>Go</Button>);
    expect(screen.getByRole("button").className).toContain("w-full");
  });

  it("omits fullWidth class by default", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button").className).not.toContain("w-full");
  });

  it("merges a custom className with the generated classes", () => {
    render(<Button className="my-extra-class">Go</Button>);
    expect(screen.getByRole("button").className).toContain("my-extra-class");
  });

  it("respects an explicit type override", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });

  it("forwards refs to the underlying button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Go</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("fires onClick and respects the disabled attribute", async () => {
    const user = userEvent.setup();
    const onClick = jest.fn();
    render(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
