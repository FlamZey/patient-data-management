// Characters that are invisible when rendered but that
// String.prototype.trim() does NOT strip -- trim() only removes ASCII
// whitespace and the Unicode "space separator" category, not zero-width
// format characters (zero-width space/non-joiner/joiner, byte-order mark).
// A required-field check written as `!value.trim()` therefore treats a
// "name" made of nothing but one of these as non-empty.
//
// Built from character codes rather than a regex literal containing \u
// escapes or the raw characters themselves -- both are prone to silently
// turning into the literal (invisible, undiffable) characters when this
// file passes through certain editors/tools, which is exactly the
// maintenance landmine this comment is warning about in the first place.
const ZERO_WIDTH_SPACE = 0x200b;
const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;
const ZERO_WIDTH_NO_BREAK_SPACE = 0xfeff; // a.k.a. the byte-order mark (BOM)

const INVISIBLE_CHARS = new RegExp(
  `[${[ZERO_WIDTH_SPACE, ZERO_WIDTH_NON_JOINER, ZERO_WIDTH_JOINER, ZERO_WIDTH_NO_BREAK_SPACE]
    .map((code) => String.fromCharCode(code))
    .join("")}]`,
  "g",
);

// True for a string that's empty once both ordinary whitespace and the
// invisible characters above are stripped -- what a required-field check
// almost always actually means by "is this filled in".
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE_CHARS, "").trim().length === 0;
}
