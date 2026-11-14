/** Extract private book drafts while preserving originals and page-level evidence for review. */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { Book, Chapter, Passage } from '../src/domain';
import { atomicJson } from './azure';

interface SourcePart {
  title?: string;
  text: string;
  images: { name: string; data: Uint8Array; alt: string }[];
}

/** Normalize layout whitespace only; store raw extraction separately so editorial changes stay auditable. */
export function makeChapters(parts: SourcePart[]): Chapter[] {
  const chapters: Chapter[] = [];
  let current: Chapter | undefined;
  const sentences = new Intl.Segmenter('fr', { granularity: 'sentence' });
  for (const part of parts) {
    const blocks = part.title
      ? [{ title: part.title, text: part.text }]
      : part.text
          .split(/((?:PREMIER CHAPITRE|CHAPITRE\s+[IVXLCDM]+)(?:\s*\n|\s*$))/g)
          .map((text, index) => ({
            title: /^(?:PREMIER CHAPITRE|CHAPITRE\s+[IVXLCDM]+)/.test(text.trim())
              ? text.trim()
              : '',
            text: /^(?:PREMIER CHAPITRE|CHAPITRE\s+[IVXLCDM]+)/.test(text.trim()) ? '' : text,
          }));
    let attached = false;
    for (const block of blocks) {
      if (block.title || !current) {
        current = {
          id: `chapter_${String(chapters.length + 1).padStart(2, '0')}`,
          title: block.title || 'Dédicace',
          subtitle: block.title ? `Capítulo ${chapters.length + 1}` : 'Dedicatória',
          segments: [],
        };
        chapters.push(current);
      }
      for (const sentence of sentences.segment(block.text.replace(/\s+/g, ' ').trim())) {
        if (!sentence.segment.trim()) continue;
        const segment: Passage = {
          id: `${current.id}_s${String(current.segments.length + 1).padStart(3, '0')}`,
          fr: sentence.segment.trim(),
          pt: '',
          speaker: 'narrator',
        };
        if (!attached && part.images.length) {
          segment.illustrations = part.images.map((image) => ({
            src: `images/${image.name}`,
            alt: image.alt,
          }));
          attached = true;
        }
        current.segments.push(segment);
      }
    }
  }
  return chapters.filter((c) => c.segments.length);
}

/** Extract PDF text and native image objects without executing document scripts. */
async function pdfParts(file: string): Promise<SourcePart[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { PNG } = await import('pngjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(file)),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const parts: SourcePart[] = [];
  try {
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
        .join('');
      const images: SourcePart['images'] = [];
      const operators = await page.getOperatorList();
      const seen = new Set<string>();
      for (let at = 0; at < operators.fnArray.length; at++) {
        if (operators.fnArray[at] !== pdfjs.OPS.paintImageXObject) continue;
        const name = operators.argsArray[at][0] as string;
        if (seen.has(name)) continue;
        seen.add(name);
        const image = page.objs.get(name) as {
          width: number;
          height: number;
          kind: number;
          data: Uint8Array;
        };
        if (!image?.data || image.width * image.height > 20_000_000) continue;
        const output = new PNG({ width: image.width, height: image.height });
        for (let pixel = 0; pixel < image.width * image.height; pixel++) {
          if (image.kind === pdfjs.ImageKind.RGBA_32BPP) {
            for (let channel = 0; channel < 4; channel++)
              output.data[pixel * 4 + channel] = image.data[pixel * 4 + channel];
          } else if (image.kind === pdfjs.ImageKind.RGB_24BPP) {
            for (let channel = 0; channel < 3; channel++)
              output.data[pixel * 4 + channel] = image.data[pixel * 3 + channel];
            output.data[pixel * 4 + 3] = 255;
          } else {
            const shade = image.data[pixel >> 3] & (1 << (7 - (pixel % 8))) ? 255 : 0;
            output.data.fill(shade, pixel * 4, pixel * 4 + 3);
            output.data[pixel * 4 + 3] = 255;
          }
        }
        images.push({
          name: `page_${String(index).padStart(3, '0')}_${images.length + 1}.png`,
          data: PNG.sync.write(output),
          alt: `Ilustração da página ${index} do original; descrição editorial pendente.`,
        });
      }
      parts.push({ text, images });
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  if (parts.reduce((n, p) => n + p.text.length, 0) < 100)
    throw new Error('PDF sem texto extraível. Faça o reconhecimento de texto antes de importar.');
  return parts;
}

/** Read EPUB spine order and package images; reject encrypted or oversized input archives. */
async function epubParts(file: string): Promise<SourcePart[]> {
  let expandedBytes = 0;
  const files = unzipSync(await readFile(file), {
    filter: (entry) => {
      expandedBytes += entry.originalSize;
      if (entry.originalSize > 30_000_000 || expandedBytes > 150_000_000)
        throw new Error('EPUB excede o limite de extração.');
      return true;
    },
  });
  if (files['META-INF/encryption.xml']) throw new Error('EPUB com criptografia não é suportado.');
  if (Object.values(files).reduce((n, b) => n + b.length, 0) > 150_000_000)
    throw new Error('EPUB excede o limite de extração.');
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
  const text = (name: string) => (files[name] ? Buffer.from(files[name]).toString('utf8') : '');
  const container = parser.parse(text('META-INF/container.xml'));
  const opf = container?.container?.rootfiles?.rootfile?.['@_full-path'];
  if (typeof opf !== 'string' || opf.includes('..'))
    throw new Error('EPUB sem índice de leitura válido.');
  const pkg = parser.parse(text(opf))?.package;
  const many = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);
  const items = many(pkg?.manifest?.item).filter(Boolean) as Record<string, string>[];
  const spine = many(pkg?.spine?.itemref).filter(Boolean) as Record<string, string>[];
  const parts: SourcePart[] = [];
  for (const reference of spine) {
    const item = items.find((i) => i['@_id'] === reference['@_idref']);
    if (!item) continue;
    const name = path.posix.normalize(
      path.posix.join(path.posix.dirname(opf), decodeURIComponent(item['@_href'])),
    );
    if (name.startsWith('../')) throw new Error('Caminho inseguro no EPUB.');
    const html = text(name).replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    const title = html
      .match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1]
      .replace(/<[^>]*>/g, '')
      .trim();
    const decoded = html
      .replace(/<\/?(?:p|div|br|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
        const point = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '�';
      });
    const images: SourcePart['images'] = [];
    for (const match of html.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
      const asset = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), decodeURIComponent(match[1])),
      );
      if (
        asset.startsWith('../') ||
        !files[asset] ||
        !/^\.(png|jpe?g|webp)$/i.test(path.posix.extname(asset))
      )
        continue;
      images.push({
        name: `chapter_${parts.length + 1}_${images.length + 1}${path.posix.extname(asset)}`,
        data: files[asset],
        alt: `Ilustração do capítulo ${parts.length + 1}; descrição editorial pendente.`,
      });
    }
    if (decoded.trim()) parts.push({ title, text: decoded, images });
  }
  if (!parts.length) throw new Error('EPUB sem capítulos legíveis.');
  return parts;
}

