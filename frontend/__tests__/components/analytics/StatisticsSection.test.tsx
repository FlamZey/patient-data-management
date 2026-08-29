import { render, screen } from "@testing-library/react";

import StatisticsSection from "@/components/analytics/StatisticsSection";
import { TARGET_VARIABLES, type AnalyticsRow } from "@/lib/analytics";

function makeRow(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    gender: "Female", state: "CA", raceEthnicity: null, maritalStatus: null, insuranceProvider: null,
    preferredPharmacy: null, bloodType: null, smokingStatus: null, alcoholUse: null, careDepartment: null,
    age: 40, heightIn: 65, weightLbs: 140, systolicBp: 120, diastolicBp: 80,
    chronicConditions: [], currentMedications: [], registrationMonth: "2023-01", lastVisitMonth: "2023-06",
    bmi: 23, ageBracket: "30-44", conditionCount: 0, medicationCount: 0,
    ...overrides,
  };
}

const target = TARGET_VARIABLES.find((t) => t.id === "condition_burden")!;

describe("components/analytics/StatisticsSection", () => {
  // Renders the empty state when there are no rows to test.
  it("renders the empty state when there are no rows to test", () => {
    render(<StatisticsSection rows={[]} target={target} />);
    expect(screen.getByText(/Not enough data on file/)).toBeInTheDocument();
  });

  // Renders a results table with the field, p, and result columns for enough data.
  it("renders a results table with the field, p, and result columns for enough data", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      makeRow({ age: 20 + (i % 50), conditionCount: i % 3, systolicBp: 110 + (i % 20) }),
    );
    render(<StatisticsSection rows={rows} target={target} />);
    expect(screen.getByRole("columnheader", { name: "Field" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Result" })).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

  // Shows the count of fields still significant after correction.
  it("shows the count of fields still significant after correction", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      makeRow({ age: 20 + (i % 50), conditionCount: i % 3, systolicBp: 110 + (i % 20) }),
    );
    render(<StatisticsSection rows={rows} target={target} />);
    expect(screen.getByText(/of \d+ fields remain significant after correction\./)).toBeInTheDocument();
  });

  // Re-renders results for a different target.
  it("re-renders results for a different target", () => {
    const rows = Array.from({ length: 20 }, (_, i) => makeRow({ conditionCount: i % 2 }));
    const obesityTarget = TARGET_VARIABLES.find((t) => t.id === "obesity")!;
    render(<StatisticsSection rows={rows} target={obesityTarget} />);
    expect(screen.getByText(/What's associated with obesity/)).toBeInTheDocument();
  });
});
