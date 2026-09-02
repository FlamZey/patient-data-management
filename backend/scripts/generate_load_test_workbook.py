"""Generates a large (10,000-row), all-valid, randomized-but-plausible patient
upload workbook for exercising upload performance/pagination (see
generate_validation_fixtures for validation edge cases). Includes every
OPTIONAL_COLUMNS field, all correlated -- age/BMI/smoking bias conditions,
conditions bias meds/department, age biases insurance, age/BMI/smoking/
hypertension bias BP -- so the analytics dashboard has real correlations to
find, not independent columns. Rates are directional epidemiology, not tuned
for a specific finding.

    python -m scripts.generate_load_test_workbook
"""

import math
import random
from datetime import date

from faker import Faker

from app.services.patient_import import (
    ALLOWED_ALCOHOL_USE,
    ALLOWED_BLOOD_TYPES,
    ALLOWED_CARE_DEPARTMENTS,
    ALLOWED_GENDERS,
    ALLOWED_MARITAL_STATUSES,
    ALLOWED_RACE_ETHNICITIES,
    ALLOWED_RELATIONSHIPS,
    ALLOWED_SMOKING_STATUSES,
    MAX_DIASTOLIC_BP,
    MAX_SYSTOLIC_BP,
    MIN_DIASTOLIC_BP,
    MIN_SYSTOLIC_BP,
    OPTIONAL_COLUMNS,
    REQUIRED_COLUMNS,
)
from scripts.generate_validation_fixtures import SAMPLES_DIR, _write_workbook

ROW_COUNT = 10_000
MAX_AGE_YEARS = 100

DATE_STRING_FORMATS = ("%Y-%m-%d", "%m/%d/%Y")

# Gates the smoking-linked condition/BP boosts below. Excludes "Former smoker" -- not the acute risk current smoking carries.
CURRENT_SMOKING_STATUSES = {"Current every day smoker", "Current some day smoker", "Heavy tobacco smoker"}

# --- candidate field value pools -------------------------------------------
# Closed-enum pools import ALLOWED_* from patient_import so this generator can't drift from the real validator.
# Open-ended pools (payers, pharmacies, allergens, drugs, conditions, vaccines) stay local -- too numerous to enumerate.
# Lopsided real-world distributions (blood type, smoking, allergy/condition presence) use weighted choice, not uniform.

INSURANCE_PROVIDERS = [
    "Blue Cross Blue Shield",
    "UnitedHealthcare",
    "Aetna",
    "Cigna",
    "Humana",
    "Kaiser Permanente",
    "Medicare",
    "Medicaid",
    "Anthem",
    "Molina Healthcare",
    "Centene",
    "WellCare",
    "Tricare",
    "Oscar Health",
    "Independence Blue Cross",
]
# Medicare is age-gated (see _random_insurance) so it's excluded here, not just another uniform pool member.
_NON_MEDICARE_INSURANCE_PROVIDERS = [p for p in INSURANCE_PROVIDERS if p != "Medicare"]

PHARMACIES = [
    "CVS Pharmacy",
    "Walgreens",
    "Rite Aid",
    "Walmart Pharmacy",
    "Costco Pharmacy",
    "Kroger Pharmacy",
    "Publix Pharmacy",
    "Sam's Club Pharmacy",
    "Safeway Pharmacy",
    "Independent Pharmacy",
]

# Weighted to real US ABO/Rh frequency (positional against ALLOWED_BLOOD_TYPES) -- uniform would overrepresent O-/AB-.
BLOOD_TYPE_WEIGHTS = [38, 34, 9, 3, 7, 6, 2, 1]

ALLERGENS = [
    "Penicillin",
    "Sulfa drugs",
    "Aspirin",
    "Ibuprofen/NSAIDs",
    "Codeine",
    "Cephalosporins",
    "Peanuts",
    "Tree nuts",
    "Shellfish",
    "Milk",
    "Eggs",
    "Soy",
    "Wheat/Gluten",
    "Fish",
    "Latex",
    "Pollen",
    "Dust mites",
    "Pet dander",
    "Bee stings",
    "Mold",
]

# Real drug names -- a fabricated string is meaningless downstream. Representative set, not RxNorm; swap in a real RxNorm export before this feeds more than a preview.
MEDICATIONS = [
    "Lisinopril",
    "Metformin",
    "Atorvastatin",
    "Levothyroxine",
    "Amlodipine",
    "Metoprolol",
    "Omeprazole",
    "Albuterol",
    "Gabapentin",
    "Sertraline",
    "Losartan",
    "Hydrochlorothiazide",
    "Simvastatin",
    "Warfarin",
    "Insulin glargine",
    "Furosemide",
    "Prednisone",
    "Amoxicillin",
    "Azithromycin",
    "Citalopram",
    "Trazodone",
    "Alprazolam",
    "Tramadol",
    "Pantoprazole",
    "Montelukast",
    "Escitalopram",
    "Duloxetine",
    "Clopidogrel",
]

