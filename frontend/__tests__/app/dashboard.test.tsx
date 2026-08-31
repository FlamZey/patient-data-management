import { render, screen, waitFor } from "@testing-library/react";

const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: jest.fn() }),
}));

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

// The dashboard page's own job is permission gating and layout -- the
// patient table/upload flow has its own coverage, so it's stubbed here.
jest.mock("@/components/PatientTable", () => {
  const MockPatientTable = () => <div data-testid="patient-table" />;
  MockPatientTable.displayName = "PatientTable";
  return MockPatientTable;
});

import DashboardPage from "@/app/dashboard/page";
import type { UserRead } from "@/lib/types";

const VIEW_PERMISSION = { id: 1, code: "patient.view", resource: "patient", action: "view", description: null };

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
      permissions: [VIEW_PERMISSION],
    },
    location: { id: 1, code: "L1", name: "Location One", is_active: true },
    team: null,
    ...overrides,
  };
}

function setCurrentUser(user: UserRead | null) {
  useAuthMock.mockReturnValue({ currentUser: user, isLoading: false, logout: jest.fn() });
}

describe("app/dashboard", () => {
  beforeEach(() => {
    replaceMock.mockClear();
  });

  // Redirects to /home and renders nothing when the user lacks patient.view.
  it("redirects to /home and renders nothing when the user lacks patient.view", async () => {
    setCurrentUser(makeUser({ role: { ...makeUser().role, permissions: [] } }));
    const { container } = render(<DashboardPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/home"));
    expect(container.querySelector('[data-testid="patient-table"]')).not.toBeInTheDocument();
  });

  // Renders Sidebar and the patient table when the user has patient.view.
  it("renders Sidebar and the patient table when the user has patient.view", async () => {
    setCurrentUser(makeUser());
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByTestId("patient-table")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Records" })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // Renders nothing while currentUser is not yet available.
  it("renders nothing while currentUser is not yet available", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
    const { container } = render(<DashboardPage />);
    expect(container).toBeEmptyDOMElement();
  });
});
