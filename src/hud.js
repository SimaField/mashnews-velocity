import * as THREE from 'three';
import { R_EARTH, subPoint, formatLatLon } from './orbits.js';
import { COLORS } from './game.js';

const FONT = '"Cascadia Mono", Consolas, "Courier New", monospace';
const RADAR_RANGE = 1500;
const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _d = new THREE.Vector3(), _c = new THREE.Vector3();
const _up = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const _s = { x: 0, y: 0, cx: 0, cy: 0, front: false, on: false };
const _geo = {};

const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Приборы рисуются на отдельном холсте в полном разрешении поверх «пиксельной» сцены
export class Hud {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.w = this.h = 0;
    this.dpr = 1;
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = Math.round(w * this.dpr);
    this.cv.height = Math.round(h * this.dpr);
  }

  clear() {
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.cv.width, this.cv.height);
  }

  // Мировая точка → экран. cx, cy — направление в осях камеры, годится и для целей за спиной
  toScreen(pos, cam) {
    _v.copy(pos).applyMatrix4(cam.matrixWorldInverse);
    _s.cx = _v.x;
    _s.cy = _v.y;
    _s.front = _v.z < 0;
    _v.applyMatrix4(cam.projectionMatrix);
    _s.x = (_v.x * 0.5 + 0.5) * this.w;
    _s.y = (0.5 - _v.y * 0.5) * this.h;
    _s.on = _s.front && _s.x > 0 && _s.x < this.w && _s.y > 0 && _s.y < this.h;
    return _s;
  }

  // Закрыта ли точка диском Земли
  hidden(pos, cam) {
    _d.subVectors(pos, cam.position);
    const t = THREE.MathUtils.clamp(-cam.position.dot(_d) / _d.lengthSq(), 0, 1);
    return _c.copy(cam.position).addScaledVector(_d, t).length() < R_EARTH;
  }

  text(str, x, y, color, size = 13, align = 'left', weight = 600) {
    const g = this.g;
    g.font = `${weight} ${size}px ${FONT}`;
    g.textAlign = align;
    // Тёмная обводка: надпись читается и на фоне облаков
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(2,8,16,.85)';
    g.strokeText(str, x, y);
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 8;
    g.fillText(str, x, y);
    g.shadowBlur = 0;
  }

  plate(x, y, w, h) {
    const g = this.g;
    g.beginPath();
    g.roundRect(x, y, w, h, 8);
    g.fillStyle = 'rgba(3,10,20,.6)';
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(94,242,255,.18)';
    g.stroke();
  }

  bar(x, y, w, label, value, max, color) {
    const g = this.g, frac = Math.max(0, Math.min(1, value / max));
    this.text(label, x, y + 9, color, 11);
    const bx = x + 74;
    g.strokeStyle = color;
    g.globalAlpha = 0.45;
    g.strokeRect(bx + 0.5, y + 0.5, w, 9);
    g.globalAlpha = 1;
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 8;
    g.fillRect(bx + 2, y + 2, Math.max(0, (w - 3) * frac), 6);
    g.shadowBlur = 0;
    this.text(String(Math.ceil(value)), bx + w + 10, y + 9, color, 11);
  }

  brackets(x, y, s, color, width = 1.5) {
    const g = this.g, k = s * 0.45;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.shadowColor = color;
    g.shadowBlur = 8;
    g.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      g.moveTo(x + sx * s, y + sy * (s - k));
      g.lineTo(x + sx * s, y + sy * s);
      g.lineTo(x + sx * (s - k), y + sy * s);
    }
    g.stroke();
    g.shadowBlur = 0;
  }

  diamond(x, y, s, color, fill = false) {
    const g = this.g;
    g.beginPath();
    g.moveTo(x, y - s);
    g.lineTo(x + s, y);
    g.lineTo(x, y + s);
    g.lineTo(x - s, y);
    g.closePath();
    g.strokeStyle = g.fillStyle = color;
    g.lineWidth = 1.5;
    g.shadowColor = color;
    g.shadowBlur = 6;
    if (fill) g.fill();
    else g.stroke();
    g.shadowBlur = 0;
  }

  // Стрелка у края экрана в сторону цели вне кадра
  edgeArrow(s, color, label) {
    const g = this.g, w = this.w, h = this.h;
    let dx = s.cx, dy = -s.cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const x = w / 2 + dx * w * 0.4, y = h / 2 + dy * h * 0.36;
    const ang = Math.atan2(dy, dx);
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(12, 0);
    g.lineTo(-6, -7);
    g.lineTo(-2, 0);
    g.lineTo(-6, 7);
    g.closePath();
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 10;
    g.fill();
    g.restore();
    g.shadowBlur = 0;
    if (label) this.text(label, x - dx * 26, y - dy * 26 + 4, color, 11, 'center');
  }

  draw(game) {
    const g = this.g, w = this.w, h = this.h;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (game.state === 'briefing') return;
    this.drawWorld(game);
    this.drawGauges(game);
    this.drawRadar(game);
    this.drawStatus(game);

    if (game.damageFlash > 0) {
      const grad = g.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.75);
      grad.addColorStop(0, 'rgba(255,40,60,0)');
      grad.addColorStop(1, `rgba(255,40,60,${0.55 * game.damageFlash})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }
  }

  drawWorld(game) {
    const { sl, rs, player: p, camera: cam } = game;
    const playing = game.state === 'play';

    // Цели миссии; ближайшая вне кадра показывается стрелкой
    let nearest = -1, nearestDist = Infinity;
    for (const i of game.targets) {
      if (!sl.alive[i]) continue;
      sl.position(i, _p);
      const dist = _p.distanceTo(p.pos);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
      if (dist > 9000 || this.hidden(_p, cam)) continue;
      const s = this.toScreen(_p, cam);
      if (!s.on) continue;
      this.diamond(s.x, s.y, 5, COLORS.cyan);
      if (dist < 3000) this.text(`${Math.round(dist)}`, s.x, s.y + 20, COLORS.cyan, 10, 'center');
    }
    if (nearest >= 0 && playing) {
      const s = this.toScreen(sl.position(nearest, _p), cam);
      if (!s.on) this.edgeArrow(s, COLORS.cyan, `ЦЕЛЬ ${Math.round(nearestDist)} км`);
    }

    // Свои
    for (let i = 0; i < rs.count; i++) {
      if (!rs.alive[i]) continue;
      rs.position(i, _p);
      const dist = _p.distanceTo(p.pos);
      if (dist > 3500 || this.hidden(_p, cam)) continue;
      const s = this.toScreen(_p, cam);
      if (!s.on) continue;
      this.g.beginPath();
      this.g.arc(s.x, s.y, 9, 0, Math.PI * 2);
      this.g.strokeStyle = COLORS.gold;
      this.g.lineWidth = 1.5;
      this.g.stroke();
      this.text(`${rs.names[i]} · СВОЙ`, s.x + 15, s.y + 4, COLORS.gold, 10);
    }

    for (const k of game.pickups) {
      if (!k.alive) continue;
      const s = this.toScreen(k.pos, cam);
      if (s.on) this.diamond(s.x, s.y, 7, COLORS.green, true);
    }

    for (const gd of game.guards) {
      if (!gd.alive) continue;
      const dist = gd.pos.distanceTo(p.pos);
      const s = this.toScreen(gd.pos, cam);
      if (s.on) this.brackets(s.x, s.y, 12, COLORS.red);
      else if (playing) this.edgeArrow(s, COLORS.red, `${Math.round(dist)}`);
    }

    // Захваченная цель
    const lock = p.lock;
    if (lock && game.targetAlive(lock) && playing) {
      game.targetPos(lock, _p);
      const dist = _p.distanceTo(p.pos);
      const s = this.toScreen(_p, cam);
      if (s.on) {
        const color = lock.guard ? COLORS.red : COLORS.white;
        const size = THREE.MathUtils.clamp(9000 / dist, 16, 46);
        const x = s.x, y = s.y;
        this.brackets(x, y, size, color, 2);
        const tx = x + size + 10;
        if (lock.guard) {
          this.text('ПЕРЕХВАТЧИК ОХРАНЫ', tx, y - 6, color, 12);
          this.text(`${Math.round(dist)} км · БРОНЯ ${lock.guard.hp}/4`, tx, y + 10, color, 11);
        } else {
          const i = lock.sat;
          subPoint(_p.x, _p.y, _p.z, game.gmst, _geo);
          this.text(sl.names[i], tx, y - 14, color, 13);
          this.text(`NORAD ${sl.ids[i]} · ${Math.round(dist)} км`, tx, y + 2, color, 11);
          this.text(`над ${formatLatLon(_geo.lat, _geo.lon)}`, tx, y + 17, color, 11);
          if (game.isTarget[i]) this.text('ЦЕЛЬ МИССИИ', tx, y + 32, COLORS.cyan, 10);
        }
      }
    }

    // Перекрестье в точке, куда смотрит нос
    if (playing) {
      const s = this.toScreen(_p.copy(p.pos).addScaledVector(p.fwd, 900), cam);
      if (s.front) {
        const g = this.g, color = lock ? COLORS.gold : COLORS.cyan;
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.shadowColor = color;
        g.shadowBlur = 8;
        g.beginPath();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          g.moveTo(s.x + dx * 7, s.y + dy * 7);
          g.lineTo(s.x + dx * 17, s.y + dy * 17);
        }
        g.stroke();
        g.fillStyle = color;
        g.fillRect(s.x - 1, s.y - 1, 2, 2);
        g.shadowBlur = 0;
      }
    }
  }

  drawGauges(game) {
    const { player: p, ship } = game, w = this.w, h = this.h;
    const x = 24, y = h - 84;
    this.plate(12, h - 98, 276, 74);
    this.plate(w - 262, h - 104, 250, 96);
    const hullColor = p.hull < ship.hull * 0.3 ? COLORS.red : COLORS.green;
    this.bar(x, y, 150, 'ЩИТ', p.shield, ship.shield, COLORS.cyan);
    this.bar(x, y + 20, 150, 'КОРПУС', p.hull, ship.hull, hullColor);
    this.bar(x, y + 40, 150, 'ТОПЛИВО', p.fuel, ship.fuel, COLORS.gold);

    const rx = w - 24;
    this.text(`${Math.round(p.speed)} км/с`, rx, h - 76, p.boosting ? COLORS.gold : COLORS.cyan, 20, 'right', 700);
    this.text(p.boosting ? 'ФОРСАЖ' : 'СКОРОСТЬ', rx - 132, h - 78, p.boosting ? COLORS.gold : COLORS.cyan, 10, 'right');
    const lowAlt = p.alt < 260;
    this.text(`ВЫСОТА ${Math.round(p.alt)} км`, rx, h - 54, lowAlt ? COLORS.red : COLORS.cyan, 12, 'right');
    this.text(`РАКЕТЫ ${'▮'.repeat(Math.min(p.missiles, 16))}${p.missiles ? '' : '—'} ${p.missiles}`, rx, h - 36, p.missiles ? COLORS.white : COLORS.red, 12, 'right');
    this.text(`${ship.name.toUpperCase()} · ПУШКА Р-23М`, rx, h - 18, 'rgba(94,242,255,.6)', 10, 'right');
  }

  drawRadar(game) {
    const g = this.g, { sl, rs, player: p } = game;
    const cx = this.w / 2, cy = this.h - 82, R = 62, k = R / RADAR_RANGE;
    g.fillStyle = 'rgba(4,14,26,.55)';
    g.strokeStyle = 'rgba(94,242,255,.55)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.strokeStyle = 'rgba(94,242,255,.2)';
    g.beginPath();
    g.arc(cx, cy, R / 2, 0, Math.PI * 2);
    g.moveTo(cx - R, cy);
    g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R);
    g.lineTo(cx, cy + R);
    g.stroke();

    // Плоскость радара — местный горизонт, курс вверх
    _up.copy(p.pos).normalize();
    _f.copy(p.fwd).addScaledVector(_up, -p.fwd.dot(_up)).normalize();
    _r.crossVectors(_f, _up);
    const plot = (pos, color, size, pin = false) => {
      _d.subVectors(pos, p.pos);
      let x = _d.dot(_r) * k, y = -_d.dot(_f) * k;
      const d = Math.hypot(x, y);
      if (d > R - 2) {
        if (!pin) return;
        x *= (R - 2) / d;
        y *= (R - 2) / d;
      }
      g.fillStyle = color;
      g.fillRect(cx + x - size / 2, cy + y - size / 2, size, size);
    };
    for (let n = 0; n < game.nearCount; n++) {
      const i = game.nearIdx[n];
      if (sl.alive[i] && !game.isTarget[i]) plot(sl.position(i, _p), 'rgba(110,150,210,.75)', 2);
    }
    for (let i = 0; i < rs.count; i++) if (rs.alive[i]) plot(rs.position(i, _p), COLORS.gold, 4);
    for (const i of game.targets) if (sl.alive[i]) plot(sl.position(i, _p), COLORS.cyan, 4, true);
    for (const kk of game.pickups) if (kk.alive) plot(kk.pos, COLORS.green, 3);
    for (const gd of game.guards) if (gd.alive) plot(gd.pos, COLORS.red, 5, true);

    g.fillStyle = COLORS.white;
    g.beginPath();
    g.moveTo(cx, cy - 6);
    g.lineTo(cx + 4, cy + 4);
    g.lineTo(cx - 4, cy + 4);
    g.closePath();
    g.fill();
    this.text(`${RADAR_RANGE} км`, cx, cy + R + 14, 'rgba(94,242,255,.55)', 9, 'center');
  }

  drawStatus(game) {
    const { player: p, rs } = game, w = this.w, h = this.h;
    const total = game.targets.length, done = total - game.targetsLeft;
    this.plate(12, 12, 244, 76);
    this.text('МИССИЯ 01 · ПЕРЕХВАТ', 24, 30, 'rgba(94,242,255,.65)', 10);
    this.text(`ЦЕЛИ ${String(done).padStart(2, '0')}/${total}`, 24, 56, COLORS.cyan, 22, 'left', 700);
    this.text(`СЧЁТ ${game.score}   ВРЕМЯ ${mmss(game.t)}`, 24, 76, COLORS.cyan, 12);

    const linked = game.comm.dist < 2200 && game.comm.index >= 0;
    if (linked) {
      this.text(`СВЯЗЬ · ${rs.names[game.comm.index]} · ${Math.round(game.comm.dist)} км`, w - 24, 30, COLORS.gold, 11, 'right');
      this.text('щит восстанавливается быстрее', w - 24, 46, 'rgba(255,178,62,.7)', 10, 'right');
    } else {
      this.text('НЕТ СВЯЗИ С ГРУППИРОВКОЙ', w - 24, 30, 'rgba(160,180,210,.7)', 11, 'right');
    }
    subPoint(p.pos.x, p.pos.y, p.pos.z, game.gmst, _geo);
    this.text(formatLatLon(_geo.lat, _geo.lon), w - 24, linked ? 64 : 46, 'rgba(94,242,255,.65)', 10, 'right');

    // Журнал событий
    let y = Math.round(h * 0.3);
    for (let i = game.messages.length - 1; i >= 0; i--) {
      const m = game.messages[i];
      this.g.globalAlpha = Math.max(0, Math.min(1, (5 - m.t) / 1.2));
      this.text(m.text, 24, y, m.color, 12);
      y += 18;
    }
    this.g.globalAlpha = 1;

    if (game.warning && Math.floor(game.clock * 4) % 2 === 0) {
      this.text(game.warning, w / 2, Math.round(h * 0.22), COLORS.red, 20, 'center', 700);
    }
    if (game.state === 'won') this.text('ЗАДАЧА ВЫПОЛНЕНА', w / 2, h * 0.42, COLORS.gold, 34, 'center', 700);
    if (game.state === 'lost') this.text('АППАРАТ ПОТЕРЯН', w / 2, h * 0.42, COLORS.red, 34, 'center', 700);
  }
}
