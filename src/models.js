import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Низкополигональные модели собираются из примитивов. Оси модели: нос в −Z,
// верх в +Y, правый борт в +X. Единица — километр (размеры условные: настоящий
// спутник с такого расстояния был бы не виден).

const NOSE = [-Math.PI / 2, 0, 0]; // ось цилиндра/конуса Y → вперёд

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rTop, rBottom, h, seg = 8) => new THREE.CylinderGeometry(rTop, rBottom, h, seg);
const ball = (r) => new THREE.SphereGeometry(r, 6, 4);

// Плоская деталь по контуру: x — вправо, y — вперёд, толщина — вверх
function slab(points, thickness) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
}

// Деталь: поворот, затем масштаб и сдвиг в осях модели, цвет запекается в вершины
function part(geom, color, { p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] } = {}) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r[0], r[1], r[2])));
  g.applyMatrix4(new THREE.Matrix4().makeScale(s[0], s[1], s[2]));
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(p[0], p[1], p[2]));
  g.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const WHITE = '#e9eef3', GREY = '#8f9aa8', STEEL = '#b8c0cb', DARK = '#1b1f26', GLASS = '#16233b', PANEL = '#16357f';

const PARTS = {
  spiral: () => [
    part(cyl(0.12, 1.0, 5, 6), '#cfd6de', { r: NOSE, s: [1.25, 0.5, 1] }),
    part(box(0.7, 0.3, 1.1), GLASS, { p: [0, 0.3, -0.7] }),
    part(box(2.3, 0.1, 1.5), GREY, { p: [1.75, 0.55, 1.5], r: [0, 0, 0.75] }),
    part(box(2.3, 0.1, 1.5), GREY, { p: [-1.75, 0.55, 1.5], r: [0, 0, -0.75] }),
    part(box(0.1, 1.2, 1.3), GREY, { p: [0, 0.8, 1.7] }),
    part(cyl(0.38, 0.5, 0.5, 6), DARK, { r: NOSE, p: [0, 0, 2.7] }),
  ],
  buran: () => {
    const wing = [[0.7, 1.2], [3.4, -2.3], [3.4, -3.0], [0.7, -3.0]];
    return [
      part(cyl(0.8, 0.8, 5.4, 8), WHITE, { r: NOSE, p: [0, 0, 0.3] }),
      part(cyl(0.22, 0.8, 1.6, 8), WHITE, { r: NOSE, p: [0, 0, -3.2] }),
      part(cyl(0.02, 0.22, 0.45, 8), DARK, { r: NOSE, p: [0, 0, -4.22] }),
      part(box(1.0, 0.3, 0.7), DARK, { p: [0, 0.55, -2.5] }),
      part(slab(wing, 0.14), '#22272f', { r: NOSE, p: [0, -0.7, 0] }),
      part(slab(wing, 0.14), '#22272f', { r: NOSE, p: [0, -0.7, 0], s: [-1, 1, 1] }),
      part(box(0.14, 1.9, 1.5), WHITE, { p: [0, 1.5, 2.3], r: [0.4, 0, 0] }),
      part(box(0.55, 0.55, 1.5), '#cfd6de', { p: [0.6, 0.6, 2.4] }),
      part(box(0.55, 0.55, 1.5), '#cfd6de', { p: [-0.6, 0.6, 2.4] }),
      part(cyl(0.3, 0.38, 0.5, 6), DARK, { r: NOSE, p: [0, 0.35, 3.2] }),
      part(cyl(0.3, 0.38, 0.5, 6), DARK, { r: NOSE, p: [0.4, -0.2, 3.2] }),
      part(cyl(0.3, 0.38, 0.5, 6), DARK, { r: NOSE, p: [-0.4, -0.2, 3.2] }),
    ];
  },
  is: () => [
    part(cyl(0.9, 0.9, 3.2, 8), STEEL, { r: NOSE }),
    part(cyl(1.2, 0.25, 0.6, 8), GREY, { r: NOSE, p: [0, 0, -1.9] }),
    part(ball(0.75), '#d9a441', { p: [1.25, 0, 0.6] }),
    part(ball(0.75), '#d9a441', { p: [-1.25, 0, 0.6] }),
    part(ball(0.75), '#d9a441', { p: [0, 1.25, 0.6] }),
    part(ball(0.75), '#d9a441', { p: [0, -1.25, 0.6] }),
    part(cyl(0.3, 0.45, 0.6, 6), DARK, { r: NOSE, p: [0, 0, 1.9] }),
  ],
  zeus: () => [
    part(box(0.3, 0.3, 9), GREY),
    part(ball(0.9), STEEL, { p: [0, 0, -4.6] }),
    part(cyl(1.3, 0.9, 0.5, 8), '#5a6472', { r: NOSE, p: [0, 0, -3.5] }),
    part(box(5.5, 0.06, 3.2), '#b5482c', { p: [0, 0, -0.6] }),
    part(box(0.06, 5.5, 3.2), '#b5482c', { p: [0, 0, -0.6] }),
    part(box(1.6, 1.6, 1.8), WHITE, { p: [0, 0, 3.6] }),
    part(cyl(0.45, 0.6, 0.6, 6), DARK, { r: NOSE, p: [0, 0, 4.8] }),
  ],
  // Плоский корпус и одна высокая солнечная батарея, как у Starlink v1.5
  starlink: () => [
    part(box(5.2, 0.5, 2.8), '#aab4c2'),
    part(box(4.0, 11, 0.12), PANEL, { p: [0, 5.8, 0] }),
  ],
  rassvet: () => [
    part(box(2.4, 2.4, 3.2), '#d9dde3'),
    part(box(6, 0.1, 2.2), PANEL, { p: [4.2, 0, 0] }),
    part(box(6, 0.1, 2.2), PANEL, { p: [-4.2, 0, 0] }),
    part(box(2.0, 0.2, 2.6), '#c8922e', { p: [0, -1.3, 0] }),
  ],
  guard: () => [
    part(new THREE.ConeGeometry(1.4, 5.5, 4), '#3a2230', { r: NOSE, s: [1, 0.45, 1] }),
    part(box(4.4, 0.1, 1.3), '#5a2a35', { p: [0, 0, 1.7] }),
    part(box(0.1, 1.5, 1.1), '#5a2a35', { p: [0, 0.5, 1.9] }),
  ],
  // МКС: ферма поперёк курса, восемь крыльев батарей, цепочка модулей вдоль курса
  iss: () => {
    const arrays = [];
    for (const x of [-47, -36, 36, 47]) {
      for (const z of [-19, 19]) arrays.push(part(box(8.5, 0.2, 30), '#b07a2a', { p: [x, 0, z] }));
    }
    return [
      part(box(100, 2.4, 2.4), GREY),
      ...arrays,
      part(box(3.2, 0.2, 15), WHITE, { p: [-15, 0, 10] }),
      part(box(3.2, 0.2, 15), WHITE, { p: [15, 0, 10] }),
      part(cyl(2.3, 2.3, 46, 8), WHITE, { r: NOSE, p: [0, -2.2, 0] }),
      part(cyl(2.3, 2.3, 17, 8), '#cfd6de', { r: [0, 0, Math.PI / 2], p: [0, -2.2, -15] }),
      part(cyl(2.0, 2.0, 12, 8), '#cfd6de', { p: [0, -7, 12] }),
      part(box(1.6, 0.2, 13), PANEL, { p: [5.5, -2.2, 20] }),
      part(box(1.6, 0.2, 13), PANEL, { p: [-5.5, -2.2, 20] }),
    ];
  },
  // Starship: корпус 50 км в длину, нос вперёд; двигатели и отсек — отдельные модели
  starship: () => [
    part(cyl(4.5, 4.5, 38, 10), '#c3cad3', { r: NOSE, p: [0, 0, 6] }),
    part(cyl(0.7, 4.5, 12, 10), '#c3cad3', { r: NOSE, p: [0, 0, -19] }),
    part(box(8.4, 0.5, 40), '#1e2228', { p: [0, -4.2, 4] }),
    part(box(3.6, 0.4, 6.5), '#2a2f38', { p: [5.6, 0, -14] }),
    part(box(3.6, 0.4, 6.5), '#2a2f38', { p: [-5.6, 0, -14] }),
    part(box(4.6, 0.4, 9.5), '#2a2f38', { p: [6.2, 0, 19] }),
    part(box(4.6, 0.4, 9.5), '#2a2f38', { p: [-6.2, 0, 19] }),
    part(cyl(4.7, 4.7, 2, 10), DARK, { r: NOSE, p: [0, 0, 24.5] }),
  ],
  starshipEngine: () => [part(cyl(1.0, 1.9, 3.4, 8), '#4a3038', { r: NOSE })],
  starshipBay: () => [part(box(5.2, 0.8, 10), '#ff5a2a')],
  starshipDoor: () => [part(box(5.8, 0.5, 10.6), '#c3cad3')],
  missile: () => [
    part(new THREE.ConeGeometry(0.45, 3, 5), WHITE, { r: NOSE }),
    part(box(1.4, 0.06, 0.6), GREY, { p: [0, 0, 1.2] }),
    part(box(0.06, 1.4, 0.6), GREY, { p: [0, 0, 1.2] }),
  ],
};

