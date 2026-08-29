import { fireEvent, render, screen } from "@testing-library/react";

import SegmentFilterBar from "@/components/analytics/SegmentFilterBar";
import { EMPTY_SEGMENT_FILTERS, type SegmentFilters } from "@/lib/segmentation";
import type { AnalyticsRow } from "@/lib/analytics";

function makeRow(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    gender: "Female", state: "CA", raceEthnicity: null, maritalStatus: null, insuranceProvider: "Aetna",
    preferredPharmacy: null, bloodType: null, smokingStatus: "Never smoker", alcoholUse: null,
    careDepartment: "Primary Care",
    age: 40, heightIn: 65, weightLbs: 140, systolicBp: 120, diastolicBp: 80,
    chronicConditions: [], currentMedications: [], registrationMonth: "2023-01", lastVisitMonth: "2023-06",
    bmi: 23, ageBracket: "30-44", conditionCount: 0, medicationCount: 0,
    ...overrides,
  };
}

describe("components/analytics/SegmentFilterBar", () => {
  const rows = [makeRow({ gender: "Female" }), makeRow({ gender: "Male" })];

  // Renders a filter dropdown button for every segment filter field.
  it("renders a filter dropdown button for every segment filter field", () => {
    render(
      <SegmentFilterBar rows={rows} filters={EMPTY_SEGMENT_FILTERS} onChange={jest.fn()} matchCount={2} totalCount={2} />,
    );
    expect(screen.getByRole("button", { name: /Gender/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Age bracket/ })).toBeInTheDocument();
  });

  // Shows the plain total patient count when no filter is active.
  it("shows the plain total patient count when no filter is active", () => {
    render(
      <SegmentFilterBar rows={rows} filters={EMPTY_SEGMENT_FILTERS} onChange={jest.fn()} matchCount={2} totalCount={2} />,
    );
    expect(screen.getByText("2 patients")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  // Shows the match count out of total and a reset button when a filter is active.
  it("shows the match count out of total and a reset button when a filter is active", () => {
    const filters: SegmentFilters = { ...EMPTY_SEGMENT_FILTERS, gender: ["Female"] };
    render(<SegmentFilterBar rows={rows} filters={filters} onChange={jest.fn()} matchCount={1} totalCount={2} />);
    expect(screen.getByText(/of 2 patients match/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  // Opens a dropdown on click and shows its available options.
  it("opens a dropdown on click and shows its available options", () => {
    render(
      <SegmentFilterBar rows={rows} filters={EMPTY_SEGMENT_FILTERS} onChange={jest.fn()} matchCount={2} totalCount={2} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Gender/ }));
    expect(screen.getByText("Female")).toBeInTheDocument();
    expect(screen.getByText("Male")).toBeInTheDocument();
  });

  // Toggles an option and reports the updated selection through onChange.
  it("toggles an option and reports the updated selection through onChange", () => {
    const onChange = jest.fn();
    render(
      <SegmentFilterBar rows={rows} filters={EMPTY_SEGMENT_FILTERS} onChange={onChange} matchCount={2} totalCount={2} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Gender/ }));
    fireEvent.click(screen.getByLabelText("Female"));

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_SEGMENT_FILTERS, gender: ["Female"] });
  });

  // Deselects an already selected option on second click.
  it("deselects an already selected option on second click", () => {
    const onChange = jest.fn();
    const filters: SegmentFilters = { ...EMPTY_SEGMENT_FILTERS, gender: ["Female"] };
    render(<SegmentFilterBar rows={rows} filters={filters} onChange={onChange} matchCount={1} totalCount={2} />);
    fireEvent.click(screen.getByRole("button", { name: /Gender/ }));
    fireEvent.click(screen.getByLabelText("Female"));

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_SEGMENT_FILTERS, gender: [] });
  });

  // Select all toggles every option on, and again toggles them all off.
  it("select all toggles every option on, and again toggles them all off", () => {
    const onChange = jest.fn();
    render(
      <SegmentFilterBar rows={rows} filters={EMPTY_SEGMENT_FILTERS} onChange={onChange} matchCount={2} totalCount={2} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Gender/ }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_SEGMENT_FILTERS, gender: ["Female", "Male"] });
  });

  // Reset button clears every filter back to the empty state.
  it("reset button clears every filter back to the empty state", () => {
    const onChange = jest.fn();
    const filters: SegmentFilters = { ...EMPTY_SEGMENT_FILTERS, gender: ["Female"] };
    render(<SegmentFilterBar rows={rows} filters={filters} onChange={onChange} matchCount={1} totalCount={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(onChange).toHaveBeenCalledWith(EMPTY_SEGMENT_FILTERS);
  });

  // Closes the dropdown when clicking outside of it.
  it("closes the dropdown when clicking outside of it", () => {
    render(
      <SegmentFilterBar rows={rows} filters={EMPTY_SEGMENT_FILTERS} onChange={jest.fn()} matchCount={2} totalCount={2} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Gender/ }));
    expect(screen.getByText("Female")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Female")).not.toBeInTheDocument();
  });
});
