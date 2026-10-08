import { SCORE, segSphereT } from './common.js';

// Миссия управляет сценарием боя: что считается целью, откуда берутся
// противники, когда бой выигран или проигран и что показывать на приборах.
// Общие системы (полёт, оружие, перехватчики, эффекты) живут в Game.
// Здесь — поведение по умолчанию; конкретные миссии переопределяют нужное.
export class Mission {
  constructor(game) {
    this.game = game;
    this.maxGuards = 3; // сколько перехватчиков может быть в бою одновременно
    this.guardName = 'ПЕРЕХВАТЧИК';
    this.winText = 'ЗАДАЧА ВЫПОЛНЕНА';
    this.winTitle = 'Задача выполнена';
  }

  update() {}

  // Сбит аппарат Starlink, не отмеченный как цель
  onSatKilled(i, pos) {
    const g = this.game;
    g.score += SCORE.starlink;
    g.say(`СБИТ ${g.sl.names[i]}  +${SCORE.starlink}`, '#8fb4e8');
    if (Math.random() < 0.15) g.dropPickup(pos);
  }

  onGuardKilled() {}

  // Попадание снаряда игрока: 0 — мимо, 1 — урон, 2 — снаряд поглощён без урона
  bulletHit() {
    return 0;
  }

  // Попадание выстрела противника во что-то кроме игрока
  boltHit() {
    return false;
  }

  lockCandidates() {}

  damagePart() {}

  updateComm() {}

  drawMarkers() {}

  drawBars() {}

  radar() {}

  dispose() {}
}

// Босс для стрельбы — набор сфер: уязвимые узлы и броня. Функция находит первую
// сферу на пути снаряда. В ответе t — доля пути до попадания (Infinity, если мимо),
// part — узел или null, если снаряд пришёл в броню.
// Узел: { pos, r, alive }; броня: центры hull с общим радиусом hullR.
const _hit = { t: Infinity, part: null };

export function firstHit(pos, step, parts, hull, hullR) {
  _hit.t = Infinity;
  _hit.part = null;
  for (const part of parts) {
    if (!part.alive) continue;
    const t = segSphereT(pos, step, part.pos, part.r);
    if (t < _hit.t) {
      _hit.t = t;
      _hit.part = part;
    }
  }
  for (const c of hull) {
    const t = segSphereT(pos, step, c, hullR);
    if (t < _hit.t) {
      _hit.t = t;
      _hit.part = null;
    }
  }
  return _hit;
}
