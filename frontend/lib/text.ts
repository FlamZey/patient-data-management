// trim() strips ASCII whitespace and Unicode space-separators, but not these
// zero-width format characters -- so `!value.trim()` treats a "name" made of
// only these as non-empty.
//
// Built from char codes, not a regex literal with \u escapes or raw
// characters -- both are prone to silently becoming the literal invisible
// character when this file passes through certain editors/tools.
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
