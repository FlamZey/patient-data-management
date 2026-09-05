import { render, screen } from "@testing-library/react";

import KeyInsights from "@/components/analytics/KeyInsights";
import { TARGET_VARIABLES, type AnalyticsRow } from "@/lib/analytics";

// KeyInsights was the one source file in the repo with no coverage at all.
// It renders no numbers of its own -- every figure it shows comes from
// computeAssociations/topFactors/computeOutlierCallouts, the same functions
// the Statistics tab uses -- so what's worth asserting here is the wiring and
// the branches: what appears when there are findings, what appears when there
// are none, and that the empty cases degrade to a message rather than a crash.

const TARGET = TARGET_VARIABLES.find((variable) => variable.id === "has_condition")!;

function makeRow(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    gender: "Female",
    state: "CA",
    raceEthnicity: null,
    maritalStatus: null,
    insuranceProvider: null,
    preferredPharmacy: null,
    bloodType: null,
    smokingStatus: "Never",
    alcoholUse: null,
    careDepartment: null,
    age: 40,
    heightIn: 66,
    weightLbs: 150,
    systolicBp: 118,
    diastolicBp: 76,
    chronicConditions: [],
    currentMedications: [],
    registrationMonth: "2024-01",
    lastVisitMonth: "2024-06",
    bmi: 24.2,
    ageBracket: "30-44",
    conditionCount: 0,
    medicationCount: 0,
    ...overrides,
  };
}

// A population where smoking status tracks condition burden strongly enough
// to survive correction for multiple comparisons, so the "top factors" list
// has something in it.
function correlatedRows(): AnalyticsRow[] {
  const rows: AnalyticsRow[] = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(
      makeRow({
        smokingStatus: "Current",
        chronicConditions: ["E11"],
        conditionCount: 1,
        age: 60 + (i % 5),
      }),
    );
    rows.push(
      makeRow({
        smokingStatus: "Never",
        chronicConditions: [],
        conditionCount: 0,
        age: 30 + (i % 5),
      }),
    );
  }
  return rows;
}

describe("components/analytics/KeyInsights", () => {
  // The three cards always render, so the tab is never blank.
  it("renders the top-factors, and next-steps cards for a normal population", () => {
    render(<KeyInsights rows={correlatedRows()} target={TARGET} />);

    expect(
      screen.getByText(`Top factors associated with ${TARGET.label.toLowerCase()}`),
    ).toBeInTheDocument();
    expect(screen.getByText("What to investigate next")).toBeInTheDocument();
  });

  // The headline count reflects the rows actually passed in, not the whole dataset.
  it("reports the number of patients in the current view", () => {
    render(<KeyInsights rows={correlatedRows()} target={TARGET} />);

    expect(screen.getByText(/Based on 120 patients in the current view\./)).toBeInTheDocument();
  });

  // With no association surviving correction, the card says so rather than showing an empty list or inventing a finding.
  it("shows an explicit message when nothing survives correction", () => {
    // Every row identical: nothing can correlate with anything.
    const flat = Array.from({ length: 40 }, () => makeRow());

    render(<KeyInsights rows={flat} target={TARGET} />);

    expect(
      screen.getByText(
        `No field tested here holds up as significant against ${TARGET.label.toLowerCase()} after correction.`,
      ),
    ).toBeInTheDocument();
  });

  // An empty dataset must not throw -- the segment filters can legitimately narrow the view to nothing.
  it("renders without crashing on an empty dataset", () => {
    render(<KeyInsights rows={[]} target={TARGET} />);

    expect(screen.getByText("What to investigate next")).toBeInTheDocument();
    expect(screen.getByText(/Based on 0 patients in the current view\./)).toBeInTheDocument();
  });

  // The subtitle reports how many fields were tested, making the "top 5" ranking interpretable rather than arbitrary.
  it("states how many fields were tested", () => {
    render(<KeyInsights rows={correlatedRows()} target={TARGET} />);

    expect(screen.getByText(/out of \d+ tested\./)).toBeInTheDocument();
  });

  // Switching target re-runs the computation rather than caching the first.
  it("recomputes when the target changes", () => {
    const other = TARGET_VARIABLES.find((variable) => variable.id === "condition_burden")!;
    const { rerender } = render(<KeyInsights rows={correlatedRows()} target={TARGET} />);
    expect(
      screen.getByText(`Top factors associated with ${TARGET.label.toLowerCase()}`),
    ).toBeInTheDocument();

    rerender(<KeyInsights rows={correlatedRows()} target={other} />);
    expect(
      screen.getByText(`Top factors associated with ${other.label.toLowerCase()}`),
    ).toBeInTheDocument();
  });
});
