import * as THREE from 'three';
import { R_EARTH, EARTH_RATE, gmstAt, subPoint, formatLatLon } from './orbits.js';
import { instance } from './models.js';
import { Mission, firstHit } from './mission.js';
import { TIME_SCALE, SCORE, COLORS, clamp, orient, turnToward } from './common.js';

// ---------- Миссия 03: гигантский космический клоун ----------
// Вся миссия — бой с боссом. Голова клоуна бронирована, уязвимы два глаза,
// а после них — нос. Клоун жонглирует спутниками и швыряет их в игрока,
// время от времени плюётся конфетти, которое забивает радар.

const HEAD_R = 110; // радиус головы, км
const ORBIT_LIFT = 160; // насколько клоун выше «Рассвета», рядом с которым объявился
const ORBIT_LEAD = 950; // и насколько впереди него по орбите
const THROW_SPEED = 430, THROW_LIFE = 8, THROW_HIT = 16, THROW_DAMAGE = 18, THROW_RANGE = 2600;
const CONFETTI_RANGE = 2000, JAM_TIME = 5;
const PINK = '#ff7ad9';
const CONFETTI = [[1, 0.3, 0.5], [1, 0.85, 0.2], [0.3, 0.9, 1], [0.5, 1, 0.5], [0.8, 0.5, 1]];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _hull = [new THREE.Vector3()];

export class Clown extends Mission {
  constructor(game) {
    super(game);
    this.maxGuards = 0;
    this.winText = 'НОС ЛОПНУЛ. КЛОУН СДУЛСЯ';
    this.winTitle = 'Цирк уехал';
    this.thrownKilled = 0;
    this.pickOrbit();
    this.buildClown();
    this.track(game.orbitT);
  }

  // Клоун идёт по орбите одного из «Рассветов», чуть выше и впереди него
  pickOrbit() {
    const rs = this.game.rs;
    const alive = [];
    for (let i = 0; i < rs.count; i++) if (rs.alive[i] && rs.radius[i] > R_EARTH + 430) alive.push(i);
    const i = alive.length ? alive[Math.floor(Math.random() * alive.length)] : -1;
    this.anchor = i >= 0 ? rs.names[i] : null;
    const j = i * 3;
    this.orbit = i >= 0
      ? { e1: new THREE.Vector3(rs.e1[j], rs.e1[j + 1], rs.e1[j + 2]), e2: new THREE.Vector3(rs.e2[j], rs.e2[j + 1], rs.e2[j + 2]), radius: rs.radius[i] + ORBIT_LIFT, rate: rs.rate[i] }
      : { e1: new THREE.Vector3(1, 0, 0), e2: new THREE.Vector3(0, 0.6, -0.8), radius: R_EARTH + 660, rate: 0.0011 };
    this.orbit.phase = ORBIT_LEAD / this.orbit.radius;
  }

