"""Generates a large (10,000 row) all-valid patient upload workbook with
randomized-but-plausible data, for exercising upload performance and
pagination rather than validation edge cases (see generate_sample_workbooks
for those).

    python -m scripts.generate_random_workbook
"""

import random

from faker import Faker

from app.services.patient_import import ALLOWED_GENDERS, REQUIRED_COLUMNS
from scripts.generate_sample_workbooks import SAMPLES_DIR, _write_workbook

ROW_COUNT = 10_000
MAX_AGE_YEARS = 100

DATE_STRING_FORMATS = ("%Y-%m-%d", "%m/%d/%Y")


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
            ]
        )
    return rows


def generate_random_workbook(seed: int | None = None) -> None:
    rng = random.Random(seed)
    fake = Faker()
    fake.seed_instance(seed)
    _write_workbook(SAMPLES_DIR / "random_10000_patients.xlsx", REQUIRED_COLUMNS, _random_rows(rng, fake))


if __name__ == "__main__":
    generate_random_workbook()