const EDGE = {
  spiral: '#ffb23e', buran: '#ffb23e', is: '#ffb23e', zeus: '#ffb23e',
  starlink: '#3d7fd9', rassvet: '#ffb23e', guard: '#ff4d5e', missile: '#ffd9a0',
  iss: '#ffb23e', starship: '#ff4d5e', starshipEngine: '#ff9a3c', starshipBay: '#ffd27a', starshipDoor: '#ff4d5e',
};

const bodyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
const lineMaterials = new Map();
const built = new Map();

export function edgeMaterial(color) {
  if (!lineMaterials.has(color)) lineMaterials.set(color, new THREE.LineBasicMaterial({ color }));
  return lineMaterials.get(color);
}

// Экземпляр модели: общий меш и неоновые рёбра. Геометрия у экземпляров общая.
export function instance(name, edgeColor = EDGE[name]) {
  if (!built.has(name)) {
    const geom = mergeGeometries(PARTS[name]());
    built.set(name, { geom, edges: new THREE.EdgesGeometry(geom, 28) });
  }
  const { geom, edges } = built.get(name);
  const group = new THREE.Group();
  const lines = new THREE.LineSegments(edges, edgeMaterial(edgeColor));
  group.add(new THREE.Mesh(geom, bodyMaterial), lines);
  group.userData.lines = lines;
  return group;
}

