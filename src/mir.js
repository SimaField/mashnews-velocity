import * as THREE from 'three';
import { R_EARTH, EARTH_RATE, gmstAt, subPoint, formatLatLon } from './orbits.js';
import { instance } from './models.js';
import { Mission, firstHit } from './mission.js';
import { TIME_SCALE, BULLET_SPEED, BULLET_LIFE, MAX_SHOTS, COLORS, orient, turnToward } from './common.js';

// ---------- Миссия 04: оборона станции «Мир» ----------
// Игрок не летает, а сидит за спаренными пулемётами станции. Сама станция идёт
// по орбите, на неё волнами заходят дроны, космический хлам и ракеты с Земли.
// Помогают две автоматические турели и дроны-перехватчики, которых игрок запускает сам.

const MU = 398600.44; // гравитационный параметр Земли, км³/с²
const MIR_ALT = 390, MIR_INC = 51.6;
const WAVES = [
  { drones: 3, junk: 0, rockets: 0 },
  { drones: 2, junk: 4, rockets: 0 },
  { drones: 3, junk: 0, rockets: 3 },
  { drones: 2, junk: 5, rockets: 3 },
  { drones: 4, junk: 4, rockets: 4 },
];
// Хлам: летит на таран. hp — попаданий пулемёта, dmg — урон станции при ударе
const JUNK = [
  { kind: 'junk', model: 'saucer', name: 'НЛО', hp: 5, speed: 210, dmg: 30, r: 20, scale: 2.2, turn: 0.7 },
  { kind: 'junk', model: 'teapot', name: 'ЧАЙНИК РАССЕЛА', hp: 3, speed: 170, dmg: 22, r: 18, scale: 2.4, turn: 0.7, tumble: true },
  { kind: 'junk', model: 'roadster', name: 'РОДСТЕР', hp: 6, speed: 240, dmg: 36, r: 20, scale: 2.2, turn: 0.7 },
  { kind: 'junk', model: 'starlink', name: 'БЕШЕНЫЙ СПУТНИК', hp: 4, speed: 190, dmg: 26, r: 18, scale: 2, turn: 0.7, tumble: true, edge: COLORS.red },
];
const ROCKET = { kind: 'rocket', model: 'missile', name: 'РАКЕТА С ЗЕМЛИ', hp: 2, speed: 120, accel: 30, top: 320, dmg: 45, r: 16, scale: 6, turn: 1.2, edge: '#ff9a3c' };
const SCORE_FOR = { junk: 150, rocket: 200 };
// Автоматика помогает, но не воюет вместо игрока: стреляет реже него и с разбросом
const HELPERS = 3, HELPER_COST = 40, HELPER_LIFE = 18, HELPER_SPEED = 330, HELPER_RANGE = 650, HELPER_FIRE = 0.8;
const TURRET_RANGE = 600, TURRET_FIRE = 1.4, AUTO_SPREAD = 0.05;
const MISSILE_RELOAD = 5; // секунд на одну ракету
const ORANGE = '#ff9a3c';
const NO_HULL = [];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export class MirDefense extends Mission {
  constructor(game) {
    super(game);
    this.maxGuards = 6;
    this.guardName = 'ДРОН';
    this.winText = 'ВСЕ ВОЛНЫ ОТБИТЫ. СТАНЦИЯ ВЫСТОЯЛА';
    this.winTitle = 'Станция выстояла';
    this.wave = 0;
    this.cleared = 0;
    this.waveDelay = 5;
    this.reload = MISSILE_RELOAD;
    this.shiftWas = false;
    this.killed = { junk: 0, rocket: 0 };
    this.things = []; // хлам и ракеты: для захвата и попаданий это «узлы», как у боссов
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.pickOrbit();

    const scene = game.scene;
    this.gun = instance('mirGun');
    this.gun.scale.setScalar(2.2);
    scene.add(this.gun);
    this.turrets = [-1, 1].map((side) => {
      const mesh = instance('mirGun');
      mesh.scale.setScalar(1.5);
      scene.add(mesh);
      return { side, mesh, cd: Math.random(), aim: new THREE.Vector3(0, 0, -1), pos: new THREE.Vector3() };
    });
    this.helpers = [];
    for (let k = 0; k < HELPERS; k++) {
      const mesh = instance('guard', COLORS.gold);
      mesh.scale.setScalar(1.3);
      mesh.visible = false;
      scene.add(mesh);
      this.helpers.push({ mesh, alive: false, life: 0, cd: 0, pos: new THREE.Vector3(), fwd: new THREE.Vector3(), vel: new THREE.Vector3() });
    }
    this.track(game.orbitT);
  }

  // Настоящий «Мир» сведён с орбиты в 2001 году. Здесь он идёт в плоскости МКС
  // (наклонение у них одинаковое), но с другой стороны Земли и на своей высоте.
  pickOrbit() {
    const iss = this.game.catalog.iss;
    const inc = (MIR_INC * Math.PI) / 180;
    const e1 = iss ? new THREE.Vector3(-iss.e1[0], -iss.e1[1], -iss.e1[2]) : new THREE.Vector3(1, 0, 0);
    const e2 = iss ? new THREE.Vector3(-iss.e2[0], -iss.e2[1], -iss.e2[2]) : new THREE.Vector3(0, Math.sin(inc), -Math.cos(inc));
    const radius = R_EARTH + MIR_ALT;
    this.orbit = { e1, e2, radius, rate: Math.sqrt(MU / radius ** 3) };
  }

  track(orbitT) {
    const o = this.orbit, ang = o.rate * orbitT;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    this.pos.copy(o.e1).multiplyScalar(cs * o.radius).addScaledVector(o.e2, sn * o.radius);
    this.vel.copy(o.e2).multiplyScalar(cs).addScaledVector(o.e1, -sn).multiplyScalar(o.radius * o.rate * TIME_SCALE);
  }

  briefing() {
    const { catalog } = this.game;
    const t = (Date.now() - catalog.epoch.getTime()) / 1000;
    this.track(t);
    const geo = subPoint(this.pos.x, this.pos.y, this.pos.z, gmstAt(catalog.epoch) + EARTH_RATE * t);
    return {
      text: 'Вы за пулемётами станции «Мир». Лететь некуда: станция идёт по орбите, а на неё волнами заходят дроны, космический хлам и ракеты с Земли. Отбейте пять волн.',
      facts: [
        ['Наклонение', `${MIR_INC}°`],
        ['Высота', `${MIR_ALT} км`],
        ['Сейчас над', formatLatLon(geo.lat, geo.lon)],
        ['Волн', WAVES.length],
        ['Вооружение', 'пулемёты, ракеты, 2 турели, дроны'],
      ],
      hint: 'Shift или кнопка «Дрон» запускает перехватчик за 40 единиц заряда: он сам ищет цели. Турели стреляют без вас. Настоящий «Мир» свели с орбиты в 2001 году — здесь он вернулся.',
    };
  }

  placePlayer(p) {
    this.track(this.game.orbitT);
    p.pos.copy(this.pos);
    p.vel.copy(this.vel);
    const up = _a.copy(this.pos).normalize();
    p.fwd.copy(this.vel).normalize().addScaledVector(up, 0.12).normalize();
    return 'СТАНЦИЯ «МИР» НА ДЕЖУРСТВЕ. ЖДИТЕ ГОСТЕЙ';
  }

  threats() {
    return this.game.guardsAlive() + this.game.guardsPending + this.things.length;
  }

  // ---------- ход миссии ----------

  update(dt) {
    const g = this.game, p = g.player;
    this.track(g.orbitT);
    // Игрок и есть станция: её положение и скорость задаёт орбита
    p.pos.copy(this.pos);
    p.vel.copy(this.vel);
    const up = _a.copy(this.pos).normalize();
    const heading = _b.copy(this.vel).normalize();
    this.gun.position.copy(this.pos).addScaledVector(up, 12);
    orient(this.gun, p.fwd, up);
    this.gun.visible = g.shipMesh.visible;
    for (const t of this.turrets) {
      t.pos.copy(this.pos).addScaledVector(heading, t.side * 22).addScaledVector(up, -7);
      t.mesh.position.copy(t.pos);
      t.mesh.visible = g.shipMesh.visible;
    }

    this.moveThings(dt);
    this.moveHelpers(dt);
    this.aimTurrets(dt);
    if (g.state !== 'play') return;

    // Ракеты понемногу пополняются
    if (p.missiles < g.ship.missiles) {
      this.reload -= dt;
      if (this.reload <= 0) {
        this.reload = MISSILE_RELOAD;
        p.missiles++;
      }
    }

    // Запуск дрона: по нажатию, а не пока держат
    const held = g.input.down('ShiftLeft') || g.input.down('ShiftRight');
    if (held && !this.shiftWas) this.launchHelper();
    this.shiftWas = held;

    if (this.threats() > 0) return;
    this.waveDelay -= dt;
    if (this.waveDelay > 0) return;
    this.cleared = this.wave;
    if (this.wave >= WAVES.length) return g.win();
    this.spawnWave(WAVES[this.wave++]);
    // После последней волны победа засчитывается почти сразу, между волнами — передышка
    this.waveDelay = this.wave >= WAVES.length ? 1.5 : 5;
  }

  spawnWave(wave) {
    const g = this.game;
    for (let k = 0; k < wave.drones; k++) {
      if (!g.spawnGuard({ pos: this.approachPoint(2400 + Math.random() * 600, 200, _c) })) g.guardsPending++;
    }
    for (let k = 0; k < wave.junk; k++) {
      this.spawnThing(JUNK[Math.floor(Math.random() * JUNK.length)], this.approachPoint(2600 + Math.random() * 700, 500, _c));
    }
    for (let k = 0; k < wave.rockets; k++) this.spawnThing(ROCKET, this.launchSite(_c));
    g.say(`ВОЛНА ${this.wave} ИЗ ${WAVES.length}`, COLORS.red);
    if (wave.rockets) g.say(`ПУСК С ЗЕМЛИ: РАКЕТ ${wave.rockets}`, ORANGE);
    g.audio.alarm();
  }

  // Точка на расстоянии dist от станции в случайную сторону по горизонту, с разбросом по высоте
  approachPoint(dist, spread, out) {
    const up = _a.copy(this.pos).normalize();
    const east = _b.copy(this.vel).normalize();
    const north = _d.crossVectors(up, east);
    const ang = Math.random() * Math.PI * 2;
    return out.copy(this.pos)
      .addScaledVector(east, Math.cos(ang) * dist)
      .addScaledVector(north, Math.sin(ang) * dist)
      .setLength(Math.max(R_EARTH + 260, this.pos.length() + (Math.random() - 0.5) * spread));
  }

  // Место пуска ракеты: на поверхности в 1500–2300 км от точки под станцией.
  // Оттуда она идёт до станции секунд восемь: хватает, чтобы заметить и сбить.
  launchSite(out) {
    return this.approachPoint(1500 + Math.random() * 800, 0, out).setLength(R_EARTH + 25);
  }

  spawnThing(type, pos) {
    const g = this.game;
    const mesh = instance(type.model, type.edge);
    mesh.scale.setScalar(type.scale);
    g.scene.add(mesh);
    const label = type.model === 'starlink' ? `${type.name} ${g.sl.names[Math.floor(Math.random() * g.sl.count)]}` : type.name;
    this.things.push({
      type, kind: type.kind, owner: type.kind === 'rocket' ? 'ЗЕМЛЯ' : 'ХЛАМ', label, mesh,
      r: type.r, hp: type.hp, max: type.hp, alive: true, open: true, speed: type.speed,
      pos: new THREE.Vector3().copy(pos), vel: new THREE.Vector3(),
      dir: new THREE.Vector3().subVectors(this.pos, pos).normalize(),
    });
  }

  moveThings(dt) {
    const g = this.game, playing = g.state === 'play';
    for (let k = this.things.length - 1; k >= 0; k--) {
      const t = this.things[k], type = t.type;
      const toStation = _c.subVectors(this.pos, t.pos);
      const dist = toStation.length();
      turnToward(t.dir, toStation.normalize(), type.turn * dt);
      if (type.accel) t.speed = Math.min(type.top, t.speed + type.accel * dt);
      // Скорость станции прибавляется, чтобы цель не отставала от неё на орбите
      t.vel.copy(t.dir).multiplyScalar(t.speed).add(this.vel);
      t.pos.addScaledVector(t.vel, dt);
      t.mesh.position.copy(t.pos);
      if (type.tumble) t.mesh.rotation.set(g.clock * 2.1 + k, g.clock * 1.3, 0);
      else orient(t.mesh, t.dir, _d.copy(t.pos).normalize());
      if (type.kind === 'rocket') g.spark(t.pos, 45, 0.5, 1.0, 0.6, 0.2);
      if (playing && dist < g.ship.radius + t.r * 0.5) {
        g.say(`УДАР: ${t.label}`, COLORS.red);
        this.removeThing(t, 1.3);
        g.damagePlayer(type.dmg);
      }
    }
  }

  removeThing(t, boom) {
    const g = this.game;
    t.alive = false;
    g.scene.remove(t.mesh);
    this.things.splice(this.things.indexOf(t), 1);
    if (g.player.lock && g.player.lock.part === t) g.player.lock = null;
    if (boom) g.explode(t.pos, boom, t.kind === 'rocket' ? 0xffa040 : 0x9fe8ff);
  }

  damagePart(part, dmg) {
    const g = this.game;
    if (!part.alive) return false;
    part.hp -= dmg;
    if (part.hp > 0) {
      g.spark(part.pos, 110, 0.4, 1.0, 0.7, 0.4, 6);
      g.audio.spark();
      return true;
    }
    this.killed[part.kind]++;
    g.score += SCORE_FOR[part.kind];
    g.say(`СБИТО: ${part.label}  +${SCORE_FOR[part.kind]}`, COLORS.cyan);
    this.removeThing(part, 1);
    return true;
  }

  // ---------- свои: дроны-перехватчики и турели ----------

  // Ближайший противник к точке from не дальше range: дрон или хлам с ракетами.
  // Возвращает объект с pos и vel или null.
  nearestEnemy(from, range) {
    let best = null, bestD = range * range;
    for (const e of this.game.guards) {
      if (!e.alive) continue;
      const d = e.pos.distanceToSquared(from);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    for (const e of this.things) {
      const d = e.pos.distanceToSquared(from);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  // Направление выстрела автоматики со случайным отклонением
  scatter(dir) {
    const shot = _d.copy(dir);
    shot.x += (Math.random() - 0.5) * AUTO_SPREAD * 2;
    shot.y += (Math.random() - 0.5) * AUTO_SPREAD * 2;
    shot.z += (Math.random() - 0.5) * AUTO_SPREAD * 2;
    return shot.normalize();
  }

  // Снаряд своих: летит как пулемётный, но в точность игрока не засчитывается
  autoShot(from, dir, vel) {
    const g = this.game;
    if (g.bullets.length >= MAX_SHOTS) return;
    g.bullets.push({ pos: from.clone().addScaledVector(dir, 8), vel: dir.clone().multiplyScalar(BULLET_SPEED).add(vel), life: BULLET_LIFE, auto: true });
  }

  launchHelper() {
    const g = this.game, p = g.player;
    const h = this.helpers.find((x) => !x.alive);
    if (!h) return g.say('ВСЕ ДРОНЫ В ВОЗДУХЕ', COLORS.gold);
    if (p.fuel < HELPER_COST) return g.say('МАЛО ЗАРЯДА ДЛЯ ДРОНА', COLORS.gold);
    p.fuel -= HELPER_COST;
    h.alive = true;
    h.life = HELPER_LIFE;
    h.cd = 0.5;
    h.pos.copy(this.pos).addScaledVector(_a.copy(this.pos).normalize(), 30);
    h.fwd.copy(p.fwd);
    h.mesh.visible = true;
    g.say('ДРОН-ПЕРЕХВАТЧИК ЗАПУЩЕН', COLORS.gold);
    g.audio.missile();
  }

  activeHelpers() {
    return this.helpers.filter((h) => h.alive).length;
  }

  moveHelpers(dt) {
    const g = this.game, playing = g.state === 'play';
    for (const h of this.helpers) {
      if (!h.alive) continue;
      h.life -= dt;
      if (h.life <= 0) {
        h.alive = false;
        h.mesh.visible = false;
        continue;
      }
      const enemy = playing ? this.nearestEnemy(this.pos, 3000) : null;
      const up = _a.copy(h.pos).normalize();
      let want;
      if (enemy) {
        const dist = enemy.pos.distanceTo(h.pos);
        want = _c.copy(enemy.pos).addScaledVector(enemy.vel, dist / BULLET_SPEED).addScaledVector(h.vel, -dist / BULLET_SPEED).sub(h.pos).normalize();
        h.cd -= dt;
        if (h.cd <= 0 && dist < HELPER_RANGE && h.fwd.dot(want) > 0.985) {
          h.cd = HELPER_FIRE;
          this.autoShot(h.pos, this.scatter(want), h.vel);
        }
        // Вплотную не подходит: проскакивает мимо и заходит снова
        if (dist < 90) want = _c.crossVectors(want, up).normalize();
      } else {
        // Целей нет: кружит вокруг станции
        const out = _c.subVectors(h.pos, this.pos);
        const far = out.length() > 260;
        want = _d.crossVectors(up, out).normalize();
        if (far) want.addScaledVector(out.normalize(), -0.8).normalize();
      }
      turnToward(h.fwd, want, 1.7 * dt);
      h.vel.copy(h.fwd).multiplyScalar(HELPER_SPEED).add(this.vel);
      h.pos.addScaledVector(h.vel, dt);
      h.mesh.position.copy(h.pos);
      orient(h.mesh, h.fwd, up);
    }
  }

  aimTurrets(dt) {
    const g = this.game, playing = g.state === 'play';
    const up = _a.copy(this.pos).normalize();
    for (const t of this.turrets) {
      const enemy = playing ? this.nearestEnemy(t.pos, TURRET_RANGE) : null;
      if (enemy) {
        const dist = enemy.pos.distanceTo(t.pos);
        const lead = _c.copy(enemy.pos).addScaledVector(enemy.vel, dist / BULLET_SPEED).addScaledVector(this.vel, -dist / BULLET_SPEED).sub(t.pos).normalize();
        turnToward(t.aim, lead, 3 * dt);
        t.cd -= dt;
        if (t.cd <= 0 && t.aim.dot(lead) > 0.99) {
          t.cd = TURRET_FIRE;
          this.autoShot(t.pos, this.scatter(t.aim), this.vel);
        }
      }
      // Ствол не может смотреть ровно вдоль вертикали: иначе нечем задать, где у турели верх
      const tilt = t.aim.dot(up);
      if (Math.abs(tilt) > 0.95) t.aim.addScaledVector(up, Math.sign(tilt) * 0.95 - tilt).normalize();
      orient(t.mesh, t.aim, up);
    }
  }

  // ---------- попадания и захват ----------

  bulletHit(bul, step) {
    const hit = firstHit(bul.pos, step, this.things, NO_HULL, 0);
    return hit.part && this.damagePart(hit.part, 1) ? 1 : 0;
  }

  lockCandidates(consider) {
    for (const t of this.things) consider({ part: t }, t.kind === 'rocket' ? -0.05 : -0.03);
  }

  // ---------- приборы ----------

  status() {
    return { title: 'МИССИЯ 04 · СТАНЦИЯ «МИР»', big: this.wave ? `ВОЛНА ${this.wave}/${WAVES.length}` : 'ДЕЖУРСТВО' };
  }

  // На месте скорости у станции — сколько дронов в воздухе
  speedLine() {
    return { label: 'ДРОНЫ', value: `${this.activeHelpers()}/${HELPERS}` };
  }

  drawBars(hud) {
    const n = this.threats(), small = hud.compact;
    const w = small ? 150 : 210, x = Math.round(hud.w / 2 - w / 2), y = small ? 8 : 10;
    hud.plate(x, y, w, 30);
    if (n > 0) hud.text(`УГРОЗЫ: ${n}`, hud.w / 2, y + 20, COLORS.red, 12, 'center', 700);
    else if (this.wave >= WAVES.length) hud.text('ЧИСТО', hud.w / 2, y + 20, COLORS.green, 12, 'center', 700);
    else hud.text(`ВОЛНА ЧЕРЕЗ ${Math.max(1, Math.ceil(this.waveDelay))}`, hud.w / 2, y + 20, COLORS.gold, 12, 'center', 700);
  }

  drawMarkers(hud) {
    const game = this.game, cam = game.camera, p = game.player;
    const playing = game.state === 'play';
    let arrows = 0;
    for (const t of this.things) {
      const dist = t.pos.distanceTo(p.pos);
      const color = t.kind === 'rocket' ? ORANGE : COLORS.red;
      const s = hud.toScreen(t.pos, cam);
      if (s.on && !hud.hidden(t.pos, cam)) {
        const x = s.x, y = s.y;
        hud.brackets(x, y, 11, color);
        hud.text(`${Math.round(dist)}`, x, y + 24, color, 10, 'center');
      } else if (playing && arrows < 5) {
        arrows++;
        hud.edgeArrow(s, color, t.kind === 'rocket' ? `РАКЕТА ${Math.round(dist)}` : `${Math.round(dist)}`);
      }
    }
    for (const h of this.helpers) {
      if (!h.alive) continue;
      const s = hud.toScreen(h.pos, cam);
      if (s.on) hud.diamond(s.x, s.y, 5, COLORS.gold);
    }
  }

  radar(plot) {
    for (const t of this.things) plot(t.pos, t.kind === 'rocket' ? ORANGE : COLORS.red, 4, true);
    for (const h of this.helpers) if (h.alive) plot(h.pos, COLORS.gold, 3);
  }

  resultFacts() {
    const g = this.game, ship = g.ship, p = g.player;
    return [
      ['Волны отбиты', `${g.state === 'won' ? WAVES.length : this.cleared} из ${WAVES.length}`],
      ['Сбито дронов', g.stats.guards],
      ['Сбито хлама', this.killed.junk],
      ['Сбито ракет с Земли', this.killed.rocket],
      ['Корпус станции', `${Math.round((p.hull / ship.hull) * 100)}%`],
    ];
  }

  dispose() {
    for (const t of this.things) this.game.scene.remove(t.mesh);
  }
}
