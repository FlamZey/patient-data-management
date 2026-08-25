"""Generates a large (10,000 row) all-valid patient upload workbook with
randomized-but-plausible data, for exercising upload performance and
pagination rather than validation edge cases (see generate_sample_workbooks
for those). Every row includes all of OPTIONAL_COLUMNS (address, insurance,
clinical core, etc.) alongside the 5 required fields -- the real upload
validator now accepts all of them.

    python -m scripts.generate_random_workbook
"""

import random

from faker import Faker

from app.services.patient_import import (
    ALLOWED_ALCOHOL_USE,
    ALLOWED_BLOOD_TYPES,
    ALLOWED_GENDERS,
    ALLOWED_MARITAL_STATUSES,
    ALLOWED_RACE_ETHNICITIES,
    ALLOWED_RELATIONSHIPS,
    ALLOWED_SMOKING_STATUSES,
    OPTIONAL_COLUMNS,
    REQUIRED_COLUMNS,
)
from scripts.generate_sample_workbooks import SAMPLES_DIR, _write_workbook

ROW_COUNT = 10_000
MAX_AGE_YEARS = 100

DATE_STRING_FORMATS = ("%Y-%m-%d", "%m/%d/%Y")

# --- candidate field value pools -------------------------------------------
# Closed-enum pools (relationship, race/ethnicity, marital status, blood type,
# smoking status, alcohol use) are imported from patient_import's ALLOWED_*
# tuples rather than hardcoded here, so this generator and the real upload
# validator can never drift apart. Open-ended pools (payers, pharmacies,
# allergens, drug names, conditions, vaccines) stay local -- real-world values
# there are far too numerous to enumerate as a closed set. Where real-world
# distribution is lopsided (blood type, smoking status, allergy/condition
# presence), a weighted choice is used instead of uniform.

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

# Weighted roughly to US population frequency; uniform choice here would make
# O-/AB- wildly overrepresented. ALLOWED_BLOOD_TYPES is the full set of real
# ABO/Rh combinations -- there are only 8, so weights below are positional.
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

# Common drug names -- a real reference list matters more here than for the
# other pools, since a fabricated string is meaningless for any downstream
# analysis. This is a larger representative set, not RxNorm; swap in a real
# RxNorm export before this feeds anything beyond a preview.
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

# (ICD-10 code, label) for common chronic conditions -- real codes, a larger
# representative set. Swap in a full CMS ICD-10 export before this feeds
# anything beyond a preview.
CHRONIC_CONDITIONS = [
    ("I10", "Essential hypertension"),
    ("E11.9", "Type 2 diabetes mellitus"),
    ("E78.5", "Hyperlipidemia"),
    ("J45.909", "Asthma"),
    ("M54.5", "Low back pain"),
    ("F41.9", "Anxiety disorder"),
    ("F32.9", "Major depressive disorder"),
    ("K21.9", "GERD"),
    ("N18.3", "Chronic kidney disease, stage 3"),
    ("E03.9", "Hypothyroidism"),
    ("I25.10", "Coronary artery disease"),
    ("I48.91", "Atrial fibrillation"),
    ("J44.9", "COPD"),
    ("M17.9", "Osteoarthritis, knee"),
    ("G47.33", "Obstructive sleep apnea"),
    ("E66.9", "Obesity"),
    ("M81.0", "Osteoporosis"),
    ("H40.9", "Glaucoma"),
    ("L40.9", "Psoriasis"),
    ("D64.9", "Anemia"),
    ("G43.909", "Migraine"),
]

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

# SMOKING_WEIGHTS/ALCOHOL_WEIGHTS are positional against ALLOWED_SMOKING_STATUSES/
# ALLOWED_ALCOHOL_USE (imported above) -- SNOMED CT smoking-status value set (the
# standard used in US Core/Meaningful Use), not just a made-up three-way split.
SMOKING_WEIGHTS = [55, 20, 8, 4, 4, 3, 3, 3]
ALCOHOL_WEIGHTS = [25, 15, 30, 20, 5, 5]


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


