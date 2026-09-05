import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...props }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
  MockLink.displayName = "Link";
  return MockLink;
});

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import Sidebar from "@/components/Sidebar";
import type { UserRead } from "@/lib/types";

const PATIENT_VIEW = { id: 1, code: "patient.view", resource: "patient", action: "view", description: null };
const USER_VIEW = { id: 2, code: "user.view", resource: "user", action: "view", description: null };
const AUDIT_VIEW = { id: 3, code: "audit.view", resource: "audit", action: "view", description: null };

function makeUser(permissions: typeof PATIENT_VIEW[], overrides: Partial<UserRead> = {}): UserRead {
  return {
    id: "1", email: "a@b.com", username: "a", first_name: "Ada", last_name: "Lovelace", status: "active",
    last_login_at: null, password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    role: { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true, permissions },
    location: { id: 1, code: "L1", name: "Location One", is_active: true },
    team: null,
    ...overrides,
  };
}

const logoutMock = jest.fn();

function setCurrentUser(user: UserRead | null) {
  useAuthMock.mockReturnValue({ currentUser: user, logout: logoutMock });
}

describe("components/Sidebar", () => {
  beforeEach(() => {
    logoutMock.mockClear();
  });

  // Renders nothing when there is no signed-in user.
  it("renders nothing when there is no signed-in user", () => {
    setCurrentUser(null);
    const { container } = render(<Sidebar />);
    expect(container).toBeEmptyDOMElement();
  });

  // Shows the signed-in user's initials, name, and role.
  it("shows the signed-in user's initials, name, and role", () => {
    setCurrentUser(makeUser([PATIENT_VIEW]));
    render(<Sidebar />);
    expect(screen.getByText("AL")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  // Only offers nav links the user's permissions actually unlock.
  it("only offers nav links the user's permissions actually unlock", () => {
    setCurrentUser(makeUser([PATIENT_VIEW, AUDIT_VIEW]));
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Patients & records" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage users" })).not.toBeInTheDocument();
  });

  // Renders neither nav group when the user holds none of their permissions.
  it("renders neither nav group when the user holds none of their permissions", () => {
    setCurrentUser(makeUser([]));
    render(<Sidebar />);
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Practice" })).not.toBeInTheDocument();
  });

  // Marks the item passed as `active` distinctly from the rest.
  it("marks the item passed as active distinctly from the rest", () => {
    setCurrentUser(makeUser([PATIENT_VIEW, USER_VIEW]));
    render(<Sidebar active="manage-users" />);
    expect(screen.getByRole("link", { name: "Manage users" }).className).toContain("text-accent");
    expect(screen.getByRole("link", { name: "Patients & records" }).className).not.toContain("text-accent");
  });

  // Calls logout when the logout button is clicked.
  it("calls logout when the logout button is clicked", () => {
    setCurrentUser(makeUser([PATIENT_VIEW]));
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });
});