// Характеристики: скорости в км/с, поворот в рад/с, burn — расход топлива на форсаже в секунду
export const SHIPS = {
  spiral: {
    id: 'spiral', name: 'Спираль', sub: 'Орбитальный самолёт · проект 1965 года',
    desc: 'Лёгкий и вёрткий. Догонит любую цель, но долгого обстрела не выдержит.',
    cruise: 240, boost: 520, turn: 1.55, shield: 80, hull: 80, fuel: 100, burn: 16, missiles: 8,
    engines: [[0, 0, 3.0]],
  },
  buran: {
    id: 'buran', name: 'Буран', sub: 'Орбитальный корабль 11Ф35',
    desc: 'Тяжёлый и живучий. Двойной запас ракет, зато разворачивается неохотно.',
    cruise: 195, boost: 410, turn: 1.15, shield: 140, hull: 140, fuel: 140, burn: 14, missiles: 16,
    engines: [[0, 0.35, 3.5], [0.4, -0.2, 3.5], [-0.4, -0.2, 3.5]],
  },
  is: {
    id: 'is', name: 'ИС', sub: 'Истребитель спутников', locked: true,
    desc: 'Одноразовый перехватчик с осколочной боевой частью. Появится в следующих версиях.',
    cruise: 260, boost: 480, turn: 1.3, shield: 50, hull: 60, fuel: 80, burn: 16, missiles: 4,
    engines: [[0, 0, 2.2]],
  },
  zeus: {
    id: 'zeus', name: 'Зевс', sub: 'Ядерный буксир', locked: true,
    desc: 'Реактор питает лазер и станцию помех: цели гаснут без обломков. Появится в следующих версиях.',
    cruise: 160, boost: 330, turn: 0.8, shield: 200, hull: 180, fuel: 220, burn: 12, missiles: 6,
    engines: [[0, 0, 5.1]],
  },
};
