import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: replaceMock }),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import RootRedirect from "../app/page";

beforeEach(() => {
  replaceMock.mockClear();
});

// Does not redirect while the initial session check is loading.
test("does not redirect while the initial session check is loading", () => {
  useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
  render(<RootRedirect />);
  expect(replaceMock).not.toHaveBeenCalled();
});

// Redirects to /login once loading resolves with no user.
test("redirects to /login once loading resolves with no user", () => {
  useAuthMock.mockReturnValue({ currentUser: null, isLoading: false });
  render(<RootRedirect />);
  expect(replaceMock).toHaveBeenCalledWith("/login");
});

// Redirects to /dashboard once loading resolves with a user.
test("redirects to /dashboard once loading resolves with a user", () => {
  useAuthMock.mockReturnValue({ currentUser: { id: "1" }, isLoading: false });
  render(<RootRedirect />);
  expect(replaceMock).toHaveBeenCalledWith("/dashboard");
});
