import { fireEvent, render, screen } from "@testing-library/react";

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
  // Default split is by smokingStatus (component's initial state); options sort alphabetically,
  // so cohort A defaults to "Current every day smoker" and cohort B to "Never smoker".
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => makeRow({ smokingStatus: "Never smoker", systolicBp: 110 + i, ageBracket: "18-29" })),
    ...Array.from({ length: 15 }, (_, i) => makeRow({ smokingStatus: "Current every day smoker", systolicBp: 130 + i, ageBracket: "45-59" })),
  ];

  // Renders the split by, cohort a, cohort b, and compare selects.
  it("renders the split by, cohort a, cohort b, and compare selects", () => {
    render(<SegmentationSection rows={rows} />);
    expect(screen.getByLabelText("Split by")).toBeInTheDocument();
    expect(screen.getByLabelText("Cohort A")).toBeInTheDocument();
    expect(screen.getByLabelText("Cohort B")).toBeInTheDocument();
    expect(screen.getByLabelText("Compare")).toBeInTheDocument();
  });

  // Defaults cohort a and b to the first two distinct values of the split field, sorted alphabetically.
  it("defaults cohort a and b to the first two distinct values of the split field", () => {
    render(<SegmentationSection rows={rows} />);
    expect(screen.getByText("Cohort A · Current every day smoker")).toBeInTheDocument();
    expect(screen.getByText("Cohort B · Never smoker")).toBeInTheDocument();
  });

  // Shows a pick two different values message when both cohorts resolve to the same value.
  it("shows a pick two different values message when both cohorts resolve to the same value", () => {
    render(<SegmentationSection rows={rows} />);
    const cohortBSelect = screen.getByLabelText("Cohort B") as HTMLSelectElement;
    fireEvent.change(cohortBSelect, { target: { value: "Current every day smoker" } });

    expect(screen.getByText("Pick two different values to compare.")).toBeInTheDocument();
  });

  // Resets cohort selections to the new split field's first two options when the split field changes.
  it("resets cohort selections when the split field changes", () => {
    render(<SegmentationSection rows={rows} />);
    const splitSelect = screen.getByLabelText("Split by") as HTMLSelectElement;
    fireEvent.change(splitSelect, { target: { value: "ageBracket" } });

    // ageBracket's options are the full fixed AGE_BRACKETS order, not just observed values.
    expect(screen.getByText("Cohort A · 0-17")).toBeInTheDocument();
    expect(screen.getByText("Cohort B · 18-29")).toBeInTheDocument();
  });

  // Renders the subgroup consistency table with a result per subgroup.
  it("renders the subgroup consistency table with a result per subgroup", () => {
    render(<SegmentationSection rows={rows} />);
    expect(screen.getByText("Does it hold across subgroups?")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

  // Falls back the consistency field when changing the split field would make the two match.
  it("falls back the consistency field when changing the split field would make the two match", () => {
    render(<SegmentationSection rows={rows} />);
    // The consistency select (in the second card's controls) has no accessible label of
    // its own -- find it as the last of the five comboboxes on the page.
    const comboboxes = screen.getAllByRole("combobox");
    const consistencySelect = comboboxes[comboboxes.length - 1] as HTMLSelectElement;
    expect(consistencySelect.value).toBe("ageBracket");

    // Default consistency field is "ageBracket"; switching the split to "ageBracket" too
    // would make them collide -- the component must fall back to a different field instead
    // of rendering a degenerate all-insufficient-data table (see the component's own comment).
    const splitSelect = screen.getByLabelText("Split by") as HTMLSelectElement;
    fireEvent.change(splitSelect, { target: { value: "ageBracket" } });

    expect(consistencySelect.value).not.toBe("ageBracket");
    expect(consistencySelect.value).toBe("gender");
  });
});
