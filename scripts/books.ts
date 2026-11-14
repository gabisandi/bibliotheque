/** Editorial CLI: inspect, translate, narrate, validate, back up and stage complete book editions. */
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, unzipSync } from "fflate";
import { tokenize, validateBook } from "../src/domain";
import type { Book, Chapter } from "../src/domain";
import {
  assembleChapter,
  atomicJson,
  cachedRequest,
  digest,
  listVoices,
  speechFingerprint,
  synthesizePassage,
  translateTexts,
} from "./azure";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Resolve only package-owned assets; never include arbitrary local files in an export. */
export function assetPath(manifest: string, book: Book, asset: string): string {
  const prefix = `/books/${book.id}/${book.edition}/`;
  if (
    !asset.startsWith(prefix) ||
    asset.includes("..") ||
    !/^[a-zA-Z0-9_./-]+$/.test(asset)
  )
    throw new Error("O arquivo está fora da edição.");
  return path.join(path.dirname(manifest), asset.slice(prefix.length));
}

/** Load a versioned manifest through the same validation boundary as the reader. */
export async function loadBook(file: string): Promise<Book> {
  const book: unknown = JSON.parse(await readFile(file, "utf8"));
  validateBook(book);
  return book;
}

/** Require a declared character ceiling before any billable generation starts. */
function authorize(characters: number, args: string[]): void {
  const index = args.indexOf("--approve-characters");
  const approved = index >= 0 ? Number(args[index + 1]) : 0;
  if (
    !args.includes("--execute") ||
    !Number.isSafeInteger(approved) ||
    approved < characters
  )
    throw new Error(
      `São ${characters} caracteres. Após aprovação, repita com --execute --approve-characters ${characters}.`,
    );
}

/** Limit preparation to one chapter when reviewing a pilot. */
function chaptersFor(book: Book, args: string[]): Chapter[] {
  const at = args.indexOf("--chapter");
  if (at < 0) return book.chapters;
  const chapter = book.chapters.find((c) => c.id === args[at + 1]);
  if (!chapter) throw new Error("Capítulo não encontrado.");
  return [chapter];
}

/** Show volume and optional configured price without making a provider request. */
function estimate(book: Book, chapters: Chapter[]) {
  const characters = chapters
    .flatMap((c) => c.segments)
    .reduce((sum, s) => sum + s.fr.length, 0);
  const rate = Number(process.env.AZURE_SPEECH_PRICE_PER_MILLION);
  if (
    process.env.AZURE_SPEECH_PRICE_PER_MILLION &&
    (!Number.isFinite(rate) || rate <= 0)
  )
    throw new Error("O preço configurado deve ser um número positivo.");
  return {
    book: book.title,
    chapters: chapters.length,
    speechCharacters: characters,
    missingTranslationCharacters: chapters
      .flatMap((c) => c.segments)
      .filter((s) => !s.pt.trim())
      .reduce((sum, s) => sum + s.fr.length, 0),
    estimatedSpeechCost:
      rate > 0
        ? (characters * rate) / 1_000_000
        : "Configure o preço da sua categoria para uma estimativa monetária.",
    voices: book.voices,
  };
}

/** Validate saved files, audio fingerprints and completion before staging or archiving. */
export async function validatePackage(
  file: string,
  book: Book,
): Promise<string[]> {
  validateBook(book);
  const assets = new Set([
    book.cover,
    ...book.chapters.flatMap((c) => [
      ...c.segments.flatMap((s) => [
        ...(s.image ? [s.image] : []),
        ...(s.illustrations?.map((i) => i.src) ?? []),
      ]),
      ...(c.audio ? [c.audio.src] : []),
    ]),
  ]);
  const packageRoot = await realpath(path.dirname(file));
  for (const asset of assets) {
    const localPath = assetPath(file, book, asset);
    if (!(await realpath(localPath)).startsWith(packageRoot + path.sep))
      throw new Error("Um arquivo aponta para fora da edição.");
    const size = await stat(localPath);
    if (!size.isFile() || !size.size)
      throw new Error(`Arquivo vazio ou ausente: ${asset}.`);
  }
  for (const chapter of book.chapters)
    if (
      chapter.audio &&
      chapter.audio.fingerprint !== speechFingerprint(book, chapter)
    )
      throw new Error(
        `Áudio desatualizado: ${chapter.id}. Gere novamente os trechos modificados.`,
      );
  return [...assets];
}

