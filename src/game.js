import * as THREE from 'three';
import { R_EARTH, EARTH_RATE, gmstAt, sunDirection } from './orbits.js';
import { createRetroEarth, createSky } from './earth.js';
import { SHIPS, instance, edgeMaterial } from './models.js';
import { MISSIONS } from './missions.js';
import {
  TIME_SCALE, BOLT_SPEED, BOLT_LIFE, MAX_SHOTS, COMM_RANGE, SCORE, COLORS,
  clamp, orient, turnToward, segDist2,
} from './common.js';

// Расстояния в километрах, скорости в км/с. Спутники стоят на настоящих
// орбитах в настоящем масштабе; аркадные допущения — скорость игрока
// (в десятки раз выше орбитальной) и размеры моделей.
const LOD_RANGE = 1150, LOD_MESHES = 48, NEAR_MAX = 256;
const BULLET_SPEED = 3000, BULLET_LIFE = 0.34, FIRE_RATE = 9, BULLET_HIT = 14;
const BOLT_HIT = 9, BOLT_DAMAGE = 5;
const MISSILE_SPEED = 850, MISSILE_LIFE = 7, MISSILE_TURN = 2.6, MISSILE_FUSE = 16;
const LOCK_RANGE = 3200, LOCK_CONE = 0.2, LOCK_KEEP = 0.38;
const ALT_BURN = 150, ALT_DEATH = 80, ALT_CEIL = 1800;
const GUARD_POOL = 8, MAX_PARTICLES = 640;

const PICKUPS = {
  shield: { color: 0x6dffa0, label: 'ЩИТ +40' },
  fuel: { color: 0xffe066, label: 'ТОПЛИВО +50' },
  missiles: { color: 0xff7ad9, label: 'РАКЕТЫ +4' },
};

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion(), _col = new THREE.Color();
const _mouse = { x: 0, y: 0 };

function shotLines(color) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SHOTS * 6), 3));
  geom.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  lines.frustumCulled = false;
  return lines;
}

export class Game {
  constructor({ renderer, hud, catalog, shipId, missionId, audio, input, onFinish }) {
    this.renderer = renderer;
    this.hud = hud;
    this.catalog = catalog;
    this.sl = catalog.starlink;
    this.rs = catalog.rassvet;
    this.ship = SHIPS[shipId];
    this.audio = audio;
    this.input = input;
    this.onFinish = onFinish;

    this.state = 'briefing'; // briefing → play → won | lost
    this.t = 0; // время миссии
    this.clock = 0; // время сцены, идёт и после конца миссии
    this.simT0 = 0;
    this.orbitT = 0;
    this.score = 0;
    this.stats = { kills: 0, guards: 0, shots: 0, hits: 0, friendly: 0, targets: 0 };
    this.messages = [];
    this.warning = '';
    this.damageFlash = 0;
    this.shake = 0;
    this.cockpit = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x02040a);
    this.camera = new THREE.PerspectiveCamera(70, 1, 1, 90000);
    this.camFwd = new THREE.Vector3(0, 0, -1);

    this.sun = sunDirection(catalog.epoch);
    this.scene.add(new THREE.AmbientLight(0x9fb8e8, 1.1));
    const sunLight = new THREE.DirectionalLight(0xfff2dc, 2.4);
    sunLight.position.copy(this.sun);
    this.scene.add(sunLight);

    this.earth = createRetroEarth();
    this.earth.uniforms.uSun.value.copy(this.sun);
    this.scene.add(this.earth.group, this.earth.air);
    this.sky = createSky(this.sun);
    this.scene.add(this.sky);

