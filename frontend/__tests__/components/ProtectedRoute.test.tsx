import { act, render, screen, waitFor } from "@testing-library/react";

const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import ProtectedRoute from "@/components/ProtectedRoute";

// Mirrors the component's own constant.
const SHOW_DELAY_MS = 150;

describe("components/ProtectedRoute", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    replaceMock.mockClear();
    useAuthMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it("renders nothing and does not redirect while loading, before the show-delay elapses", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
    const { container } = render(
      <ProtectedRoute>
        <div>secret</div>
      </ProtectedRoute>,
    );
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("shows a loading indicator once loading has taken longer than the show-delay", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
    const { container } = render(
      <ProtectedRoute>
        <div>secret</div>
      </ProtectedRoute>,
    );
    act(() => {
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });
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
