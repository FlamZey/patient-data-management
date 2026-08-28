// Phase 5 (Key Insights): turns computeAssociations' output into plain-
// language sentences and a short "what to investigate next" list. Every
// sentence is templated from the actual computed numbers -- never free-text
// generation -- specifically so it can't state something the data doesn't
// support.

import type { AssociationResult } from "@/lib/associations";
import { pearson, type AnalyticsRow, type NumericField, type TargetVariable } from "@/lib/analytics";
import { NUMERIC_FIELDS, pairsFor } from "@/lib/analytics";

function formatP(p: number): string {
  return p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`;
}

// effectLabel values ("negligible", "small", "medium", "large") are
// adjectives -- naively appending "ly" for adverb use produces "smally" and
// "negligiblely", neither of which is a word. This maps each to its actual
// adverb for the sentence templates below.
const EFFECT_ADVERB: Record<string, string> = {
  negligible: "negligibly",
  small: "slightly",
  medium: "moderately",
  large: "strongly",
};

function asAdverb(effectLabel: string): string {
  return EFFECT_ADVERB[effectLabel] ?? effectLabel;
}

// One finding, worded from its own test type -- a Pearson result reads as a
// correlation, a t-test/ANOVA result reads as a group difference, and a
// chi-square result reads as an association, matching what each test
// actually measures rather than using one generic phrasing for all of them.
export function describeAssociation(result: AssociationResult, target: TargetVariable): string {
  const n = `n=${result.n.toLocaleString()}`;
  switch (result.detail.test) {
    case "pearson": {
      const direction = result.detail.r > 0 ? "rises" : "falls";
      return `${result.fieldLabel} is ${asAdverb(result.effectLabel)} correlated with ${target.label.toLowerCase()} (r=${result.detail.r.toFixed(2)}, ${formatP(result.p)}, ${n}) -- ${target.label.toLowerCase()} typically ${direction} as ${result.fieldLabel.toLowerCase()} increases.`;
    }
    case "welch-t": {
      const higherGroup = result.detail.mean1 >= result.detail.mean2 ? "with" : "without";
      return `Patients ${higherGroup} ${target.label.toLowerCase()} have a ${asAdverb(result.effectLabel)} different average ${result.fieldLabel.toLowerCase()} (${result.detail.mean1.toFixed(1)} vs. ${result.detail.mean2.toFixed(1)}, ${formatP(result.p)}, ${n}).`;
    }
    case "anova":
      return `${result.fieldLabel} shows a ${result.effectLabel} relationship with ${target.label.toLowerCase()} across its groups (${formatP(result.p)}, ${n}).`;
    case "chi-square":
      return `${result.fieldLabel} is ${asAdverb(result.effectLabel)} associated with ${target.label.toLowerCase()} (${formatP(result.p)}, ${n}).`;
    default:
      return `${result.fieldLabel} is associated with ${target.label.toLowerCase()} (${formatP(result.p)}).`;
  }
}

const TOP_FACTOR_COUNT = 5;

// The strongest few SIGNIFICANT findings, ranked by effect size (not just
// p-value) among what survived FDR correction -- with thousands of patients,
// a tiny, practically meaningless effect can still be statistically
// significant, so significance alone isn't the ranking criterion.
export function topFactors(results: AssociationResult[], count = TOP_FACTOR_COUNT): AssociationResult[] {
  return results
    .filter((result) => result.significant)
    .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize))
    .slice(0, count);
}

export interface OutlierCallout {
  label: string;
  detail: string;
}

// A handful of real, computed callouts -- not a fixed list applied blindly,
// each is only included when the underlying data actually supports it (e.g.
// no "rarest condition" callout when every condition is equally common).
export function computeOutlierCallouts(rows: AnalyticsRow[]): OutlierCallout[] {
  const callouts: OutlierCallout[] = [];
  if (rows.length === 0) return callouts;

  const conditionCounts = new Map<string, number>();
  for (const row of rows) {
    for (const condition of row.chronicConditions) {
      conditionCounts.set(condition, (conditionCounts.get(condition) ?? 0) + 1);
    }
  }
  if (conditionCounts.size > 0) {
    const sorted = [...conditionCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [mostLabel, mostCount] = sorted[0];
    callouts.push({
      label: "Most common condition",
      detail: `${mostLabel} -- ${((100 * mostCount) / rows.length).toFixed(1)}% of patients (${mostCount.toLocaleString()}).`,
    });
    if (sorted.length > 1) {
      const [rareLabel, rareCount] = sorted[sorted.length - 1];
      callouts.push({
        label: "Least common condition on file",
        detail: `${rareLabel} -- ${rareCount.toLocaleString()} patient${rareCount === 1 ? "" : "s"}.`,
      });
    }
  }

  // Strongest pairwise numeric correlation, excluding a field against
  // itself -- a quick "what else moves together" callout independent of
  // whatever target is currently selected.
  let strongestPair: { a: NumericField; b: NumericField; r: number } | null = null;
  for (let i = 0; i < NUMERIC_FIELDS.length; i += 1) {
    for (let j = i + 1; j < NUMERIC_FIELDS.length; j += 1) {
      const pairs = pairsFor(rows, NUMERIC_FIELDS[i].valueOf, NUMERIC_FIELDS[j].valueOf);
      const r = pairs.length >= 3 ? pearson(pairs) : null;
      if (r != null && (strongestPair == null || Math.abs(r) > Math.abs(strongestPair.r))) {
        strongestPair = { a: NUMERIC_FIELDS[i], b: NUMERIC_FIELDS[j], r };
      }
    }
  }
  if (strongestPair && Math.abs(strongestPair.r) >= 0.3) {
    callouts.push({
      label: "Strongest relationship between two measures",
      detail: `${strongestPair.a.label} and ${strongestPair.b.label} (r=${strongestPair.r.toFixed(2)}).`,
    });
  }

  return callouts;
}

// Templated, not generated -- each suggestion is keyed off a real property
// of the top finding (its field kind, its direction) so the "next step" is
// always something the data in front of the reader actually supports.
export function suggestNextSteps(top: AssociationResult[], target: TargetVariable): string[] {
  if (top.length === 0) {
    return [
      `No field tested here survived correction for multiple comparisons against ${target.label.toLowerCase()}. Try a different target, or check the Data Overview tab for coverage gaps that might be hiding a real pattern.`,
    ];
  }

  const suggestions: string[] = [];
  const leader = top[0];

  if (leader.fieldKind === "numeric") {
    suggestions.push(
      `${leader.fieldLabel} is the strongest factor found. Check the correlation heatmap on the Visualisations tab for whether it's confounded by age or BMI before treating it as independent.`,
    );
  } else {
    suggestions.push(
      `${leader.fieldLabel} is the strongest factor found. Use the Segmentation tab to compare specific categories directly and confirm the pattern holds within each one.`,
    );
  }

  if (top.some((result) => result.caveat)) {
    suggestions.push(
      "One or more of these findings has a small-sample caveat -- treat those specifically with extra caution until more data is on file.",
    );
  }

  suggestions.push(
    "Re-check these findings after excluding the records flagged on the Data Overview tab, to confirm the pattern isn't being driven by a data-quality issue.",
  );

  return suggestions;
}