  buildClown() {
    const scene = this.game.scene;
    const group = instance('clown');
    scene.add(group);
    const vel = new THREE.Vector3();
    const part = (kind, label, x, y, z, r, hp, model, open) => {
      const mesh = instance(model);
      mesh.position.set(x, y, z);
      group.add(mesh);
      return { kind, owner: 'КЛОУН', label, local: new THREE.Vector3(x, y, z), r, hp, max: hp, alive: true, open, pos: new THREE.Vector3(), vel, mesh };
    };
    const parts = [
      part('eye', 'ЛЕВЫЙ ГЛАЗ', -38, 30, -97, 28, 16, 'clownEye', true),
      part('eye', 'ПРАВЫЙ ГЛАЗ', 38, 30, -97, 28, 16, 'clownEye', true),
      part('nose', 'НОС', 0, -6, -114, 34, 40, 'clownNose', false),
    ];

    // Брошенные спутники: для захвата и попаданий это такие же «узлы», только летающие
    const thrown = [];
    for (let k = 0; k < 6; k++) {
      const mesh = instance('starlink', COLORS.red);
      mesh.scale.setScalar(1.4);
      mesh.visible = false;
      scene.add(mesh);
      thrown.push({ kind: 'thrown', owner: 'БРОСОК', label: '', r: THROW_HIT, hp: 2, max: 2, alive: false, open: true, pos: new THREE.Vector3(), vel: new THREE.Vector3(), mesh, life: 0 });
    }
    // Спутники, которыми клоун жонглирует над головой
    const juggle = [];
    for (let k = 0; k < 4; k++) {
      const mesh = instance('starlink');
      mesh.scale.setScalar(1.6);
      scene.add(mesh);
      juggle.push(mesh);
    }

    this.clown = {
      group, parts, thrown, juggle, vel, nose: parts[2],
      targets: [...parts, ...thrown],
      pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1), hand: new THREE.Vector3(), drift: new THREE.Vector3(),
      throwCd: 4, confettiCd: 9, bump: 0, dying: 0, popped: false, range: 0,
    };
  }

  // Положение и скорость клоуна на орбите
  track(orbitT) {
    const o = this.orbit, c = this.clown;
    const ang = o.phase + o.rate * orbitT;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    c.pos.copy(o.e1).multiplyScalar(cs * o.radius).addScaledVector(o.e2, sn * o.radius).add(c.drift);
    c.vel.copy(o.e2).multiplyScalar(cs).addScaledVector(o.e1, -sn).multiplyScalar(o.radius * o.rate * TIME_SCALE);
  }

  eyesAlive() {
    return this.clown.parts.filter((x) => x.kind === 'eye' && x.alive).length;
  }

  briefing() {
    const { catalog } = this.game, o = this.orbit;
    const t = (Date.now() - catalog.epoch.getTime()) / 1000;
    this.track(t);
    const pos = this.clown.pos;
    const geo = subPoint(pos.x, pos.y, pos.z, gmstAt(catalog.epoch) + EARTH_RATE * t);
    return {
      text: 'На орбите объявился гигантский клоун. Он жонглирует спутниками Starlink и швыряет их во всё, что подлетит. Голову не пробить: выбейте оба глаза, после этого откроется нос.',
      facts: [
        ['Поперечник головы', `${HEAD_R * 2} км`],
        ['Высота', `${Math.round(o.radius - R_EARTH)} км`],
        ['Сейчас над', formatLatLon(geo.lat, geo.lon)],
        ['Рядом', this.anchor ?? 'никого из своих'],
        ['Слабые места', 'два глаза, затем нос'],
      ],
      hint: 'Брошенные спутники можно сбивать. Конфетти в лицо на пять секунд забивает радар.',
    };
  }

  // Старт в 2000 км позади клоуна, курс на него
  placePlayer(p) {
    const c = this.clown;
    this.track(this.game.orbitT);
    const along = _a.copy(c.vel).normalize();
    p.pos.copy(c.pos).addScaledVector(along, -2000).setLength(c.pos.length() - 40);
    const up = _b.copy(p.pos).normalize();
    p.fwd.copy(along).addScaledVector(up, -along.dot(up)).normalize();
    c.fwd.subVectors(p.pos, c.pos).normalize();
    return 'ВПЕРЕДИ ЧТО-ТО БОЛЬШОЕ. СТРЕЛЯЙТЕ ПО ГЛАЗАМ';
  }

  // ---------- ход миссии ----------

  update(dt) {
    const g = this.game, c = this.clown, p = g.player;
    if (c.popped) this.deflate(dt);
    this.track(g.orbitT);

    const toPlayer = _a.subVectors(p.pos, c.pos);
    c.range = toPlayer.length();
    const dir = toPlayer.normalize();
    const up = _b.copy(c.pos).normalize();
    // Лицо поворачивается за игроком, но не быстрее 26° в секунду: его можно облететь
    if (!c.popped) turnToward(c.fwd, dir, 0.45 * dt);
    // Круче 64° вверх или вниз лицо не задирается: иначе нечем задать, где у головы верх
    const tilt = c.fwd.dot(up);
    if (Math.abs(tilt) > 0.9) c.fwd.addScaledVector(up, Math.sign(tilt) * 0.9 - tilt).normalize();
    c.group.position.copy(c.pos);
    orient(c.group, c.fwd, up, c.popped ? c.dying * 9 : 0);
    c.group.updateMatrixWorld(true);
    for (const part of c.parts) part.pos.copy(part.local).applyMatrix4(c.group.matrixWorld);

    // Жонглирование: четыре спутника по кругу над головой
    const right = _c.crossVectors(c.fwd, up).normalize();
    c.hand.copy(c.pos).addScaledVector(up, HEAD_R + 95);
    c.juggle.forEach((mesh, k) => {
      const ang = g.clock * 2.6 + (k * Math.PI) / 2;
      mesh.visible = !c.popped;
      mesh.position.copy(c.hand).addScaledVector(right, Math.cos(ang) * 75).addScaledVector(up, Math.sin(ang) * 48);
      mesh.rotation.set(ang * 1.7, ang, 0);
    });

    this.moveThrown(dt);
    if (g.state !== 'play') return;

    // Бросок: только когда игрок рядом; без глаз клоун злится и бросает чаще
    c.throwCd -= dt;
    if (c.throwCd <= 0 && c.range < THROW_RANGE) {
      c.throwCd = this.eyesAlive() ? 2.8 : 1.9;
      this.throwSat(dir);
    }

    // Конфетти летит туда, куда смотрит лицо; радар забивает, только если попало по игроку
    c.confettiCd -= dt;
    if (c.confettiCd <= 0 && c.range < CONFETTI_RANGE) {
      c.confettiCd = this.eyesAlive() ? 13 : 9;
      const mouth = _c.copy(c.pos).addScaledVector(c.fwd, HEAD_R).addScaledVector(up, -45);
      for (let k = 0; k < 90; k++) {
        const col = CONFETTI[k % CONFETTI.length];
        _d.randomDirection().multiplyScalar(150).addScaledVector(c.fwd, 650 * (0.45 + Math.random() * 0.55)).add(c.vel);
        g.emit(mouth, _d, 1.6 + Math.random(), col[0], col[1], col[2]);
      }
      g.audio.honk();
      if (c.fwd.dot(dir) > 0.6) {
        g.radarJam = JAM_TIME;
        g.say('КОНФЕТТИ! РАДАР ЗАБИТ', PINK);
      }
    }

    // Столкновение с головой: клоун мягкий, но большой
    c.bump -= dt;
    if (c.bump <= 0 && c.range < HEAD_R + 6) {
      c.bump = 0.8;
      p.pos.sub(c.pos).setLength(HEAD_R + 30).add(c.pos);
      g.say('ОТСКОК ОТ КЛОУНА', PINK);
      g.audio.boing();
      g.damagePlayer(15);
    }
  }

  throwSat(dir) {
    const g = this.game, c = this.clown, p = g.player;
    const s = c.thrown.find((x) => !x.alive);
    if (!s) return;
    const lead = _d.copy(p.pos).addScaledVector(p.vel, c.range / THROW_SPEED).sub(c.hand).normalize();
    s.pos.copy(c.hand);
    s.vel.copy(lead).multiplyScalar(THROW_SPEED).add(c.vel);
    s.alive = true;
    s.hp = s.max;
    s.life = THROW_LIFE;
    // Имя берётся у случайного настоящего аппарата: клоун «подобрал» его с орбиты
    s.label = g.sl.names[Math.floor(Math.random() * g.sl.count)];
    s.mesh.visible = true;
    if (c.range < 1600) g.audio.boing();
    if (dir.dot(g.player.fwd) < -0.2 && Math.random() < 0.35) g.say(`КЛОУН МЕТНУЛ ${s.label}`, COLORS.red);
  }

  moveThrown(dt) {
    const g = this.game, p = g.player;
    for (const s of this.clown.thrown) {
      if (!s.alive) continue;
      s.life -= dt;
      // Первые секунды бросок слегка доворачивает на игрока, потом летит по прямой
      if (s.life > THROW_LIFE - 2.5) {
        const speed = s.vel.length();
        turnToward(s.vel.divideScalar(speed), _d.subVectors(p.pos, s.pos).normalize(), 0.3 * dt).multiplyScalar(speed);
      }
      s.pos.addScaledVector(s.vel, dt);
      s.mesh.position.copy(s.pos);
      s.mesh.rotation.set(g.clock * 5, g.clock * 3, 0);
      if (g.state === 'play' && s.pos.distanceTo(p.pos) < THROW_HIT) {
        this.dropThrown(s, 0.8);
        g.say(`ПОПАДАНИЕ: ${s.label}`, COLORS.red);
        g.damagePlayer(THROW_DAMAGE);
      } else if (s.life <= 0 || s.pos.length() < R_EARTH + 90) {
        this.dropThrown(s, 0);
      }
    }
  }

  dropThrown(s, boom) {
    const g = this.game;
    s.alive = false;
    s.mesh.visible = false;
    if (g.player.lock && g.player.lock.part === s) g.player.lock = null;
    if (boom) g.explode(s.pos, boom, 0xff7050);
  }

  damagePart(part, dmg) {
    const g = this.game, c = this.clown;
    if (!part.alive || !part.open || c.popped) return false;
    part.hp -= dmg;
    if (part.hp > 0) {
      g.spark(part.pos, 130, 0.45, 1.0, 0.5, 0.75, 8);
      g.audio.spark();
      return true;
    }
    part.hp = 0;
    if (part.kind === 'thrown') {
      this.dropThrown(part, 0.7);
      this.thrownKilled++;
      g.score += 50;
      return true;
    }
    part.alive = false;
    part.mesh.visible = false;
    if (g.player.lock && g.player.lock.part === part) g.player.lock = null;
    if (part.kind === 'eye') {
      g.score += SCORE.bossPart;
      g.explode(part.pos, 1.4, 0x5ef2ff);
      g.audio.honk();
      if (this.eyesAlive()) {
        g.say(`${part.label} ВЫБИТ. КЛОУН МОРГАЕТ ОСТАВШИМСЯ`, COLORS.gold);
      } else {
        c.nose.open = true;
        g.say('ОБА ГЛАЗА ВЫБИТЫ', COLORS.gold);
        g.say('НОС ОТКРЫТ: БЕЙТЕ В КРАСНОЕ', COLORS.gold);
      }
      return true;
    }
    // Нос лопнул: клоун сдувается и улетает
    c.popped = true;
    for (const s of c.thrown) if (s.alive) this.dropThrown(s, 0.6);
    g.score += SCORE.boss;
    g.explode(part.pos, 2.2, 0xe3202e, false);
    g.audio.honk();
    g.audio.deflate();
    g.win();
    return true;
  }

  // Сдувшийся шарик летит задом наперёд, вихляя и уменьшаясь
  deflate(dt) {
    const c = this.clown;
    c.dying += dt;
    const up = _a.copy(c.pos).normalize();
    c.drift.addScaledVector(c.fwd, -(350 + 1100 * c.dying) * dt).addScaledVector(up, Math.sin(c.dying * 11) * 420 * dt + 160 * dt);
    c.group.scale.setScalar(Math.max(0.02, 1 - c.dying / 3.2));
    if (c.dying > 3.4) c.group.visible = false;
  }

  // ---------- попадания ----------

  bulletHit(bul, step) {
    const g = this.game, c = this.clown;
    if (c.popped) return 0;
    _hull[0].copy(c.pos);
    const hit = firstHit(bul.pos, step, c.targets, _hull, HEAD_R);
    if (hit.t === Infinity) return 0;
    if (hit.part && this.damagePart(hit.part, 1)) return 1;
    // Голова и закрытый нос снаряды не берут
    g.spark(_c.copy(bul.pos).addScaledVector(step, hit.t), 70, 0.25, 1.0, 0.6, 0.85, 3);
    return 2;
  }

  lockCandidates(consider) {
    const c = this.clown;
    if (c.popped) return;
    for (const part of c.parts) if (part.alive && part.open) consider({ part }, -0.06);
    for (const s of c.thrown) if (s.alive) consider({ part: s }, -0.02);
  }

  // ---------- приборы ----------

  status() {
    const big = this.clown.nose.open ? 'НОС' : `ГЛАЗА ${2 - this.eyesAlive()}/2`;
    return { title: 'МИССИЯ 03 · ЦИРК НА ОРБИТЕ', big };
  }

  drawBars(hud) {
    const g = hud.g, c = this.clown, small = hud.compact;
    const bw = small ? 130 : 220, pad = small ? 52 : 70;
    const x = Math.round(hud.w / 2 - bw / 2), y = small ? 16 : 20;
    hud.plate(x - pad, y - 10, bw + pad + (small ? 50 : 62), 60);
    let hp = 0, max = 0;
    for (const part of c.parts) {
      hp += part.hp;
      max += part.max;
    }
    const frac = hp / max;
    hud.text('КЛОУН', x - pad + 12, y + 10, PINK, 12);
    g.strokeStyle = PINK;
    g.lineWidth = 1;
    g.globalAlpha = 0.5;
    g.strokeRect(x + 0.5, y + 0.5, bw, 10);
    g.globalAlpha = 1;
    g.fillStyle = PINK;
    g.fillRect(x + 2, y + 2, (bw - 3) * frac, 7);
    hud.text(`${Math.ceil(frac * 100)}%`, x + bw + 10, y + 10, PINK, 12);

    // Узлы: два глаза и нос (контур — пока нос закрыт)
    c.parts.forEach((part, k) => {
      const px = x + k * (small ? 44 : 74), py = y + 27;
      const color = part.alive ? (part.kind === 'nose' ? COLORS.red : COLORS.cyan) : 'rgba(160,180,210,.3)';
      g.strokeStyle = g.fillStyle = color;
      g.strokeRect(px + 0.5, py + 0.5, 15, 9);
      if (part.alive && part.open) g.fillRect(px + 2, py + 2, 12, 6);
      hud.text(part.kind === 'nose' ? 'НОС' : 'ГЛАЗ', px + 21, py + 9, color, 9);
    });
  }

  drawMarkers(hud) {
    const game = this.game, cam = game.camera, p = game.player, c = this.clown;
    if (c.popped) return;
    const playing = game.state === 'play';
    const s = hud.toScreen(c.pos, cam);
    if (s.on && !hud.hidden(c.pos, cam)) {
      const size = clamp(((HEAD_R * 1.25) / c.range / Math.tan((cam.fov * Math.PI) / 360)) * (hud.h / 2), 16, 140);
      const x = s.x, y = s.y;
      hud.brackets(x, y, size, PINK, 2);
      hud.text(`КЛОУН · ${Math.round(c.range)} км`, x, y - size - 8, PINK, 11, 'center');
      for (const part of c.parts) {
        if (!part.alive) continue;
        const q = hud.toScreen(part.pos, cam);
        if (q.on) hud.diamond(q.x, q.y, part.kind === 'nose' ? 7 : 5, part.open ? COLORS.red : 'rgba(255,77,94,.4)', part.kind === 'nose' && part.open);
      }
    } else if (playing) {
      hud.edgeArrow(s, PINK, `КЛОУН ${Math.round(c.range)} км`);
    }

    // Летящие в игрока спутники: рамка на экране или стрелка у края
    for (const t of c.thrown) {
      if (!t.alive) continue;
      const dist = t.pos.distanceTo(p.pos);
      const q = hud.toScreen(t.pos, cam);
      if (q.on) hud.brackets(q.x, q.y, 10, COLORS.red);
      else if (playing && dist < 2500) hud.edgeArrow(q, COLORS.red, `${Math.round(dist)}`);
    }
  }

  radar(plot) {
    const c = this.clown;
    if (c.popped) return;
    plot(c.pos, PINK, 9, true);
    for (const s of c.thrown) if (s.alive) plot(s.pos, COLORS.red, 4);
  }

  resultFacts() {
    const c = this.clown;
    return [
      ['Глаза выбиты', `${2 - this.eyesAlive()} из 2`],
      ['Нос', c.popped ? 'лопнул' : 'цел'],
      ['Сбито брошенных спутников', this.thrownKilled],
      ['Сбито Starlink', this.game.stats.kills],
    ];
  }
}
