import {
  applySegmentFilters,
  checkSubgroupConsistency,
  compareCohorts,
  EMPTY_SEGMENT_FILTERS,
  filterOptionsFor,
  isFilterActive,
} from "@/lib/segmentation";
import type { AnalyticsRow } from "@/lib/analytics";

function makeRow(overrides: Partial<AnalyticsRow>): AnalyticsRow {
  return {
    gender: "Female",
    state: "CA",
    raceEthnicity: "White",
    maritalStatus: "Married",
    insuranceProvider: "Aetna",
    preferredPharmacy: "CVS Pharmacy",
    bloodType: "O+",
    smokingStatus: "Never smoker",
    alcoholUse: "Never",
    careDepartment: "Primary Care",
    age: 40,
    heightIn: 66,
    weightLbs: 160,
    systolicBp: 120,
    diastolicBp: 78,
    chronicConditions: [],
    currentMedications: [],
    registrationMonth: "2020-01",
    lastVisitMonth: "2024-01",
    bmi: 25.8,
    ageBracket: "30-44",
    conditionCount: 0,
    medicationCount: 0,
    ...overrides,
  };
}

describe("applySegmentFilters", () => {
  it("returns all rows when no filter is active", () => {
    const rows = [makeRow({ gender: "Male" }), makeRow({ gender: "Female" })];
    expect(applySegmentFilters(rows, EMPTY_SEGMENT_FILTERS)).toHaveLength(2);
    expect(isFilterActive(EMPTY_SEGMENT_FILTERS)).toBe(false);
  });

  it("filters on a single active field", () => {
    const rows = [makeRow({ gender: "Male" }), makeRow({ gender: "Female" })];
    const filtered = applySegmentFilters(rows, { ...EMPTY_SEGMENT_FILTERS, gender: ["Male"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].gender).toBe("Male");
    expect(isFilterActive({ ...EMPTY_SEGMENT_FILTERS, gender: ["Male"] })).toBe(true);
  });

  it("combines multiple active fields with AND", () => {
    const rows = [
      makeRow({ gender: "Male", smokingStatus: "Never smoker" }),
      makeRow({ gender: "Male", smokingStatus: "Current every day smoker" }),
      makeRow({ gender: "Female", smokingStatus: "Current every day smoker" }),
    ];
    const filtered = applySegmentFilters(rows, {
      ...EMPTY_SEGMENT_FILTERS,
      gender: ["Male"],
      smokingStatus: ["Current every day smoker"],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].gender).toBe("Male");
    expect(filtered[0].smokingStatus).toBe("Current every day smoker");
  });

  it("excludes rows with a null value for an actively-filtered field", () => {
    const rows = [makeRow({ insuranceProvider: null }), makeRow({ insuranceProvider: "Aetna" })];
    const filtered = applySegmentFilters(rows, { ...EMPTY_SEGMENT_FILTERS, insuranceProvider: ["Aetna"] });
    expect(filtered).toHaveLength(1);
  });
});

describe("filterOptionsFor", () => {
  it("keeps age brackets in natural (not alphabetical) order", () => {
    const rows = [makeRow({ ageBracket: "75+" }), makeRow({ ageBracket: "0-17" })];
    expect(filterOptionsFor(rows, "ageBracket")).toEqual(["0-17", "18-29", "30-44", "45-59", "60-74", "75+"]);
  });

  it("returns sorted distinct values for other fields", () => {
    const rows = [makeRow({ gender: "Male" }), makeRow({ gender: "Female" }), makeRow({ gender: "Male" })];
    expect(filterOptionsFor(rows, "gender")).toEqual(["Female", "Male"]);
  });
});

describe("compareCohorts", () => {
  it("computes summary stats and a significance test for two cohorts", () => {
    // Welch's t-test needs non-zero variance within each sample (it divides
    // by the standard error) -- a small spread around each mean, not a
    // constant value, so it's a realistic input rather than a degenerate one.
    const cohortA = Array.from({ length: 20 }, (_, i) => makeRow({ systolicBp: 136 + (i % 5) }));
    const cohortB = Array.from({ length: 20 }, (_, i) => makeRow({ systolicBp: 116 + (i % 5) }));
    const result = compareCohorts(cohortA, cohortB, (row) => row.systolicBp);
    expect(result.cohortA.mean).toBeCloseTo(138, 6);
    expect(result.cohortB.mean).toBeCloseTo(118, 6);
    expect(result.test).not.toBeNull();
    expect(result.test!.p).toBeLessThan(0.001);
  });
});

describe("checkSubgroupConsistency", () => {
  it("flags a genuine Simpson's-paradox-shaped reversal", () => {
    // Pooled: cohort A has a higher mean than cohort B (constructed below).
    // Within EACH subgroup, cohort B is actually higher -- a classic
    // confounding-by-subgroup-size setup.
    const cohortA = [
      // subgroup "young": low value, small group
      ...Array.from({ length: 90 }, () => makeRow({ ageBracket: "18-29", systolicBp: 110 })),
      // subgroup "old": high value, large group -- dominates cohort A's pooled mean
      ...Array.from({ length: 10 }, () => makeRow({ ageBracket: "75+", systolicBp: 200 })),
    ];
    const cohortB = [
      // subgroup "young": higher than cohort A's young subgroup
      ...Array.from({ length: 10 }, () => makeRow({ ageBracket: "18-29", systolicBp: 115 })),
      // subgroup "old": higher than cohort A's old subgroup, but small group
      // so it barely moves cohort B's pooled mean
      ...Array.from({ length: 90 }, () => makeRow({ ageBracket: "75+", systolicBp: 90 })),
    ];
    // Sanity: pooled cohort A mean should exceed pooled cohort B mean.
    const pooledA = (90 * 110 + 10 * 200) / 100;
    const pooledB = (10 * 115 + 90 * 90) / 100;
    expect(pooledA).toBeGreaterThan(pooledB);

    const result = checkSubgroupConsistency(
      cohortA,
      cohortB,
      (row) => row.systolicBp,
      (row) => row.ageBracket,
    );
    expect(result.pooledDirection).toBe("higher"); // cohort A pooled > cohort B pooled
    const young = result.outcomes.find((o) => o.subgroup === "18-29")!;
    const old = result.outcomes.find((o) => o.subgroup === "75+")!;
    // Within "young", cohort A (110) < cohort B (115) -- "lower", disagreeing
    // with the pooled "higher" direction. That single disagreement is the
    // reversal this check exists to catch, even though "old" (200 vs 90)
    // still agrees with the pooled direction on its own.
    expect(young.direction).toBe("lower");
    expect(old.direction).toBe("higher");
    expect(result.consistent).toBe(false);
  });

  it("reports consistent when every subgroup agrees with the pooled direction", () => {
    const cohortA = [
      ...Array.from({ length: 30 }, () => makeRow({ ageBracket: "18-29", systolicBp: 130 })),
      ...Array.from({ length: 30 }, () => makeRow({ ageBracket: "75+", systolicBp: 150 })),
    ];
    const cohortB = [
      ...Array.from({ length: 30 }, () => makeRow({ ageBracket: "18-29", systolicBp: 110 })),
      ...Array.from({ length: 30 }, () => makeRow({ ageBracket: "75+", systolicBp: 120 })),
    ];
    const result = checkSubgroupConsistency(
      cohortA,
      cohortB,
      (row) => row.systolicBp,
      (row) => row.ageBracket,
    );
    expect(result.consistent).toBe(true);
    expect(result.outcomes.every((o) => o.direction === "higher")).toBe(true);
  });

  it("marks a subgroup insufficient-data when below the minimum size", () => {
    const cohortA = [
      ...Array.from({ length: 2 }, () => makeRow({ ageBracket: "18-29", systolicBp: 130 })),
      ...Array.from({ length: 30 }, () => makeRow({ ageBracket: "75+", systolicBp: 150 })),
    ];
    const cohortB = [
      ...Array.from({ length: 2 }, () => makeRow({ ageBracket: "18-29", systolicBp: 110 })),
      ...Array.from({ length: 30 }, () => makeRow({ ageBracket: "75+", systolicBp: 120 })),
    ];
    const result = checkSubgroupConsistency(
      cohortA,
      cohortB,
      (row) => row.systolicBp,
      (row) => row.ageBracket,
    );
    const young = result.outcomes.find((o) => o.subgroup === "18-29")!;
    expect(young.direction).toBe("insufficient-data");
  });
});
