/** Local Azure adapters. Credentials are read only at an explicit provider boundary. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Book, Chapter, Passage, WordTiming } from "../src/domain";

/** A confirmed HTTP 429 is a rejected request, unlike an interrupted result with uncertain billing. */
class AzureRateLimitError extends Error {
  /** Retain the provider's retry deadline without storing response bodies or credentials. */
  constructor(readonly retryAt: number) {
    super(
      "Azure Translator: HTTP 429. Aguarde o limite de requisições antes de retomar.",
    );
  }
}

/** Write cache and manifests atomically so interruption cannot leave half a JSON file. */
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, file);
}

/** Hash only spoken input, provider settings and casting; Portuguese edits preserve valid audio. */
export function speechFingerprint(book: Book, chapter: Chapter): string {
  return digest(
    JSON.stringify({
      format: "riff-24khz-16bit-mono-v1",
      segments: chapter.segments.map((s) => ({
        id: s.id,
        text: s.fr,
        voice: book.voices[s.speaker],
      })),
    }),
  );
}
/** Identify deterministic cache entries without storing credentials in their names. */
export function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Reject empty template settings before contacting a paid service. */
function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value || value.startsWith("replace-with-"))
    throw new Error(`Configure ${key} no .env local.`);
  return value;
}

/** List the actual French voices available on the configured Speech resource. */
export async function listVoices(): Promise<unknown> {
  const region = required("AZURE_SPEECH_REGION");
  if (!/^[a-z0-9]+$/.test(region)) throw new Error("Região Azure inválida.");
  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    {
      headers: { "Ocp-Apim-Subscription-Key": required("AZURE_SPEECH_KEY") },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Azure Speech recusou a consulta: HTTP ${response.status}. Confira chave e região.`,
    );
  const voices = (await response.json()) as {
    ShortName: string;
    Locale: string;
    Gender: string;
  }[];
  return voices
    .filter((v) => v.Locale === "fr-FR")
    .map((v) => ({ voice: v.ShortName, gender: v.Gender }));
}

/** Translate one batch, keeping explicit source language and never logging provider error bodies. */
export async function translateTexts(
  texts: string[],
  from: string,
  to: string,
  allowEmpty = false,
): Promise<string[]> {
  const endpoint = new URL(
    process.env.AZURE_TRANSLATOR_ENDPOINT ||
      "https://api.cognitive.microsofttranslator.com",
  );
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    !endpoint.hostname.endsWith(".cognitive.microsofttranslator.com")
  )
    throw new Error("Use o endpoint HTTPS oficial do Azure Translator.");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/translate`;
  endpoint.search = new URLSearchParams({
    "api-version": "3.0",
    from,
    to,
    textType: "plain",
  }).toString();
  const headers: Record<string, string> = {
    "Ocp-Apim-Subscription-Key": required("AZURE_TRANSLATOR_KEY"),
    "Content-Type": "application/json",
  };
  if (process.env.AZURE_TRANSLATOR_REGION?.trim())
    headers["Ocp-Apim-Subscription-Region"] =
      process.env.AZURE_TRANSLATOR_REGION.trim();
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(texts.map((Text) => ({ Text }))),
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? 60 : Number(retryAfter);
    const retryAt = Number.isFinite(seconds)
      ? Date.now() + Math.max(0, seconds) * 1000
      : Date.parse(retryAfter!);
    throw new AzureRateLimitError(
      Number.isFinite(retryAt) ? retryAt : Date.now() + 60000,
    );
  }
  if (!response.ok)
    throw new Error(
      `Azure Translator: HTTP ${response.status}. A chamada não será repetida automaticamente.`,
    );
  const result = (await response.json()) as {
    translations: { text: string }[];
  }[];
  if (
    result.length !== texts.length ||
    result.some(
      (r) =>
        typeof r.translations?.[0]?.text !== "string" ||
        (!allowEmpty && !r.translations[0].text.trim()),
    )
  )
    throw new Error("O Translator retornou um lote incompleto.");
  return result.map((r) => r.translations[0].text);
}