# (ICD-10 code, label) for common chronic conditions -- real codes, representative set. Swap in a full CMS export before more than a preview.
# No label may contain a comma: chronic_conditions is comma-separated (MULTI_VALUE_FIELDS) and a comma inside a label
# reads as the separator on parse-back -- confirmed to split e.g. "Osteoarthritis, knee" into a phantom fake condition.
CHRONIC_CONDITIONS = [
    ("I10", "Essential hypertension"),
    ("E11.9", "Type 2 diabetes mellitus"),
    ("E78.5", "Hyperlipidemia"),
    ("J45.909", "Asthma"),
    ("M54.5", "Low back pain"),
    ("F41.9", "Anxiety disorder"),
    ("F32.9", "Major depressive disorder"),
    ("K21.9", "GERD"),
    ("N18.3", "Chronic kidney disease (stage 3)"),
    ("E03.9", "Hypothyroidism"),
    ("I25.10", "Coronary artery disease"),
    ("I48.91", "Atrial fibrillation"),
    ("J44.9", "COPD"),
    ("M17.9", "Osteoarthritis (knee)"),
    ("G47.33", "Obstructive sleep apnea"),
    ("E66.9", "Obesity"),
    ("M81.0", "Osteoporosis"),
    ("H40.9", "Glaucoma"),
    ("L40.9", "Psoriasis"),
    ("D64.9", "Anemia"),
    ("G43.909", "Migraine"),
]
_CONDITION_LABEL_BY_CODE: dict[str, str] = dict(CHRONIC_CONDITIONS)
HYPERTENSION_CODE = "I10"
OBESITY_CODE = "E66.9"

# Prevalence per age band (<18/18-29/30-44/45-59/60-74/75+), roughly calibrated to real epidemiology.
# Obesity excluded (driven by BMI, see _random_conditions). Pediatric rates are near-zero for adult-onset
# disease (hypertension, diabetes, CAD, COPD, etc.) and comparable/higher for childhood-common ones (asthma, anxiety, anemia).
CONDITION_AGE_RATES: dict[str, tuple[float, float, float, float, float, float]] = {
    "I10": (0.005, 0.04, 0.15, 0.35, 0.55, 0.65),
    # Scaled down from CDC-like base rates to compensate for OBESITY_MULTIPLIER compounding on top --
    # unscaled, audited population average came out at 15.7% vs. the real ~11-12% CDC figure.
    "E11.9": (0.002, 0.008, 0.04, 0.11, 0.17, 0.20),
    "E78.5": (0.01, 0.02, 0.12, 0.30, 0.40, 0.40),
    "J45.909": (0.10, 0.08, 0.07, 0.06, 0.05, 0.05),
    "M54.5": (0.02, 0.05, 0.10, 0.15, 0.15, 0.12),
    "F41.9": (0.10, 0.15, 0.12, 0.08, 0.05, 0.03),
    "F32.9": (0.04, 0.10, 0.10, 0.08, 0.06, 0.05),
    "K21.9": (0.02, 0.04, 0.08, 0.12, 0.15, 0.15),
    "N18.3": (0.001, 0.005, 0.01, 0.03, 0.08, 0.15),
    "E03.9": (0.01, 0.02, 0.04, 0.06, 0.08, 0.08),
    "I25.10": (0.0005, 0.005, 0.02, 0.06, 0.15, 0.20),
    "I48.91": (0.0005, 0.002, 0.01, 0.03, 0.08, 0.15),
    "J44.9": (0.0005, 0.005, 0.01, 0.03, 0.08, 0.12),
    "M17.9": (0.002, 0.01, 0.03, 0.10, 0.20, 0.25),
    "G47.33": (0.02, 0.03, 0.06, 0.08, 0.08, 0.06),
    "M81.0": (0.0005, 0.001, 0.005, 0.02, 0.08, 0.15),
    "H40.9": (0.001, 0.001, 0.005, 0.02, 0.05, 0.10),
    "L40.9": (0.01, 0.02, 0.025, 0.03, 0.025, 0.02),
    "D64.9": (0.03, 0.015, 0.02, 0.025, 0.03, 0.035),
    "G43.909": (0.06, 0.08, 0.10, 0.06, 0.03, 0.02),
}

