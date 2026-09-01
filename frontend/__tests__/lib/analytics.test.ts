import {
  AGE_BRACKETS,
  ageBracketOf,
  bmiCategoryOf,
  bmiOf,
  computeCoverage,
  computeQualityFlags,
  countBy,
  countByOrdered,
  decodeDataset,
  meanOf,
  minMax,
  monthlySeries,
  pairsFor,
  pearson,
  TARGET_VARIABLES,
  type AnalyticsRow,
} from "@/lib/analytics";
import type { AnalyticsDataset, AnalyticsQuality } from "@/lib/types";

function makeRow(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    gender: "Female",
    state: "CA",
    raceEthnicity: null,
    maritalStatus: null,
    insuranceProvider: null,
    preferredPharmacy: null,
    bloodType: null,
    smokingStatus: null,
    alcoholUse: null,
    careDepartment: null,
    age: 40,
    heightIn: 65,
    weightLbs: 140,
    systolicBp: 120,
    diastolicBp: 80,
    chronicConditions: [],
    currentMedications: [],
    registrationMonth: "2023-01",
    lastVisitMonth: "2023-06",
    bmi: bmiOf(65, 140),
    ageBracket: ageBracketOf(40),
    conditionCount: 0,
    medicationCount: 0,
    ...overrides,
  };
}

function makeQuality(overrides: Partial<AnalyticsQuality> = {}): AnalyticsQuality {
  return {
    duplicate_identity_groups: 0,
    duplicate_identity_rows: 0,
    dates_before_birth: 0,
    last_visit_before_registration: 0,
    unreadable_rows: 0,
    ...overrides,
  };
}

