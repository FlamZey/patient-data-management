import { render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
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

import HomePage from "@/app/home/page";

describe("app/home", () => {
  // Renders the Home heading and NavBar once authenticated.
  it("renders the Home heading and NavBar once authenticated", () => {
    useAuthMock.mockReturnValue({
      currentUser: {
        id: "1",
        first_name: "Ada",
        last_name: "Lovelace",
        role: { display_name: "Admin", permissions: [] },
      },
      isLoading: false,
      logout: jest.fn(),
    });

    render(<HomePage />);

    expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  // Renders nothing but the loading indicator while unauthenticated.
  it("renders nothing but the loading indicator while unauthenticated", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });

    render(<HomePage />);

    expect(screen.queryByRole("heading", { name: "Home" })).not.toBeInTheDocument();
  });
});
