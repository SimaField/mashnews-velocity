// Обновляет снимок каталога в public/data из CelesTrak.
// CelesTrak отдаёт один и тот же запрос не чаще раза в два часа, при отказе
// прежний файл остаётся на месте.
import { writeFile, readFile } from 'node:fs/promises';

const API = 'https://celestrak.org/NORAD/elements/gp.php';
const OUT = new URL('../public/data/', import.meta.url);
const SETS = { rassvet: 'RASSVET', starlink: 'STARLINK' };

const rows = (csv) => csv.trim().split(/\r?\n/).length - 1;

const counts = {};
let updated = 0;
for (const [file, name] of Object.entries(SETS)) {
  const target = new URL(`${file}.csv`, OUT);
  try {
    const res = await fetch(`${API}?NAME=${name}&FORMAT=csv`, {
      headers: { 'User-Agent': 'MashnewsVelocity/0.1 (catalog snapshot)' },
    });
    const text = await res.text();
    if (!res.ok || !text.startsWith('OBJECT_NAME')) {
      throw new Error(`HTTP ${res.status}: ${text.trim().split('\n')[0]}`);
    }
    await writeFile(target, text);
    counts[file] = rows(text);
    updated++;
    console.log(`${file}: ${counts[file]} объектов`);
  } catch (err) {
    console.warn(`${file}: не обновлён (${err.message})`);
    counts[file] = rows(await readFile(target, 'utf8'));
  }
}

if (updated) {
  const meta = { fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), source: 'CelesTrak GP (NORAD)', counts };
  await writeFile(new URL('meta.json', OUT), JSON.stringify(meta, null, 2) + '\n');
}
