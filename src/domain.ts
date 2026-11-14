/** Versioned editorial contract shared by the static reader and local book tools. */
export interface Annotation {
  fr: [number, number];
  pt: [number, number];
  note?: string;
}
export interface WordTiming {
  start: number;
  end: number;
  offset: number;
  length: number;
  segmentId: string;
}
export interface Passage {
  id: string;
  fr: string;
  pt: string;
  speaker: string;
  image?: string;
  imageAlt?: string;
  annotations?: Annotation[];
  illustrations?: { src: string; alt: string }[];
}
export interface Chapter {
  id: string;
  title: string;
  subtitle: string;
  segments: Passage[];
  audio?: {
    src: string;
    duration: number;
    words: WordTiming[];
    fingerprint: string;
  };
}
export interface Book {
  schemaVersion: 1;
  id: string;
  edition: string;
  title: string;
  translatedTitle: string;
  author: string;
  description: string;
  sourceLanguage: string;
  targetLanguage: string;
  cover: string;
  accent: string;
  status: "preview" | "published";
  source: { name: string; rights: "pending" | "verified"; credit: string };
  voices: Record<string, string>;
  chapters: Chapter[];
  glossary: Record<string, string>;
  review: {
    translation: boolean;
    voices: boolean;
    illustrations: boolean;
    cover: boolean;
    audio: boolean;
  };
}
export interface Catalog {
  schemaVersion: 1;
  books: { id: string; manifest: string }[];
  entries: { date: string; title: string; text: string; tag: string }[];
}
export interface Preferences {
  sounds: boolean;
  fontSize: number;
  spacing: number;
  translation: boolean;
  theme: "paper" | "night";
  speed: number;
}
export const DEFAULT_PREFERENCES: Preferences = {
  sounds: true,
  fontSize: 20,
  spacing: 1.8,
  translation: true,
  theme: "paper",
  speed: 1,
};
export interface Bookmark {
  language?: "fr" | "pt";
  edition: string;
  chapterId: string;
  segmentId: string;
  offset: number;
  time: number;
}

/** Reject incompatible, malformed or unsafe public content before rendering or packaging. */
export function validateBook(value: unknown): asserts value is Book {
  const b = value as Book;
  const fail = (message: string): never => {
    throw new Error(`Edição inválida: ${message}`);
  };
  if (!b || b.schemaVersion !== 1) fail("versão do manifesto não suportada.");
  for (const key of [
    "id",
    "edition",
    "title",
    "author",
    "description",
    "sourceLanguage",
    "targetLanguage",
    "cover",
  ] as const)
    if (typeof b[key] !== "string" || !b[key].trim())
      fail(`campo ${key} ausente.`);
  if (!/^[a-z0-9_]+$/.test(b.id) || !/^[a-zA-Z0-9_.-]+$/.test(b.edition))
    fail("identificadores inseguros.");
  if (!["preview", "published"].includes(b.status))
    fail("estado desconhecido.");
  if (
    !b.source ||
    !["pending", "verified"].includes(b.source.rights) ||
    !b.review ||
    !b.voices ||
    !b.glossary ||
    typeof b.glossary !== "object"
  )
    fail("créditos ou revisão ausentes.");
  for (const key of [
    "translation",
    "voices",
    "illustrations",
    "cover",
    "audio",
  ] as const)
    if (typeof b.review[key] !== "boolean") fail(`revisão ${key} ausente.`);
  if (
    Object.values(b.voices).some((v) => typeof v !== "string" || !v.trim()) ||
    Object.values(b.glossary).some((v) => typeof v !== "string")
  )
    fail("elenco ou glossário inválido.");
  if (!Array.isArray(b.chapters) || !b.chapters.length)
    fail("nenhum capítulo.");
  const ids = new Set<string>();
  const safeAsset = (path: string) =>
    /^\/books\/[a-zA-Z0-9_./-]+$/.test(path) && !path.includes("..");
  if (!safeAsset(b.cover)) fail("capa fora do pacote.");
  for (const c of b.chapters) {
    if (
      !c.id ||
      ids.has(c.id) ||
      !c.title ||
      !Array.isArray(c.segments) ||
      !c.segments.length
    )
      fail("capítulo vazio ou duplicado.");
    ids.add(c.id);
    for (const s of c.segments) {
      if (
        !s.id ||
        ids.has(s.id) ||
        typeof s.fr !== "string" ||
        !s.fr.trim() ||
        typeof s.pt !== "string" ||
        !s.speaker ||
        !b.voices[s.speaker]
      )
        fail("trecho vazio, duplicado ou sem voz.");
      ids.add(s.id);
      if (s.image && (!safeAsset(s.image) || !s.imageAlt))
        fail("ilustração sem descrição ou fora do pacote.");
      if (
        s.illustrations &&
        (!Array.isArray(s.illustrations) ||
          s.illustrations.some((i) => !safeAsset(i.src) || !i.alt))
      )
        fail("ilustrações inválidas.");
      for (const a of s.annotations ?? [])
        for (const lang of ["fr", "pt"] as const)
          if (
            !Array.isArray(a[lang]) ||
            a[lang].length !== 2 ||
            !a[lang].every(Number.isInteger) ||
            a[lang][0] < 0 ||
            a[lang][1] <= a[lang][0] ||
            a[lang][1] > s[lang].length
          )
            fail("anotação fora do texto.");
    }
    if (c.audio) {
      if (
        !safeAsset(c.audio.src) ||
        !Number.isFinite(c.audio.duration) ||
        c.audio.duration <= 0 ||
        !c.audio.fingerprint ||
        !Array.isArray(c.audio.words) ||
        !c.audio.words.length
      )
        fail("áudio incompleto.");
      let previous = -1;
      for (const w of c.audio.words) {
        const s = c.segments.find((s) => s.id === w.segmentId);
        if (
          !s ||
          ![w.start, w.end, w.offset, w.length].every(Number.isFinite) ||
          w.start < previous ||
          w.end <= w.start ||
          w.end > c.audio.duration + 0.1 ||
          !Number.isInteger(w.offset) ||
          !Number.isInteger(w.length) ||
          w.offset < 0 ||
          w.length <= 0 ||
          w.offset + w.length > s.fr.length
        )
          fail("marcação de áudio inválida.");
        previous = w.start;
      }
    }
  }
  if (
    b.status === "published" &&
    (b.source.rights !== "verified" ||
      Object.values(b.review).some((v) => v !== true) ||
      b.chapters.some((c) => !c.audio || c.segments.some((s) => !s.pt.trim())))
  )
    fail("publicação exige direitos, revisão, tradução e áudio completos.");
}

