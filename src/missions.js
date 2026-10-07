import * as THREE from 'three';
import { R_EARTH, EARTH_RATE, gmstAt, subPoint, formatLatLon } from './orbits.js';
import { instance } from './models.js';
import {
  TIME_SCALE, BOLT_SPEED, BOLT_LIFE, MAX_SHOTS, SCORE, COLORS,
  clamp, orient, turnToward, segDist2, segSphereT,
} from './common.js';

// Миссия управляет сценарием боя: что считается целью, откуда берутся
// противники, когда бой выигран или проигран и что показывать на приборах.
// Общие системы (полёт, оружие, перехватчики, эффекты) живут в Game.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

class Mission {
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

// ---------- Миссия 01: перехват орбитальной плоскости Starlink ----------

class Intercept extends Mission {
  constructor(game) {
    super(game);
    this.winText = 'ПЛОСКОСТЬ ЗАЧИЩЕНА';
    this.winTitle = 'Плоскость зачищена';
    this.nextWaveAt = 1;
    this.quietTime = 0;
    this.pickTargets();
  }

  // Цели миссии: аппараты одной орбитальной плоскости оболочки 53°
  pickTargets() {
    const game = this.game, sl = game.sl, bins = new Map(), pl = {};
    for (let i = 0; i < sl.count; i++) {
      if (!sl.alive[i]) continue;
      const alt = sl.radius[i] - R_EARTH;
      if (alt < 470 || alt > 600) continue;
      sl.plane(i, pl);
      if (Math.abs(pl.inc - 53.1) > 0.4) continue;
      const key = Math.floor(pl.raan / 2);
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push({ i, raan: pl.raan, r: sl.radius[i] });
    }
    // В двухградусное окно попадают соседние плоскости и аппараты на других
    // высотах: оставляем тех, кто рядом с медианой окна
    const median = (arr, f) => arr.map(f).sort((x, y) => x - y)[arr.length >> 1];
    const pool = [...bins.values()].sort(() => Math.random() - 0.5);
    let group = [];
    for (const bin of pool) {
      const raan = median(bin, (o) => o.raan), r = median(bin, (o) => o.r);
      const tight = bin.filter((o) => Math.abs(o.raan - raan) < 0.4 && Math.abs(o.r - r) < 25);
      if (tight.length > group.length) group = tight;
      if (tight.length >= 14) break;
    }
    group = group.map((o) => o.i);
    if (!group.length) {
      for (let i = 0; i < sl.count && group.length < 16; i++) if (sl.alive[i]) group.push(i);
    }

    // Средняя плоскость и фаза каждого аппарата в ней
    const normal = new THREE.Vector3();
    let radius = 0;
    for (const i of group) {
      normal.add(sl.normal(i, _a));
      radius += sl.radius[i];
    }
    normal.normalize();
    radius /= group.length;
    const u = sl.position(group[0], new THREE.Vector3()).projectOnPlane(normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u);
    const phase = (i) => {
      sl.position(i, _a);
      return Math.atan2(_a.dot(v), _a.dot(u));
    };
    group = group.map((i) => ({ i, ph: (phase(i) + Math.PI * 2) % (Math.PI * 2) })).sort((x, y) => x.ph - y.ph).map((o) => o.i);
    // Больше двадцати целей не берём: прореживаем равномерно по кольцу
    if (group.length > 20) {
      const step = group.length / 20;
      group = Array.from({ length: 20 }, (_, k) => group[Math.floor(k * step)]);
    }

    game.targets = group;
    this.left = group.length;
    for (const i of group) game.isTarget[i] = 1;
    game.paintTargets();

    sl.plane(group[0], pl);
    this.plane = { normal, u, v, radius, inc: pl.inc, raan: pl.raan, alt: radius - R_EARTH, count: group.length, names: group.map((i) => sl.names[i]) };

    // Линия орбиты целей — ориентир в полёте
    const pts = [];
    for (let k = 0; k <= 256; k++) {
      const ang = (k / 256) * Math.PI * 2;
      pts.push(_a.copy(u).multiplyScalar(Math.cos(ang) * radius).addScaledVector(v, Math.sin(ang) * radius).clone());
    }
    this.ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x2aa4c4, transparent: true, opacity: 0.55 }));
    this.ring.frustumCulled = false;
    game.scene.add(this.ring);
  }

  briefing() {
    const pl = this.plane;
    const names = pl.names.slice(0, 5).join(', ') + (pl.count > 5 ? ` и ещё ${pl.count - 5}` : '');
    return {
      text: 'Одна орбитальная плоскость Starlink проходит сквозь рабочие высоты «Рассвета». Пройдите вдоль неё и уничтожьте все отмеченные аппараты. После первых потерь противник поднимет перехватчики охраны.',
      facts: [
        ['Целей', pl.count],
        ['Наклонение', `${pl.inc.toFixed(1)}°`],
        ['Восходящий узел', `${pl.raan.toFixed(1)}°`],
        ['Высота', `${Math.round(pl.alt)} км`],
        ['Состав', names],
      ],
      hint: 'Рядом с «Рассветом» щит восстанавливается быстрее. По своим не стрелять: штраф 2000 очков.',
    };
  }

  // Старт на линии орбиты, курс по движению аппаратов. Точку выбираем в самом
  // широком промежутке между целями, за 1600 км до ближайшей впереди.
  placePlayer(p) {
    const { sl, targets } = this.game, plane = this.plane;
    const phases = targets
      .map((i) => {
        sl.position(i, _a);
        return Math.atan2(_a.dot(plane.v), _a.dot(plane.u));
      })
      .sort((x, y) => x - y);
    let phase = phases[0], widest = 0;
    for (let k = 0; k < phases.length; k++) {
      const next = phases[(k + 1) % phases.length];
      const gap = (next - phases[k] + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
      if (gap > widest) {
        widest = gap;
        phase = next - Math.min(1600 / plane.radius, gap * 0.6);
      }
    }
    p.pos.copy(plane.u).multiplyScalar(Math.cos(phase)).addScaledVector(plane.v, Math.sin(phase)).multiplyScalar(plane.radius);
    p.fwd.copy(plane.u).multiplyScalar(-Math.sin(phase)).addScaledVector(plane.v, Math.cos(phase));
    return 'ЦЕЛИ ВПЕРЕДИ ПО КУРСУ. ДЕРЖИТЕСЬ ЛИНИИ ОРБИТЫ';
  }

  callGuards(n) {
    const g = this.game;
    g.guardsPending += n;
    g.say('ВНИМАНИЕ: ПЕРЕХВАТЧИКИ ОХРАНЫ', COLORS.red);
    g.audio.alarm();
  }

  update(dt) {
    const g = this.game;
    if (g.state !== 'play') return;
    // В затишье охрана всё равно подтягивается
    this.quietTime = g.guardsAlive() ? 0 : this.quietTime + dt;
    if (this.quietTime > 28 && g.stats.targets > 0) {
      this.quietTime = 0;
      this.callGuards(1);
    }
  }

  onSatKilled(i, pos, rammed) {
    const g = this.game;
    if (!g.isTarget[i]) return super.onSatKilled(i, pos);
    this.left--;
    g.stats.targets++;
    g.score += SCORE.target;
    g.say(`${rammed ? 'ТАРАН' : 'ЦЕЛЬ УНИЧТОЖЕНА'}: ${g.sl.names[i]}`, COLORS.cyan);
    if (Math.random() < 0.4) g.dropPickup(pos);
    if (g.stats.targets >= this.nextWaveAt && this.left > 0) {
      this.nextWaveAt += 3;
      this.callGuards(g.stats.targets === 1 ? 1 : this.left <= 4 ? 3 : 2);
    }
    if (this.left === 0) g.win();
  }

  status() {
    const total = this.game.targets.length;
    return { title: 'МИССИЯ 01 · ПЕРЕХВАТ', big: `ЦЕЛИ ${String(total - this.left).padStart(2, '0')}/${total}` };
  }

  resultFacts() {
    const s = this.game.stats;
    return [
      ['Цели миссии', `${s.targets} из ${this.game.targets.length}`],
      ['Всего сбито Starlink', s.kills],
      ['Перехватчики', s.guards],
      ['Потеряно своих', s.friendly],
    ];
  }

  dispose() {
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}

// ---------- Миссия 02: защита МКС, в финале Starship-носитель ----------

// Состав волн: сколько дронов идёт на станцию и сколько на игрока
const WAVES = [{ station: 2, player: 2 }, { station: 3, player: 2 }, { station: 3, player: 3 }];
const ISS_HP = 500, ISS_RADIUS = 42;
const BOSS_SCALE = 1.5, BOSS_SPEED = 34, BOSS_START = 5200, DOCK_RANGE = 75;
const HULL_Z = [-20, -12, -4, 4, 12, 20], HULL_R = 4.6; // корпус носителя как цепочка сфер, в осях модели

class Defend extends Mission {
  constructor(game) {
    super(game);
    this.maxGuards = 6;
    this.guardName = 'ДРОН';
    this.winText = 'НОСИТЕЛЬ УНИЧТОЖЕН. СТАНЦИЯ СПАСЕНА';
    this.winTitle = 'Станция спасена';
    this.wave = 0;
    this.wavesCleared = 0;
    this.waveDelay = 4;
    this.phase = 'waves'; // waves → boss
    this.bossKilled = false;

    const mesh = instance('iss');
    game.scene.add(mesh);
    this.iss = { set: game.catalog.iss, pos: new THREE.Vector3(), vel: new THREE.Vector3(), hp: ISS_HP, max: ISS_HP, alive: true, mesh, warned: 1, fireWarn: 0, bump: 0 };
    this.trackStation(game.orbitT);
    this.buildBoss();
  }

  buildBoss() {
    const group = new THREE.Group();
    group.scale.setScalar(BOSS_SCALE);
    group.visible = false;
    group.add(instance('starship'));
    const vel = new THREE.Vector3();
    const part = (kind, label, x, y, z, r, hp, model) => {
      const mesh = instance(model);
      mesh.position.set(x, y, z);
      group.add(mesh);
      return { kind, label, local: new THREE.Vector3(x, y, z), r: r * BOSS_SCALE, hp, max: hp, alive: true, open: kind === 'engine', pos: new THREE.Vector3(), vel, mesh };
    };
    const parts = [
      part('engine', 'ДВИГАТЕЛЬ 1', 0, 2.2, 26.5, 5, 12, 'starshipEngine'),
      part('engine', 'ДВИГАТЕЛЬ 2', 1.9, -1.1, 26.5, 5, 12, 'starshipEngine'),
      part('engine', 'ДВИГАТЕЛЬ 3', -1.9, -1.1, 26.5, 5, 12, 'starshipEngine'),
      part('bay', 'ГРУЗОВОЙ ОТСЕК', 0, 4.4, -4, 7, 30, 'starshipBay'),
    ];
    const door = instance('starshipDoor');
    door.position.set(0, 4.75, -4);
    group.add(door);
    this.game.scene.add(group);
    this.boss = {
      active: false, group, door, parts, bay: parts[3], vel,
      pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1),
      hull: HULL_Z.map(() => new THREE.Vector3()),
      bayTimer: 9, turretCd: 2, bump: 0, dying: 0, range: 0,
    };
  }

  // Положение и скорость станции на её настоящей орбите
  trackStation(orbitT) {
    const iss = this.iss;
    iss.set.update(orbitT);
    iss.set.position(0, iss.pos);
    iss.set.velocity(0, orbitT, iss.vel).multiplyScalar(TIME_SCALE);
    iss.mesh.position.copy(iss.pos);
    orient(iss.mesh, _a.copy(iss.vel).normalize(), _b.copy(iss.pos).normalize());
  }

  briefing() {
    const { catalog } = this.game, set = this.iss.set, pl = set.plane(0);
    const t = (Date.now() - catalog.epoch.getTime()) / 1000;
    set.update(t);
    const geo = subPoint(set.pos[0], set.pos[1], set.pos[2], gmstAt(catalog.epoch) + EARTH_RATE * t);
    return {
      text: 'К Международной космической станции идут захватчики. Отбейте три волны дронов: часть из них бьёт по станции, часть охотится за вами. Когда дроны кончатся, на стыковку пойдёт Starship-носитель.',
      facts: [
        ['Станция', set.names[0]],
        ['Наклонение', `${pl.inc.toFixed(1)}°`],
        ['Высота', `${Math.round(geo.alt)} км`],
        ['Сейчас над', formatLatLon(geo.lat, geo.lon)],
        ['Противник', '3 волны дронов, затем Starship'],
      ],
      hint: 'Корпус носителя бронирован: бейте по двигателям и по грузовому отсеку, пока его створки открыты. Если носитель дойдёт до станции, она захвачена.',
    };
  }

  // Старт в 1400 км позади станции и на 90 км выше: прямой курс проходит над ней, а не сквозь неё
  placePlayer(p) {
    const iss = this.iss;
    this.trackStation(this.game.orbitT);
    const along = _a.copy(iss.vel).normalize();
    p.pos.copy(iss.pos).addScaledVector(along, -1400).setLength(iss.pos.length() + 90);
    const up = _b.copy(p.pos).normalize();
    p.fwd.copy(along).addScaledVector(up, -along.dot(up)).normalize();
    return 'СТАНЦИЯ ВПЕРЕДИ. ЗАХВАТЧИКИ НА ПОДХОДЕ';
  }

  // ---------- ход миссии ----------

  update(dt) {
    const g = this.game, iss = this.iss, boss = this.boss;
    this.trackStation(g.orbitT);
    if (boss.active) this.moveBoss(dt);
    if (g.state !== 'play') return;

    // Столкновение игрока со станцией
    const p = g.player;
    iss.bump -= dt;
    iss.fireWarn -= dt;
    if (iss.alive && iss.bump <= 0 && p.pos.distanceTo(iss.pos) < ISS_RADIUS) {
      iss.bump = 1;
      p.pos.sub(iss.pos).setLength(ISS_RADIUS + 25).add(iss.pos);
      g.say('СТОЛКНОВЕНИЕ СО СТАНЦИЕЙ', COLORS.red);
      g.damagePlayer(20);
      this.hitStation(8);
    }

    if (this.phase === 'waves') {
      if (g.guardsAlive() + g.guardsPending > 0) return;
      this.waveDelay -= dt;
      if (this.waveDelay > 0) return;
      this.wavesCleared = this.wave;
      if (this.wave < WAVES.length) {
        this.spawnWave(WAVES[this.wave++]);
        this.waveDelay = 4;
      } else {
        this.phase = 'boss';
        this.spawnBoss();
      }
    } else {
      this.fightBoss(dt);
    }
  }

  spawnWave(wave) {
    const g = this.game;
    for (let k = 0; k < wave.station + wave.player; k++) {
      this.spawnDrone(this.approachPoint(2200 + Math.random() * 600, _c), k < wave.station);
    }
    g.say(`ВОЛНА ${this.wave} ИЗ ${WAVES.length}: ДРОНЫ НА ПОДХОДЕ`, COLORS.red);
    g.audio.alarm();
  }

  // Точка на расстоянии dist от станции в случайную сторону по горизонту
  approachPoint(dist, out) {
    const iss = this.iss;
    const up = _a.copy(iss.pos).normalize();
    const east = _b.copy(iss.vel).normalize();
    const north = _d.crossVectors(up, east);
    const ang = Math.random() * Math.PI * 2;
    return out.copy(iss.pos)
      .addScaledVector(east, Math.cos(ang) * dist)
      .addScaledVector(north, Math.sin(ang) * dist)
      .setLength(iss.pos.length() + (Math.random() - 0.5) * 160);
  }

  // Дрон идёт либо на станцию, либо на игрока. Если свободных нет, он придёт позже.
  spawnDrone(pos, onStation) {
    const g = this.game;
    if (!g.spawnGuard({ pos, prey: onStation ? this.iss : null })) g.guardsPending++;
  }

  hitStation(dmg, friendly = false) {
    const g = this.game, iss = this.iss;
    if (!iss.alive || g.state !== 'play') return;
    iss.hp -= dmg;
    _c.randomDirection().multiplyScalar(ISS_RADIUS * 0.6).add(iss.pos);
    g.spark(_c, 120, 0.5, 1.0, 0.75, 0.3, 5);
    if (friendly && iss.fireWarn <= 0) {
      iss.fireWarn = 2;
      g.say('ОГОНЬ ПО СТАНЦИИ', COLORS.gold);
      g.audio.alarm();
    }
    const frac = iss.hp / iss.max;
    for (const mark of [0.75, 0.5, 0.25]) {
      if (frac <= mark && iss.warned > mark) {
        iss.warned = mark;
        g.say(`МКС: ПРОЧНОСТЬ ${Math.round(mark * 100)}%`, COLORS.red);
        g.audio.alarm();
      }
    }
    if (iss.hp <= 0) {
      iss.hp = 0;
      iss.alive = false;
      iss.mesh.visible = false;
      for (let k = 0; k < 5; k++) g.explode(_c.randomDirection().multiplyScalar(ISS_RADIUS * 0.8).add(iss.pos), 1.6, 0xffb23e, k === 0);
      g.lose('МКС разрушена', false);
    }
  }

  // ---------- босс ----------

  spawnBoss() {
    const g = this.game, iss = this.iss, boss = this.boss;
    boss.pos.copy(iss.pos).addScaledVector(_a.copy(iss.vel).normalize(), BOSS_START).setLength(iss.pos.length() + 30);
    boss.fwd.subVectors(iss.pos, boss.pos).normalize();
    boss.active = true;
    boss.group.visible = true;
    this.moveBoss(0);
    g.say('STARSHIP-НОСИТЕЛЬ ИДЁТ НА СТЫКОВКУ', COLORS.red);
    g.say('БЕЙТЕ ПО ДВИГАТЕЛЯМ И ОТКРЫТОМУ ОТСЕКУ', COLORS.gold);
    g.audio.alarm();
  }

  enginesAlive() {
    let n = 0;
    for (const part of this.boss.parts) if (part.kind === 'engine' && part.alive) n++;
    return n;
  }

  // Носитель идёт к станции; скорость сближения зависит от числа целых двигателей
  moveBoss(dt) {
    const iss = this.iss, boss = this.boss;
    const toStation = _a.subVectors(iss.pos, boss.pos);
    boss.range = toStation.length();
    if (boss.dying <= 0) turnToward(boss.fwd, toStation.normalize(), 0.35 * dt);
    boss.vel.copy(iss.vel).addScaledVector(boss.fwd, boss.dying > 0 ? 0 : (BOSS_SPEED * this.enginesAlive()) / 3);
    boss.pos.addScaledVector(boss.vel, dt);
    boss.group.position.copy(boss.pos);
    orient(boss.group, boss.fwd, _b.copy(boss.pos).normalize());
    boss.group.updateMatrixWorld(true);
    for (const part of boss.parts) part.pos.copy(part.local).applyMatrix4(boss.group.matrixWorld);
    HULL_Z.forEach((z, k) => boss.hull[k].set(0, 0, z).applyMatrix4(boss.group.matrixWorld));
    boss.door.visible = boss.bay.alive && !boss.bay.open;

    // Гибель: серия взрывов вдоль корпуса, затем корпус исчезает
    if (boss.dying > 0) {
      boss.dying -= dt;
      if (Math.random() < dt * 9) {
        this.game.explode(_c.copy(boss.hull[Math.floor(Math.random() * boss.hull.length)]), 1.4, 0xff7050, Math.random() < 0.4);
      }
      if (boss.dying <= 0) {
        boss.active = false;
        boss.group.visible = false;
      }
    }
  }

  fightBoss(dt) {
    const g = this.game, p = g.player, boss = this.boss, bay = boss.bay;
    if (!boss.active || boss.dying > 0) return;

    if (boss.range < DOCK_RANGE) {
      g.say('НОСИТЕЛЬ ПРИСТЫКОВАЛСЯ', COLORS.red);
      return g.lose('МКС захвачена', false);
    }

    // Грузовой отсек: створки открываются, чтобы выпустить дронов, и в это время он уязвим.
    // Обездвиженный носитель держит створки открытыми и выпускает дронов по одному.
    const stalled = this.enginesAlive() === 0;
    boss.bayTimer -= dt;
    if (bay.alive && boss.bayTimer <= 0) {
      if (!bay.open || stalled) {
        if (!bay.open) g.say('СТВОРКИ ОТКРЫТЫ: ОТСЕК УЯЗВИМ', COLORS.gold);
        bay.open = true;
        boss.bayTimer = stalled ? 9 : 6;
        const room = 4 - (g.guardsAlive() + g.guardsPending);
        for (let k = 0; k < Math.min(stalled ? 1 : 2, room); k++) this.spawnDrone(bay.pos, k % 2 === 0);
      } else {
        bay.open = false;
        boss.bayTimer = 13;
      }
    }

    // Турели бьют по игроку, если он рядом
    boss.turretCd -= dt;
    const dist = boss.pos.distanceTo(p.pos);
    if (dist < 1100 && boss.turretCd <= 0 && g.bolts.length < MAX_SHOTS) {
      boss.turretCd = 1.1;
      const dir = _a.copy(p.pos).addScaledVector(p.vel, dist / BOLT_SPEED).sub(boss.pos).normalize();
      dir.x += (Math.random() - 0.5) * 0.06;
      dir.y += (Math.random() - 0.5) * 0.06;
      dir.z += (Math.random() - 0.5) * 0.06;
      dir.normalize();
      g.bolts.push({ pos: boss.pos.clone().addScaledVector(dir, 40), vel: dir.clone().multiplyScalar(BOLT_SPEED), life: BOLT_LIFE });
      if (dist < 800) g.audio.bolt();
    }

    // Столкновение игрока с корпусом
    boss.bump -= dt;
    if (boss.bump <= 0) {
      for (const c of boss.hull) {
        if (p.pos.distanceTo(c) < HULL_R * BOSS_SCALE + 4) {
          boss.bump = 0.8;
          p.pos.sub(c).setLength(HULL_R * BOSS_SCALE + 30).add(c);
          g.say('СТОЛКНОВЕНИЕ С НОСИТЕЛЕМ', COLORS.red);
          g.damagePlayer(25);
          break;
        }
      }
    }
  }

  damagePart(part, dmg) {
    const g = this.game, boss = this.boss;
    if (!part.alive || !part.open) return false;
    part.hp -= dmg;
    if (part.hp > 0) {
      g.spark(part.pos, 130, 0.45, 1.0, 0.6, 0.3, 8);
      g.audio.spark();
      return true;
    }
    part.hp = 0;
    part.alive = false;
    part.mesh.visible = false;
    if (g.player.lock && g.player.lock.part === part) g.player.lock = null;
    g.score += SCORE.bossPart;
    g.explode(part.pos, 1.5, 0xff7050);
    if (part.kind === 'bay') g.say('ГРУЗОВОЙ ОТСЕК УНИЧТОЖЕН: ДРОНОВ БОЛЬШЕ НЕ БУДЕТ', COLORS.gold);
    else if (this.enginesAlive() > 0) g.say(`${part.label} УНИЧТОЖЕН: НОСИТЕЛЬ ЗАМЕДЛИЛСЯ`, COLORS.gold);
    else {
      g.say('НОСИТЕЛЬ ОБЕЗДВИЖЕН', COLORS.gold);
      if (boss.bay.alive) {
        g.say('ДОБЕЙТЕ ГРУЗОВОЙ ОТСЕК', COLORS.gold);
        boss.bayTimer = 0;
      }
    }
    if (boss.parts.every((x) => !x.alive)) {
      boss.dying = 2.2;
      this.bossKilled = true;
      g.score += SCORE.boss;
      g.win();
    }
    return true;
  }

  // ---------- попадания ----------

  bulletHit(bul, step) {
    const g = this.game, iss = this.iss, boss = this.boss;
    if (iss.alive && segDist2(bul.pos, step, iss.pos) < ISS_RADIUS * ISS_RADIUS) {
      this.hitStation(1, true);
      return 2;
    }
    if (!boss.active || boss.dying > 0) return 0;
    // Первая сфера на пути снаряда: уязвимый узел или броня корпуса
    let best = Infinity, hit = null;
    for (const part of boss.parts) {
      if (!part.alive) continue;
      const t = segSphereT(bul.pos, step, part.pos, part.r);
      if (t < best) {
        best = t;
        hit = part;
      }
    }
    for (const c of boss.hull) {
      const t = segSphereT(bul.pos, step, c, HULL_R * BOSS_SCALE);
      if (t < best) {
        best = t;
        hit = null;
      }
    }
    if (best === Infinity) return 0;
    if (hit && this.damagePart(hit, 1)) return 1;
    g.spark(_c.copy(bul.pos).addScaledVector(step, best), 70, 0.25, 0.7, 0.75, 0.85, 3);
    return 2;
  }

  boltHit(bolt, step) {
    const iss = this.iss;
    if (!iss.alive || segDist2(bolt.pos, step, iss.pos) > ISS_RADIUS * ISS_RADIUS) return false;
    this.hitStation(3);
    return true;
  }

  lockCandidates(consider) {
    if (!this.boss.active || this.boss.dying > 0) return;
    for (const part of this.boss.parts) if (part.alive && part.open) consider({ part }, -0.06);
  }

  // Рядом со станцией щит восстанавливается быстрее, как и рядом с «Рассветом»
  updateComm(comm, p) {
    if (!this.iss.alive) return;
    const dist = this.iss.pos.distanceTo(p.pos);
    if (dist < comm.dist) {
      comm.dist = dist;
      comm.name = 'МКС';
    }
  }

  // ---------- приборы ----------

  status() {
    const big = this.phase === 'boss' ? 'БОСС' : this.wave ? `ВОЛНА ${this.wave}/${WAVES.length}` : 'ПОДХОД';
    return { title: 'МИССИЯ 02 · ЗАЩИТА МКС', big };
  }

  drawBars(hud) {
    const g = hud.g, iss = this.iss, boss = this.boss;
    const bw = 220, x = Math.round(hud.w / 2 - bw / 2), y = 20;
    hud.plate(x - 62, 10, bw + 124, boss.active ? 60 : 32);
    const frac = Math.max(0, iss.hp / iss.max);
    const color = frac < 0.3 ? COLORS.red : COLORS.gold;
    hud.text('МКС', x - 50, y + 10, color, 12);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.globalAlpha = 0.5;
    g.strokeRect(x + 0.5, y + 0.5, bw, 10);
    g.globalAlpha = 1;
    g.fillStyle = color;
    g.fillRect(x + 2, y + 2, (bw - 3) * frac, 7);
    hud.text(`${Math.ceil(frac * 100)}%`, x + bw + 10, y + 10, color, 12);
    if (!boss.active) return;

    // Узлы носителя: три двигателя и отсек (контур — пока створки закрыты)
    hud.text('STARSHIP', x - 50, y + 36, COLORS.red, 10);
    boss.parts.forEach((part, k) => {
      const px = x + 28 + k * 22, py = y + 27;
      g.strokeStyle = g.fillStyle = part.alive ? COLORS.red : 'rgba(255,77,94,.25)';
      g.strokeRect(px + 0.5, py + 0.5, 15, 9);
      if (part.alive && part.open) g.fillRect(px + 2, py + 2, 12, 6);
    });
    hud.text(`ДО СТЫКОВКИ ${Math.max(0, Math.round(boss.range - DOCK_RANGE))} км`, x + bw + 50, y + 36, COLORS.red, 10, 'right');
  }

  drawMarkers(hud) {
    const game = this.game, cam = game.camera, p = game.player, iss = this.iss, boss = this.boss;
    const playing = game.state === 'play';
    // Видимый размер объекта поперечником span километров, в пикселях экрана
    const sizeOf = (span, dist) => clamp(((span / dist) / Math.tan((cam.fov * Math.PI) / 360)) * (hud.h / 2), 14, 110);

    if (iss.alive) {
      const dist = iss.pos.distanceTo(p.pos);
      const s = hud.toScreen(iss.pos, cam);
      if (s.on && !hud.hidden(iss.pos, cam)) {
        const size = sizeOf(58, dist), x = s.x, y = s.y;
        hud.brackets(x, y, size, COLORS.gold, 2);
        hud.text(`МКС · ${Math.round(dist)} км`, x, y - size - 8, COLORS.gold, 11, 'center');
      } else if (playing) {
        hud.edgeArrow(s, COLORS.gold, `МКС ${Math.round(dist)} км`);
      }
    }

    if (boss.active && boss.dying <= 0) {
      const dist = boss.pos.distanceTo(p.pos);
      const s = hud.toScreen(boss.pos, cam);
      if (s.on && !hud.hidden(boss.pos, cam)) {
        const size = sizeOf(44, dist), x = s.x, y = s.y;
        hud.brackets(x, y, size, COLORS.red, 2);
        hud.text(`STARSHIP · ${Math.round(dist)} км`, x, y - size - 8, COLORS.red, 11, 'center');
        for (const part of boss.parts) {
          if (!part.alive) continue;
          const q = hud.toScreen(part.pos, cam);
          if (q.on) hud.diamond(q.x, q.y, part.kind === 'bay' ? 6 : 4, part.open ? COLORS.red : 'rgba(255,77,94,.4)', part.kind === 'bay' && part.open);
        }
      } else if (playing) {
        hud.edgeArrow(s, COLORS.red, `БОСС ${Math.round(dist)} км`);
      }
    }
  }

  radar(plot) {
    if (this.iss.alive) plot(this.iss.pos, COLORS.gold, 7, true);
    if (this.boss.active) plot(this.boss.pos, COLORS.red, 8, true);
  }

  resultFacts() {
    const iss = this.iss;
    return [
      ['Волны отбиты', `${this.phase === 'boss' ? WAVES.length : this.wavesCleared} из ${WAVES.length}`],
      ['Дронов сбито', this.game.stats.guards],
      ['Starship-носитель', this.bossKilled ? 'уничтожен' : 'не уничтожен'],
      ['Прочность МКС', `${Math.round((iss.hp / iss.max) * 100)}%`],
    ];
  }
}

export const MISSIONS = {
  intercept: { id: 'intercept', number: '01', name: 'Перехват', create: (game) => new Intercept(game) },
  defend: { id: 'defend', number: '02', name: 'Защита МКС', create: (game) => new Defend(game) },
};