# Multipliers for real, documented risk associations (obesity->metabolic, smoking->cardiopulmonary, sex->osteoporosis/migraine), not tuned for a result.
OBESITY_BOOSTED_CONDITIONS = {"I10", "E11.9", "E78.5", "G47.33", "M17.9"}
SMOKING_BOOSTED_CONDITIONS = {"J44.9", "J45.909", "I25.10", "I48.91"}
FEMALE_BOOSTED_CONDITIONS = {"M81.0", "G43.909"}
OBESITY_MULTIPLIER = 1.8
SMOKING_MULTIPLIER = 2.5
FEMALE_MULTIPLIER = 2.0
_MAX_CONDITION_RATE = 0.95

# Age-appropriate rate that a patient has any of the 20 conditions at all, rolled once before which specific
# one(s) (see _random_conditions) -- independent per-condition rolls alone put 63.8%/98.8% of children/75+ at
# "has a condition", both unrealistic. Adult bands pulled down further after audit: realized rate (67.5%)
# still beat the real ~60% CDC "any chronic condition" figure, for a narrower 20-condition list.
AGE_BAND_ANY_CONDITION_RATE = [0.16, 0.24, 0.36, 0.53, 0.68, 0.77]

# Diagnosis-appropriate medication pools -- a real (not certain) chance of a typical treatment, not an unrelated draw. Every medication here is also in MEDICATIONS.
CONDITION_MEDICATIONS: dict[str, list[str]] = {
    "I10": ["Lisinopril", "Amlodipine", "Losartan", "Metoprolol", "Hydrochlorothiazide"],
    "E11.9": ["Metformin", "Insulin glargine"],
    "E78.5": ["Atorvastatin", "Simvastatin"],
    "J45.909": ["Albuterol", "Montelukast"],
    "K21.9": ["Omeprazole", "Pantoprazole"],
    "F41.9": ["Alprazolam", "Sertraline", "Escitalopram"],
    "F32.9": ["Sertraline", "Trazodone", "Citalopram", "Escitalopram", "Duloxetine"],
    "I25.10": ["Clopidogrel", "Metoprolol"],
    "I48.91": ["Warfarin", "Metoprolol", "Clopidogrel"],
    "J44.9": ["Albuterol", "Prednisone"],
    "M54.5": ["Gabapentin", "Tramadol"],
    "E03.9": ["Levothyroxine"],
    "N18.3": ["Furosemide", "Losartan"],
    "M17.9": ["Gabapentin"],
}

# Pediatric overrides for adult treatments with real pediatric safety concerns (Alprazolam/Tramadol carry
# pediatric warnings; SSRI is the pediatric first-line for depression). Unlisted conditions use CONDITION_MEDICATIONS as-is.
PEDIATRIC_CONDITION_MEDICATIONS: dict[str, list[str]] = {
    "F41.9": ["Sertraline", "Escitalopram"],
    "F32.9": ["Sertraline", "Escitalopram", "Citalopram"],
    "M54.5": ["Gabapentin"],
}
assert set(PEDIATRIC_CONDITION_MEDICATIONS) <= set(CONDITION_MEDICATIONS)
assert all(
    set(meds) <= set(CONDITION_MEDICATIONS[code]) for code, meds in PEDIATRIC_CONDITION_MEDICATIONS.items()
)

# Unrelated-medication pool for a pediatric patient (see _random_medications) -- child-appropriate only, not full adult MEDICATIONS (Warfarin, Insulin glargine, etc.).
PEDIATRIC_UNRELATED_MEDICATIONS = ["Amoxicillin", "Azithromycin", "Albuterol", "Montelukast"]
assert set(PEDIATRIC_UNRELATED_MEDICATIONS) <= set(MEDICATIONS)

# Care department driven by condition, not independent; falls back to a general department when nothing maps.
DEPARTMENT_BY_CONDITION: dict[str, str] = {
    "I10": "Cardiology",
    "I25.10": "Cardiology",
    "I48.91": "Cardiology",
    "N18.3": "Nephrology",
    "E11.9": "Endocrinology",
    "E03.9": "Endocrinology",
    "E66.9": "Endocrinology",
    "J45.909": "Pulmonology",
    "J44.9": "Pulmonology",
    "G47.33": "Pulmonology",
    "M17.9": "Orthopedics",
    "M54.5": "Orthopedics",
    "M81.0": "Orthopedics",
    "F41.9": "Psychiatry",
    "F32.9": "Psychiatry",
}
# Weighted random choice among matching departments, not a strict priority -- a fixed priority let
# Cardiology dominate (45.8% in an audit, since hypertension alone qualifies most patients).
_DEPARTMENT_WEIGHTS: dict[str, int] = {
    "Cardiology": 3,
    "Nephrology": 3,
    "Endocrinology": 2,
    "Pulmonology": 2,
    "Orthopedics": 2,
    "Psychiatry": 2,
}
# Fallback when no condition maps to a specialty.
_FALLBACK_DEPARTMENTS = ("Primary Care", "General Medicine")
# Pediatric patients always route to Pediatrics regardless of condition -- the real medical home for
# most US children even when a condition (e.g. childhood asthma) would route an adult to a specialty.
PEDIATRIC_DEPARTMENT = "Pediatrics"
# Asserted at import time so a change to ALLOWED_CARE_DEPARTMENTS fails loudly instead of silently drifting.
assert set(DEPARTMENT_BY_CONDITION.values()) | set(_FALLBACK_DEPARTMENTS) | {
    PEDIATRIC_DEPARTMENT
} == set(ALLOWED_CARE_DEPARTMENTS)
assert set(_DEPARTMENT_WEIGHTS) == set(DEPARTMENT_BY_CONDITION.values())