/** Read preferences defensively: storage can be disabled, stale, or edited by a visitor. */
export function readPreferences(raw: string | null): Preferences {
  try {
    const p = JSON.parse(raw ?? "{}");
    const range = (
      value: unknown,
      min: number,
      max: number,
      fallback: number,
    ) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(min, Math.min(max, value))
        : fallback;
    return {
      sounds: typeof p?.sounds === "boolean" ? p.sounds : true,
      fontSize: range(p?.fontSize, 16, 30, 20),
      spacing: range(p?.spacing, 1.4, 2.2, 1.8),
      speed: range(p?.speed, 0.5, 2, 1),
      translation: typeof p?.translation === "boolean" ? p.translation : true,
      theme: p?.theme === "night" ? "night" : "paper",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Recover by stable anchor; a removed passage falls back to its chapter's beginning. */
export function recoverBookmark(
  book: Book,
  raw: string | null,
): { bookmark: Bookmark; moved: boolean } | null {
  try {
    if (!raw) return null;
    const old = JSON.parse(raw) as Bookmark;
    const chapter =
      book.chapters.find((c) => c.id === old.chapterId) ?? book.chapters[0];
    const segment = chapter.segments.find((s) => s.id === old.segmentId);
    const changed = old.edition !== book.edition;
    return {
      bookmark: {
        edition: book.edition,
        chapterId: chapter.id,
        segmentId: segment?.id ?? chapter.segments[0].id,
        language: old.language === "pt" ? "pt" : "fr",
        offset:
          segment && Number.isInteger(old.offset)
            ? Math.max(
                0,
                Math.min(
                  old.offset,
                  segment[old.language === "pt" ? "pt" : "fr"].length,
                ),
              )
            : 0,
        time:
          !changed && segment && Number.isFinite(old.time)
            ? Math.max(0, Math.min(old.time, chapter.audio?.duration ?? 0))
            : 0,
      },
      moved: changed || !segment,
    };
  } catch {
    return null;
  }
}

/** Use the audio clock to find the spoken word, leaving silent pauses unhighlighted. */
export function activeWord(
  words: WordTiming[],
  seconds: number,
): WordTiming | undefined {
  let lo = 0,
    hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid].start <= seconds) lo = mid + 1;
    else hi = mid - 1;
  }
  const word = words[hi];
  return word && seconds < word.end ? word : undefined;
}

/** Return word spans while keeping punctuation and whitespace byte-for-byte in the page. */
export function tokenize(
  text: string,
): { text: string; start: number; word: boolean }[] {
  return [
    ...text.matchAll(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*|[^\p{L}\p{N}]+/gu),
  ].map((m) => ({
    text: m[0],
    start: m.index!,
    word: /^[\p{L}\p{N}]/u.test(m[0]),
  }));
}

/** Match an editorial expression, then a lexical equivalent actually present in the paired sentence. */
export function pairedWords(
  book: Book,
  segment: Passage,
  language: "fr" | "pt",
  offset: number,
): Annotation | null {
  const editorial = segment.annotations?.find(
    (annotation) =>
      offset >= annotation[language][0] && offset < annotation[language][1],
  );
  if (editorial) return editorial;
  const word = tokenize(segment[language]).find(
    (token) =>
      token.word &&
      offset >= token.start &&
      offset < token.start + token.text.length,
  );
  if (!word) return null;
  const other = language === "fr" ? "pt" : "fr";
  const equivalent =
    book.glossary[
      `${language}:${word.text.toLocaleLowerCase().normalize("NFC")}`
    ];
  if (!equivalent) return null;
  const candidates = equivalent
    .split(/\s*\/\s*|\s*;\s*/)
    .map((value) => value.replace(/\s*\([^)]*\)/g, "").trim())
    .filter(Boolean);
  const target = segment[other].toLocaleLowerCase();
  const matches: [number, number][] = [];
  for (const candidate of candidates) {
    const needle = candidate.toLocaleLowerCase();
    for (
      let at = target.indexOf(needle);
      at >= 0;
      at = target.indexOf(needle, at + needle.length)
    ) {
      const before = target[at - 1] ?? " ";
      const after = target[at + needle.length] ?? " ";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after))
        matches.push([at, at + needle.length]);
    }
  }
  const expected = offset / segment[language].length;
  matches.sort(
    (a, b) =>
      Math.abs(a[0] / target.length - expected) -
      Math.abs(b[0] / target.length - expected),
  );
  if (!matches[0]) return null;
  return language === "fr"
    ? { fr: [word.start, word.start + word.text.length], pt: matches[0] }
    : { pt: [word.start, word.start + word.text.length], fr: matches[0] };
}

/** Keep display clocks consistent across chapter metadata and the native player. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
