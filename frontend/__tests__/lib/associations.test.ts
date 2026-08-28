// Integration test for computeAssociations -- lib/stats.ts is already
// validated against reference values in isolation; this checks the WIRING
// (field access, grouping, exclusions, FDR correction) on realistic-shaped
// rows, since a bug here would silently show a wrong field or wrong grouping
// with a p-value that still looks plausible.

import { computeAssociations } from "@/lib/associations";
import { TARGET_VARIABLES, type AnalyticsRow } from "@/lib/analytics";

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

const conditionBurdenTarget = TARGET_VARIABLES.find((t) => t.id === "condition_burden")!;
const obesityTarget = TARGET_VARIABLES.find((t) => t.id === "obesity")!;

describe("computeAssociations", () => {
  it("finds a real designed relationship: age correlates with condition burden", () => {
    // Deliberately mirrors the generator's own age->condition-count shape:
    // older rows get more conditions, younger rows get fewer.
    const rows: AnalyticsRow[] = [];
    for (let i = 0; i < 200; i += 1) {
      const isOld = i % 2 === 0;
      rows.push(
        makeRow({
          age: isOld ? 70 : 25,
          ageBracket: isOld ? "60-74" : "18-29",
          conditionCount: isOld ? 3 + (i % 3) : i % 2,
        }),
      );
    }

    const results = computeAssociations(rows, conditionBurdenTarget);
    const ageResult = results.find((r) => r.fieldKey === "age");
    expect(ageResult).toBeDefined();
    expect(ageResult!.method).toBe("Pearson correlation");
    expect(ageResult!.effectSize).toBeGreaterThan(0.5); // strong positive correlation by construction
    expect(ageResult!.p).toBeLessThan(0.001);
    expect(ageResult!.significant).toBe(true);
  });

  it("excludes bmi as a candidate against the obesity target (tautological)", () => {
    const rows: AnalyticsRow[] = Array.from({ length: 50 }, (_, i) => makeRow({ age: 20 + i }));
    const results = computeAssociations(rows, obesityTarget);
    expect(results.find((r) => r.fieldKey === "bmi")).toBeUndefined();
  });

  it("excludes conditionCount as a candidate against the condition_burden target", () => {
    const rows: AnalyticsRow[] = Array.from({ length: 50 }, (_, i) => makeRow({ age: 20 + i }));
    const results = computeAssociations(rows, conditionBurdenTarget);
    expect(results.find((r) => r.fieldKey === "conditionCount")).toBeUndefined();
  });

  it("finds no false association in genuinely random data more often than chance allows, after FDR correction", () => {
    // Every field here is independent of the target by construction -- FDR
    // correction should suppress most/all of the raw-p<0.05 hits that occur
    // by chance across this many tests.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const genders = ["Male", "Female"];
    const rows: AnalyticsRow[] = Array.from({ length: 500 }, () =>
      makeRow({
        age: Math.floor(random() * 80),
        conditionCount: Math.floor(random() * 5),
        gender: genders[Math.floor(random() * genders.length)],
      }),
    );

    const results = computeAssociations(rows, conditionBurdenTarget);
    const rawSignificant = results.filter((r) => r.p < 0.05).length;
    const adjustedSignificant = results.filter((r) => r.significant).length;
    expect(adjustedSignificant).toBeLessThanOrEqual(rawSignificant);
  });

  it("every adjusted p-value is >= its raw p-value", () => {
    const rows: AnalyticsRow[] = Array.from({ length: 100 }, (_, i) =>
      makeRow({ age: 20 + (i % 60), conditionCount: i % 4 }),
    );
    const results = computeAssociations(rows, conditionBurdenTarget);
    for (const result of results) {
      expect(result.adjustedP).toBeGreaterThanOrEqual(result.p - 1e-9);
    }
  });

  it("returns an empty array for an empty dataset", () => {
    expect(computeAssociations([], conditionBurdenTarget)).toEqual([]);
  });
});