# Mean BP per age band, rising through middle age like real population trends, boosted further below for
# obesity/smoking/hypertension. Pediatric entry is one rough average across the whole 0-17 span.
BP_AGE_MEANS: tuple[tuple[int, int], ...] = ((100, 62), (112, 72), (117, 76), (123, 78), (129, 78), (134, 76))

# Mean adult weight per non-pediatric band, rising then easing off like real population trends. Indexed by
# age_band_idx - 1 (pediatric uses _pediatric_height_weight's own curve -- an adult mean applied to a toddler
# was the original pediatric BMI bug). Height is sex-linked, not age-linked, for adults (see _random_height_weight).
ADULT_WEIGHT_MEAN_BY_AGE_BAND: tuple[int, ...] = (155, 178, 185, 178, 162)

# Rough 50th-percentile-ish (age, height_in, weight_lbs) growth curve, linearly interpolated -- not clinical-grade, just body-scale-appropriate.
_PEDIATRIC_GROWTH_ANCHORS: tuple[tuple[int, int, int], ...] = (
    (0, 20, 8),
    (2, 34, 28),
    (5, 43, 40),
    (10, 54, 70),
    (14, 63, 110),
    (17, 67, 140),
)


def _pediatric_height_weight(rng: random.Random, age: int) -> tuple[int, int]:
    age = max(0, min(age, 17))
    for (a0, h0, w0), (a1, h1, w1) in zip(_PEDIATRIC_GROWTH_ANCHORS, _PEDIATRIC_GROWTH_ANCHORS[1:]):
        if a0 <= age <= a1:
            frac = (age - a0) / (a1 - a0)
            mean_height = h0 + frac * (h1 - h0)
            mean_weight = w0 + frac * (w1 - w0)
            break
    height_in = round(rng.gauss(mean_height, max(1.5, mean_height * 0.06)))
    weight_lbs = round(rng.gauss(mean_weight, max(2.0, mean_weight * 0.15)))
    return max(18, height_in), max(6, weight_lbs)

VACCINES = [
    "Influenza",
    "COVID-19",
    "Tdap",
    "MMR",
    "Hepatitis A",
    "Hepatitis B",
    "Shingles",
    "Pneumococcal",
    "HPV",
    "Varicella",
    "Meningococcal",
    "RSV",
]
# Real minimum age for vaccines where giving one to a young child would be wrong (Shingles 50+, HPV 9+, Meningococcal ~11+). Unlisted vaccines have no floor here.
MIN_VACCINE_AGE: dict[str, int] = {"Shingles": 50, "HPV": 9, "Meningococcal": 11}

# Positional against ALLOWED_SMOKING_STATUSES/ALLOWED_ALCOHOL_USE -- SNOMED CT smoking value set (US Core/Meaningful Use standard), not a made-up split.
SMOKING_WEIGHTS = [55, 20, 8, 4, 4, 3, 3, 3]
ALCOHOL_WEIGHTS = [25, 15, 30, 20, 5, 5]

# Positional against ALLOWED_GENDERS -- uniform would put Other/Prefer-not-to-say at 25% each; real surveys put them at ~1-2% combined.
GENDER_WEIGHTS = [49, 49, 1, 1]