/** Cache every translation batch before mutating the edition; preserve editorial edits already present. */
async function translateBook(
  file: string,
  book: Book,
  args: string[],
): Promise<void> {
  const chapters = chaptersFor(book, args);
  const segments = chapters
    .flatMap((c) => c.segments)
    .filter((s) => !s.pt.trim());
  const characters = segments.reduce((sum, s) => sum + s.fr.length, 0);
  authorize(characters, args);
  const cache = path.join(root, "editorial", book.id, "cache", "translations");
  for (let at = 0; at < segments.length; at += 30) {
    if (at > 0) await delay(5000);
    const batch = segments.slice(at, at + 30);
    const result = await cachedRequest(
      cache,
      digest(
        JSON.stringify({
          texts: batch.map((s) => s.fr),
          from: book.sourceLanguage,
          to: book.targetLanguage,
        }),
      ),
      () =>
        translateTexts(
          batch.map((s) => s.fr),
          book.sourceLanguage,
          book.targetLanguage,
        ),
    );
    batch.forEach((segment, i) => {
      segment.pt = result[i];
    });
    book.review.translation = false;
    await atomicJson(file, book);
  }
  console.info(
    `Tradução preparada: ${segments.length} trechos; revisão editorial pendente.`,
  );
}

/** Save bilingual lexical aids; richer contextual expressions can be added as annotations by Codex. */
async function prepareGlossary(
  file: string,
  book: Book,
  args: string[],
): Promise<void> {
  const chapters = chaptersFor(book, args);
  const pending = new Map<
    string,
    { text: string; language: string; target: string }
  >();
  for (const s of chapters.flatMap((c) => c.segments))
    for (const language of ["fr", "pt"] as const) {
      for (const token of tokenize(s[language]).filter((t) => t.word)) {
        const text = token.text.toLocaleLowerCase().normalize("NFC");
        const key = `${language}:${text}`;
        if (!Object.hasOwn(book.glossary, key))
          pending.set(key, {
            text,
            language,
            target: language === "fr" ? "pt-BR" : "fr",
          });
      }
    }
  authorize(
    [...pending.values()].reduce((sum, word) => sum + word.text.length, 0),
    args,
  );
  for (const language of ["fr", "pt"]) {
    const list = [...pending.entries()].filter(
      ([, value]) => value.language === language,
    );
    for (let at = 0; at < list.length; at += 100) {
      const batch = list.slice(at, at + 100);
      const texts = batch.map(([, v]) => v.text);
      const translated = await cachedRequest(
        path.join(root, "editorial", book.id, "cache", "glossary"),
        digest(JSON.stringify({ language, texts })),
        () =>
          translateTexts(
            texts,
            language,
            language === "fr" ? "pt-BR" : "fr",
            true,
          ),
      );
      batch.forEach(([key], i) => {
        book.glossary[key] = translated[i];
      });
      book.review.translation = false;
      await atomicJson(file, book);
    }
  }
  console.info(
    `Glossário preparado: ${pending.size} palavras de apoio; expressões contextuais devem ser revisadas.`,
  );
}

