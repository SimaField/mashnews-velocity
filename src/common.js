import * as THREE from 'three';

// Общее для боя, миссий и приборов. Расстояния в километрах, скорости в км/с.
export const TIME_SCALE = 3; // во сколько раз орбитальное движение быстрее реального
export const BULLET_SPEED = 3000, BULLET_LIFE = 0.34;
export const BOLT_SPEED = 1100, BOLT_LIFE = 1.4;
export const MAX_SHOTS = 96;
export const COMM_RANGE = 2200;
export const SCORE = { target: 500, starlink: 100, guard: 300, pickup: 50, friendly: -2000, bossPart: 400, boss: 3000 };
export const COLORS = { cyan: '#5ef2ff', gold: '#ffb23e', red: '#ff4d5e', green: '#6dffa0', white: '#e8f4ff' };

export const clamp = THREE.MathUtils.clamp;

const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _nf = new THREE.Vector3();
const _m = new THREE.Matrix4();

// Ставит объект носом по fwd, верхом по up; roll — крен вокруг продольной оси
export function orient(obj, fwd, up, roll = 0) {
  _r.crossVectors(fwd, up).normalize();
  _u.crossVectors(_r, fwd);
  _m.makeBasis(_r, _u, _nf.copy(fwd).negate());
  obj.quaternion.setFromRotationMatrix(_m);
  if (roll) obj.rotateZ(roll);
}

// Доворачивает единичный вектор cur к target не больше чем на maxAngle
export function turnToward(cur, target, maxAngle) {
  const angle = cur.angleTo(target);
  if (angle <= maxAngle) return cur.copy(target);
  _r.crossVectors(cur, target);
  if (_r.lengthSq() < 1e-10) _r.set(cur.y, cur.z, cur.x).cross(cur);
  return cur.applyAxisAngle(_r.normalize(), maxAngle).normalize();
}

// Квадрат расстояния от точки c до отрезка p → p + d
export function segDist2(p, d, c) {
  const wx = c.x - p.x, wy = c.y - p.y, wz = c.z - p.z;
  const dd = d.x * d.x + d.y * d.y + d.z * d.z;
  let t = dd > 0 ? (wx * d.x + wy * d.y + wz * d.z) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = wx - d.x * t, ey = wy - d.y * t, ez = wz - d.z * t;
  return ex * ex + ey * ey + ez * ez;
}

// Доля пути по отрезку p → p + d, на которой он входит в сферу (c, r);
// Infinity, если не входит. Нужна, чтобы из нескольких сфер выбрать первую на пути.
export function segSphereT(p, d, c, r) {
  const mx = p.x - c.x, my = p.y - c.y, mz = p.z - c.z;
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc <= 0) return 0; // уже внутри
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  const b = mx * d.x + my * d.y + mz * d.z;
  if (a === 0 || b >= 0) return Infinity; // стоит на месте или удаляется
  const disc = b * b - a * cc;
  if (disc < 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : Infinity;
}
