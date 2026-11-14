import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleChapter,
  cachedRequest,
  speechFingerprint,
  translateTexts,
} from "../../../scripts/azure";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import manifest from "../../../public/books/le_petit_prince/1/manifest.json";
import { validateBook } from "../../../src/domain";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("durable editorial guarantees", () => {
  it("allows retrying a confirmed rate-limit rejection without retrying uncertain paid results", async () => {
    const folder = await mkdtemp(
      path.join(os.tmpdir(), "bibliotheque-rate-limit-"),
    );
    vi.stubEnv("AZURE_TRANSLATOR_KEY", "test-only-credential");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("", { status: 429, headers: { "Retry-After": "0" } }),
    );
    try {
      await expect(
        cachedRequest(folder, "limited", () =>
          translateTexts(["bonjour"], "fr", "pt-BR"),
        ),
      ).rejects.toThrow("429");
      expect(
        JSON.parse(await readFile(path.join(folder, "limited.json"), "utf8"))
          .status,
      ).toBe("rejected");
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(JSON.stringify([{ translations: [{ text: "olá" }] }])),
      );
      await expect(
        cachedRequest(folder, "limited", () =>
          translateTexts(["bonjour"], "fr", "pt-BR"),
        ),
      ).resolves.toEqual(["olá"]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it("treats empty lexical translations as unresolved instead of publishing fabricated meanings", async () => {
    vi.stubEnv("AZURE_TRANSLATOR_KEY", "test-only-credential");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify([{ translations: [{ text: "" }] }]), {
          status: 200,
        }),
    );
    await expect(translateTexts(["de"], "fr", "pt-BR")).rejects.toThrow(
      "incompleto",
    );
    await expect(translateTexts(["de"], "fr", "pt-BR", true)).resolves.toEqual([
      "",
    ]);
  });
  it("invalidates spoken changes while preserving audio after Portuguese edits", () => {
    const book = structuredClone(manifest);
    validateBook(book);
    const before = speechFingerprint(book, book.chapters[0]);
    book.chapters[0].segments[0].pt = "Uma revisão da tradução.";
    expect(speechFingerprint(book, book.chapters[0])).toBe(before);
    book.chapters[0].segments[0].fr += " Encore.";
    expect(speechFingerprint(book, book.chapters[0])).not.toBe(before);
  });
  it("offsets chapter boundaries by actual PCM sample count", () => {
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(36 + 48000, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(48000, 40);
    const wav = Buffer.concat([header, Buffer.alloc(48000)]).toString("base64");
    const result = assembleChapter([
      {
        wav,
        words: [
          { start: 0.1, end: 0.5, offset: 0, length: 3, segmentId: "one" },
        ],
      },
      {
        wav,
        words: [
          { start: 0.2, end: 0.6, offset: 0, length: 3, segmentId: "two" },
        ],
      },
    ]);
    expect(result.duration).toBe(2);
    expect(result.words[1].start).toBeCloseTo(1.2);
    expect(result.data.length).toBe(96044);
  });
  it("reuses completed calls and blocks an uncertain paid request from silently retrying", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "bibliotheque-cache-"));
    try {
      let charges = 0;
      await expect(
        cachedRequest(folder, "uncertain", async () => {
          charges++;
          throw new Error("network interrupted");
        }),
      ).rejects.toThrow("network interrupted");
      await expect(
        cachedRequest(folder, "uncertain", async () => {
          charges++;
          return "paid";
        }),
      ).rejects.toThrow("incerto");
      expect(charges).toBe(1);
      expect(
        await cachedRequest(folder, "complete", async () => {
          charges++;
          return "saved";
        }),
      ).toBe("saved");
      expect(
        await cachedRequest(folder, "complete", async () => {
          charges++;
          return "charged again";
        }),
      ).toBe("saved");
      expect(charges).toBe(2);
      expect(
        JSON.parse(await readFile(path.join(folder, "complete.json"), "utf8"))
          .status,
      ).toBe("complete");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