# Pediatric emergency contacts exclude Spouse/Partner/Child/Grandchild (nonsensical for a minor) -- real intake records are overwhelmingly "Parent".
_PEDIATRIC_EMERGENCY_RELATIONSHIPS = ("Parent", "Grandparent", "Sibling", "Caregiver", "Other Relative")
_PEDIATRIC_EMERGENCY_RELATIONSHIP_WEIGHTS = [70, 15, 5, 5, 5]
# Elderly patients exclude "Parent" (would be centenarian+) in favor of adult child, spouse, grandchild, caregiver, sibling, or other relative.
_ELDERLY_EMERGENCY_RELATIONSHIPS = ("Child", "Spouse", "Grandchild", "Caregiver", "Sibling", "Other Relative")
_ELDERLY_EMERGENCY_RELATIONSHIP_WEIGHTS = [45, 15, 15, 15, 5, 5]
assert set(_PEDIATRIC_EMERGENCY_RELATIONSHIPS) <= set(ALLOWED_RELATIONSHIPS)
assert set(_ELDERLY_EMERGENCY_RELATIONSHIPS) <= set(ALLOWED_RELATIONSHIPS)
# Positional against ALLOWED_MARITAL_STATUSES, indexed by age_band_idx - 1 (pediatric is always "Single",
# see _random_marital_status). Age-graduated, not flat: a flat 1-in-6 chance pooled "Widowed" to 22.5% of
# all adults vs. the real ~6% -- follows a real Census-like shape (Single dominant 18-29, Married peaks
# mid-life, Widowed rises sharply only at 75+).
MARITAL_STATUS_WEIGHTS_BY_ADULT_BAND: tuple[list[int], ...] = (
    [70, 20, 3, 1, 2, 4],  # 18-29
    [25, 52, 12, 1, 4, 6],  # 30-44
    [12, 55, 18, 4, 5, 6],  # 45-59
    [6, 58, 16, 13, 3, 4],  # 60-74
    [4, 38, 10, 42, 2, 4],  # 75+
)
assert all(len(weights) == len(ALLOWED_MARITAL_STATUSES) for weights in MARITAL_STATUS_WEIGHTS_BY_ADULT_BAND)
assert "Single" in ALLOWED_MARITAL_STATUSES
assert "Widowed" in ALLOWED_MARITAL_STATUSES
assert {"Never smoker", "Current some day smoker"} <= set(ALLOWED_SMOKING_STATUSES)
assert {"Never", "Rarely"} <= set(ALLOWED_ALCOHOL_USE)


def _random_smoking_status(rng: random.Random, age: int) -> str:
    # A young child isn't a plausible "current smoker"; teen rate is low (CDC: ~2-4% of high schoolers), well below the adult SMOKING_WEIGHTS distribution.
    if age < 12:
        return "Never smoker"
    if age < 18:
        return "Current some day smoker" if rng.random() < 0.03 else "Never smoker"
    return rng.choices(ALLOWED_SMOKING_STATUSES, weights=SMOKING_WEIGHTS, k=1)[0]


def _random_alcohol_use(rng: random.Random, age: int) -> str:
    if age < 15:
        return "Never"
    if age < 18:
        return "Rarely" if rng.random() < 0.05 else "Never"
    return rng.choices(ALLOWED_ALCOHOL_USE, weights=ALCOHOL_WEIGHTS, k=1)[0]


def _random_marital_status(rng: random.Random, age: int, age_band_idx: int) -> str:
    if age < 18:
        return "Single"
    weights = MARITAL_STATUS_WEIGHTS_BY_ADULT_BAND[age_band_idx - 1]
    return rng.choices(ALLOWED_MARITAL_STATUSES, weights=weights, k=1)[0]


def _random_occupation(rng: random.Random, fake: Faker, age: int) -> str:
    # fake.job() is implausible for a minor or most 65+ (retired in reality). Graduated, not flat: a 68-year-old is likelier to still work than an 85-year-old.
    if age < 18:
        return "Student"
    if age >= 75:
        return "Retired" if rng.random() < 0.92 else fake.job()
    if age >= 65:
        return "Retired" if rng.random() < 0.70 else fake.job()
    return fake.job()


def _random_emergency_contact_relationship(rng: random.Random, age: int) -> str:
    if age < 18:
        return rng.choices(
            _PEDIATRIC_EMERGENCY_RELATIONSHIPS, weights=_PEDIATRIC_EMERGENCY_RELATIONSHIP_WEIGHTS, k=1
        )[0]
    if age >= 75:
        return rng.choices(_ELDERLY_EMERGENCY_RELATIONSHIPS, weights=_ELDERLY_EMERGENCY_RELATIONSHIP_WEIGHTS, k=1)[0]
    return rng.choice(ALLOWED_RELATIONSHIPS)


def _random_first_name(fake: Faker, gender: str) -> str:
    if gender == "Male":
        return fake.first_name_male()
    if gender == "Female":
        return fake.first_name_female()
    return fake.first_name()


def _random_unique_name(fake: Faker, gender: str, seen_names: set[tuple[str, str]]) -> tuple[str, str]:
    while True:
        name = (_random_first_name(fake, gender), fake.last_name())
        if name not in seen_names:
            seen_names.add(name)
            return name


