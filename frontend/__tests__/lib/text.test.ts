import { isBlank } from "@/lib/text";

describe("lib/text", () => {
  describe("isBlank", () => {
    // Returns true for an empty string.
    it("returns true for an empty string", () => {
      expect(isBlank("")).toBe(true);
    });

    // Returns true for ordinary whitespace only.
    it("returns true for ordinary whitespace only", () => {
      expect(isBlank("   \t\n  ")).toBe(true);
    });

    // Returns true for a string made only of a zero width space.
    it("returns true for a string made only of a zero width space", () => {
      expect(isBlank(String.fromCharCode(0x200b))).toBe(true);
    });

    // Returns true for a mix of invisible characters and ordinary whitespace.
    it("returns true for a mix of invisible characters and ordinary whitespace", () => {
      const value = " " + String.fromCharCode(0x200b, 0x200c, 0x200d, 0xfeff) + " ";
      expect(isBlank(value)).toBe(true);
    });

    // Returns false for real, visible content.
    it("returns false for real, visible content", () => {
      expect(isBlank("Ada")).toBe(false);
    });

    // Returns false when invisible characters surround real content.
    it("returns false when invisible characters surround real content", () => {
      const value = String.fromCharCode(0x200b) + "Ada" + String.fromCharCode(0x200b);
      expect(isBlank(value)).toBe(false);
    });

    // Returns false for a single non whitespace character.
    it("returns false for a single non whitespace character", () => {
      expect(isBlank("a")).toBe(false);
    });
  });
});