/** Require explicit reconciliation after an interrupted paid request instead of silently recharging. */
export async function cachedRequest<T>(
  cacheDir: string,
  hash: string,
  operation: () => Promise<T>,
): Promise<T> {
  const file = path.join(cacheDir, `${hash}.json`);
  try {
    const previous = JSON.parse(await readFile(file, "utf8"));
    if (previous.status === "complete") return previous.result as T;
    if (previous.status === "rejected" && previous.code === 429) {
      if (Date.now() < previous.retryAt)
        throw new AzureRateLimitError(previous.retryAt);
    } else {
      throw new Error(
        `Resultado incerto: ${file}. Confira o consumo no Azure e arquive este registro antes de autorizar outra tentativa.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicJson(file, {
    status: "pending",
    startedAt: new Date().toISOString(),
  });
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    if (error instanceof AzureRateLimitError)
      await atomicJson(file, {
        status: "rejected",
        code: 429,
        retryAt: error.retryAt,
      });
    throw error;
  }
  await atomicJson(file, {
    status: "complete",
    result,
    completedAt: new Date().toISOString(),
  });
  return result;
}

/** Escape literary content as XML text, keeping SSML markup out of user-controlled strings. */
function xml(text: string): string {
  return text.replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

/** Synthesize one passage with word boundaries; save the provider WAV before chapter assembly. */
export async function synthesizePassage(
  segment: Passage,
  voice: string,
): Promise<{ wav: string; words: WordTiming[] }> {
  if (!/^fr-FR-[a-zA-Z0-9:]+$/.test(voice))
    throw new Error(`Voz não suportada: ${voice}.`);
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");
  const region = required("AZURE_SPEECH_REGION");
  if (!/^[a-z0-9]+$/.test(region)) throw new Error("Região Azure inválida.");
  const configuration = sdk.SpeechConfig.fromSubscription(
    required("AZURE_SPEECH_KEY"),
    region,
  );
  configuration.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
  configuration.speechSynthesisVoiceName = voice;
  const synthesizer = new sdk.SpeechSynthesizer(configuration, null as never);
  const events: { text: string; start: number; duration: number }[] = [];
  synthesizer.wordBoundary = (_sender, e) => {
    if (e.boundaryType === sdk.SpeechSynthesisBoundaryType.Word)
      events.push({
        text: e.text,
        start: e.audioOffset / 10_000_000,
        duration: e.duration / 10_000_000,
      });
  };
  try {
    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        synthesizer.close();
        reject(
          new Error(
            "Tempo de geração excedido. Verifique o registro incerto antes de repetir.",
          ),
        );
      }, 120000);
      synthesizer.speakSsmlAsync(
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fr-FR"><voice name="${voice}">${xml(segment.fr)}</voice></speak>`,
        (result) => {
          clearTimeout(timer);
          if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted)
            reject(
              new Error(
                "Azure cancelou a síntese. Confira a disponibilidade da voz e a configuração do recurso.",
              ),
            );
          else resolve(result.audioData);
        },
        () => {
          clearTimeout(timer);
          reject(
            new Error(
              "Falha de conexão com Azure Speech. Confira o registro antes de repetir.",
            ),
          );
        },
      );
    });
    let cursor = 0;
    const words = events.map((event, index) => {
      const normalizedText = segment.fr
        .replaceAll("’", "'")
        .toLocaleLowerCase();
      const offset = normalizedText.indexOf(
        event.text.replaceAll("’", "'").toLocaleLowerCase(),
        cursor,
      );
      if (offset < 0)
        throw new Error(
          `Alinhamento divergente no trecho ${segment.id}; áudio não aprovado.`,
        );
      cursor = offset + event.text.length;
      const end =
        event.duration > 0
          ? event.start + event.duration
          : (events[index + 1]?.start ?? event.start + 0.15);
      return {
        start: event.start,
        end,
        offset,
        length: event.text.length,
        segmentId: segment.id,
      };
    });
    if (!words.length)
      throw new Error(
        "A voz não retornou tempos por palavra. Escolha uma voz compatível.",
      );
    return { wav: Buffer.from(data).toString("base64"), words };
  } finally {
    synthesizer.close();
  }
}

/** Extract PCM chunks from RIFF instead of assuming a fixed 44-byte provider header. */
export function readWav(buffer: Buffer): Buffer {
  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Áudio não é WAV RIFF.");
  let pcm: Buffer | undefined,
    format = false;
  for (let at = 12; at + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > buffer.length) throw new Error("WAV incompleto.");
    const kind = buffer.toString("ascii", at, at + 4);
    if (kind === "fmt ") {
      if (
        size < 16 ||
        buffer.readUInt16LE(start) !== 1 ||
        buffer.readUInt16LE(start + 2) !== 1 ||
        buffer.readUInt32LE(start + 4) !== 24000 ||
        buffer.readUInt16LE(start + 14) !== 16
      )
        throw new Error("WAV deve ser PCM mono, 24 kHz e 16 bits.");
      format = true;
    }
    if (kind === "data") pcm = buffer.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  if (!format || !pcm?.length || pcm.length % 2)
    throw new Error("WAV sem amostras PCM válidas.");
  return pcm;
}

/** Assemble lossless chapters; sample counts give exact offsets without encoder padding drift. */
export function assembleChapter(
  parts: { wav: string; words: WordTiming[] }[],
): {
  data: Buffer;
  words: WordTiming[];
  duration: number;
} {
  let bytes = 0;
  const chunks: Buffer[] = [];
  const words: WordTiming[] = [];
  for (const part of parts) {
    const pcm = readWav(Buffer.from(part.wav, "base64"));
    const offset = bytes / 48000;
    words.push(
      ...part.words.map((w) => ({
        ...w,
        start: w.start + offset,
        end: w.end + offset,
      })),
    );
    chunks.push(pcm);
    bytes += pcm.length;
  }
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return {
    data: Buffer.concat([header, ...chunks]),
    words,
    duration: bytes / 48000,
  };
}