/** Generate approved passages once, assemble PCM chapters and persist exact word offsets. */
async function narrateBook(
  file: string,
  book: Book,
  args: string[],
  sample = false,
): Promise<void> {
  const selected = chaptersFor(book, args);
  const chapters = sample
    ? [
        {
          ...selected[0],
          id: "sample",
          segments: selected[0].segments.slice(0, 3),
        },
      ]
    : selected;
  authorize(
    chapters
      .flatMap((c) => c.segments)
      .reduce((sum, s) => sum + s.fr.length, 0),
    args,
  );
  const cache = path.join(root, "editorial", book.id, "cache", "speech");
  for (const chapter of chapters) {
    const fingerprint = speechFingerprint(book, chapter);
    if (!sample && chapter.audio?.fingerprint === fingerprint) {
      console.info(`Reutilizado: ${chapter.id}`);
      continue;
    }
    const parts = [];
    for (const s of chapter.segments) {
      const voice = book.voices[s.speaker];
      const result = await cachedRequest(
        cache,
        digest(
          JSON.stringify({
            text: s.fr,
            voice,
            format: "riff-24khz-16bit-mono-v1",
          }),
        ),
        () => synthesizePassage(s, voice),
      );
      parts.push({
        ...result,
        words: result.words.map((word) => ({ ...word, segmentId: s.id })),
      });
    }
    const assembled = assembleChapter(parts);
    const destination = path.join(
      path.dirname(file),
      "audio",
      `${chapter.id}_${fingerprint.slice(0, 12)}.wav`,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(`${destination}.tmp`, assembled.data);
    await rename(`${destination}.tmp`, destination);
    if (sample) {
      await atomicJson(destination.replace(".wav", ".json"), {
        duration: assembled.duration,
        words: assembled.words,
      });
      console.info(`Amostra: ${destination}`);
    } else {
      const prefix = `/books/${book.id}/${book.edition}/audio/`;
      chapter.audio = {
        src: prefix + path.basename(destination),
        duration: assembled.duration,
        words: assembled.words,
        fingerprint,
      };
      book.review.audio = false;
      book.review.voices = false;
      validateBook(book);
      await atomicJson(file, book);
      console.info(
        `${chapter.id}: ${assembled.duration.toFixed(1)} segundos, ${assembled.words.length} marcações salvas.`,
      );
    }
  }
}

/** Archive only declared package files plus the original when explicitly supplied. */
async function backupBook(
  file: string,
  book: Book,
  destination: string,
  original?: string,
): Promise<void> {
  const assets = await validatePackage(file, book);
  const files: Record<string, Uint8Array> = {
    "manifest.json": Buffer.from(JSON.stringify(book, null, 2)),
  };
  const hashes: Record<string, string> = {};
  hashes["manifest.json"] = createAssetHash(files["manifest.json"]);
  for (const asset of assets) {
    const relative = asset.replace(`/books/${book.id}/${book.edition}/`, "");
    const data = await readFile(assetPath(file, book, asset));
    files[relative] = data;
    hashes[relative] = createAssetHash(data);
  }
  if (original) {
    const name = `source/original${path.extname(original).toLowerCase()}`;
    const data = await readFile(original);
    files[name] = data;
    hashes[name] = createAssetHash(data);
  }
  files["checksums.json"] = Buffer.from(JSON.stringify(hashes, null, 2));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, zipSync(files, { level: 1 }));
  console.info(`Backup: ${destination}`);
}

/** Hash binary assets without lossy string decoding. */
function createAssetHash(bytes: Uint8Array): string {
  return digest(Buffer.from(bytes).toString("base64"));
}

