import { SatSet } from './orbits.js';

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const rec = {};
    for (let i = 0; i < head.length; i++) rec[head[i]] = cells[i];
    return rec;
  });
}

async function getText(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// CelesTrak обновляет элементы раз в два часа, на повторные запросы отвечает 403,
// а настойчивых блокирует по адресу. Поэтому ответ (или сам факт отказа)
// запоминается в браузере, и следующий запрос уходит не раньше чем через два часа.
const LIVE_TTL = 2 * 60 * 60 * 1000;
const LIVE_KEY = 'dv-rassvet';

async function liveRassvet() {
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(LIVE_KEY));
  } catch {
    // хранилище недоступно — спросим CelesTrak напрямую
  }
  if (cached && Date.now() - cached.at < LIVE_TTL) return cached.csv;

  let csv = null;
  try {
    const text = await getText(`${CELESTRAK}?NAME=RASSVET&FORMAT=csv`, 2500);
    if (text.startsWith('OBJECT_NAME')) csv = text;
  } catch {
    // офлайн или лимит CelesTrak
  }
  try {
    localStorage.setItem(LIVE_KEY, JSON.stringify({ at: Date.now(), csv }));
  } catch {
    // без хранилища просто спросим ещё раз при следующей загрузке
  }
  return csv;
}

// Starlink всегда берётся из снимка в public/data (11 тысяч объектов).
// «Рассветов» три десятка, их пробуем обновить вживую и молча остаёмся
// на снимке, если не вышло.
export async function loadCatalog() {
  const base = `${import.meta.env.BASE_URL}data/`;
  const [starlinkCsv, rassvetSnapshot, issCsv, meta] = await Promise.all([
    getText(`${base}starlink.csv`, 30000),
    getText(`${base}rassvet.csv`, 30000),
    getText(`${base}iss.csv`, 30000).catch(() => ''), // без станции недоступна только вторая миссия
    getText(`${base}meta.json`, 30000).then(JSON.parse).catch(() => ({})),
  ]);

  const liveCsv = await liveRassvet();
  const rassvetCsv = liveCsv ?? rassvetSnapshot;
  const live = Boolean(liveCsv);

  const catalog = {
    starlink: new SatSet(parseCsv(starlinkCsv)),
    rassvet: new SatSet(parseCsv(rassvetCsv)),
    iss: issCsv.startsWith('OBJECT_NAME') ? new SatSet(parseCsv(issCsv)) : null,
    meta,
    live,
    epoch: null,
  };
  syncCatalog(catalog, new Date());
  return catalog;
}

// Привязывает оба набора к одному моменту реального времени
export function syncCatalog(catalog, date) {
  catalog.epoch = date;
  catalog.starlink.sync(date);
  catalog.rassvet.sync(date);
  if (catalog.iss) {
    catalog.iss.sync(date);
    if (!catalog.iss.aliveCount) catalog.iss = null; // элементы устарели настолько, что орбита не считается
  }
}
