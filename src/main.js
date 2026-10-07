import * as THREE from 'three';
import { loadCatalog, syncCatalog } from './catalog.js';
import { Menu } from './menu.js';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { SHIPS } from './models.js';
import { MISSIONS } from './missions.js';
import { formatLatLon } from './orbits.js';
import { GOALS, reachGoal } from './analytics.js';

const $ = (id) => document.getElementById(id);
const num = (n) => n.toLocaleString('ru-RU');
// Имена аппаратов приходят из внешнего каталога, поэтому в разметку идут только экранированными
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const factRows = (rows) => rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd>`).join('');

const glCanvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, powerPreference: 'high-performance' });
const hud = new Hud($('hud'));
const input = new Input();
const audio = new Sfx();

let catalog = null, menu = null, game = null;
let mode = 'loading'; // loading | menu | game
let paused = false;
let shipId = 'spiral';
let missionId = 'intercept';

function show(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('hidden', el.id !== `s-${name}`);
  $('tip').classList.add('hidden');
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  hud.resize(w, h);
  if (mode === 'game') game.resize(w, h);
  else if (menu) menu.resize(w, h);
}

// ---------- меню ----------

function setSpeed(speed) {
  menu.timeScale = speed;
  for (const b of $('speeds').children) b.classList.toggle('on', Number(b.dataset.speed) === speed);
}

function resyncNow() {
  syncCatalog(catalog, new Date());
  menu.resync();
}

function toTitle() {
  mode = 'menu';
  glCanvas.classList.remove('retro');
  menu.activate();
  menu.setPreview(null);
  show('title');
  resize();
}

const BARS = [
  ['Скорость', (s) => s.cruise / 260],
  ['Форсаж', (s) => s.boost / 520],
  ['Манёвр', (s) => s.turn / 1.6],
  ['Защита', (s) => (s.shield + s.hull) / 380],
  ['Ракеты', (s) => s.missiles / 16],
];

function selectShip(id) {
  shipId = id;
  const ship = SHIPS[id];
  for (const b of $('ships').children) b.classList.toggle('on', b.dataset.ship === id);
  $('ship-desc').textContent = ship.desc;
  $('ship-bars').innerHTML = BARS.map(([label, f]) => `<span>${label}</span><i style="--v:${Math.round(Math.min(1, f(ship)) * 100)}%"></i>`).join('');
  const next = $('b-hangar-next');
  next.disabled = Boolean(ship.locked);
  next.textContent = ship.locked ? 'В разработке' : 'К брифингу';
  menu.setPreview(id);
}

function toHangar() {
  show('hangar');
  selectShip(SHIPS[shipId].locked ? 'spiral' : shipId);
}

function newGame() {
  if (game) game.dispose();
  // Бой начинается с настоящего положения аппаратов на текущий момент
  resyncNow();
  setSpeed(1);
  game = new Game({ renderer, hud, catalog, shipId, missionId, audio, input, onFinish: showResult });
}

function toBriefing() {
  newGame();
  const meta = MISSIONS[missionId], brief = game.mission.briefing();
  $('brief-eyebrow').textContent = `Миссия ${meta.number}`;
  $('brief-title').textContent = meta.name;
  $('brief-text').textContent = brief.text;
  $('brief-hint').textContent = brief.hint;
  $('brief-facts').innerHTML = factRows([['Аппарат', SHIPS[shipId].name, 'gold'], ...brief.facts]);
  for (const b of $('missions').children) b.classList.toggle('on', b.dataset.mission === missionId);
  menu.setPreview(null);
  show('briefing');
}

// ---------- бой ----------

function lockPointer() {
  try {
    const res = glCanvas.requestPointerLock();
    if (res && res.catch) res.catch(() => {});
  } catch {
    // без захвата курсора остаётся управление с клавиатуры
  }
}

function launch() {
  mode = 'game';
  paused = false;
  menu.deactivate();
  glCanvas.classList.add('retro');
  show(null);
  resize();
  input.reset();
  input.enabled = true;
  game.start();
  lockPointer();
  reachGoal(GOALS.start, { mission: missionId, ship: shipId });
}

function setPaused(value) {
  if (mode !== 'game' || game.state !== 'play' || paused === value) return;
  paused = value;
  input.enabled = !value;
  input.reset();
  show(value ? 'pause' : null);
  if (value) {
    audio.engine(0, false, false);
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    lockPointer();
  }
}

function showResult(res) {
  input.enabled = false;
  if (document.pointerLockElement) document.exitPointerLock();
  reachGoal(res.won ? GOALS.win : GOALS.lose, { mission: missionId, ship: shipId, outcome: res.title });
  // Рекорд у каждой миссии свой; у первой ключ остался прежним
  const bestKey = missionId === 'intercept' ? 'dv-best' : `dv-best-${missionId}`;
  let best = 0;
  try {
    best = Number(localStorage.getItem(bestKey)) || 0;
    if (res.score > best) localStorage.setItem(bestKey, String(res.score));
  } catch {
    // хранилище недоступно — обойдёмся без рекорда
  }
  const t = Math.round(res.time);
  $('res-eyebrow').textContent = res.won ? 'Миссия выполнена' : 'Миссия провалена';
  $('res-title').textContent = res.title;
  $('res-facts').innerHTML = factRows([
    ['Счёт', `${num(res.score)}${res.score > best && best > 0 ? ' · рекорд' : ''}`, 'gold'],
    ['Лучший результат', num(Math.max(best, res.score))],
    ...res.facts,
    ['Точность пушки', `${Math.round(res.accuracy * 100)}%`],
    ['Время', `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`],
  ]);
  show('result');
}

function restart() {
  newGame();
  launch();
}

function leaveGame() {
  paused = false;
  input.enabled = false;
  if (document.pointerLockElement) document.exitPointerLock();
  game.dispose();
  game = null;
  hud.clear();
  resyncNow();
  setSpeed(60);
  toTitle();
}

// ---------- события ----------

function bind() {
  const on = (id, fn) => $(id).addEventListener('click', () => {
    audio.unlock();
    audio.click();
    fn();
  });
  on('b-play', toHangar);
  on('b-help', () => show('help'));
  on('b-help-close', () => show('title'));
  on('b-hangar-back', toTitle);
  on('b-hangar-next', toBriefing);
  on('b-brief-back', toHangar);
  on('b-start', launch);
  on('b-resume', () => setPaused(false));
  on('b-restart', restart);
  on('b-quit', leaveGame);
  on('b-again', restart);
  on('b-result-quit', leaveGame);
  on('b-now', () => {
    resyncNow();
    setSpeed(1);
  });
  // Вращение глобуса выключено при каждой загрузке, даже если браузер помнит галочку
  $('t-spin').checked = false;
  $('t-spin').addEventListener('change', (e) => {
    audio.unlock();
    audio.click();
    menu.setSpin(e.target.checked);
  });
  // Выбор миссии на экране брифинга: бой пересоздаётся под выбранный сценарий
  $('missions').innerHTML = Object.values(MISSIONS).map((m) => `<button data-mission="${m.id}">${m.number} · ${m.name}</button>`).join('');
  if (!catalog.iss) {
    const defend = $('missions').querySelector('[data-mission="defend"]');
    defend.disabled = true;
    defend.title = 'Нет данных об орбите МКС';
  }
  $('missions').addEventListener('click', (e) => {
    const id = e.target.dataset.mission;
    if (!id || id === missionId || e.target.disabled) return;
    audio.unlock();
    audio.click();
    missionId = id;
    toBriefing();
  });
  $('speeds').addEventListener('click', (e) => {
    if (e.target.dataset.speed) setSpeed(Number(e.target.dataset.speed));
  });

  $('ships').innerHTML = Object.values(SHIPS).map((s) => `
    <button class="ship${s.locked ? ' locked' : ''}" data-ship="${s.id}">
      <b>${s.name}</b><span>${s.sub}</span>${s.locked ? '<em>в разработке</em>' : ''}
    </button>`).join('');
  $('ships').addEventListener('click', (e) => {
    const card = e.target.closest('[data-ship]');
    if (card) {
      audio.unlock();
      audio.click();
      selectShip(card.dataset.ship);
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('keydown', (e) => {
    if (mode !== 'game') return;
    if (e.code === 'Escape' || e.code === 'KeyP') setPaused(!paused);
    else if (e.code === 'KeyM') audio.setMuted(!audio.muted);
    else if (e.code === 'F2') {
      e.preventDefault();
      game.sharp = !game.sharp;
      resize();
    }
  });
  // Esc при захваченном курсоре до страницы не доходит: браузер просто снимает захват
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement) setPaused(true);
  });
  glCanvas.addEventListener('click', () => {
    if (mode === 'game' && !paused && game.state === 'play' && !document.pointerLockElement) lockPointer();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setPaused(true);
  });

  // Подсказка по «Рассвету» под курсором
  const tip = $('tip');
  window.addEventListener('mousemove', (e) => {
    const hit = mode === 'menu' && e.target === glCanvas ? menu.pick(e.clientX, e.clientY) : null;
    tip.classList.toggle('hidden', !hit);
    if (!hit) return;
    tip.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
    tip.style.top = `${Math.min(e.clientY, window.innerHeight - 110)}px`;
    tip.innerHTML = `<b>${hit.name}</b><br>NORAD ${hit.id}<br>высота ${Math.round(hit.alt)} км · ${hit.speed.toFixed(2)} км/с<br>над ${formatLatLon(hit.lat, hit.lon)}`;
  });
}

const clockFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC',
});
let clockText = '';

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (mode === 'menu') {
    menu.update(dt);
    menu.render();
    const text = `${clockFormat.format(menu.now())} UTC`;
    if (text !== clockText) $('clock').textContent = clockText = text;
  } else if (mode === 'game') {
    if (!paused) game.update(dt);
    game.render();
    input.endFrame();
  }
}

async function init() {
  resize();
  try {
    catalog = await loadCatalog();
  } catch (err) {
    $('load-text').textContent = `Не удалось загрузить каталог: ${err.message}`;
    throw err;
  }
  menu = new Menu(renderer, catalog);
  bind();
  $('st-rassvet').textContent = num(catalog.rassvet.aliveCount);
  $('st-starlink').textContent = num(catalog.starlink.aliveCount);
  const fetched = catalog.meta.fetchedAt ? new Date(catalog.meta.fetchedAt).toLocaleDateString('ru-RU') : 'неизвестной даты';
  $('data-line').textContent = `Элементы орбит: CelesTrak, каталог NORAD · Starlink — снимок от ${fetched} · «Рассвет» — ${catalog.live ? 'онлайн' : 'снимок'}`;
  toTitle();
  requestAnimationFrame(frame);
}

if (import.meta.env.DEV) {
  // Отладочный доступ из консоли
  window.__dv = { get game() { return game; }, get menu() { return menu; }, input, launch, toBriefing };
}

init();
