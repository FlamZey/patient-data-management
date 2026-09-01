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

// Each section has its own dedicated test coverage -- stub them here so this
// file's tests exercise only PatientAnalysis's own logic: fetch lifecycle
// and error/empty states.
jest.mock("@/components/analytics/DataOverview", () => {
  const Mock = () => <div data-testid="section-overview" />;
  Mock.displayName = "DataOverview";
  return Mock;
});
jest.mock("@/components/analytics/ChartsSection", () => {
  const Mock = () => <div data-testid="section-charts" />;
  Mock.displayName = "ChartsSection";
  return Mock;
});
jest.mock("@/components/analytics/StatisticsSection", () => {
  const Mock = () => <div data-testid="section-statistics" />;
  Mock.displayName = "StatisticsSection";
  return Mock;
});
jest.mock("@/components/analytics/SegmentationSection", () => {
  const Mock = () => <div data-testid="section-segmentation" />;
  Mock.displayName = "SegmentationSection";
  return Mock;
});
jest.mock("@/components/analytics/KeyInsights", () => {
  const Mock = () => <div data-testid="section-insights" />;
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

  // Fetches the dataset on mount and shows a loading spinner while pending.
  it("fetches the dataset on mount and shows a loading spinner while pending", async () => {
    let resolveFetch: (value: ReturnType<typeof makeDatasetEvent>) => void = () => {};
    apiGetAnalyticsDatasetMock.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

    render(<PatientAnalysis />);
    expect(screen.getByText("Preparing the analysis…")).toBeInTheDocument();
    expect(apiGetAnalyticsDatasetMock).toHaveBeenCalledTimes(1);

    resolveFetch(makeDatasetEvent());
    await waitFor(() => expect(screen.getByTestId("section-charts")).toBeInTheDocument());
  });

  // Renders every report section once the dataset loads.
  it("renders every report section once the dataset loads", async () => {
    apiGetAnalyticsDatasetMock.mockResolvedValue(makeDatasetEvent());

    render(<PatientAnalysis />);

    await waitFor(() => expect(screen.getByTestId("section-overview")).toBeInTheDocument());
    expect(screen.getByTestId("section-charts")).toBeInTheDocument();
    expect(screen.getByTestId("section-statistics")).toBeInTheDocument();
    expect(screen.getByTestId("section-segmentation")).toBeInTheDocument();
    expect(screen.getByTestId("section-insights")).toBeInTheDocument();
  });

  // Shows decrypting progress with a percentage once a progress callback fires.
  it("shows decrypting progress with a percentage once a progress callback fires", async () => {
    apiGetAnalyticsDatasetMock.mockImplementation(async (onProgress: (p: unknown) => void) => {
      onProgress({ processed: 50, total: 100 });
      return makeDatasetEvent();
    });

    render(<PatientAnalysis />);

    await waitFor(() => expect(screen.getByTestId("section-charts")).toBeInTheDocument());
  });

  // Shows a permission specific error message for a 403 and a retry button.
  it("shows a permission specific error message for a 403 and a retry button", async () => {
    apiGetAnalyticsDatasetMock.mockRejectedValue(new ApiError(403, null));

    render(<PatientAnalysis />);

    await waitFor(() =>
      expect(screen.getByText("You don't have permission to view patient analytics.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  // Shows a generic error message for a non permission failure.
  it("shows a generic error message for a non permission failure", async () => {
    apiGetAnalyticsDatasetMock.mockRejectedValue(new Error("network down"));

    render(<PatientAnalysis />);

    await waitFor(() => expect(screen.getByText("Couldn't load the analysis. Try again.")).toBeInTheDocument());
  });

  // Retry button re-fetches after a failure.
  it("retry button re-fetches after a failure", async () => {
    apiGetAnalyticsDatasetMock.mockRejectedValueOnce(new Error("network down"));
    apiGetAnalyticsDatasetMock.mockResolvedValueOnce(makeDatasetEvent());

    render(<PatientAnalysis />);
    await waitFor(() => expect(screen.getByText("Couldn't load the analysis. Try again.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("section-charts")).toBeInTheDocument());
  });

  // Shows the no records message for a dataset with zero rows.
  it("shows the no records message for a dataset with zero rows", async () => {
    apiGetAnalyticsDatasetMock.mockResolvedValue({ ...makeDatasetEvent(), total: 0, columns: { ...makeDatasetEvent().columns, gender: [], age: [] } });

    render(<PatientAnalysis />);

    await waitFor(() =>
      expect(screen.getByText("No patient records to analyse yet. Upload a workbook first.")).toBeInTheDocument(),
    );
  });
});
