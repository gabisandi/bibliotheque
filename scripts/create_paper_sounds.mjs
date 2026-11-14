/** Rebuild the small, deterministic paper-rustle WAV assets without external services. */
import { mkdirSync, writeFileSync } from 'node:fs';

const rate = 24000;
mkdirSync('public/sounds', { recursive: true });
for (const [name, seconds] of [
  ['page_turn', 0.38],
  ['book_open', 0.64],
]) {
  const count = Math.round(rate * seconds);
  const data = Buffer.alloc(count * 2);
  let seed = 23071;
  let low = 0;
  let smooth = 0;
  for (let index = 0; index < count; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    low += 0.045 * (noise - low);
    smooth += 0.48 * (noise - low - smooth);
    const t = index / count;
    const envelope =
      Math.sin(Math.PI * t) ** 1.4 * (0.45 + 0.55 * Math.sin(Math.PI * t * 3.4) ** 2);
    data.writeInt16LE(Math.round(smooth * envelope * 17000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(data.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(`public/sounds/${name}.wav`, Buffer.concat([header, data]));
}
