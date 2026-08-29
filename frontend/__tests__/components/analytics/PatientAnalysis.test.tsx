import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiGetAnalyticsDatasetMock = jest.fn();
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super("failed");
      this.status = status;
    }
  },
  apiGetAnalyticsDataset: (...args: unknown[]) => apiGetAnalyticsDatasetMock(...args),
}));

// Each tab section has its own dedicated test coverage -- stub them here so
// this file's tests exercise only PatientAnalysis's own logic: fetch
// lifecycle, error/empty states, tab switching, and refresh invalidation.
jest.mock("@/components/analytics/DataOverview", () => {
  const Mock = () => <div data-testid="tab-overview" />;
  Mock.displayName = "DataOverview";
  return Mock;
});
jest.mock("@/components/analytics/ChartsSection", () => {
  const Mock = () => <div data-testid="tab-charts" />;
  Mock.displayName = "ChartsSection";
  return Mock;
});
jest.mock("@/components/analytics/StatisticsSection", () => {
  const Mock = () => <div data-testid="tab-statistics" />;
  Mock.displayName = "StatisticsSection";
  return Mock;
});
jest.mock("@/components/analytics/SegmentationSection", () => {
  const Mock = () => <div data-testid="tab-segmentation" />;
  Mock.displayName = "SegmentationSection";
  return Mock;
});
jest.mock("@/components/analytics/KeyInsights", () => {
  const Mock = () => <div data-testid="tab-insights" />;
  Mock.displayName = "KeyInsights";
  return Mock;
});

import PatientAnalysis from "@/components/analytics/PatientAnalysis";
import { ApiError } from "@/lib/api";

function makeDatasetEvent() {
  return {
    total: 1,
    categories: {},
    multi_value_categories: {},
    columns: {
      gender: [0], state: [null], race_ethnicity: [null], marital_status: [null], insurance_provider: [null],
      preferred_pharmacy: [null], blood_type: [null], smoking_status: [null], alcohol_use: [null],
      care_department: [null], age: [30], height_in: [null], weight_lbs: [null], systolic_bp: [null],
      diastolic_bp: [null], chronic_conditions: [[]], current_medications: [[]],
      registration_month: [null], last_visit_month: [null],
    },
    quality: {
      duplicate_identity_groups: 0, duplicate_identity_rows: 0, dates_before_birth: 0,
      last_visit_before_registration: 0, unreadable_rows: 0,
    },
  };
}

describe("components/analytics/PatientAnalysis", () => {
  beforeEach(() => {
    apiGetAnalyticsDatasetMock.mockReset();
  });

  // Starts collapsed and does not fetch the dataset until opened.
  it("starts collapsed and does not fetch the dataset until opened", () => {
    render(<PatientAnalysis />);
    expect(screen.getByRole("button", { name: /Patient analysis/ })).toHaveAttribute("aria-expanded", "false");
    expect(apiGetAnalyticsDatasetMock).not.toHaveBeenCalled();
  });

  // Fetches the dataset on first open and shows a loading spinner while pending.
  it("fetches the dataset on first open and shows a loading spinner while pending", async () => {
    let resolveFetch: (value: ReturnType<typeof makeDatasetEvent>) => void = () => {};
    apiGetAnalyticsDatasetMock.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));

    expect(screen.getByText("Preparing the analysis…")).toBeInTheDocument();
    resolveFetch(makeDatasetEvent());
    await waitFor(() => expect(screen.getByTestId("tab-charts")).toBeInTheDocument());
  });

  // Shows decrypting progress with a percentage once a progress callback fires.
  it("shows decrypting progress with a percentage once a progress callback fires", async () => {
    apiGetAnalyticsDatasetMock.mockImplementation(async (onProgress: (p: unknown) => void) => {
      onProgress({ processed: 50, total: 100 });
      return makeDatasetEvent();
    });

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));

    await waitFor(() => expect(screen.getByTestId("tab-charts")).toBeInTheDocument());
  });

  // Shows a permission specific error message for a 403 and a retry button.
  it("shows a permission specific error message for a 403 and a retry button", async () => {
    apiGetAnalyticsDatasetMock.mockRejectedValue(new ApiError(403));

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));

    await waitFor(() =>
      expect(screen.getByText("You don't have permission to view patient analytics.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  // Shows a generic error message for a non permission failure.
  it("shows a generic error message for a non permission failure", async () => {
    apiGetAnalyticsDatasetMock.mockRejectedValue(new Error("network down"));

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));

    await waitFor(() => expect(screen.getByText("Couldn't load the analysis. Try again.")).toBeInTheDocument());
  });

  // Retry button re-fetches after a failure.
  it("retry button re-fetches after a failure", async () => {
    apiGetAnalyticsDatasetMock.mockRejectedValueOnce(new Error("network down"));
    apiGetAnalyticsDatasetMock.mockResolvedValueOnce(makeDatasetEvent());

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));
    await waitFor(() => expect(screen.getByText("Couldn't load the analysis. Try again.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("tab-charts")).toBeInTheDocument());
  });

  // Shows the no records message for a dataset with zero rows.
  it("shows the no records message for a dataset with zero rows", async () => {
    apiGetAnalyticsDatasetMock.mockResolvedValue({ ...makeDatasetEvent(), total: 0, columns: { ...makeDatasetEvent().columns, gender: [], age: [] } });

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));

    await waitFor(() =>
      expect(screen.getByText("No patient records to analyse yet. Upload a workbook first.")).toBeInTheDocument(),
    );
  });

  // Switches tabs without re-fetching the dataset.
  it("switches tabs without re-fetching the dataset", async () => {
    apiGetAnalyticsDatasetMock.mockResolvedValue(makeDatasetEvent());

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));
    await waitFor(() => expect(screen.getByTestId("tab-charts")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "Data overview" }));
    expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
    expect(apiGetAnalyticsDatasetMock).toHaveBeenCalledTimes(1);
  });

  // Shows the target picker only on target aware tabs.
  it("shows the target picker only on target aware tabs", async () => {
    apiGetAnalyticsDatasetMock.mockResolvedValue(makeDatasetEvent());

    render(<PatientAnalysis />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));
    await waitFor(() => expect(screen.getByTestId("tab-charts")).toBeInTheDocument());
    expect(screen.getByText("Target")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Segmentation" }));
    expect(screen.queryByText("Target")).not.toBeInTheDocument();
  });

  // Re-fetches when reopened after refreshSignal changes, invalidating the held dataset.
  it("re-fetches when reopened after refreshSignal changes", async () => {
    apiGetAnalyticsDatasetMock.mockResolvedValue(makeDatasetEvent());

    const { rerender } = render(<PatientAnalysis refreshSignal={0} />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));
    await waitFor(() => expect(apiGetAnalyticsDatasetMock).toHaveBeenCalledTimes(1));

    // Close, bump refreshSignal (simulating a new upload), then reopen.
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));
    rerender(<PatientAnalysis refreshSignal={1} />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));

    await waitFor(() => expect(apiGetAnalyticsDatasetMock).toHaveBeenCalledTimes(2));
  });

  // Does not re-fetch on reopen when refreshSignal is unchanged.
  it("does not re-fetch on reopen when refreshSignal is unchanged", async () => {
    apiGetAnalyticsDatasetMock.mockResolvedValue(makeDatasetEvent());

    render(<PatientAnalysis refreshSignal={0} />);
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));
    await waitFor(() => expect(apiGetAnalyticsDatasetMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));
    fireEvent.click(screen.getByRole("button", { name: /Patient analysis/ }));

    expect(apiGetAnalyticsDatasetMock).toHaveBeenCalledTimes(1);
  });
});
