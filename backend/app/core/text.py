"""Text normalisation shared by the patient and user validation paths.

The backend counterpart to frontend/lib/text.ts, and it exists for the same
reason: str.strip() removes ASCII whitespace and Unicode space separators, but
NOT zero-width format characters. A "name" consisting of nothing but one of
those is invisible when rendered yet passes any check written as
`if not value.strip()`.

The frontend already guarded against this (lib/text.ts's isBlank). The backend
did not, which made it frontend-only validation -- the UI refused an invisible
name while the API accepted it. Anything reachable by an API call has to be
checked here too.
"""

# Written as code points rather than literal characters: the literals are
# invisible and undiffable, so pasting them into source is exactly the
# maintenance hazard this module exists to handle. (frontend/lib/text.ts makes
# the same choice, for the same reason.)
_ZERO_WIDTH_SPACE = "​"
_ZERO_WIDTH_NON_JOINER = "‌"
_ZERO_WIDTH_JOINER = "‍"
_ZERO_WIDTH_NO_BREAK_SPACE = "﻿"  # a.k.a. the byte-order mark

INVISIBLE_CHARS = (
    _ZERO_WIDTH_SPACE,
    _ZERO_WIDTH_NON_JOINER,
    _ZERO_WIDTH_JOINER,
    _ZERO_WIDTH_NO_BREAK_SPACE,
)

_INVISIBLE_TRANSLATION = {ord(char): None for char in INVISIBLE_CHARS}


def strip_invisible(value: str) -> str:
    """Removes the zero-width characters above, then ordinary whitespace from
    both ends. Invisible characters are dropped wherever they occur, not just
    at the edges -- one sitting between two letters is still a value nobody
    typed deliberately, and leaving it in makes rows that look identical
    compare unequal."""
    return value.translate(_INVISIBLE_TRANSLATION).strip()


def is_blank(value: str | None) -> bool:
    """True when a string holds nothing a reader would see -- the check a
    required field almost always actually means. Mirrors isBlank in
    frontend/lib/text.ts."""
    return value is None or not strip_invisible(value)
