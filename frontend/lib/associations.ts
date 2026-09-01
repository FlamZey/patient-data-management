// Computes "is this field associated with the selected target?" across a
// curated set of candidate fields, for a chosen TargetVariable (see
// lib/analytics.ts). Shared by two UI surfaces that are really the same
// computation at different altitudes: Phase 3's full statistics table shows
// every candidate, and Phase 5's Key Insights shows only the strongest few
// as plain-language sentences -- both read from computeAssociations so the
// numbers in one can never drift from the other.

import {
  benjaminiHochberg,
  chiSquareTest,
  oneWayAnova,
  pearsonTest,
  welchTTest,
  type ChiSquareResult,
  type CorrelationTestResult,
  type AnovaResult,
  type TTestResult,
} from "@/lib/stats";
import {
  NUMERIC_FIELDS,
  pairsFor,
  type AnalyticsRow,
  type NumericField,
  type TargetVariable,
} from "@/lib/analytics";

// Categorical candidates a target gets tested against -- kept to the fields
// with a plausible clinical or social relationship to an outcome. Blood type,
// care department, marital status and insurance provider are excluded: the
// first two are noise or an artifact of which clinic booked the patient, and
// every extra test costs the real candidates statistical power through the
// FDR correction below. State is excluded separately for cardinality:
// ~50-plus distinct values would produce a chi-square table with mostly
// near-empty cells (unreliable by the same >=5-expected-count rule
// chiSquareTest itself flags) and a table too wide to read. Occupation was
// already excluded from the whole analytics dataset for the same
// high-cardinality reason.
interface CategoricalField {
  key: string;
  label: string;
  accessor: (row: AnalyticsRow) => string | null;
}

const CANDIDATE_CATEGORICAL_FIELDS: CategoricalField[] = [
  { key: "gender", label: "Gender", accessor: (row) => row.gender },
  { key: "ageBracket", label: "Age bracket", accessor: (row) => row.ageBracket },
  { key: "raceEthnicity", label: "Race/Ethnicity", accessor: (row) => row.raceEthnicity },
  { key: "smokingStatus", label: "Smoking status", accessor: (row) => row.smokingStatus },
  { key: "alcoholUse", label: "Alcohol use", accessor: (row) => row.alcoholUse },
];

// A numeric candidate is skipped when the target is deterministically
// derived from it -- obesity IS bmi>=30 and elevated_bp IS
// systolicBp/diastolicBp past a threshold (see TARGET_VARIABLES in
// lib/analytics.ts), so testing either against its own source field would
// report a fake "perfect" association instead of a real finding.
const NUMERIC_FIELD_EXCLUSIONS: Record<string, string[]> = {
  condition_burden: ["conditionCount"],
  has_condition: ["conditionCount"],
  polypharmacy: ["medicationCount"],
  medication_count: ["medicationCount"],
  obesity: ["bmi"],
  elevated_bp: ["systolicBp", "diastolicBp"],
};

// Height and weight are never candidates here: BMI is tested and is a
// function of both, so all three say the same thing about a target while
// spending three tests' worth of FDR budget to say it. They stay in
// NUMERIC_FIELDS for the correlation heatmap, where seeing them separately
// is the point.
const ALWAYS_EXCLUDED_NUMERIC = new Set(["heightIn", "weightLbs"]);

function candidateNumericFields(target: TargetVariable): NumericField[] {
  const excluded = new Set(NUMERIC_FIELD_EXCLUSIONS[target.id] ?? []);
  return NUMERIC_FIELDS.filter(
    (field) => !excluded.has(field.key) && !ALWAYS_EXCLUDED_NUMERIC.has(field.key),
  );
}

export type AssociationTestDetail =
  | TTestResult
  | AnovaResult
  | ChiSquareResult
  | CorrelationTestResult;

export interface AssociationResult {
  fieldKey: string;
  fieldLabel: string;
  fieldKind: "numeric" | "categorical";
  method: string;
  p: number;
  adjustedP: number;
  significant: boolean;
  effectSize: number;
  effectLabel: string;
  effectSizeName: string;
  n: number;
  caveat: string | null;
  detail: AssociationTestDetail;
}

const MIN_GROUP_SIZE = 5;

function effectLabel(name: string, value: number): string {
  const magnitude = Math.abs(value);
  if (name === "Cohen's d") {
    if (magnitude < 0.2) return "negligible";
    if (magnitude < 0.5) return "small";
    if (magnitude < 0.8) return "medium";
    return "large";
  }
  if (name === "eta-squared") {
    if (magnitude < 0.01) return "negligible";
    if (magnitude < 0.06) return "small";
    if (magnitude < 0.14) return "medium";
    return "large";
  }
  if (name === "Cramer's V") {
    if (magnitude < 0.1) return "negligible";
    if (magnitude < 0.3) return "small";
    if (magnitude < 0.5) return "medium";
    return "large";
  }
  // Pearson r
  if (magnitude < 0.1) return "negligible";
  if (magnitude < 0.3) return "small";
  if (magnitude < 0.5) return "medium";
  return "large";
}

