import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import Home from "../app/page";

global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve([]),
  })
) as jest.Mock;

test("renders heading", async () => {
  render(<Home />);
  await waitFor(() => {
    expect(screen.getByText(/Next.js \+ FastAPI \+ PostgreSQL/i)).toBeInTheDocument();
  });
});

test("shows empty state when no items returned", async () => {
  render(<Home />);
  await waitFor(() => {
    expect(screen.getByText(/No items yet/i)).toBeInTheDocument();
  });
});

test("shows error state when fetch fails", async () => {
  (global.fetch as jest.Mock).mockImplementationOnce(() => Promise.reject("fail"));
  render(<Home />);
  await waitFor(() => {
    expect(screen.getByText(/Couldn't reach the API/i)).toBeInTheDocument();
  });
});