def _random_date_of_birth(rng: random.Random, fake: Faker) -> date:
    # A uniform age draw doesn't resemble a real population (audit: 26% landed at 75+ vs. real ~5-8%).
    # Picks an age band first, weighted like a real population pyramid (bands match _age_band_index), then an age within it.
    band_idx = rng.choices(range(len(AGE_BAND_BOUNDS)), weights=AGE_BAND_POPULATION_WEIGHTS, k=1)[0]
    min_age, max_age = AGE_BAND_BOUNDS[band_idx]
    return fake.date_of_birth(minimum_age=min_age, maximum_age=max_age)


def _format_date(rng: random.Random, value: date) -> str:
    return value.strftime(rng.choice(DATE_STRING_FORMATS))


def _calculate_age(dob: date, today: date) -> int:
    years = today.year - dob.year
    if (today.month, today.day) < (dob.month, dob.day):
        years -= 1
    return years


def _years_before(base: date, years: int) -> date:
    try:
        return base.replace(year=base.year - years)
    except ValueError:
        # base is Feb 29 and base.year - years isn't a leap year.
        return base.replace(month=2, day=28, year=base.year - years)


# Pediatric (<18) is split from young adults (18-29) -- a single "<30" band previously applied adult disease/growth/BP modeling to children.
PEDIATRIC_BAND_INDEX = 0


def _age_band_index(age: int) -> int:
    if age < 18:
        return 0
    if age < 30:
        return 1
    if age < 45:
        return 2
    if age < 60:
        return 3
    if age < 75:
        return 4
    return 5


# Inclusive (min, max) bounds for _age_band_index's 6 bands, used to draw a birth date within a chosen band; weights mirror real population age shares.
AGE_BAND_BOUNDS: tuple[tuple[int, int], ...] = ((0, 17), (18, 29), (30, 44), (45, 59), (60, 74), (75, MAX_AGE_YEARS))
AGE_BAND_POPULATION_WEIGHTS = [22, 16, 19, 19, 16, 8]



# Plausible human BMI floor -- height/weight are independent gaussians, so their own clamps can still compound
# into a nonsensical pairing. Audit found 1.25% of rows under BMI 12 (some as low as 7.6). No ceiling needed
# (audit max BMI 62.9 is within the real severe-obesity range).
_MIN_PLAUSIBLE_BMI = 12.0


def _clamp_bmi_floor(height_in: int, weight_lbs: int) -> int:
    bmi = 703 * weight_lbs / (height_in**2)
    if bmi >= _MIN_PLAUSIBLE_BMI:
        return weight_lbs
    # ceil, not round -- round() can round the required weight down to still land fractionally under the
    # floor (e.g. height=69 rounds to BMI 11.96). Audit: 8/10,000 rows still landed at 11.94-12.0 without ceil.
    return max(weight_lbs, math.ceil(_MIN_PLAUSIBLE_BMI * height_in**2 / 703))


def _random_height_weight(rng: random.Random, gender: str, age: int, age_band_idx: int) -> tuple[int, int]:
    if age_band_idx == PEDIATRIC_BAND_INDEX:
        height_in, weight_lbs = _pediatric_height_weight(rng, age)
        return height_in, _clamp_bmi_floor(height_in, weight_lbs)
    # Gaussian, not uniform -- uniform over a plausible range produces nonsense outliers (e.g. a 3'2" adult) far more often than real data.
    height_mean = 69 if gender == "Male" else 64
    height_in = round(rng.gauss(height_mean, 3))
    weight_lbs = round(rng.gauss(ADULT_WEIGHT_MEAN_BY_AGE_BAND[age_band_idx - 1], 32))
    height_in = max(48, min(84, height_in))
    weight_lbs = max(80, min(350, weight_lbs))
    return height_in, _clamp_bmi_floor(height_in, weight_lbs)


def _random_subset(rng: random.Random, pool: list, count_weights: list[int]) -> str:
    """Samples 0..len(count_weights)-1 items from pool, weighted toward fewer
    (most patients have zero recorded allergies, not a handful)."""
    count = rng.choices(range(len(count_weights)), weights=count_weights, k=1)[0]
    return ", ".join(rng.sample(pool, count)) if count else ""


def _random_immunizations(rng: random.Random, fake: Faker, *, age: int, dob: date, today: date) -> str:
    eligible = [vaccine for vaccine in VACCINES if age >= MIN_VACCINE_AGE.get(vaccine, 0)]
    count = rng.randint(0, len(eligible))
    chosen = rng.sample(eligible, count)
    # Same as registration dates below -- an immunization date can't predate the patient's own birth.
    earliest = max(dob, _years_before(today, 5))
    return ", ".join(f"{name} ({fake.date_between(start_date=earliest, end_date='today')})" for name in chosen)


