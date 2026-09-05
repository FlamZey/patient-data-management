import { render, screen } from "@testing-library/react";

import ChartsSection from "@/components/analytics/ChartsSection";
import { TARGET_VARIABLES, type AnalyticsRow } from "@/lib/analytics";

function makeRow(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    gender: "Female", state: "CA", raceEthnicity: null, maritalStatus: null, insuranceProvider: null,
    preferredPharmacy: null, bloodType: "O+", smokingStatus: "Never smoker", alcoholUse: null,
    careDepartment: "Primary Care",
    age: 40, heightIn: 65, weightLbs: 140, systolicBp: 120, diastolicBp: 80,
    chronicConditions: [], currentMedications: [], registrationMonth: "2023-01", lastVisitMonth: "2023-06",
    bmi: 23, ageBracket: "30-44", conditionCount: 0, medicationCount: 0,
    ...overrides,
  };
}

const target = TARGET_VARIABLES.find((t) => t.id === "condition_burden")!;

describe("components/analytics/ChartsSection", () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    makeRow({
      age: 20 + i * 2,
      systolicBp: 110 + i,
      diastolicBp: 70 + i,
      gender: i % 2 === 0 ? "Female" : "Male",
      conditionCount: i % 3,
    }),
  );

  // Renders every chart card title for a populated dataset.
  it("renders every chart card title for a populated dataset", () => {
    render(<ChartsSection rows={rows} target={target} />);
    expect(screen.getByText("Gender split")).toBeInTheDocument();
    expect(screen.getByText("Care department split")).toBeInTheDocument();
    expect(screen.getByText("Registrations over time")).toBeInTheDocument();
    expect(screen.getByText("BMI category")).toBeInTheDocument();
    expect(screen.getByText("Correlation between numeric fields")).toBeInTheDocument();
    // condition_burden is a count target, so it titles as an average.
    expect(screen.getByText(`Average ${target.label.toLowerCase()} by age bracket`)).toBeInTheDocument();
  });

  // Renders empty states gracefully rather than crashing on an empty row set.
  it("renders empty states gracefully rather than crashing on an empty row set", () => {
    render(<ChartsSection rows={[]} target={target} />);
    expect(screen.getByText("No gender values on file.")).toBeInTheDocument();
    expect(screen.getByText("Correlation between numeric fields")).toBeInTheDocument();
  });

  // Retitles the age bracket chart based on the target's kind: a binary target reads as a share, a count target as an average.
  it("retitles the age bracket chart based on the target's kind", () => {
    const obesityTarget = TARGET_VARIABLES.find((t) => t.id === "obesity")!;
    render(<ChartsSection rows={rows} target={obesityTarget} />);
    expect(
      screen.getByText(`Share of patients with ${obesityTarget.label.toLowerCase()}, by age bracket`),
    ).toBeInTheDocument();
  });

  // States the fixed target variable above the chart grid.
  it("states the fixed target variable above the chart grid", () => {
    render(<ChartsSection rows={rows} target={target} />);
    expect(screen.getByText(`Target variable: ${target.label.toLowerCase()} (${target.kind}).`)).toBeInTheDocument();
  });
});
