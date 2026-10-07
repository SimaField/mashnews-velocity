import { json2satrec, propagate, gstime } from 'satellite.js';
import { Vector3 } from 'three';

export const R_EARTH = 6371; // км, средний радиус
export const EARTH_RATE = 7.2921159e-5; // рад/с, вращение Земли
const DEG = Math.PI / 180;

// Набор спутников. SGP4 считается один раз в момент sync(), дальше аппарат идёт
// по круговой орбите в зафиксированной плоскости: за минуты игрового времени
// расхождение с SGP4 меньше размера модели, а обновление 11 тысяч объектов
// занимает доли миллисекунды.
// Оси: TEME (x, y, z) → Three.js (x, z, -y), северный полюс смотрит в +Y.
export class SatSet {
  constructor(records) {
    const n = records.length;
    this.count = n;
    this.names = records.map((r) => r.OBJECT_NAME);
    this.ids = records.map((r) => r.NORAD_CAT_ID);
    this.satrecs = records.map((r) => json2satrec(r));
    this.e1 = new Float64Array(n * 3); // орт на аппарат в момент sync
    this.e2 = new Float64Array(n * 3); // орт вдоль скорости
    this.radius = new Float64Array(n);
    this.rate = new Float64Array(n); // рад/с
    this.pos = new Float32Array(n * 3);
    this.alive = new Uint8Array(n);
    this.aliveCount = 0;
    this.epoch = null;
  }

  sync(date) {
    const { e1, e2, radius, rate, alive } = this;
    this.epoch = date;
    this.aliveCount = 0;
    for (let i = 0, j = 0; i < this.count; i++, j += 3) {
      alive[i] = 0;
      let pv = null;
      try {
        pv = propagate(this.satrecs[i], date);
      } catch {
        continue;
      }
      const r = pv && pv.position;
      const v = pv && pv.velocity;
      if (!r || !v || !Number.isFinite(r.x) || !Number.isFinite(v.x)) continue;
      const rx = r.x, ry = r.z, rz = -r.y;
      const vx = v.x, vy = v.z, vz = -v.y;
      const a = Math.hypot(rx, ry, rz);
      if (a < R_EARTH + 150 || a > R_EARTH + 2500) continue; // сошедшие с орбиты и битые элементы
      const ux = rx / a, uy = ry / a, uz = rz / a;
      const vr = vx * ux + vy * uy + vz * uz;
      const tx = vx - vr * ux, ty = vy - vr * uy, tz = vz - vr * uz;
      const vt = Math.hypot(tx, ty, tz);
      e1[j] = ux; e1[j + 1] = uy; e1[j + 2] = uz;
      e2[j] = tx / vt; e2[j + 1] = ty / vt; e2[j + 2] = tz / vt;
      radius[i] = a;
      rate[i] = vt / a;
      alive[i] = 1;
      this.aliveCount++;
    }
    this.update(0);
  }

  // t — секунды от момента sync()
  update(t) {
    const { e1, e2, radius, rate, alive, pos } = this;
    for (let i = 0, j = 0; i < this.count; i++, j += 3) {
      if (!alive[i]) {
        pos[j] = pos[j + 1] = pos[j + 2] = 0; // прячем внутрь Земли
        continue;
      }
      const ang = rate[i] * t;
      const c = Math.cos(ang) * radius[i], s = Math.sin(ang) * radius[i];
      pos[j] = c * e1[j] + s * e2[j];
      pos[j + 1] = c * e1[j + 1] + s * e2[j + 1];
      pos[j + 2] = c * e1[j + 2] + s * e2[j + 2];
    }
  }

  position(i, out) {
    const j = i * 3;
    return out.set(this.pos[j], this.pos[j + 1], this.pos[j + 2]);
  }

  velocity(i, t, out) {
    const j = i * 3, ang = this.rate[i] * t, k = this.rate[i] * this.radius[i];
    const c = Math.cos(ang) * k, s = Math.sin(ang) * k;
    return out.set(c * this.e2[j] - s * this.e1[j], c * this.e2[j + 1] - s * this.e1[j + 1], c * this.e2[j + 2] - s * this.e1[j + 2]);
  }

  // Нормаль к плоскости орбиты
  normal(i, out) {
    const j = i * 3, { e1, e2 } = this;
    return out.set(
      e1[j + 1] * e2[j + 2] - e1[j + 2] * e2[j + 1],
      e1[j + 2] * e2[j] - e1[j] * e2[j + 2],
      e1[j] * e2[j + 1] - e1[j + 1] * e2[j],
    );
  }

  // Наклонение и долгота восходящего узла, градусы
  plane(i, out = {}) {
    const n = this.normal(i, _n);
    out.inc = Math.acos(Math.max(-1, Math.min(1, n.y))) / DEG;
    out.raan = ((Math.atan2(n.x, n.z) / DEG) + 360) % 360; // TEME: hx = x, -hy = z
    return out;
  }
}

const _n = new Vector3();

export function gmstAt(date) {
  return gstime(date);
}

// Направление на Солнце в инерциальных осях сцены (точность около 0,01°)
export function sunDirection(date, out = new Vector3()) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  return out.set(Math.cos(lam), Math.sin(eps) * Math.sin(lam), -Math.cos(eps) * Math.sin(lam)).normalize();
}

// Точка под аппаратом: широта, долгота и высота над сферической Землёй
export function subPoint(x, y, z, gmst, out = {}) {
  const r = Math.hypot(x, y, z);
  const lon = (Math.atan2(-z, x) - gmst) / DEG;
  out.lat = Math.asin(y / r) / DEG;
  out.lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  out.alt = r - R_EARTH;
  return out;
}

// Вектор в осях, связанных с Землёй (до поворота на звёздное время)
export function latLonToVec3(lat, lon, r, out = new Vector3()) {
  const phi = lat * DEG, lam = lon * DEG;
  return out.set(r * Math.cos(phi) * Math.cos(lam), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lam));
}

export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'с.ш.' : 'ю.ш.';
  const ew = lon >= 0 ? 'в.д.' : 'з.д.';
  return `${Math.abs(lat).toFixed(1)}° ${ns} ${Math.abs(lon).toFixed(1)}° ${ew}`;
}
