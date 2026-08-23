import { render, screen, waitFor } from "@testing-library/react";

const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import ProtectedRoute from "@/components/ProtectedRoute";

describe("components/ProtectedRoute", () => {
  beforeEach(() => {
    replaceMock.mockClear();
    useAuthMock.mockReset();
  });

  it("shows a loading indicator and does not redirect while loading", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
    const { container } = render(
      <ProtectedRoute>
        <div>secret</div>
      </ProtectedRoute>,
    );
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("redirects to /login and renders nothing once loading resolves with no user", async () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: false });
    const { container } = render(
      <ProtectedRoute>
        <div>secret</div>
      </ProtectedRoute>,
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders children when a user is present", () => {
    useAuthMock.mockReturnValue({ currentUser: { id: "1" }, isLoading: false });
    render(
      <ProtectedRoute>
        <div>secret</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText("secret")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
