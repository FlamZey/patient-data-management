import { formatDateDisplay, parseISODateLocal, toISODateLocal } from "@/lib/date";

describe("lib/date", () => {
  describe("parseISODateLocal", () => {
    // Parses a well-formed iso date into a local-midnight date.
    it("parses a well-formed iso date into a local-midnight date", () => {
      const date = parseISODateLocal("1990-01-15");
      expect(date).toBeInstanceOf(Date);
      expect(date?.getFullYear()).toBe(1990);
      expect(date?.getMonth()).toBe(0);
      expect(date?.getDate()).toBe(15);
    });

    // Returns undefined for an empty string.
    it("returns undefined for an empty string", () => {
      expect(parseISODateLocal("")).toBeUndefined();
    });

    // Returns undefined for a malformed string.
    it("returns undefined for a malformed string", () => {
      expect(parseISODateLocal("not-a-date")).toBeUndefined();
    });

    // Returns undefined when a component is zero.
    it("returns undefined when the month is zero", () => {
      expect(parseISODateLocal("1990-00-15")).toBeUndefined();
    });

    // Handles a leap-day date correctly.
    it("handles a leap day date correctly", () => {
      const date = parseISODateLocal("2000-02-29");
      expect(date?.getMonth()).toBe(1);
      expect(date?.getDate()).toBe(29);
    });

    // Never rolls the day back due to UTC/local timezone conversion.
    it("never rolls the day back due to timezone conversion", () => {
      // new Date("1990-01-15") (the UTC-parsing constructor this function
      // deliberately avoids) would render as Jan 14 in negative-UTC-offset
      // zones -- this asserts the local-component parse doesn't do that.
      const date = parseISODateLocal("1990-01-15");
      expect(date?.getDate()).toBe(15);
    });
  });

  describe("toISODateLocal", () => {
    // Formats a local date back into iso format, zero padded.
    it("formats a local date back into iso format, zero padded", () => {
      expect(toISODateLocal(new Date(1990, 0, 5))).toBe("1990-01-05");
    });

    // Round trips through parseISODateLocal unchanged.
    it("round trips through parseISODateLocal unchanged", () => {
      const original = "2023-11-30";
      const parsed = parseISODateLocal(original);
      expect(toISODateLocal(parsed as Date)).toBe(original);
    });
  });

  describe("formatDateDisplay", () => {
    // Formats a valid iso date into a human readable string.
    it("formats a valid iso date into a human readable string", () => {
      expect(formatDateDisplay("1920-01-10")).toMatch(/Jan 10, 1920/);
    });

    // Returns the original string unchanged when it cannot be parsed.
    it("returns the original string unchanged when it cannot be parsed", () => {
      expect(formatDateDisplay("garbage")).toBe("garbage");
    });

    // Returns the original string unchanged for an empty input.
    it("returns the original string unchanged for an empty input", () => {
      expect(formatDateDisplay("")).toBe("");
    });
  });
});
