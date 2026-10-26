import { readdir, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const width = 240;
const height = 320;
const themes = { light: '#f5f5f7', dark: '#202124' };
const root = path.resolve(process.argv[2] || 'server/data/uploads/chat-backgrounds');

let count = 0;
let totalBytes = 0;

for (const [theme, background] of Object.entries(themes)) {
  const sourceDir = path.join(root, theme);
  const targetDir = path.join(root, `${theme}-thumbnails`);
  await mkdir(targetDir, { recursive: true });
  const names = (await readdir(sourceDir)).filter((name) => name.toLowerCase().endsWith('.svg')).sort();

  for (const name of names) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, `${path.parse(name).name}.webp`);
    await sharp(source, { density: 96 })
      .resize(width, height, { fit: 'fill' })
      .flatten({ background })
      .webp({ quality: 72, effort: 4 })
      .toFile(target);
    count += 1;
    totalBytes += (await stat(target)).size;
  }
}

process.stdout.write(`Generated ${count} thumbnails (${totalBytes} bytes)\n`);
