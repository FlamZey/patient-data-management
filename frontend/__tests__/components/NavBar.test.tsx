import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

import NavBar from "@/components/NavBar";
import type { UserRead } from "@/lib/types";

function makeUser(overrides: Partial<UserRead> = {}): UserRead {
  return {
    id: "1",
    email: "a@b.com",
    username: "a",
    first_name: "Ada",
    last_name: "Lovelace",
    status: "active",
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    role: {
      id: 1,
      name: "admin",
      display_name: "Admin",
      parent_role_id: null,
      description: null,
      is_active: true,
      permissions: [],
    },
    location: { id: 1, code: "L1", name: "Location 1", is_active: true },
    team: null,
    ...overrides,
  };
}

describe("components/NavBar", () => {
  beforeEach(() => {
    useAuthMock.mockReset();
  });

  it("renders nothing when there is no current user", () => {
    useAuthMock.mockReturnValue({ currentUser: null, logout: jest.fn() });
    const { container } = render(<NavBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the Dashboard link when the user lacks patient.view permission", () => {
    useAuthMock.mockReturnValue({ currentUser: makeUser(), logout: jest.fn() });
    render(<NavBar />);
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
  });

  it("shows the Dashboard link when the user has patient.view permission", () => {
    const user = makeUser({
      role: {
        id: 1,
        name: "admin",
        display_name: "Admin",
        parent_role_id: null,
        description: null,
        is_active: true,
        permissions: [{ id: 1, code: "patient.view", resource: "patient", action: "view", description: null }],
      },
    });
    useAuthMock.mockReturnValue({ currentUser: user, logout: jest.fn() });
    render(<NavBar />);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
  });

  it("hides the Manage Users link when the user lacks user.view permission", () => {
    useAuthMock.mockReturnValue({ currentUser: makeUser(), logout: jest.fn() });
    render(<NavBar />);
    expect(screen.queryByRole("link", { name: "Manage Users" })).not.toBeInTheDocument();
  });

  it("shows the Manage Users link when the user has user.view permission", () => {
    const user = makeUser({
      role: {
        id: 1,
        name: "admin",
        display_name: "Admin",
        parent_role_id: null,
        description: null,
        is_active: true,
        permissions: [{ id: 1, code: "user.view", resource: "user", action: "view", description: null }],
      },
    });
    useAuthMock.mockReturnValue({ currentUser: user, logout: jest.fn() });
    render(<NavBar />);
    expect(screen.getByRole("link", { name: "Manage Users" })).toHaveAttribute("href", "/manage-users");
  });

  it("displays the current user's name and role", () => {
    useAuthMock.mockReturnValue({ currentUser: makeUser(), logout: jest.fn() });
    render(<NavBar />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("links to /home and /settings", () => {
    useAuthMock.mockReturnValue({ currentUser: makeUser(), logout: jest.fn() });
    render(<NavBar />);
    expect(screen.getByRole("link", { name: "Records" })).toHaveAttribute("href", "/home");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("calls logout when the Logout button is clicked", async () => {
    const user = userEvent.setup();
    const logout = jest.fn();
    useAuthMock.mockReturnValue({ currentUser: makeUser(), logout });
    render(<NavBar />);
    await user.click(screen.getByRole("button", { name: "Logout" }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