def _random_date_of_birth(rng: random.Random, fake: Faker) -> str:
    dob = fake.date_of_birth(minimum_age=0, maximum_age=MAX_AGE_YEARS)
    fmt = rng.choice(DATE_STRING_FORMATS)
    return dob.strftime(fmt)


def _random_height_weight(rng: random.Random) -> tuple[int, int]:
    # Gaussian, not uniform -- uniform random over a plausible range produces
    # nonsense outliers (e.g. a 3'2" adult) far more often than real data does.
    height_in = round(rng.gauss(66, 4))
    weight_lbs = round(rng.gauss(170, 35))
    return max(48, min(84, height_in)), max(80, min(350, weight_lbs))


def _random_subset(rng: random.Random, pool: list, count_weights: list[int]) -> str:
    """Samples 0..len(count_weights)-1 items from pool, weighted toward fewer
    (most patients have zero recorded allergies/conditions, not a handful)."""
    count = rng.choices(range(len(count_weights)), weights=count_weights, k=1)[0]
    return ", ".join(rng.sample(pool, count)) if count else ""


def _random_immunizations(rng: random.Random, fake: Faker) -> str:
    count = rng.randint(0, len(VACCINES))
    chosen = rng.sample(VACCINES, count)
    return ", ".join(f"{name} ({fake.date_between(start_date='-5y', end_date='today')})" for name in chosen)


def _random_extra_fields(rng: random.Random, fake: Faker) -> list:
    height_in, weight_lbs = _random_height_weight(rng)
    return [
        fake.street_address(),
        fake.city(),
        fake.state_abbr(),
        fake.zipcode(),
        fake.phone_number(),
        fake.email(),
        fake.name(),
        rng.choice(ALLOWED_RELATIONSHIPS),
        fake.phone_number(),
        fake.language_name(),
        rng.choice(ALLOWED_RACE_ETHNICITIES),
        rng.choice(ALLOWED_MARITAL_STATUSES),
        fake.job(),
        rng.choice(INSURANCE_PROVIDERS),
        fake.bothify(text="??########"),
        f"Dr. {fake.last_name()}",
        fake.date_between(start_date="-10y", end_date="today"),
        rng.choice(PHARMACIES),
        rng.choices(ALLOWED_BLOOD_TYPES, weights=BLOOD_TYPE_WEIGHTS, k=1)[0],
        height_in,
        weight_lbs,
        _random_subset(rng, ALLERGENS, [50, 30, 15, 5]),
        _random_subset(rng, MEDICATIONS, [40, 30, 20, 10]),
        _random_subset(rng, [f"{code} - {label}" for code, label in CHRONIC_CONDITIONS], [55, 25, 12, 8]),
        _random_immunizations(rng, fake),
        rng.choices(ALLOWED_SMOKING_STATUSES, weights=SMOKING_WEIGHTS, k=1)[0],
        rng.choices(ALLOWED_ALCOHOL_USE, weights=ALCOHOL_WEIGHTS, k=1)[0],
    ]


def _random_rows(rng: random.Random, fake: Faker) -> list[list]:
    # Random rather than sequential: Patient ID is the one field the app
    # keeps unencrypted for indexing, so a guessable/sequential value would
    # let anyone enumerate the whole patient table (IDOR) and infer patient
    # volume from the counter. fake.unique guarantees no collisions.
    seen_names: set[tuple[str, str]] = set()
    rows = []
    for _ in range(ROW_COUNT):
        gender = rng.choice(ALLOWED_GENDERS)
        first_name, last_name = _random_unique_name(fake, gender, seen_names)
        rows.append(
            [
                fake.unique.bothify(text="P-######"),
                first_name,
                last_name,
                _random_date_of_birth(rng, fake),
                gender,
                *_random_extra_fields(rng, fake),
            ]
        )
    return rows


def generate_random_workbook(seed: int | None = None) -> None:
    rng = random.Random(seed)
    fake = Faker()
    fake.seed_instance(seed)
    header = REQUIRED_COLUMNS + OPTIONAL_COLUMNS
    _write_workbook(SAMPLES_DIR / "random_10000_patients.xlsx", header, _random_rows(rng, fake))


if __name__ == "__main__":
    generate_random_workbook()
