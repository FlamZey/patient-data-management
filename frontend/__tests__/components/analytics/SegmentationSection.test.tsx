import { render, screen } from "@testing-library/react";

import SegmentationSection from "@/components/analytics/SegmentationSection";
import type { AnalyticsRow } from "@/lib/analytics";

function makeRow(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    gender: "Female", state: "CA", raceEthnicity: null, maritalStatus: null, insuranceProvider: null,
    preferredPharmacy: null, bloodType: null, smokingStatus: "Never smoker", alcoholUse: null,
    careDepartment: null,
    age: 40, heightIn: 65, weightLbs: 140, systolicBp: 120, diastolicBp: 80,
    chronicConditions: [], currentMedications: [], registrationMonth: "2023-01", lastVisitMonth: "2023-06",
    bmi: 23, ageBracket: "30-44", conditionCount: 0, medicationCount: 0,
    ...overrides,
  };
}

describe("components/analytics/SegmentationSection", () => {
  // Cohort A groups every "current smoker"-shaped status; cohort B is the never-smoker status alone.
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => makeRow({ smokingStatus: "Never smoker", systolicBp: 110 + i, ageBracket: "18-29" })),
    ...Array.from({ length: 15 }, (_, i) => makeRow({ smokingStatus: "Current every day smoker", systolicBp: 130 + i, ageBracket: "45-59" })),
  ];

  // Renders the fixed cohort labels and their sample sizes.
  it("renders the fixed cohort labels and their sample sizes", () => {
    render(<SegmentationSection rows={rows} />);
    expect(screen.getByText("Cohort A · current smoker")).toBeInTheDocument();
    expect(screen.getByText("Cohort B · never smoked")).toBeInTheDocument();
    expect(screen.getAllByText("n = 15")).toHaveLength(2);
  });

  // Reports the difference as significant when the cohorts clearly differ.
  it("reports the difference as significant when the cohorts clearly differ", () => {
    render(<SegmentationSection rows={rows} />);
    expect(screen.getByText("Significant")).toBeInTheDocument();
  });

  // Confirms consistency only when a subgroup actually had enough patients in both cohorts to be compared.
  it("reports consistency when every checkable age subgroup agrees", () => {
    const overlapping = ["18-29", "45-59"].flatMap((ageBracket, bracket) => [
      ...Array.from({ length: 12 }, (_, i) =>
        makeRow({ smokingStatus: "Never smoker", systolicBp: 110 + bracket * 5 + i, ageBracket }),
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        makeRow({ smokingStatus: "Current every day smoker", systolicBp: 130 + bracket * 5 + i, ageBracket }),
      ),
    ]);
    render(<SegmentationSection rows={overlapping} />);
    expect(screen.getByText(/every age subgroup with enough data agrees/)).toBeInTheDocument();
  });

  // The check must not claim consistency over zero real comparisons when no age bracket is shared.
  it("says the subgroup check could not run rather than claiming consistency over zero comparisons", () => {
    render(<SegmentationSection rows={rows} />);
    expect(screen.getByText(/no age subgroup has enough patients in both cohorts/)).toBeInTheDocument();
    expect(screen.queryByText(/every age subgroup with enough data agrees/)).not.toBeInTheDocument();
  });

  // Renders "not enough data" for the difference card when a cohort is empty.
  it("renders not enough data when a cohort is empty", () => {
    const onlyNeverSmoked = rows.filter((row) => row.smokingStatus === "Never smoker");
    render(<SegmentationSection rows={onlyNeverSmoked} />);
    expect(screen.getByText("Not enough data in one or both cohorts.")).toBeInTheDocument();
  });
});