def _random_conditions(rng: random.Random, *, age_band_idx: int, bmi: float, is_smoker: bool, is_female: bool) -> list[str]:
    """Rolls whether the patient has any of the 20 conditions at all (age-gated rate), then rolls each
    condition individually only for patients who do -- rates are rescaled by the gate so each condition's
    unconditional probability still matches CONDITION_AGE_RATES. Obesity is rolled separately off BMI."""
    chosen_codes = []
    gate_rate = AGE_BAND_ANY_CONDITION_RATE[age_band_idx]
    if rng.random() < gate_rate:
        for code in CONDITION_AGE_RATES:
            rate = CONDITION_AGE_RATES[code][age_band_idx] / gate_rate
            if bmi >= 30.0 and code in OBESITY_BOOSTED_CONDITIONS:
                rate *= OBESITY_MULTIPLIER
            if is_smoker and code in SMOKING_BOOSTED_CONDITIONS:
                rate *= SMOKING_MULTIPLIER
            if is_female and code in FEMALE_BOOSTED_CONDITIONS:
                rate *= FEMALE_MULTIPLIER
            if rng.random() < min(rate, _MAX_CONDITION_RATE):
                chosen_codes.append(code)

    obesity_rate = 0.75 if bmi >= 30.0 else (0.05 if bmi >= 25.0 else 0.01)
    if rng.random() < obesity_rate:
        chosen_codes.append(OBESITY_CODE)

    return chosen_codes


def _random_medications(rng: random.Random, condition_codes: list[str], *, age: int) -> list[str]:
    meds: list[str] = []
    is_pediatric = age < 18
    for code in condition_codes:
        candidates = PEDIATRIC_CONDITION_MEDICATIONS.get(code) if is_pediatric else None
        if candidates is None:
            candidates = CONDITION_MEDICATIONS.get(code)
        if not candidates or rng.random() >= 0.7:
            continue
        meds.append(rng.choice(candidates))
        if len(candidates) > 1 and rng.random() < 0.25:
            remaining = [drug for drug in candidates if drug not in meds]
            if remaining:
                meds.append(rng.choice(remaining))

    # Small chance of an unrelated medication, like a real patient on something not reflected in conditions (e.g. a short antibiotic course); child-appropriate pool only for a pediatric patient.
    if rng.random() < (0.10 if meds else 0.05):
        unrelated_pool = PEDIATRIC_UNRELATED_MEDICATIONS if is_pediatric else MEDICATIONS
        candidates = [drug for drug in unrelated_pool if drug not in meds]
        if candidates:
            meds.append(rng.choice(candidates))

    return list(dict.fromkeys(meds))


def _random_care_department(rng: random.Random, condition_codes: list[str], *, age: int) -> str:
    if age < 18:
        return PEDIATRIC_DEPARTMENT
    present = sorted({DEPARTMENT_BY_CONDITION[code] for code in condition_codes if code in DEPARTMENT_BY_CONDITION})
    if present:
        return rng.choices(present, weights=[_DEPARTMENT_WEIGHTS[d] for d in present], k=1)[0]
    return rng.choices(_FALLBACK_DEPARTMENTS, weights=[70, 30], k=1)[0]


def _random_insurance(rng: random.Random, age: int) -> str:
    # Medicare is age-gated (65+, plus some under-65 disability) and Medicaid/CHIP covers disproportionately
    # many children (~4 in 10, CMS/KFF) -- both drawn separately so insurance tracks age.
    if age < 18:
        return "Medicaid" if rng.random() < 0.40 else rng.choice(_NON_MEDICARE_INSURANCE_PROVIDERS)
    if age >= 65:
        return "Medicare" if rng.random() < 0.7 else rng.choice(_NON_MEDICARE_INSURANCE_PROVIDERS)
    return "Medicare" if rng.random() < 0.03 else rng.choice(_NON_MEDICARE_INSURANCE_PROVIDERS)


def _random_blood_pressure(
    rng: random.Random, *, age_band_idx: int, bmi: float, is_smoker: bool, has_hypertension: bool
) -> tuple[int, int]:
    systolic_mean, diastolic_mean = BP_AGE_MEANS[age_band_idx]
    if bmi >= 30.0:
        systolic_mean += 8
        diastolic_mean += 4
    if is_smoker:
        systolic_mean += 5
        diastolic_mean += 3
    if has_hypertension:
        systolic_mean += 16
        diastolic_mean += 8

    systolic = max(MIN_SYSTOLIC_BP, min(MAX_SYSTOLIC_BP, round(rng.gauss(systolic_mean, 12))))
    diastolic = max(MIN_DIASTOLIC_BP, min(MAX_DIASTOLIC_BP, round(rng.gauss(diastolic_mean, 8))))
    # Independent gaussians can cross at the tails -- audit found 16/10,000 rows with diastolic >= systolic.
    # Cap is always satisfiable: systolic >= MIN_SYSTOLIC_BP (60) leaves diastolic >= 50, above MIN_DIASTOLIC_BP (30).
    diastolic = min(diastolic, systolic - 10)
    return systolic, diastolic


