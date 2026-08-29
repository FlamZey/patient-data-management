import { render, screen } from "@testing-library/react";

import DataOverview from "@/components/analytics/DataOverview";
import type { AnalyticsRow } from "@/lib/analytics";
import type { AnalyticsQuality } from "@/lib/types";

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

function makeQuality(overrides: Partial<AnalyticsQuality> = {}): AnalyticsQuality {
  return {
    duplicate_identity_groups: 0, duplicate_identity_rows: 0, dates_before_birth: 0,
    last_visit_before_registration: 0, unreadable_rows: 0,
    ...overrides,
  };
}

describe("components/analytics/DataOverview", () => {
  // Renders patient count, mean age, and condition percentage stat tiles.
  it("renders patient count, mean age, and condition percentage stat tiles", () => {
    const rows = [makeRow({ age: 30, conditionCount: 1 }), makeRow({ age: 50, conditionCount: 0 })];
    render(<DataOverview rows={rows} quality={makeQuality()} />);

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("40 yrs")).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
  });

  // Shows an em dash for mean age when no row has an age on file.
  it("shows an em dash for mean age when no row has an age on file", () => {
    render(<DataOverview rows={[makeRow({ age: null })]} quality={makeQuality()} />);
    expect(screen.getByText("no ages on file")).toBeInTheDocument();
  });

  // Shows an em dash for the registration range when no row has a registration month.
  it("shows an em dash for the registration range when no row has a registration month", () => {
    render(<DataOverview rows={[makeRow({ registrationMonth: null })]} quality={makeQuality()} />);
    expect(screen.getByText("no dates on file")).toBeInTheDocument();
  });

  // Renders a coverage row for every tracked field.
  it("renders a coverage row for every tracked field", () => {
    render(<DataOverview rows={[makeRow()]} quality={makeQuality()} />);
    expect(screen.getByText("Age (from date of birth)")).toBeInTheDocument();
    expect(screen.getByText("Chronic conditions")).toBeInTheDocument();
  });

  // Shows the no issues message when no quality flag has a nonzero count.
  it("shows the no issues message when no quality flag has a nonzero count", () => {
    render(<DataOverview rows={[makeRow()]} quality={makeQuality()} />);
    expect(screen.getByText(/No quality issues found/)).toBeInTheDocument();
  });

  // Renders a quality flag card and its excluded badge when a flag has a nonzero count.
  it("renders a quality flag card and its excluded badge when a flag has a nonzero count", () => {
    const rows = [makeRow({ bmi: 5 })];
    render(<DataOverview rows={rows} quality={makeQuality()} />);
    expect(screen.getByText("Implausible BMI")).toBeInTheDocument();
    expect(screen.getAllByText("excluded").length).toBeGreaterThan(0);
  });

  // Renders zero counts gracefully for an empty row set without crashing.
  it("renders zero counts gracefully for an empty row set without crashing", () => {
    render(<DataOverview rows={[]} quality={makeQuality()} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
