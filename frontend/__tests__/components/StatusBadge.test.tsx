import { render, screen } from "@testing-library/react";

import StatusBadge from "@/components/StatusBadge";

describe("components/StatusBadge", () => {
  // Renders the status text.
  it("renders the status text", () => {
    render(<StatusBadge status="active" />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  // Applies the teal styling for an active status.
  it("applies the teal styling for an active status", () => {
    render(<StatusBadge status="active" />);
    expect(screen.getByText("active").className).toContain("text-teal");
  });

  // Applies the danger styling for both suspended and locked statuses.
  it.each(["suspended", "locked"])("applies the danger styling for a %s status", (status) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(status).className).toContain("text-danger");
  });

  // Applies the accent styling for a pending status.
  it("applies the accent styling for a pending status", () => {
    render(<StatusBadge status="pending" />);
    expect(screen.getByText("pending").className).toContain("text-accent");
  });

  // Falls back to a neutral style for an unrecognized status rather than crashing.
  it("falls back to a neutral style for an unrecognized status rather than crashing", () => {
    render(<StatusBadge status="unknown-status" />);
    const badge = screen.getByText("unknown-status");
    expect(badge.className).toContain("text-muted");
  });

  // Renders an empty status without crashing.
  it("renders an empty status without crashing", () => {
    const { container } = render(<StatusBadge status="" />);
    expect(container.querySelector("span")).toBeInTheDocument();
  });
});