def _random_registration_and_visit_dates(rng: random.Random, fake: Faker, *, dob: date, today: date) -> tuple[date, date]:
    # Registration can't predate DOB -- matches what the real upload validator now enforces too (_validate_optional_fields).
    earliest_registration = max(dob, _years_before(today, 10))
    registration_date = fake.date_between(start_date=earliest_registration, end_date="today")
    last_visit_date = fake.date_between(start_date=registration_date, end_date="today")
    return registration_date, last_visit_date


def _random_extra_fields(rng: random.Random, fake: Faker, *, gender: str, age: int, dob: date, today: date) -> list:
    age_band_idx = _age_band_index(age)
    is_female = gender == "Female"
    smoking_status = _random_smoking_status(rng, age)
    is_smoker = smoking_status in CURRENT_SMOKING_STATUSES

    height_in, weight_lbs = _random_height_weight(rng, gender, age, age_band_idx)
    bmi = 703 * weight_lbs / (height_in**2)

    condition_codes = _random_conditions(rng, age_band_idx=age_band_idx, bmi=bmi, is_smoker=is_smoker, is_female=is_female)
    medications = _random_medications(rng, condition_codes, age=age)
    registration_date, last_visit_date = _random_registration_and_visit_dates(rng, fake, dob=dob, today=today)
    systolic_bp, diastolic_bp = _random_blood_pressure(
        rng,
        age_band_idx=age_band_idx,
        bmi=bmi,
        is_smoker=is_smoker,
        has_hypertension=HYPERTENSION_CODE in condition_codes,
    )

    return [
        fake.street_address(),
        fake.city(),
        fake.state_abbr(),
        fake.zipcode(),
        fake.phone_number(),
        fake.email(),
        fake.name(),
        _random_emergency_contact_relationship(rng, age),
        fake.phone_number(),
        fake.language_name(),
        rng.choice(ALLOWED_RACE_ETHNICITIES),
        _random_marital_status(rng, age, age_band_idx),
        _random_occupation(rng, fake, age),
        _random_insurance(rng, age),
        fake.bothify(text="??########"),
        f"Dr. {fake.last_name()}",
        _random_care_department(rng, condition_codes, age=age),
        registration_date,
        last_visit_date,
        rng.choice(PHARMACIES),
        rng.choices(ALLOWED_BLOOD_TYPES, weights=BLOOD_TYPE_WEIGHTS, k=1)[0],
        height_in,
        weight_lbs,
        systolic_bp,
        diastolic_bp,
        _random_subset(rng, ALLERGENS, [50, 30, 15, 5]),
        ", ".join(medications),
        ", ".join(f"{code} - {_CONDITION_LABEL_BY_CODE[code]}" for code in condition_codes),
        _random_immunizations(rng, fake, age=age, dob=dob, today=today),
        smoking_status,
        _random_alcohol_use(rng, age),
    ]


def _random_rows(rng: random.Random, fake: Faker) -> list[list]:
    # Random, not sequential -- Patient ID is the one unencrypted/indexed field, so a guessable value would let anyone enumerate patients (IDOR) and infer volume.
    seen_names: set[tuple[str, str]] = set()
    today = date.today()
    rows = []
    for _ in range(ROW_COUNT):
        gender = rng.choices(ALLOWED_GENDERS, weights=GENDER_WEIGHTS, k=1)[0]
        first_name, last_name = _random_unique_name(fake, gender, seen_names)
        dob = _random_date_of_birth(rng, fake)
        age = _calculate_age(dob, today)
        rows.append(
            [
                fake.unique.bothify(text="P-######"),
                first_name,
                last_name,
                _format_date(rng, dob),
                gender,
                *_random_extra_fields(rng, fake, gender=gender, age=age, dob=dob, today=today),
            ]
        )
    return rows


def generate_load_test_workbook(seed: int | None = None) -> None:
    rng = random.Random(seed)
    fake = Faker()
    fake.seed_instance(seed)
    header = REQUIRED_COLUMNS + OPTIONAL_COLUMNS
    _write_workbook(SAMPLES_DIR / "random_10000_patients.xlsx", header, _random_rows(rng, fake))


if __name__ == "__main__":
    generate_load_test_workbook()
