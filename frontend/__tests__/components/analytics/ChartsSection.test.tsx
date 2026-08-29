import { fireEvent, render, screen } from "@testing-library/react";

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
    expect(screen.getByText("Systolic BP distribution by group")).toBeInTheDocument();
    expect(screen.getByText("Relationship between two measures")).toBeInTheDocument();
    expect(screen.getByText("BMI category")).toBeInTheDocument();
    expect(screen.getByText("Correlation between numeric fields")).toBeInTheDocument();
  });

  // Renders empty states gracefully rather than crashing on an empty row set.
  it("renders empty states gracefully rather than crashing on an empty row set", () => {
    render(<ChartsSection rows={[]} target={target} />);
    expect(screen.getByText("No gender values on file.")).toBeInTheDocument();
    expect(screen.getByText("Correlation between numeric fields")).toBeInTheDocument();
  });

  // Changing the histogram field select re-renders the distribution chart for the new field.
  it("changing the histogram field select re-renders the distribution chart for the new field", () => {
    render(<ChartsSection rows={rows} target={target} />);
    const histogramSelect = screen.getByLabelText("Histogram field") as HTMLSelectElement;
    fireEvent.change(histogramSelect, { target: { value: "weightLbs" } });

    expect(screen.getByText(/How weight is spread/)).toBeInTheDocument();
  });

  // Changing the bin count select is reflected in the field's options.
  it("changing the bin count select updates the selected option", () => {
    render(<ChartsSection rows={rows} target={target} />);
    const binSelect = screen.getByLabelText("Number of bins") as HTMLSelectElement;
    fireEvent.change(binSelect, { target: { value: "30" } });
    expect(binSelect.value).toBe("30");
  });

  // Changing the box plot grouping field switches the grouping without crashing.
  it("changing the box plot grouping field switches the grouping without crashing", () => {
    render(<ChartsSection rows={rows} target={target} />);
    const groupSelect = screen.getByLabelText("Group blood pressure by") as HTMLSelectElement;
    fireEvent.change(groupSelect, { target: { value: "bloodType" } });
    expect(groupSelect.value).toBe("bloodType");
  });

  // Changing the scatter axis fields updates both selects independently.
  it("changing the scatter axis fields updates both selects independently", () => {
    render(<ChartsSection rows={rows} target={target} />);
    const xSelect = screen.getByLabelText("Horizontal axis field") as HTMLSelectElement;
    const ySelect = screen.getByLabelText("Vertical axis field") as HTMLSelectElement;
    fireEvent.change(xSelect, { target: { value: "bmi" } });
    fireEvent.change(ySelect, { target: { value: "weightLbs" } });

    expect(xSelect.value).toBe("bmi");
    expect(ySelect.value).toBe("weightLbs");
  });

  // Retitles the age bracket chart and unit label based on the selected target's kind.
  it("retitles the age bracket chart based on the selected target's kind", () => {
    const obesityTarget = TARGET_VARIABLES.find((t) => t.id === "obesity")!;
    render(<ChartsSection rows={rows} target={obesityTarget} />);
    expect(screen.getByText(`${obesityTarget.label} by age bracket`)).toBeInTheDocument();
  });
});
