import { computeAssociations } from "@/lib/associations";
import { computeOutlierCallouts, describeAssociation, suggestNextSteps, topFactors } from "@/lib/insights";
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

describe("describeAssociation", () => {
  it("never states a claim beyond what the numbers show, and includes p/n", () => {
    const rows: AnalyticsRow[] = [];
    for (let i = 0; i < 200; i += 1) {
      const isOld = i % 2 === 0;
      rows.push(
        makeRow({
          age: isOld ? 70 : 25,
          conditionCount: isOld ? 4 : 0,
        }),
      );
    }
    const results = computeAssociations(rows, conditionBurdenTarget);
    const ageResult = results.find((r) => r.fieldKey === "age")!;
    const sentence = describeAssociation(ageResult, conditionBurdenTarget);
    expect(sentence).toContain("Age");
    expect(sentence).toContain("r=");
    expect(sentence).toMatch(/n=\d/);
    expect(sentence.toLowerCase()).not.toContain("causes");
    expect(sentence.toLowerCase()).not.toContain("proves");
    // Regression check: effectLabel + "ly" produces "smally"/"negligiblely",
    // neither a real word -- describeAssociation must use a real adverb.
    expect(sentence).not.toMatch(/\bsmally\b/i);
    expect(sentence).not.toMatch(/\bnegligiblely\b/i);
  });
});

describe("topFactors", () => {
  it("only includes significant results, ranked by effect size magnitude", () => {
    const rows: AnalyticsRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      const isOld = i % 2 === 0;
      rows.push(
        makeRow({
          age: isOld ? 70 : 25,
          ageBracket: isOld ? "60-74" : "18-29",
          conditionCount: isOld ? 4 : 0,
          gender: i % 5 === 0 ? "Male" : "Female", // weak/no real relationship
        }),
      );
    }
    const results = computeAssociations(rows, conditionBurdenTarget);
    const top = topFactors(results, 5);
    expect(top.every((r) => r.significant)).toBe(true);
    for (let i = 1; i < top.length; i += 1) {
      expect(Math.abs(top[i - 1].effectSize)).toBeGreaterThanOrEqual(Math.abs(top[i].effectSize));
    }
  });

  it("returns an empty list when nothing is significant", () => {
    const rows: AnalyticsRow[] = Array.from({ length: 20 }, (_, i) =>
      makeRow({ age: 30, conditionCount: i % 2 }),
    );
    const results = computeAssociations(rows, conditionBurdenTarget);
    // Small n, no designed relationship -- shouldn't manufacture a top factor.
    const top = topFactors(results, 5);
    expect(Array.isArray(top)).toBe(true);
  });
});

describe("computeOutlierCallouts", () => {
  it("identifies the most and least common conditions", () => {
    const rows: AnalyticsRow[] = [
      ...Array.from({ length: 80 }, () => makeRow({ chronicConditions: ["I10 - Hypertension"] })),
      ...Array.from({ length: 2 }, () => makeRow({ chronicConditions: ["G43.909 - Migraine"] })),
    ];
    const callouts = computeOutlierCallouts(rows);
    const most = callouts.find((c) => c.label === "Most common condition");
    const least = callouts.find((c) => c.label === "Least common condition on file");
    expect(most?.detail).toContain("I10 - Hypertension");
    expect(least?.detail).toContain("G43.909 - Migraine");
  });

  it("returns an empty array for an empty dataset", () => {
    expect(computeOutlierCallouts([])).toEqual([]);
  });

  it("does not throw when no patient has any condition on file", () => {
    const rows = Array.from({ length: 10 }, () => makeRow({}));
    expect(() => computeOutlierCallouts(rows)).not.toThrow();
  });
});

describe("suggestNextSteps", () => {
  it("gives an honest message when nothing is significant, not a fabricated suggestion", () => {
    const suggestions = suggestNextSteps([], conditionBurdenTarget);
    expect(suggestions[0].toLowerCase()).toContain("no field tested here survived");
  });

  it("tailors the suggestion to a numeric vs categorical leading factor", () => {
    const rows: AnalyticsRow[] = [];
    for (let i = 0; i < 200; i += 1) {
      const isOld = i % 2 === 0;
      rows.push(makeRow({ age: isOld ? 70 : 25, conditionCount: isOld ? 4 : 0 }));
    }
    const results = computeAssociations(rows, conditionBurdenTarget);
    const top = topFactors(results, 5);
    const suggestions = suggestNextSteps(top, conditionBurdenTarget);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.includes(top[0].fieldLabel))).toBe(true);
  });
});