describe("lib/analytics", () => {
  describe("ageBracketOf", () => {
    // Returns null for a null age.
    it("returns null for a null age", () => {
      expect(ageBracketOf(null)).toBeNull();
    });

    // Buckets every defined age bracket boundary correctly.
    it.each([
      [0, "0-17"],
      [17, "0-17"],
      [18, "18-29"],
      [29, "18-29"],
      [30, "30-44"],
      [44, "30-44"],
      [45, "45-59"],
      [59, "45-59"],
      [60, "60-74"],
      [74, "60-74"],
      [75, "75+"],
      [130, "75+"],
    ])("buckets age %i into %s", (age, bracket) => {
      expect(ageBracketOf(age)).toBe(bracket);
      expect(AGE_BRACKETS).toContain(bracket);
    });
  });

  describe("bmiOf", () => {
    // Computes imperial bmi for valid height and weight.
    it("computes imperial bmi for valid height and weight", () => {
      expect(bmiOf(70, 200)).toBeCloseTo((703 * 200) / (70 * 70), 5);
    });

    // Returns null when height is null.
    it("returns null when height is null", () => {
      expect(bmiOf(null, 200)).toBeNull();
    });

    // Returns null when weight is null.
    it("returns null when weight is null", () => {
      expect(bmiOf(70, null)).toBeNull();
    });

    // Returns null rather than infinity when height is zero.
    it("returns null rather than infinity when height is zero", () => {
      expect(bmiOf(0, 150)).toBeNull();
    });

    // Returns null for a negative height.
    it("returns null for a negative height", () => {
      expect(bmiOf(-5, 150)).toBeNull();
    });
  });

  describe("bmiCategoryOf", () => {
    // Returns null for a null bmi.
    it("returns null for a null bmi", () => {
      expect(bmiCategoryOf(null)).toBeNull();
    });

    // Categorizes each bmi band correctly.
    it.each([
      [18, "Underweight"],
      [18.5, "Normal"],
      [24.9, "Normal"],
      [25, "Overweight"],
      [29.9, "Overweight"],
      [30, "Obese"],
      [45, "Obese"],
    ])("categorizes bmi %s as %s", (bmi, category) => {
      expect(bmiCategoryOf(bmi)).toBe(category);
    });
  });

  describe("decodeDataset", () => {
    // Decodes a full dataset into readable rows with derived fields.
    it("decodes a full dataset into readable rows with derived fields", () => {
      const dataset: AnalyticsDataset = {
        total: 2,
        categories: { gender: ["Female", "Male"], state: ["CA"] },
        multi_value_categories: { chronic_conditions: ["Diabetes"], current_medications: [] },
        columns: {
          gender: [0, 1],
          state: [0, null],
          race_ethnicity: [null, null],
          marital_status: [null, null],
          insurance_provider: [null, null],
          preferred_pharmacy: [null, null],
          blood_type: [null, null],
          smoking_status: [null, null],
          alcohol_use: [null, null],
          care_department: [null, null],
          age: [30, null],
          height_in: [65, null],
          weight_lbs: [140, null],
          systolic_bp: [120, null],
          diastolic_bp: [80, null],
          chronic_conditions: [[0], []],
          current_medications: [[], []],
          registration_month: ["2023-01", null],
          last_visit_month: ["2023-06", null],
        },
        quality: makeQuality(),
      };

      const rows = decodeDataset(dataset);

      expect(rows).toHaveLength(2);
      expect(rows[0].gender).toBe("Female");
      expect(rows[0].state).toBe("CA");
      expect(rows[0].chronicConditions).toEqual(["Diabetes"]);
      expect(rows[0].conditionCount).toBe(1);
      expect(rows[0].bmi).toBeCloseTo(bmiOf(65, 140) as number, 5);
      expect(rows[0].ageBracket).toBe("30-44");

      expect(rows[1].gender).toBe("Male");
      expect(rows[1].state).toBeNull();
      expect(rows[1].age).toBeNull();
      expect(rows[1].bmi).toBeNull();
      expect(rows[1].ageBracket).toBeNull();
      expect(rows[1].conditionCount).toBe(0);
    });

    // Returns an empty array for an empty dataset.
    it("returns an empty array for an empty dataset", () => {
      const dataset: AnalyticsDataset = {
        total: 0,
        categories: {},
        multi_value_categories: {},
        columns: {
          gender: [], state: [], race_ethnicity: [], marital_status: [], insurance_provider: [],
          preferred_pharmacy: [], blood_type: [], smoking_status: [], alcohol_use: [], care_department: [],
          age: [], height_in: [], weight_lbs: [], systolic_bp: [], diastolic_bp: [],
          chronic_conditions: [], current_medications: [], registration_month: [], last_visit_month: [],
        },
        quality: makeQuality(),
      };
      expect(decodeDataset(dataset)).toEqual([]);
    });
  });

  describe("TARGET_VARIABLES", () => {
    // Obesity target excludes rows missing bmi rather than counting them as zero.
    it("obesity target excludes rows missing bmi rather than counting them as zero", () => {
      const obesity = TARGET_VARIABLES.find((t) => t.id === "obesity")!;
      expect(obesity.valueOf(makeRow({ bmi: null }))).toBeNull();
      expect(obesity.valueOf(makeRow({ bmi: 31 }))).toBe(1);
      expect(obesity.valueOf(makeRow({ bmi: 20 }))).toBe(0);
    });

    // Elevated bp target excludes rows missing either reading.
    it("elevated bp target excludes rows missing either reading", () => {
      const bp = TARGET_VARIABLES.find((t) => t.id === "elevated_bp")!;
      expect(bp.valueOf(makeRow({ systolicBp: null, diastolicBp: 80 }))).toBeNull();
      expect(bp.valueOf(makeRow({ systolicBp: 135, diastolicBp: 80 }))).toBe(1);
      expect(bp.valueOf(makeRow({ systolicBp: 110, diastolicBp: 70 }))).toBe(0);
    });

    // Has any chronic condition target is a plain boolean of condition count.
    it("has any chronic condition target is a plain boolean of condition count", () => {
      const has = TARGET_VARIABLES.find((t) => t.id === "has_condition")!;
      expect(has.valueOf(makeRow({ conditionCount: 0 }))).toBe(0);
      expect(has.valueOf(makeRow({ conditionCount: 2 }))).toBe(1);
    });
  });

  describe("computeCoverage", () => {
    // Reports populated counts per field across all rows.
    it("reports populated counts per field across all rows", () => {
      const rows = [makeRow({ state: "CA" }), makeRow({ state: null })];
      const coverage = computeCoverage(rows);
      const state = coverage.find((c) => c.field === "state")!;
      expect(state.populated).toBe(1);
      expect(state.total).toBe(2);
    });

    // Treats an empty multi value array as not populated.
    it("treats an empty multi value array as not populated", () => {
      const rows = [makeRow({ chronicConditions: [] }), makeRow({ chronicConditions: ["Asthma"] })];
      const coverage = computeCoverage(rows);
      const conditions = coverage.find((c) => c.field === "chronicConditions")!;
      expect(conditions.populated).toBe(1);
    });

    // Returns zero counts for an empty row set.
    it("returns zero counts for an empty row set", () => {
      const coverage = computeCoverage([]);
      expect(coverage.every((c) => c.populated === 0 && c.total === 0)).toBe(true);
    });
  });

  describe("computeQualityFlags", () => {
    // Flags implausible bmi outside the sanity bounds.
    it("flags implausible bmi outside the sanity bounds", () => {
      const rows = [makeRow({ bmi: 5 }), makeRow({ bmi: 80 }), makeRow({ bmi: 22 })];
      const flags = computeQualityFlags(rows, makeQuality());
      const bmiFlag = flags.find((f) => f.id === "implausible_bmi");
      expect(bmiFlag?.count).toBe(2);
    });

    // Flags inverted blood pressure readings.
    it("flags inverted blood pressure readings", () => {
      const rows = [makeRow({ systolicBp: 80, diastolicBp: 90 }), makeRow({ systolicBp: 120, diastolicBp: 80 })];
      const flags = computeQualityFlags(rows, makeQuality());
      const bpFlag = flags.find((f) => f.id === "bp_inverted");
      expect(bpFlag?.count).toBe(1);
    });

    // Omits a flag entirely when its count is zero.
    it("omits a flag entirely when its count is zero", () => {
      const rows = [makeRow()];
      const flags = computeQualityFlags(rows, makeQuality());
      expect(flags.find((f) => f.id === "implausible_bmi")).toBeUndefined();
    });

    // Passes through server computed quality counts unchanged.
    it("passes through server computed quality counts unchanged", () => {
      const quality = makeQuality({ duplicate_identity_rows: 4, duplicate_identity_groups: 2 });
      const flags = computeQualityFlags([makeRow()], quality);
      const dup = flags.find((f) => f.id === "duplicate_identity");
      expect(dup?.count).toBe(4);
      expect(dup?.detail).toContain("2 name + date-of-birth groups");
    });
  });

  describe("countBy", () => {
    // Counts occurrences per category, biggest first.
    it("counts occurrences per category, biggest first", () => {
      const rows = [makeRow({ state: "CA" }), makeRow({ state: "CA" }), makeRow({ state: "NY" })];
      const result = countBy(rows, (r) => r.state);
      expect(result).toEqual([
        { label: "CA", count: 2 },
        { label: "NY", count: 1 },
      ]);
    });

    // Skips rows whose accessor returns null.
    it("skips rows whose accessor returns null", () => {
      const rows = [makeRow({ state: "CA" }), makeRow({ state: null })];
      const result = countBy(rows, (r) => r.state);
      expect(result).toEqual([{ label: "CA", count: 1 }]);
    });

    // Folds the tail past topN into an other bucket.
    it("folds the tail past topN into an other bucket", () => {
      const rows = ["A", "A", "B", "C", "D"].map((state) => makeRow({ state }));
      const result = countBy(rows, (r) => r.state, 2);
      expect(result).toEqual([
        { label: "A", count: 2 },
        { label: "B", count: 1 },
        { label: "Other", count: 2 },
      ]);
    });

    // Returns an empty array for an empty row set.
    it("returns an empty array for an empty row set", () => {
      expect(countBy([], (r) => r.state)).toEqual([]);
    });
  });

  describe("countByOrdered", () => {
    // Preserves the caller supplied order regardless of magnitude.
    it("preserves the caller supplied order regardless of magnitude", () => {
      const rows = [makeRow({ ageBracket: "75+" }), makeRow({ ageBracket: "75+" }), makeRow({ ageBracket: "0-17" })];
      const result = countByOrdered(rows, (r) => r.ageBracket, AGE_BRACKETS);
      expect(result.map((b) => b.label)).toEqual([...AGE_BRACKETS]);
      expect(result.find((b) => b.label === "75+")?.count).toBe(2);
      expect(result.find((b) => b.label === "30-44")?.count).toBe(0);
    });
  });

  describe("meanOf", () => {
    // Computes the arithmetic mean.
    it("computes the arithmetic mean", () => {
      expect(meanOf([1, 2, 3, 4])).toBe(2.5);
    });

    // Returns null for an empty array.
    it("returns null for an empty array", () => {
      expect(meanOf([])).toBeNull();
    });
  });

  describe("minMax", () => {
    // Finds the min and max in a single pass.
    it("finds the min and max in a single pass", () => {
      expect(minMax([5, 1, 9, -3, 4])).toEqual({ min: -3, max: 9 });
    });

    // Returns null for an empty array.
    it("returns null for an empty array", () => {
      expect(minMax([])).toBeNull();
    });

    // Handles a very large array without a range error from argument spreading.
    it("handles a very large array without a range error from argument spreading", () => {
      const values = Array.from({ length: 200_000 }, (_, i) => i);
      expect(minMax(values)).toEqual({ min: 0, max: 199_999 });
    });
  });

  describe("pearson", () => {
    // Returns null with fewer than two pairs.
    it("returns null with fewer than two pairs", () => {
      expect(pearson([[1, 2]])).toBeNull();
    });

    // Returns 1 for perfectly correlated pairs.
    it("returns 1 for perfectly correlated pairs", () => {
      expect(pearson([[1, 1], [2, 2], [3, 3]])).toBeCloseTo(1, 5);
    });

    // Returns -1 for perfectly inversely correlated pairs.
    it("returns -1 for perfectly inversely correlated pairs", () => {
      expect(pearson([[1, 3], [2, 2], [3, 1]])).toBeCloseTo(-1, 5);
    });

    // Returns null when one variable has zero variance.
    it("returns null when one variable has zero variance", () => {
      expect(pearson([[1, 5], [2, 5], [3, 5]])).toBeNull();
    });
  });

  describe("pairsFor", () => {
    // Excludes rows where either value is missing.
    it("excludes rows where either value is missing", () => {
      const rows = [makeRow({ age: 30, bmi: 22 }), makeRow({ age: null, bmi: 25 })];
      const pairs = pairsFor(rows, (r) => r.age, (r) => r.bmi);
      expect(pairs).toEqual([[30, 22]]);
    });

    // Excludes non finite values.
    it("excludes non finite values", () => {
      const rows = [makeRow({ age: 30, bmi: Infinity })];
      const pairs = pairsFor(rows, (r) => r.age, (r) => r.bmi);
      expect(pairs).toEqual([]);
    });
  });

  describe("monthlySeries", () => {
    // Gap fills months with zero counts between the first and last observed month.
    it("gap fills months with zero counts between the first and last observed month", () => {
      const rows = [makeRow({ registrationMonth: "2023-01" }), makeRow({ registrationMonth: "2023-03" })];
      const series = monthlySeries(rows, (r) => r.registrationMonth);
      expect(series.map((s) => s.month)).toEqual(["2023-01", "2023-02", "2023-03"]);
      expect(series.find((s) => s.month === "2023-02")?.count).toBe(0);
    });

    // Rolls over the year boundary correctly.
    it("rolls over the year boundary correctly", () => {
      const rows = [makeRow({ registrationMonth: "2022-11" }), makeRow({ registrationMonth: "2023-02" })];
      const series = monthlySeries(rows, (r) => r.registrationMonth);
      expect(series.map((s) => s.month)).toEqual(["2022-11", "2022-12", "2023-01", "2023-02"]);
    });

    // Returns an empty array when no row has the field on file.
    it("returns an empty array when no row has the field on file", () => {
      const rows = [makeRow({ registrationMonth: null })];
      expect(monthlySeries(rows, (r) => r.registrationMonth)).toEqual([]);
    });
  });
});
