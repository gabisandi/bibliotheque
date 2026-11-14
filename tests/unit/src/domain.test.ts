import { describe, expect, it } from "vitest";
import {
  activeWord,
  pairedWords,
  readPreferences,
  recoverBookmark,
  tokenize,
  validateBook,
} from "../../../src/domain";
import manifest from "../../../public/books/le_petit_prince/1/manifest.json";

describe("content and reader contracts", () => {
  it("links the reported French past-tense expression to its actual Portuguese equivalent in both directions", () => {
    validateBook(manifest);
    const segment = manifest.chapters[0].segments[20];
    const pair = pairedWords(manifest, segment, "fr", 0)!;
    expect(segment.fr.slice(...pair.fr)).toBe("J’ai ainsi eu");
    expect(segment.pt.slice(...pair.pt)).toBe("tive");
    expect(
      pairedWords(manifest, segment, "pt", segment.pt.indexOf("tive")),
    ).toEqual(pair);
  });
  it("rejects a public edition without approved rights or completed audio", () => {
    expect(() => validateBook({ ...manifest, status: "published" })).toThrow();
    expect(() => validateBook(manifest)).not.toThrow();
  });
  it("preserves every character including French apostrophes and whitespace", () => {
    const text = "« J’ai six ans… »\nDessine-moi un mouton !";
    expect(
      tokenize(text)
        .map((t) => t.text)
        .join(""),
    ).toBe(text);
    expect(tokenize(text).find((t) => t.text === "J’ai")?.start).toBe(2);
  });
  it("follows seeks on the audio clock and leaves gaps unhighlighted", () => {
    const words = [
      { start: 1, end: 1.5, offset: 0, length: 2, segmentId: "a" },
      { start: 2, end: 3, offset: 3, length: 4, segmentId: "a" },
    ];
    expect(activeWord(words, 2.5)?.offset).toBe(3);
    expect(activeWord(words, 1.6)).toBeUndefined();
    expect(activeWord(words, 1.1)?.offset).toBe(0);
  });
  it("recovers from invalid preferences and clamps unsafe values", () => {
    expect(readPreferences("broken").fontSize).toBe(20);
    expect(readPreferences('{"fontSize":200,"speed":-5}')).toMatchObject({
      fontSize: 30,
      speed: 0.5,
    });
  });
  it("falls back to chapter start when an edition removes a saved passage", () => {
    validateBook(manifest);
    const result = recoverBookmark(
      manifest,
      JSON.stringify({
        edition: "old",
        chapterId: manifest.chapters[0].id,
        segmentId: "removed",
        time: 900,
      }),
    );
    expect(result?.bookmark.segmentId).toBe(
      manifest.chapters[0].segments[0].id,
    );
    expect(result?.bookmark.time).toBe(0);
    expect(result?.moved).toBe(true);
  });
});