/** Create a new private edition, never overwriting a previous draft or the source document. */
export async function importBook(file: string, id: string, destination?: string): Promise<void> {
  if (!file || !id || !/^[a-z0-9_]+$/.test(id))
    throw new Error('Uso: books import arquivo.pdf identificador [pasta_nova].');
  const output = destination || path.join('editorial', id, 'draft');
  if (
    await stat(output).then(
      () => true,
      () => false,
    )
  )
    throw new Error('A pasta de destino já existe; escolha uma pasta nova.');
  const ext = path.extname(file).toLowerCase();
  if (!['.pdf', '.epub', '.txt'].includes(ext)) throw new Error('Use PDF, EPUB ou TXT.');
  if ((await stat(file)).size > 100_000_000) throw new Error('O arquivo excede 100 MB.');
  const parts =
    ext === '.pdf'
      ? await pdfParts(file)
      : ext === '.epub'
        ? await epubParts(file)
        : [{ text: await readFile(file, 'utf8'), images: [] }];
  const chapters = makeChapters(parts);
  if (!chapters.length) throw new Error('Nenhum capítulo foi extraído.');
  for (const chapter of chapters)
    for (const segment of chapter.segments) {
      if (segment.image) segment.image = `/books/${id}/draft/${segment.image}`;
      segment.illustrations?.forEach((image) => {
        image.src = `/books/${id}/draft/${image.src}`;
      });
    }
  const book: Book = {
    schemaVersion: 1,
    id,
    edition: 'draft',
    title: path.basename(file, ext).replaceAll('_', ' '),
    translatedTitle: '',
    author: 'Autoria a revisar',
    description: 'Edição em preparação editorial.',
    sourceLanguage: 'fr',
    targetLanguage: 'pt-BR',
    cover: `/books/${id}/draft/cover.png`,
    accent: '#75805c',
    status: 'preview',
    source: {
      name: path.basename(file),
      rights: 'pending',
      credit: 'Procedência e direitos devem ser revisados antes de publicar.',
    },
    voices: { narrator: 'fr-FR-HenriNeural' },
    chapters,
    glossary: {},
    review: { translation: false, voices: false, illustrations: false, cover: false, audio: false },
  };
  await mkdir(path.join(output, 'source'), { recursive: true });
  await copyFile(file, path.join(output, 'source', `original${ext}`));
  await mkdir(path.join(output, 'images'), { recursive: true });
  for (const part of parts)
    for (const image of part.images)
      await writeFile(path.join(output, 'images', image.name), image.data);
  await atomicJson(
    path.join(output, 'source', 'extraction.json'),
    parts.map((p) => ({ text: p.text, title: p.title, images: p.images.map((i) => i.name) })),
  );
  await atomicJson(path.join(output, 'manifest.json'), book);
  console.info(
    `Rascunho importado em ${output}: ${chapters.length} capítulos. Revise texto, autoria, imagens e capa antes de validar o pacote.`,
  );
}