function groupByCategory(
  rows: AnalyticsRow[],
  accessor: (row: AnalyticsRow) => string | null,
): Map<string, AnalyticsRow[]> {
  const groups = new Map<string, AnalyticsRow[]>();
  for (const row of rows) {
    const key = accessor(row);
    if (key == null) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

// Tests one categorical field against a binary target via a contingency
// table (category x target 0/1), using chi-square + Cramer's V.
function testCategoricalAgainstBinary(
  rows: AnalyticsRow[],
  field: CategoricalField,
  target: TargetVariable,
): AssociationResult | null {
  const groups = groupByCategory(rows, field.accessor);
  const categories = [...groups.keys()].filter((key) => groups.get(key)!.length >= MIN_GROUP_SIZE);
  if (categories.length < 2) return null;

  const table = categories.map((category) => {
    let positive = 0;
    let total = 0;
    for (const row of groups.get(category)!) {
      const value = target.valueOf(row);
      if (value == null) continue;
      total += 1;
      if (value === 1) positive += 1;
    }
    return [positive, total - positive];
  });

  const result = chiSquareTest(table);
  if (result == null) return null;

  return {
    fieldKey: field.key,
    fieldLabel: field.label,
    fieldKind: "categorical",
    method: "Chi-square test of independence",
    p: result.p,
    adjustedP: result.p,
    significant: false,
    effectSize: result.cramersV,
    effectLabel: effectLabel("Cramer's V", result.cramersV),
    effectSizeName: "Cramer's V",
    n: result.n,
    caveat:
      result.minExpectedCount < 5
        ? "Some categories have too few observations for a reliable chi-square estimate."
        : null,
    detail: result,
  };
}

// Tests one categorical field against a count target via one-way ANOVA (does
// the target's mean differ across the field's categories?).
function testCategoricalAgainstCount(
  rows: AnalyticsRow[],
  field: CategoricalField,
  target: TargetVariable,
): AssociationResult | null {
  const groups = groupByCategory(rows, field.accessor);
  const numericGroups: number[][] = [];
  let n = 0;
  for (const [, groupRows] of groups) {
    if (groupRows.length < MIN_GROUP_SIZE) continue;
    const values = groupRows
      .map((row) => target.valueOf(row))
      .filter((value): value is number => value != null);
    if (values.length < MIN_GROUP_SIZE) continue;
    numericGroups.push(values);
    n += values.length;
  }
  if (numericGroups.length < 2) return null;

  const result = oneWayAnova(numericGroups);
  if (result == null) return null;

  return {
    fieldKey: field.key,
    fieldLabel: field.label,
    fieldKind: "categorical",
    method: "One-way ANOVA",
    p: result.p,
    adjustedP: result.p,
    significant: false,
    effectSize: result.etaSquared,
    effectLabel: effectLabel("eta-squared", result.etaSquared),
    effectSizeName: "eta-squared",
    n,
    caveat: null,
    detail: result,
  };
}

// Tests one numeric field against a binary target via Welch's t-test
// (comparing the field's mean between target=1 and target=0 patients).
function testNumericAgainstBinary(
  rows: AnalyticsRow[],
  field: NumericField,
  target: TargetVariable,
): AssociationResult | null {
  const withTarget: number[] = [];
  const withoutTarget: number[] = [];
  for (const row of rows) {
    const targetValue = target.valueOf(row);
    const fieldValue = field.valueOf(row);
    if (targetValue == null || fieldValue == null) continue;
    (targetValue === 1 ? withTarget : withoutTarget).push(fieldValue);
  }
  const result = welchTTest(withTarget, withoutTarget);
  if (result == null) return null;

  return {
    fieldKey: field.key,
    fieldLabel: field.label,
    fieldKind: "numeric",
    method: "Welch's t-test",
    p: result.p,
    adjustedP: result.p,
    significant: false,
    effectSize: result.cohensD,
    effectLabel: effectLabel("Cohen's d", result.cohensD),
    effectSizeName: "Cohen's d",
    n: result.n1 + result.n2,
    caveat: null,
    detail: result,
  };
}

// Tests one numeric field against a count target via Pearson correlation.
function testNumericAgainstCount(
  rows: AnalyticsRow[],
  field: NumericField,
  target: TargetVariable,
): AssociationResult | null {
  const pairs = pairsFor(rows, field.valueOf, target.valueOf);
  const result = pearsonTest(pairs);
  if (result == null) return null;

  return {
    fieldKey: field.key,
    fieldLabel: field.label,
    fieldKind: "numeric",
    method: "Pearson correlation",
    p: result.p,
    adjustedP: result.p,
    significant: false,
    effectSize: result.r,
    effectLabel: effectLabel("r", result.r),
    effectSizeName: "r",
    n: result.n,
    caveat: null,
    detail: result,
  };
}

const FDR_ALPHA = 0.05;

// Runs every candidate field against the target, then applies one
// Benjamini-Hochberg correction across the WHOLE resulting set -- not per
// field type -- since all of them are being tested against the same target
// in the same pass, and that's the family multiple-comparison correction is
// meant to cover.
export function computeAssociations(rows: AnalyticsRow[], target: TargetVariable): AssociationResult[] {
  const results: AssociationResult[] = [];

  for (const field of candidateNumericFields(target)) {
    const result =
      target.kind === "binary"
        ? testNumericAgainstBinary(rows, field, target)
        : testNumericAgainstCount(rows, field, target);
    if (result) results.push(result);
  }

  for (const field of CANDIDATE_CATEGORICAL_FIELDS) {
    const result =
      target.kind === "binary"
        ? testCategoricalAgainstBinary(rows, field, target)
        : testCategoricalAgainstCount(rows, field, target);
    if (result) results.push(result);
  }

  const pValues = results.map((result) => result.p);
  const adjusted = benjaminiHochberg(pValues, FDR_ALPHA);
  return results.map((result, index) => ({
    ...result,
    adjustedP: adjusted[index].adjustedP,
    significant: adjusted[index].significant,
  }));
}