/** Restore into a fresh folder and verify checksums before making any edition visible. */
async function restoreBook(
  archive: string,
  destination: string,
): Promise<void> {
  if (
    await stat(destination).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      "Restaure em uma pasta nova para preservar a edição existente.",
    );
  let expandedBytes = 0;
  let entries = 0;
  const files = unzipSync(await readFile(archive), {
    filter: (entry) => {
      expandedBytes += entry.originalSize;
      entries++;
      if (
        entry.originalSize > 150_000_000 ||
        expandedBytes > 500_000_000 ||
        entries > 5000
      )
        throw new Error("Backup excede os limites locais.");
      return true;
    },
  });
  if (!files["manifest.json"] || !files["checksums.json"])
    throw new Error("Backup incompleto.");
  const hashes = JSON.parse(Buffer.from(files["checksums.json"]).toString());
  const names = Object.keys(files);
  if (
    names.length > 5000 ||
    Object.values(files).reduce((n, b) => n + b.length, 0) > 500_000_000
  )
    throw new Error("Backup excede os limites locais.");
  for (const name of names) {
    if (
      path.isAbsolute(name) ||
      name.split(/[\\/]/).includes("..") ||
      name.includes("\\") ||
      !/^[a-zA-Z0-9_./-]+$/.test(name)
    )
      throw new Error("Caminho inseguro no backup.");
    if (
      name !== "checksums.json" &&
      (!hashes[name] || createAssetHash(files[name]) !== hashes[name])
    )
      throw new Error(`Checksum divergente: ${name}.`);
  }
  const book: unknown = JSON.parse(
    Buffer.from(files["manifest.json"]).toString(),
  );
  validateBook(book);
  for (const [name, data] of Object.entries(files)) {
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  await validatePackage(path.join(destination, "manifest.json"), book);
  console.info(`Edição restaurada e validada: ${destination}`);
}

/** Stage immutable asset files first and expose their manifest only after all copies succeed. */
async function stageBook(
  file: string,
  book: Book,
  preview: boolean,
): Promise<void> {
  if (!preview) {
    book.status = "published";
    validateBook(book);
  } else book.status = "preview";
  const assets = await validatePackage(file, book);
  const destination = path.join(root, "public", "books", book.id, book.edition);
  if (path.resolve(path.dirname(file)) === destination) {
    if (!preview)
      throw new Error(
        "Prepare a publicação em editorial/ e use uma nova edição para preservar a anterior.",
      );
    await atomicJson(file, book);
    return;
  }
  if (
    await stat(destination).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      "Esta edição já existe. Use um novo identificador de edição.",
    );
  for (const asset of assets) {
    const target = assetPath(
      path.join(destination, "manifest.json"),
      book,
      asset,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(assetPath(file, book, asset), target);
  }
  await atomicJson(path.join(destination, "manifest.json"), book);
  const catalogFile = path.join(root, "public", "catalog.json");
  const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
  catalog.books = [
    ...catalog.books.filter((b: { id: string }) => b.id !== book.id),
    {
      id: book.id,
      manifest: `/books/${book.id}/${book.edition}/manifest.json`,
    },
  ];
  await atomicJson(catalogFile, catalog);
  console.info(
    "Edição preparada localmente. Revise a prévia antes de fazer o deploy.",
  );
}

/** Dispatch explicit editorial operations; every paid command defaults to a dry estimate. */
async function main(): Promise<void> {
  const [command, file, ...args] = process.argv.slice(2);
  if (command === "voices") {
    console.info(JSON.stringify(await listVoices(), null, 2));
    return;
  }
  if (command === "import") {
    const { importBook } = await import("./import_book");
    await importBook(file, args[0], args[1]);
    return;
  }
  if (command === "restore") {
    if (!file || !args[0])
      throw new Error("Uso: books restore backup.zip pasta_nova");
    await restoreBook(file, args[0]);
    return;
  }
  if (
    !file ||
    ![
      "validate",
      "estimate",
      "translate",
      "glossary",
      "sample",
      "synthesize",
      "backup",
      "stage",
    ].includes(command)
  ) {
    console.info(
      "Bibliothèque — ferramentas editoriais\n\nbooks voices\nbooks import arquivo.pdf identificador [pasta]\nbooks validate manifesto.json\nbooks estimate manifesto.json [--chapter chapter_01]\nbooks translate|glossary|sample|synthesize manifesto.json [--chapter chapter_01] --execute --approve-characters N\nbooks backup manifesto.json backup.zip [arquivo_original]\nbooks restore backup.zip pasta_nova\nbooks stage manifesto.json [--preview]\n\nSem --execute e limite aprovado, nenhuma geração paga é iniciada.",
    );
    return;
  }
  const book = await loadBook(file);
  if (command === "estimate")
    console.info(
      JSON.stringify(estimate(book, chaptersFor(book, args)), null, 2),
    );
  if (command === "validate") {
    await validatePackage(file, book);
    console.info(
      `Edição válida: ${book.title} (${book.status}), ${book.chapters.length} capítulos.`,
    );
  }
  if (command === "translate") await translateBook(file, book, args);
  if (command === "glossary") await prepareGlossary(file, book, args);
  if (command === "sample" || command === "synthesize")
    await narrateBook(file, book, args, command === "sample");
  if (command === "backup") {
    if (!args[0]) throw new Error("Informe o arquivo ZIP de destino.");
    await backupBook(file, book, args[0], args[1]);
  }
  if (command === "stage")
    await stageBook(file, book, args.includes("--preview"));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
