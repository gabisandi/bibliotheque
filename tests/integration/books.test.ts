import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { unzipSync, zipSync } from 'fflate';
import manifest from '../../public/books/le_petit_prince/1/manifest.json';

const created: string[] = [];
afterEach(async () => {
  for (const folder of created.splice(0)) await rm(folder, { recursive: true, force: true });
});

it('backs up and restores all declared files without provider calls, rejects corruption and overwrite', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'bibliotheque-backup-'));
  created.push(folder);
  const source = path.join(folder, 'source');
  await mkdir(source);
  const book = structuredClone(manifest);
  book.chapters[0].segments.forEach((s) => {
    delete (s as { image?: string }).image;
  });
  delete (book.chapters[0] as { audio?: unknown }).audio;
  book.cover = '/books/le_petit_prince/1/cover.png';
  const cover = Buffer.from('test cover bytes');
  await writeFile(path.join(source, 'cover.png'), cover);
  const file = path.join(source, 'manifest.json');
  await writeFile(file, JSON.stringify(book));
  const command = (...args: string[]) =>
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/books.ts', ...args], {
      cwd: process.cwd(),
      stdio: 'pipe',
    }).toString();
  const archive = path.join(folder, 'backup.zip');
  command('backup', file, archive);
  const restored = path.join(folder, 'restored');
  expect(command('restore', archive, restored)).toContain('restaurada');
  expect(await readFile(path.join(restored, 'cover.png'))).toEqual(cover);
  expect(
    JSON.parse(await readFile(path.join(restored, 'manifest.json'), 'utf8')).chapters[0].segments[0]
      .fr,
  ).toBe(book.chapters[0].segments[0].fr);
  expect(() => command('restore', archive, restored)).toThrow();
  const files = unzipSync(await readFile(archive));
  files['cover.png'] = Buffer.from('damaged');
  const damaged = path.join(folder, 'damaged.zip');
  await writeFile(damaged, zipSync(files));
  expect(() => command('restore', damaged, path.join(folder, 'invalid'))).toThrow();
});