    this.buildSatellites();
    this.buildPlayer();
    this.buildPools();
    this.mission = MISSIONS[missionId].create(this);
  }

  // ---------- построение сцены ----------

  buildSatellites() {
    const { sl, rs } = this;
    this.targets = []; // аппараты, отмеченные миссией как цели
    this.isTarget = new Uint8Array(sl.count);
    this.satHp = new Map();
    this.rsHp = new Map();

    const geom = new THREE.BufferGeometry();
    this.slPosAttr = new THREE.BufferAttribute(sl.pos, 3);
    this.slColAttr = new THREE.BufferAttribute(new Float32Array(sl.count * 3), 3);
    geom.setAttribute('position', this.slPosAttr);
    geom.setAttribute('color', this.slColAttr);
    this.slPoints = new THREE.Points(geom, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }));
    this.slPoints.frustumCulled = false;
    this.scene.add(this.slPoints);
    this.paintTargets();

    this.targetEdge = edgeMaterial('#7dfcff');
    this.otherEdge = edgeMaterial('#3d7fd9');
    this.slMeshes = [];
    for (let k = 0; k < LOD_MESHES; k++) {
      const mesh = instance('starlink');
      mesh.visible = false;
      this.slMeshes.push(mesh);
      this.scene.add(mesh);
    }
    this.nearIdx = new Int32Array(NEAR_MAX);
    this.nearD2 = new Float32Array(NEAR_MAX);
    this.nearCount = 0;
    this.nearOrder = [];

    this.rsMeshes = [];
    for (let i = 0; i < rs.count; i++) {
      const mesh = instance('rassvet');
      mesh.scale.setScalar(1.4);
      this.rsMeshes.push(mesh);
      this.scene.add(mesh);
    }
    this.comm = { name: '', dist: Infinity }; // ближайший «свой», от которого идёт связь
  }

  // Цели на общем облаке точек ярче остальных
  paintTargets() {
    const col = this.slColAttr.array;
    for (let i = 0; i < this.sl.count; i++) {
      const t = this.isTarget[i];
      col[i * 3] = t ? 0.55 : 0.3;
      col[i * 3 + 1] = t ? 1.0 : 0.42;
      col[i * 3 + 2] = t ? 1.0 : 0.62;
    }
    this.slColAttr.needsUpdate = true;
  }

  buildPlayer() {
    const ship = this.ship;
    this.player = {
      pos: new THREE.Vector3(R_EARTH + 550, 0, 0),
      fwd: new THREE.Vector3(0, 0, -1),
      vel: new THREE.Vector3(),
      speed: ship.cruise,
      yawRate: 0, pitchRate: 0, bank: 0,
      shield: ship.shield, hull: ship.hull, fuel: ship.fuel, missiles: ship.missiles,
      boosting: false,
      fireCd: 0, missileCd: 0, gunSide: 1,
      sinceHit: 99,
      lock: null,
      alt: 550,
    };
    this.shipMesh = instance(ship.id);
    this.scene.add(this.shipMesh);
    this.flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.flames = ship.engines.map((e) => {
      // Конус основанием у сопла, вершиной назад (+Z); длина меняется масштабом по Z
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1, 5).rotateX(Math.PI / 2).translate(0, 0, 0.5), this.flameMat);
      flame.position.set(e[0], e[1], e[2]);
      this.shipMesh.add(flame);
      return flame;
    });
  }

  buildPools() {
    this.bullets = [];
    this.bolts = [];
    this.bulletLines = shotLines(0xfff3a0);
    this.boltLines = shotLines(0xff5060);
    this.scene.add(this.bulletLines, this.boltLines);

    this.guards = [];
    for (let k = 0; k < GUARD_POOL; k++) {
      const mesh = instance('guard');
      mesh.scale.setScalar(1.6);
      mesh.visible = false;
      this.scene.add(mesh);
      this.guards.push({ mesh, alive: false, pos: new THREE.Vector3(), fwd: new THREE.Vector3(), vel: new THREE.Vector3(), breakDir: new THREE.Vector3(), speed: 0, hp: 0, cd: 0, mode: 'attack', timer: 0, prey: null });
    }
    this.guardsPending = 0;

    this.missiles = [];
    for (let k = 0; k < 8; k++) {
      const mesh = instance('missile');
      mesh.scale.setScalar(1.8);
      mesh.visible = false;
      this.scene.add(mesh);
      this.missiles.push({ mesh, alive: false, pos: new THREE.Vector3(), dir: new THREE.Vector3(), target: null, life: 0 });
    }

    this.flashes = [];
    const flashGeom = new THREE.IcosahedronGeometry(1, 1);
    for (let k = 0; k < 14; k++) {
      const mesh = new THREE.Mesh(flashGeom, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      mesh.visible = false;
      this.scene.add(mesh);
      this.flashes.push({ mesh, t: 0, dur: 0, size: 0 });
    }
    this.flashNext = 0;

    const pGeom = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pVel = new Float32Array(MAX_PARTICLES * 3);
    this.pLife = new Float32Array(MAX_PARTICLES);
    this.pNext = 0;
    pGeom.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pGeom.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.particles = new THREE.Points(pGeom, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    this.pickups = [];
    const pickGeom = new THREE.OctahedronGeometry(5);
    for (let k = 0; k < 10; k++) {
      const mesh = new THREE.Mesh(pickGeom, new THREE.MeshBasicMaterial({ wireframe: true }));
      mesh.visible = false;
      this.scene.add(mesh);
      this.pickups.push({ mesh, alive: false, type: 'shield', life: 0, pos: mesh.position });
    }

    // Пыль вокруг камеры: без неё в пустоте не чувствуется скорость
    this.dustPos = new Float32Array(320 * 3);
    for (let i = 0; i < this.dustPos.length; i++) this.dustPos[i] = (Math.random() - 0.5) * 800;
    const dGeom = new THREE.BufferGeometry();
    dGeom.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    this.dust = new THREE.Points(dGeom, new THREE.PointsMaterial({ color: 0x8fa6c8, size: 1, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false }));
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  // ---------- запуск ----------

  start() {
    const { sl, rs, player: p } = this;
    this.simT0 = (Date.now() - this.catalog.epoch.getTime()) / 1000;
    this.orbitT = this.simT0;
    sl.update(this.orbitT);
    rs.update(this.orbitT);

    const hello = this.mission.placePlayer(p);
    this.camFwd.copy(p.fwd);
    this.state = 'play';
    this.endTimer = 0;
    this.say(hello, COLORS.cyan);
    this.update(0);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Сцена рисуется в размер окна, без уменьшения под «крупный пиксель»
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
  }

  say(text, color = COLORS.cyan) {
    this.messages.push({ text, color, t: 0 });
    if (this.messages.length > 5) this.messages.shift();
  }

  // ---------- цель захвата: перехватчик, узел босса или спутник ----------

  targetAlive(t) {
    if (t.guard) return t.guard.alive;
    if (t.part) return t.part.alive && t.part.open;
    return this.sl.alive[t.sat] === 1;
  }

  targetPos(t, out) {
    if (t.guard) return out.copy(t.guard.pos);
    if (t.part) return out.copy(t.part.pos);
    return this.sl.position(t.sat, out);
  }

  targetVel(t, out) {
    if (t.guard) return out.copy(t.guard.vel);
    if (t.part) return out.copy(t.part.vel);
    return this.sl.velocity(t.sat, this.orbitT, out).multiplyScalar(TIME_SCALE);
  }

  damageTarget(t, dmg) {
    if (t.guard) this.damageGuard(t.guard, dmg);
    else if (t.part) this.mission.damagePart(t.part, dmg);
    else this.damageSat(t.sat, dmg);
  }

  // ---------- игрок ----------

  updatePlayer(dt) {
    const p = this.player, inp = this.input, ship = this.ship;
    let yawIn = 0, pitchIn = 0;
    if (inp.down('ArrowLeft') || inp.down('KeyA')) yawIn += 1;
    if (inp.down('ArrowRight') || inp.down('KeyD')) yawIn -= 1;
    if (inp.down('ArrowUp') || inp.down('KeyW')) pitchIn += 1;
    if (inp.down('ArrowDown') || inp.down('KeyS')) pitchIn -= 1;
    // Экранный джойстик: вправо — поворот вправо, вверх — нос вверх
    yawIn = clamp(yawIn - inp.stick.x, -1, 1);
    pitchIn = clamp(pitchIn - inp.stick.y, -1, 1);
    const ease = Math.min(1, dt * 8);
    p.yawRate += (yawIn * ship.turn - p.yawRate) * ease;
    p.pitchRate += (pitchIn * ship.turn * 0.85 - p.pitchRate) * ease;
    const mouse = inp.takeMouse(_mouse);
    const maxStep = ship.turn * 2.4 * dt;
    const dyaw = clamp(p.yawRate * dt - mouse.x * 0.0022, -maxStep, maxStep);
    const dpitch = clamp(p.pitchRate * dt - mouse.y * 0.0022, -maxStep, maxStep);
    if (dt > 0) p.bank += (clamp((dyaw / dt) * 0.55, -1.1, 1.1) - p.bank) * Math.min(1, dt * 5);

    // Рыскание вокруг местной вертикали, тангаж относительно местного горизонта
    const up = _a.copy(p.pos).normalize();
    p.fwd.applyAxisAngle(up, dyaw);
    const right = _b.crossVectors(p.fwd, up).normalize();
    const pitch = Math.asin(clamp(p.fwd.dot(up), -1, 1));
    p.fwd.applyAxisAngle(right, clamp(pitch + dpitch, -1.2, 1.2) - pitch).normalize();

    // Скорость постоянная, меняет её только форсаж
    const wantBoost = inp.down('ShiftLeft') || inp.down('ShiftRight');
    p.boosting = wantBoost && (p.boosting ? p.fuel > 0 : p.fuel > 6);
    if (p.boosting) p.fuel = Math.max(0, p.fuel - ship.burn * dt);
    else p.fuel = Math.min(ship.fuel, p.fuel + 2.5 * dt);
    const want = p.boosting ? ship.boost : ship.cruise;
    p.speed += (want - p.speed) * Math.min(1, dt * (p.boosting ? 2.6 : 1.6));

    this.movePlayer(dt);

    // Высота: внизу атмосфера, наверху корабль сам заворачивает обратно
    this.warning = '';
    if (p.alt < ALT_BURN + 90) this.warning = 'АТМОСФЕРА! НАБЕРИТЕ ВЫСОТУ';
    if (p.alt < ALT_BURN) this.damagePlayer(((ALT_BURN - p.alt) / (ALT_BURN - ALT_DEATH)) * 70 * dt + 6 * dt, true);
    if (p.alt < ALT_DEATH) return this.lose('Аппарат сгорел в атмосфере');
    if (p.alt > ALT_CEIL) {
      this.warning = 'ВЫ ПОКИДАЕТЕ ЗОНУ БОЯ';
      const up2 = _a.copy(p.pos).normalize();
      // Чем выше потолка, тем сильнее автоматика опускает нос: пересилить её нельзя
      const push = 0.9 + (p.alt - ALT_CEIL) / 200;
      if (p.fwd.dot(up2) > -0.3) p.fwd.applyAxisAngle(_b.crossVectors(p.fwd, up2).normalize(), -push * dt).normalize();
    }

    p.sinceHit += dt;
    const linked = this.comm.dist < COMM_RANGE;
    if (p.sinceHit > 3 && p.shield < ship.shield) p.shield = Math.min(ship.shield, p.shield + (linked ? 14 : 6) * dt);

    // Оружие
    p.fireCd -= dt;
    p.missileCd -= dt;
    if ((inp.down('Space') || inp.mouseDown(0)) && p.fireCd <= 0) {
      this.fireCannon();
      p.fireCd = 1 / FIRE_RATE;
    }
    if ((inp.pressed('KeyF') || inp.mousePressed(2)) && p.missileCd <= 0) this.fireMissile();
    if (inp.pressed('KeyV')) this.cockpit = !this.cockpit;
  }

  // Движение вперёд с удержанием горизонта: при прямолинейном полёте нос
  // следует за кривизной Земли, как над рельефом
  movePlayer(dt) {
    const p = this.player;
    const up = _a.copy(p.pos).normalize();
    p.vel.copy(p.fwd).multiplyScalar(p.speed);
    p.pos.addScaledVector(p.vel, dt);
    const up2 = _b.copy(p.pos).normalize();
    p.fwd.applyQuaternion(_q.setFromUnitVectors(up, up2)).normalize();
    p.alt = p.pos.length() - R_EARTH;
  }

  damagePlayer(dmg, quiet = false) {
    if (this.state !== 'play') return;
    const p = this.player;
    p.sinceHit = 0;
    p.shield -= dmg;
    if (p.shield < 0) {
      p.hull += p.shield;
      p.shield = 0;
    }
    if (!quiet) {
      this.damageFlash = 1;
      this.shake = Math.min(1.5, this.shake + 0.6);
      this.audio.hit();
    } else {
      this.damageFlash = Math.max(this.damageFlash, 0.35);
      this.shake = Math.max(this.shake, 0.25);
    }
    if (p.hull <= 0) {
      p.hull = 0;
      // «Тихий» урон бывает только от нагрева в атмосфере
      this.lose(quiet ? 'Аппарат сгорел в атмосфере' : 'Аппарат уничтожен');
    }
  }

  // ---------- захват цели ----------

  updateLock() {
    const p = this.player, inp = this.input;
    const cands = this._cands ?? (this._cands = []);
    cands.length = 0;
    const consider = (t, bias) => {
      this.targetPos(t, _a).sub(p.pos);
      const dist = _a.length();
      if (dist > LOCK_RANGE || dist < 1) return;
      const ang = Math.acos(clamp(_a.dot(p.fwd) / dist, -1, 1));
      if (ang < 0.5) cands.push({ t, ang, key: ang + bias });
    };
    for (const g of this.guards) if (g.alive) consider({ guard: g }, -0.05);
    for (const i of this.targets) if (this.sl.alive[i]) consider({ sat: i }, -0.03);
    for (let k = 0; k < this.nearCount; k++) {
      const i = this.nearIdx[k];
      if (!this.isTarget[i]) consider({ sat: i }, 0);
    }
    this.mission.lockCandidates(consider);
    cands.sort((x, y) => x.key - y.key);
    const same = (x, y) => x && y && x.guard === y.guard && x.sat === y.sat && x.part === y.part;

    if (inp.pressed('Tab') || inp.pressed('KeyT')) {
      const k = cands.findIndex((c) => same(c.t, p.lock));
      const next = cands[(k + 1) % Math.max(1, cands.length)];
      if (next) {
        p.lock = next.t;
        this.audio.lock();
      }
      return;
    }
    if (p.lock) {
      const cur = cands.find((c) => same(c.t, p.lock));
      if (cur && cur.ang < LOCK_KEEP && this.targetAlive(p.lock)) return;
      p.lock = null;
    }
    const best = cands[0];
    if (best && best.ang < LOCK_CONE) {
      p.lock = best.t;
      this.audio.lock();
    }
  }

  // ---------- оружие ----------

  fireCannon() {
    const p = this.player;
    const up = _a.copy(p.pos).normalize();
    const right = _b.crossVectors(p.fwd, up).normalize();
    const muzzle = new THREE.Vector3().copy(p.pos).addScaledVector(right, p.gunSide * 1.3).addScaledVector(p.fwd, 3);
    p.gunSide = -p.gunSide;
    const dir = new THREE.Vector3().copy(p.fwd);
    // Доводка: если цель близко к перекрестью, снаряд идёт в упреждённую точку
    if (p.lock && this.targetAlive(p.lock)) {
      const tp = this.targetPos(p.lock, _c);
      const tv = this.targetVel(p.lock, _d).sub(p.vel);
      const time = tp.distanceTo(muzzle) / BULLET_SPEED;
      tp.addScaledVector(tv, time).sub(muzzle).normalize();
      if (tp.angleTo(p.fwd) < (p.lock.sat === undefined ? 0.1 : 0.07)) dir.copy(tp);
    }
    const vel = dir.multiplyScalar(BULLET_SPEED).add(p.vel);
    if (this.bullets.length < MAX_SHOTS) this.bullets.push({ pos: muzzle, vel, life: BULLET_LIFE });
    this.stats.shots++;
    this.audio.shot();
  }

  fireMissile() {
    const p = this.player;
    const m = this.missiles.find((x) => !x.alive);
    if (!m) return;
    if (p.missiles <= 0) {
      this.say('РАКЕТ НЕТ', COLORS.red);
      p.missileCd = 0.5;
      return;
    }
    p.missiles--;
    p.missileCd = 0.45;
    m.alive = true;
    m.life = MISSILE_LIFE;
    m.target = p.lock && this.targetAlive(p.lock) ? p.lock : null;
    m.pos.copy(p.pos).addScaledVector(_a.copy(p.pos).normalize(), -1.6);
    m.dir.copy(p.fwd);
    m.mesh.visible = true;
    this.audio.missile();
  }

  updateBullets(dt) {
    const p = this.player, { sl, rs } = this;
    for (let b = this.bullets.length - 1; b >= 0; b--) {
      const bul = this.bullets[b];
      const step = _d.copy(bul.vel).multiplyScalar(dt);
      let hit = false, spent = false;
      for (const g of this.guards) {
        if (g.alive && segDist2(bul.pos, step, g.pos) < 18 * 18) {
          this.damageGuard(g, 1);
          hit = true;
          break;
        }
      }
      for (let k = 0; !hit && k < this.nearCount; k++) {
        const i = this.nearIdx[k];
        if (sl.alive[i] && segDist2(bul.pos, step, sl.position(i, _c)) < BULLET_HIT * BULLET_HIT) {
          this.damageSat(i, 1);
          hit = true;
        }
      }
      for (let i = 0; !hit && i < rs.count; i++) {
        if (rs.alive[i] && segDist2(bul.pos, step, rs.position(i, _c)) < 12 * 12) {
          this.damageFriendly(i);
          hit = true;
        }
      }
      if (!hit) {
        const res = this.mission.bulletHit(bul, step);
        hit = res === 1;
        spent = res === 2;
      }
      bul.pos.add(step);
      bul.life -= dt;
      if (hit) this.stats.hits++;
      if (hit || spent || bul.life <= 0) this.bullets.splice(b, 1);
    }

    for (let b = this.bolts.length - 1; b >= 0; b--) {
      const bolt = this.bolts[b];
      // В системе отсчёта игрока: он сам за кадр успевает сместиться
      const rel = _d.copy(bolt.vel).sub(p.vel).multiplyScalar(dt);
      let hit = this.state === 'play' && segDist2(bolt.pos, rel, p.pos) < BOLT_HIT * BOLT_HIT;
      if (hit) this.damagePlayer(BOLT_DAMAGE);
      else hit = this.mission.boltHit(bolt, _d.copy(bolt.vel).multiplyScalar(dt));
      bolt.pos.addScaledVector(bolt.vel, dt);
      bolt.life -= dt;
      if (hit || bolt.life <= 0) this.bolts.splice(b, 1);
    }

    this.writeShots(this.bulletLines, this.bullets, 45 / BULLET_SPEED);
    this.writeShots(this.boltLines, this.bolts, 40 / BOLT_SPEED);
  }

  writeShots(lines, shots, tail) {
    const arr = lines.geometry.attributes.position.array;
    const n = Math.min(shots.length, MAX_SHOTS);
    for (let k = 0; k < n; k++) {
      const s = shots[k];
      arr[k * 6] = s.pos.x;
      arr[k * 6 + 1] = s.pos.y;
      arr[k * 6 + 2] = s.pos.z;
      arr[k * 6 + 3] = s.pos.x - s.vel.x * tail;
      arr[k * 6 + 4] = s.pos.y - s.vel.y * tail;
      arr[k * 6 + 5] = s.pos.z - s.vel.z * tail;
    }
    lines.geometry.setDrawRange(0, n * 2);
    lines.geometry.attributes.position.needsUpdate = true;
  }

  updateMissiles(dt) {
    for (const m of this.missiles) {
      if (!m.alive) continue;
      m.life -= dt;
      let boom = m.life <= 0;
      if (m.target && this.targetAlive(m.target)) {
        const tp = this.targetPos(m.target, _c);
        const dist = tp.distanceTo(m.pos);
        if (dist < MISSILE_FUSE + MISSILE_SPEED * dt) {
          this.damageTarget(m.target, 9);
          this.stats.hits++;
          boom = true;
        } else {
          tp.addScaledVector(this.targetVel(m.target, _d), dist / MISSILE_SPEED).sub(m.pos).normalize();
          turnToward(m.dir, tp, MISSILE_TURN * dt);
        }
      }
      m.pos.addScaledVector(m.dir, MISSILE_SPEED * dt);
      if (m.pos.length() < R_EARTH + 60) boom = true;
      if (boom) {
        m.alive = false;
        m.mesh.visible = false;
        this.explode(m.pos, 0.5, 0xffc070, false);
        continue;
      }
      m.mesh.position.copy(m.pos);
      orient(m.mesh, m.dir, _a.copy(m.pos).normalize());
      this.spark(m.pos, 30, 0.35, 1.0, 0.6, 0.2);
    }
  }

  // ---------- урон по целям ----------

  damageSat(i, dmg) {
    const hp = (this.satHp.get(i) ?? 2) - dmg;
    if (hp > 0) {
      this.satHp.set(i, hp);
      this.spark(this.sl.position(i, _c), 90, 0.4, 0.6, 0.95, 1.0, 6);
      this.audio.spark();
      return;
    }
    this.killSat(i);
  }

  killSat(i, rammed = false) {
    const { sl, player: p } = this;
    const pos = sl.position(i, new THREE.Vector3());
    sl.alive[i] = 0;
    this.stats.kills++;
    if (p.lock && p.lock.sat === i) p.lock = null;
    this.explode(pos, 1, 0x9fe8ff);
    this.mission.onSatKilled(i, pos, rammed);
  }

  damageFriendly(i) {
    const { rs } = this;
    const hp = (this.rsHp.get(i) ?? 3) - 1;
    const pos = rs.position(i, new THREE.Vector3());
    if (hp > 0) {
      this.rsHp.set(i, hp);
      this.spark(pos, 90, 0.4, 1.0, 0.7, 0.2, 6);
      this.say(`ОГОНЬ ПО СВОИМ: ${rs.names[i]}`, COLORS.gold);
      this.audio.alarm();
      return;
    }
    rs.alive[i] = 0;
    this.rsMeshes[i].visible = false;
    this.stats.friendly++;
    this.score += SCORE.friendly;
    this.explode(pos, 1, 0xffb23e);
    this.say(`ПОТЕРЯН СВОЙ АППАРАТ: ${rs.names[i]}  ${SCORE.friendly}`, COLORS.red);
  }

  damageGuard(g, dmg) {
    g.hp -= dmg;
    if (g.hp > 0) {
      this.spark(g.pos, 110, 0.4, 1.0, 0.5, 0.4, 6);
      this.audio.spark();
      return;
    }
    g.alive = false;
    g.mesh.visible = false;
    if (this.player.lock && this.player.lock.guard === g) this.player.lock = null;
    this.stats.guards++;
    this.score += SCORE.guard;
    this.explode(g.pos, 1.2, 0xff7050);
    this.say(`${this.mission.guardName} СБИТ  +${SCORE.guard}`, COLORS.red);
    if (Math.random() < 0.5) this.dropPickup(g.pos);
    this.mission.onGuardKilled(g);
  }

  // ---------- перехватчики ----------

  guardsAlive() {
    let n = 0;
    for (const g of this.guards) if (g.alive) n++;
    return n;
  }

  // Перехватчик появляется в точке pos или, если она не задана, впереди по курсу игрока.
  // prey — за кем он охотится (объект с pos, vel и alive); по умолчанию за игроком.
  spawnGuard({ pos = null, prey = null } = {}) {
    const g = this.guards.find((x) => !x.alive);
    if (!g) return false;
    const p = this.player;
    if (pos) {
      g.pos.copy(pos);
    } else {
      const up = _a.copy(p.pos).normalize();
      const right = _b.crossVectors(p.fwd, up).normalize();
      g.pos.copy(p.pos)
        .addScaledVector(p.fwd, 1500 + Math.random() * 500)
        .addScaledVector(right, (Math.random() - 0.5) * 1600);
      g.pos.setLength(clamp(p.pos.length() + (Math.random() - 0.5) * 200, R_EARTH + 320, R_EARTH + 1200));
    }
    g.prey = prey;
    g.fwd.subVectors((prey ?? p).pos, g.pos).normalize();
    g.vel.set(0, 0, 0);
    g.speed = 260;
    g.hp = 4;
    g.cd = 1 + Math.random();
    g.mode = 'attack';
    g.alive = true;
    g.mesh.visible = true;
    return true;
  }

  updateGuards(dt) {
    const p = this.player;
    if (this.state === 'play') {
      let alive = this.guardsAlive();
      while (this.guardsPending > 0 && alive < this.mission.maxGuards && this.spawnGuard()) {
        this.guardsPending--;
        alive++;
      }
    }

    for (const g of this.guards) {
      if (!g.alive) continue;
      const prey = g.prey && g.prey.alive ? g.prey : p; // добыча погибла — остаётся игрок
      const toPrey = _a.subVectors(prey.pos, g.pos);
      const dist = toPrey.length();
      const toPlayer = g.pos.distanceTo(p.pos);
      if (dist > 7000) {
        // Отстал: вернётся со следующей волной
        g.alive = false;
        g.mesh.visible = false;
        this.guardsPending++;
        continue;
      }
      const closing = (g.vel.dot(toPrey) - prey.vel.dot(toPrey)) / dist; // скорость сближения
      const up = _c.copy(g.pos).normalize();
      const aim = _b.copy(prey.pos).addScaledVector(prey.vel, dist / BOLT_SPEED).sub(g.pos).normalize();
      const want = _d.copy(aim);
      const tooClose = prey === p ? 160 : 280; // крупную добычу облетает по большему радиусу
      if (g.mode === 'attack') {
        // Отворачивает за секунду до столкновения, иначе на встречных курсах таранит
        if (dist < tooClose || dist < closing || this.state !== 'play') {
          g.mode = 'break';
          g.timer = 1.4 + Math.random();
          g.breakDir.crossVectors(aim, up).multiplyScalar(Math.random() < 0.5 ? 1 : -1).addScaledVector(up, 0.3).normalize();
        }
      } else {
        want.copy(g.breakDir);
        g.timer -= dt;
        if (g.timer <= 0 && this.state === 'play') g.mode = 'attack';
      }
      const alt = g.pos.length() - R_EARTH;
      if (alt < 300) want.addScaledVector(up, 0.9).normalize();
      else if (alt > 1400) want.addScaledVector(up, -0.9).normalize();
      turnToward(g.fwd, want, 1.25 * dt);

      const wantSpeed = g.mode === 'attack' ? clamp(dist * 0.5, 170, 340) : 330;
      g.speed += (wantSpeed - g.speed) * Math.min(1, dt * 2);
      g.vel.copy(g.fwd).multiplyScalar(g.speed);
      g.pos.addScaledVector(g.vel, dt);

      g.cd -= dt;
      if (g.mode === 'attack' && dist < 950 && g.cd <= 0 && g.fwd.dot(aim) > 0.985) {
        g.cd = 1.2 + Math.random() * 0.8;
        const dir = new THREE.Vector3().copy(aim);
        dir.x += (Math.random() - 0.5) * 0.04;
        dir.y += (Math.random() - 0.5) * 0.04;
        dir.z += (Math.random() - 0.5) * 0.04;
        dir.normalize();
        if (this.bolts.length < MAX_SHOTS) {
          this.bolts.push({ pos: new THREE.Vector3().copy(g.pos).addScaledVector(dir, 5), vel: dir.multiplyScalar(BOLT_SPEED), life: BOLT_LIFE });
        }
        if (toPlayer < 700) this.audio.bolt();
      }

      // Столкновение с игроком
      if (toPlayer < 9 && this.state === 'play') {
        this.damageGuard(g, 99);
        this.damagePlayer(25);
        continue;
      }
      g.mesh.position.copy(g.pos);
      orient(g.mesh, g.fwd, up);
    }
  }

  // ---------- эффекты и бонусы ----------

  spark(pos, speed, life, r, g, b, count = 1) {
    for (let k = 0; k < count; k++) {
      const i = this.pNext;
      this.pNext = (this.pNext + 1) % MAX_PARTICLES;
      _u.randomDirection().multiplyScalar(speed * (0.3 + Math.random() * 0.7));
      this.pPos.set([pos.x, pos.y, pos.z], i * 3);
      this.pVel.set([_u.x, _u.y, _u.z], i * 3);
      this.pCol.set([r, g, b], i * 3);
      this.pLife[i] = life * (0.6 + Math.random() * 0.8);
    }
  }

  explode(pos, size, color, loud = true) {
    const f = this.flashes[this.flashNext];
    this.flashNext = (this.flashNext + 1) % this.flashes.length;
    f.t = 0;
    f.dur = 0.3 + 0.12 * size;
    f.size = 28 * size;
    f.mesh.position.copy(pos);
    f.mesh.material.color.set(color);
    f.mesh.visible = true;
    const c = _col.set(color);
    this.spark(pos, 170 * size, 0.9, c.r, c.g, c.b, Math.round(22 * size));
    this.spark(pos, 80 * size, 1.3, 1, 0.8, 0.5, Math.round(10 * size));
    if (loud) {
      const near = clamp(1 - pos.distanceTo(this.player.pos) / 2600, 0.15, 1);
      this.audio.boom(size * near);
    }
  }

  dropPickup(pos) {
    const k = this.pickups.find((x) => !x.alive);
    if (!k) return;
    const p = this.player, ship = this.ship;
    // Чаще выпадает то, чего не хватает
    const need = [
      ['shield', 1.2 - (p.shield + p.hull) / (ship.shield + ship.hull)],
      ['fuel', 1.1 - p.fuel / ship.fuel],
      ['missiles', 1.1 - p.missiles / ship.missiles],
    ];
    let roll = Math.random() * need.reduce((s, n) => s + n[1], 0);
    k.type = need.find((n) => (roll -= n[1]) <= 0)?.[0] ?? 'shield';
    k.alive = true;
    k.life = 45;
    k.pos.copy(pos);
    k.mesh.material.color.set(PICKUPS[k.type].color);
    k.mesh.visible = true;
  }

  updatePickups(dt) {
    const p = this.player, ship = this.ship;
    for (const k of this.pickups) {
      if (!k.alive) continue;
      k.life -= dt;
      k.mesh.rotation.y += dt * 2.4;
      k.mesh.rotation.x += dt * 1.1;
      const dist = k.pos.distanceTo(p.pos);
      // Бонус притягивается к кораблю, иначе на такой скорости его не поймать
      if (dist < 260) k.pos.lerp(p.pos, Math.min(1, (dt * 520) / Math.max(dist, 1)));
      if (dist < 30 && this.state === 'play') {
        if (k.type === 'shield') {
          p.shield = Math.min(ship.shield, p.shield + 40);
          p.hull = Math.min(ship.hull, p.hull + 15);
        } else if (k.type === 'fuel') p.fuel = Math.min(ship.fuel, p.fuel + 50);
        else p.missiles = Math.min(ship.missiles, p.missiles + 4);
        this.score += SCORE.pickup;
        this.say(PICKUPS[k.type].label, COLORS.green);
        this.audio.pickup();
        k.life = 0;
      }
      if (k.life <= 0) {
        k.alive = false;
        k.mesh.visible = false;
      }
    }
  }

  updateEffects(dt) {
    const { pPos, pVel, pCol, pLife } = this;
    const fade = Math.max(0, 1 - dt * 1.4);
    for (let i = 0, j = 0; i < MAX_PARTICLES; i++, j += 3) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      if (pLife[i] <= 0) {
        pPos[j] = pPos[j + 1] = pPos[j + 2] = 0;
        continue;
      }
      pPos[j] += pVel[j] * dt;
      pPos[j + 1] += pVel[j + 1] * dt;
      pPos[j + 2] += pVel[j + 2] * dt;
      pCol[j] *= fade;
      pCol[j + 1] *= fade;
      pCol[j + 2] *= fade;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.color.needsUpdate = true;

    for (const f of this.flashes) {
      if (!f.mesh.visible) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        f.mesh.visible = false;
        continue;
      }
      f.mesh.scale.setScalar(f.size * (0.25 + 0.75 * Math.sqrt(k)));
      f.mesh.material.opacity = (1 - k) * (1 - k);
    }

    // Пыль заворачивается в куб вокруг камеры
    const cam = this.camera.position, d = this.dustPos;
    for (let j = 0; j < d.length; j += 3) {
      d[j] = cam.x + ((((d[j] - cam.x + 400) % 800) + 800) % 800) - 400;
      d[j + 1] = cam.y + ((((d[j + 1] - cam.y + 400) % 800) + 800) % 800) - 400;
      d[j + 2] = cam.z + ((((d[j + 2] - cam.z + 400) % 800) + 800) % 800) - 400;
    }
    this.dust.geometry.attributes.position.needsUpdate = true;

    for (const m of this.messages) m.t += dt;
    while (this.messages.length && this.messages[0].t > 5) this.messages.shift();
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }

  // ---------- ближние аппараты ----------

  updateNear() {
    const { sl, rs, player: p } = this;
    const pos = sl.pos, px = p.pos.x, py = p.pos.y, pz = p.pos.z, r2 = LOD_RANGE * LOD_RANGE;
    let n = 0;
    for (let i = 0, j = 0; i < sl.count; i++, j += 3) {
      const dx = pos[j] - px;
      if (dx > LOD_RANGE || dx < -LOD_RANGE || !sl.alive[i]) continue;
      const dy = pos[j + 1] - py, dz = pos[j + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2 || n >= NEAR_MAX) continue;
      this.nearIdx[n] = i;
      this.nearD2[n] = d2;
      n++;
      // Таран: спутник гибнет, корабль получает удар
      if (d2 < 9 * 9 && this.state === 'play') {
        this.killSat(i, true);
        this.damagePlayer(18);
      }
    }
    this.nearCount = n;

    // Меши достаются самым близким
    const order = this.nearOrder;
    order.length = n;
    for (let k = 0; k < n; k++) order[k] = k;
    order.sort((x, y) => this.nearD2[x] - this.nearD2[y]);
    for (let k = 0; k < LOD_MESHES; k++) {
      const mesh = this.slMeshes[k];
      if (k >= n || !sl.alive[this.nearIdx[order[k]]]) {
        mesh.visible = false;
        continue;
      }
      const i = this.nearIdx[order[k]];
      sl.position(i, mesh.position);
      orient(mesh, sl.velocity(i, this.orbitT, _b).normalize(), _a.copy(mesh.position).normalize());
      mesh.userData.lines.material = this.isTarget[i] ? this.targetEdge : this.otherEdge;
      mesh.visible = true;
    }

    this.comm.name = '';
    this.comm.dist = Infinity;
    for (let i = 0; i < rs.count; i++) {
      const mesh = this.rsMeshes[i];
      mesh.visible = rs.alive[i] === 1;
      if (!mesh.visible) continue;
      rs.position(i, mesh.position);
      orient(mesh, rs.velocity(i, this.orbitT, _b).normalize(), _a.copy(mesh.position).normalize());
      const dist = mesh.position.distanceTo(p.pos);
      if (dist < this.comm.dist) {
        this.comm.dist = dist;
        this.comm.name = rs.names[i];
      }
    }
    this.mission.updateComm(this.comm, p);
  }

  // ---------- исход ----------

  win() {
    if (this.state !== 'play') return;
    this.state = 'won';
    this.endTimer = 3;
    this.score += Math.max(0, Math.round((360 - this.t) * 5)) + Math.round(this.player.hull * 5);
    this.say(this.mission.winText, COLORS.gold);
    this.audio.fanfare(true);
  }

  // shipLost = false — миссия провалена, но сам аппарат цел
  lose(reason, shipLost = true) {
    if (this.state !== 'play') return;
    this.state = 'lost';
    this.reason = reason;
    this.shipLost = shipLost;
    this.endTimer = 3;
    if (shipLost) {
      this.shipMesh.visible = false;
      this.explode(this.player.pos, 2, 0xffa040);
      this.player.speed *= 0.3;
    }
    this.audio.fanfare(false);
  }

  result() {
    const s = this.stats, won = this.state === 'won';
    return {
      won,
      title: won ? this.mission.winTitle : this.reason ?? '',
      score: this.score,
      time: this.t,
      facts: this.mission.resultFacts(),
      accuracy: s.shots ? s.hits / s.shots : 0,
    };
  }

  // ---------- кадр ----------

  update(dt) {
    const { sl, rs, player: p } = this;
    this.clock += dt;
    if (this.state === 'play') this.t += dt;
    this.orbitT = this.simT0 + this.clock * TIME_SCALE;
    sl.update(this.orbitT);
    rs.update(this.orbitT);
    this.slPosAttr.needsUpdate = true;
    this.gmst = gmstAt(this.catalog.epoch) + EARTH_RATE * this.orbitT;
    this.earth.group.rotation.y = this.gmst;
    this.earth.uniforms.uTime.value = this.clock;

    if (this.state === 'play') this.updatePlayer(dt);
    else this.movePlayer(dt);
    this.updateNear();
    this.mission.update(dt);
    if (this.state === 'play') this.updateLock();
    this.updateGuards(dt);
    this.updateBullets(dt);
    this.updateMissiles(dt);
    this.updatePickups(dt);

    this.shipMesh.position.copy(p.pos);
    orient(this.shipMesh, p.fwd, _a.copy(p.pos).normalize(), p.bank);
    const thrust = p.boosting ? 5.5 : 1.2 + 1.6 * (p.speed / this.ship.cruise);
    for (const f of this.flames) f.scale.set(1, 1, thrust * (0.85 + Math.random() * 0.3));
    this.flameMat.color.set(p.boosting ? 0x9fd8ff : 0xffa040);

    this.updateCamera(dt);
    this.updateEffects(dt);
    this.audio.engine(p.speed / this.ship.boost, p.boosting, this.state === 'play');

    if (this.state !== 'play' && this.state !== 'briefing' && this.endTimer > 0) {
      this.endTimer -= dt;
      if (this.endTimer <= 0) this.onFinish(this.result());
    }
  }

  updateCamera(dt) {
    const p = this.player, cam = this.camera;
    const up = _a.copy(p.pos).normalize();
    // Камера догоняет нос с небольшим отставанием: корабль «входит» в поворот раньше кадра
    this.camFwd.lerp(p.fwd, Math.min(1, dt * 7)).normalize();
    const f = this.cockpit ? p.fwd : this.camFwd;
    const right = _b.crossVectors(f, up).normalize();
    const top = _c.crossVectors(right, f);
    if (this.cockpit) {
      cam.position.copy(p.pos).addScaledVector(f, 2.5).addScaledVector(top, 0.9);
      _d.copy(cam.position).addScaledVector(f, 100);
    } else {
      // Камера смотрит чуть сверху вниз, чтобы Земля занимала заметную часть кадра
      cam.position.copy(p.pos).addScaledVector(f, -16).addScaledVector(top, 6.5);
      _d.copy(p.pos).addScaledVector(f, 40).addScaledVector(top, -4);
    }
    cam.up.copy(top).applyAxisAngle(f, -p.bank * (this.cockpit ? 0.6 : 0.22));
    if (this.shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this.shake * 1.4;
      cam.position.y += (Math.random() - 0.5) * this.shake * 1.4;
      cam.position.z += (Math.random() - 0.5) * this.shake * 1.4;
    }
    cam.lookAt(_d);
    const fov = p.boosting ? 84 : 70;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this.shipMesh.visible = !this.cockpit && !(this.state === 'lost' && this.shipLost);
    this.sky.position.copy(cam.position);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.hud.draw(this);
  }

  dispose() {
    this.audio.engine(0, false, false);
    // Геометрия и материалы моделей общие с меню, освобождаем только своё
    this.mission.dispose();
    const own = [this.slPoints, this.bulletLines, this.boltLines, this.particles, this.dust, this.earth.air, ...this.earth.group.children, ...this.sky.children];
    for (const o of own) {
      o.geometry.dispose();
      o.material.dispose();
    }
    this.earth.uniforms.uMask.value.dispose();
  }
}
