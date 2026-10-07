import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { feature, mesh } from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';
import countriesTopo from 'world-atlas/countries-110m.json';
import { R_EARTH, latLonToVec3 } from './orbits.js';

const MASK_W = 4096, MASK_H = 2048;
let maskCanvas = null;

// Маска суши в равнопромежуточной проекции: белое — суша, чёрное — вода.
// Контуры в world-atlas заданы на сфере и по 180-му меридиану не разрезаны:
// Евразия и Фиджи его пересекают, а Антарктида замкнута вокруг полюса. Поэтому
// долготы каждого кольца «разворачиваются» в непрерывную линию, кольцо вокруг
// полюса замыкается через полюс, а всё вместе рисуется трижды со сдвигом на 360°.
function landMask() {
  if (maskCanvas) return maskCanvas;
  const cv = document.createElement('canvas');
  cv.width = MASK_W;
  cv.height = MASK_H;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, MASK_W, MASK_H);
  g.fillStyle = '#fff';
  const land = feature(landTopo, landTopo.objects.land);
  const geoms = land.type === 'FeatureCollection' ? land.features.map((f) => f.geometry) : [land.geometry];
  for (const geom of geoms) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      g.beginPath();
      for (const ring of poly) {
        const pts = [];
        let turn = 0;
        for (let i = 0; i < ring.length; i++) {
          if (i) {
            const d = ring[i][0] - ring[i - 1][0];
            if (d > 180) turn -= 360;
            else if (d < -180) turn += 360;
          }
          pts.push([ring[i][0] + turn, ring[i][1]]);
        }
        if (turn) {
          const pole = pts[0][1] < 0 ? -90 : 90;
          pts.push([pts[pts.length - 1][0], pole], [pts[0][0], pole]);
        }
        for (const shift of [-360, 0, 360]) {
          for (let i = 0; i < pts.length; i++) {
            const x = ((pts[i][0] + shift + 180) / 360) * MASK_W;
            const y = ((90 - pts[i][1]) / 180) * MASK_H;
            if (i) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
          g.closePath();
        }
      }
      g.fill('evenodd');
    }
  }
  maskCanvas = cv;
  return cv;
}

// Мягкое круглое пятно для светящихся точек
export function glowTexture(size = 64) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}

const RIM_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Ореол рисуется на внутренней стороне сферы чуть больше Земли: ярче всего у
// самого края диска и гаснет наружу. uK = sqrt(1 - (R / Rоболочки)^2).
function rimMaterial(ratio, fragmentColor, uniforms = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uK: { value: Math.sqrt(1 - 1 / (ratio * ratio)) }, ...uniforms },
    vertexShader: RIM_VERT,
    fragmentShader: /* glsl */ `
      uniform float uK;
      uniform vec3 uSun;
      uniform vec3 uColor;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vPosW);
        float glow = pow(clamp(-dot(N, V) / uK, 0.0, 1.0), 2.2);
        ${fragmentColor}
        gl_FragColor = vec4(col * glow, glow);
      }
    `,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

// Глобус-схема для стартового экрана: тёмный шар, суша точками, сетка, ореол
export function createSchemaGlobe() {
  const group = new THREE.Group();

  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH * 0.994, 96, 64),
    new THREE.MeshBasicMaterial({ color: 0x050d1a }),
  ));

  // Суша: точки на сетке с равной плотностью по площади
  const small = document.createElement('canvas');
  small.width = 1440;
  small.height = 720;
  const sg = small.getContext('2d', { willReadFrequently: true });
  sg.drawImage(landMask(), 0, 0, 1440, 720);
  const px = sg.getImageData(0, 0, 1440, 720).data;
  const pts = [];
  const v = new THREE.Vector3();
  const step = 1.15;
  for (let lat = -88; lat <= 88; lat += step) {
    const n = Math.max(1, Math.round((360 / step) * Math.cos((lat * Math.PI) / 180)));
    for (let k = 0; k < n; k++) {
      const lon = -180 + ((k + 0.5) / n) * 360;
      const ix = Math.min(1439, Math.floor(((lon + 180) / 360) * 1440));
      const iy = Math.min(719, Math.floor(((90 - lat) / 180) * 720));
      if (px[(iy * 1440 + ix) * 4] < 128) continue;
      latLonToVec3(lat, lon, R_EARTH, v);
      pts.push(v.x, v.y, v.z);
    }
  }
  const dots = new THREE.BufferGeometry();
  dots.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  // Суша зелёная, чтобы не сливалась с голубыми точками Starlink
  const dotMat = new THREE.PointsMaterial({ color: 0x2fc46e, size: 3.2, sizeAttenuation: false, transparent: true, opacity: 0.85 });
  group.add(new THREE.Points(dots, dotMat));

  // Границы стран и береговая линия. Длинные отрезки дробим по широте и долготе,
  // иначе хорда уходит под поверхность шара. Отрезок через 180-й меридиан идёт
  // коротким путём; швы данных вдоль самого меридиана границами не являются.
  const borders = [];
  const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  for (const line of mesh(countriesTopo, countriesTopo.objects.countries).coordinates) {
    for (let i = 1; i < line.length; i++) {
      const [lon1, lat1] = line[i - 1], lat2 = line[i][1];
      let lon2 = line[i][0];
      if (Math.abs(lon1) > 179.9 && Math.abs(lon2) > 179.9) continue;
      if (lon2 - lon1 > 180) lon2 -= 360;
      else if (lon2 - lon1 < -180) lon2 += 360;
      const parts = Math.max(1, Math.ceil(Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1)) / 2));
      for (let k = 0; k < parts; k++) {
        const a0 = k / parts, a1 = (k + 1) / parts;
        latLonToVec3(lat1 + (lat2 - lat1) * a0, lon1 + (lon2 - lon1) * a0, R_EARTH * 1.0015, p1);
        latLonToVec3(lat1 + (lat2 - lat1) * a1, lon1 + (lon2 - lon1) * a1, R_EARTH * 1.0015, p2);
        borders.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    }
  }
  // Обычная линия WebGL всегда толщиной в один пиксель буфера и на сглаженном
  // экране меню почти не видна, поэтому границы рисуются «толстыми» линиями
  const borderLines = new LineSegments2(
    new LineSegmentsGeometry().setPositions(borders),
    new LineMaterial({ color: 0xa6ffd0, linewidth: 1.3, transparent: true, opacity: 0.75 }),
  );
  group.add(borderLines);

  // Градусная сетка через 30°
  const grid = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const seg = (lat1, lon1, lat2, lon2) => {
    latLonToVec3(lat1, lon1, R_EARTH, a);
    latLonToVec3(lat2, lon2, R_EARTH, b);
    grid.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 3) seg(lat, lon, lat, lon + 3);
  for (let lon = -180; lon < 180; lon += 30) for (let lat = -84; lat < 84; lat += 3) seg(lat, lon, lat + 3, lon);
  const gridGeom = new THREE.BufferGeometry();
  gridGeom.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
  group.add(new THREE.LineSegments(gridGeom, new THREE.LineBasicMaterial({ color: 0x1f4f78, transparent: true, opacity: 0.45 })));

  const rim = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH * 1.07, 96, 64),
    rimMaterial(1.07, 'vec3 col = uColor;', { uColor: { value: new THREE.Color(0.2, 0.75, 1.0) } }),
  );
  group.add(rim);

  return { group, dotMat };
}

// Земля для боя: палитра и «пиксель» поверхности считаются в шейдере по маске суши
export function createRetroEarth() {
  const mask = new THREE.CanvasTexture(landMask());
  mask.magFilter = THREE.NearestFilter;
  mask.minFilter = THREE.LinearMipmapLinearFilter;
  mask.generateMipmaps = true;
  mask.wrapS = THREE.RepeatWrapping;
  mask.anisotropy = 4;

  const uniforms = {
    uMask: { value: mask },
    uSun: { value: new THREE.Vector3(1, 0, 0) },
    uTime: { value: 0 },
  };

  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH, 128, 80),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormalW;
        void main() {
          vUv = uv;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMask;
        uniform vec3 uSun;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vNormalW;
        const vec2 CELLS = vec2(${MASK_W}.0, ${MASK_H}.0);

        float hash(vec2 p) {
          p = fract(p * vec2(0.1031, 0.1030));
          p += dot(p, p.yx + 33.33);
          return fract((p.x + p.y) * p.x);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.01 + 3.7);
        }

        void main() {
          vec3 N = normalize(vNormalW);
          float land = step(0.5, texture2D(uMask, vUv).r);
          vec2 cell = floor(vUv * CELLS);
          // Сколько ячеек поверхности попадает в экранный пиксель: мелкое зерно
          // гасим вдали, иначе горизонт рябит
          float px = fwidth(vUv.x * CELLS.x) + fwidth(vUv.y * CELLS.y);
          float grain = mix(0.5, hash(cell), clamp(1.5 - px, 0.0, 1.0));
          float block = mix(0.5, hash(floor(vUv * CELLS / 8.0) + 17.0), clamp(1.5 - px / 8.0, 0.0, 1.0));
          float lat = (vUv.y - 0.5) * 180.0;
          vec2 wide = vUv * vec2(2.0, 1.0);
          float big = fbm(wide * 40.0);
          float zone = abs(lat) + (big - 0.5) * 16.0;

          vec3 col;
          if (land > 0.5) {
            float dry = fbm(wide * 14.0 + 11.0);
            if (lat < -60.0 || zone > 70.0) col = vec3(0.88, 0.92, 0.96);
            else if (zone > 56.0) col = vec3(0.40, 0.44, 0.34);
            else if (zone > 36.0) col = vec3(0.19, 0.40, 0.15);
            else if (zone > 14.0) col = dry > 0.47 ? vec3(0.74, 0.61, 0.37) : vec3(0.47, 0.48, 0.22);
            else col = vec3(0.08, 0.33, 0.13);
            col *= (0.80 + 0.30 * grain) * (0.90 + 0.20 * block);
          } else {
            col = mix(vec3(0.02, 0.07, 0.21), vec3(0.05, 0.20, 0.42), big);
            col *= (0.86 + 0.22 * grain) * (0.92 + 0.16 * block);
            if (abs(lat) > 76.0 + (big - 0.5) * 10.0) col = vec3(0.80, 0.86, 0.93) * (0.9 + 0.2 * grain);
          }

          float cloud = smoothstep(0.62, 0.65, fbm(wide * 30.0 + vec2(uTime * 0.0015, 0.0)));
          col = mix(col, vec3(0.86, 0.89, 0.93), cloud * 0.75);

          float k = dot(N, uSun);
          float day = smoothstep(-0.10, 0.20, k);
          vec3 night = col * vec3(0.17, 0.21, 0.36);
          float city = land * step(0.972, hash(floor(vUv * CELLS / 2.0) + 3.0)) * step(abs(lat), 62.0)
                     * (1.0 - cloud) * clamp(1.5 - px / 2.0, 0.0, 1.0);
          night += vec3(1.0, 0.78, 0.35) * city * 0.9;
          vec3 lit = col * (0.38 + 0.74 * max(k, 0.0));
          vec3 outc = mix(night, lit, day);
          outc += vec3(0.95, 0.42, 0.12) * exp(-pow(k / 0.13, 2.0)) * 0.22; // полоса рассвета
          gl_FragColor = vec4(floor(outc * 24.0 + 0.5) / 24.0, 1.0);        // грубая палитра
        }
      `,
    }),
  );

  const air = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH * 1.025, 96, 64),
    rimMaterial(
      1.025,
      `float k = dot(N, uSun);
       float dawn = exp(-pow(k / 0.22, 2.0));
       vec3 col = mix(vec3(0.25, 0.55, 1.0), vec3(1.0, 0.45, 0.12), dawn) * (0.12 + 0.88 * smoothstep(-0.25, 0.15, k));`,
      { uSun: uniforms.uSun },
    ),
  );

  const group = new THREE.Group();
  group.add(surface);
  return { group, air, uniforms };
}

// Звёздное небо и Солнце. Группа должна следовать за камерой.
export function createSky(sunDir, radius = 60000, count = 1400) {
  const group = new THREE.Group();
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection().multiplyScalar(radius);
    pos.set([v.x, v.y, v.z], i * 3);
    const b = 0.35 + Math.random() * 0.65, tint = Math.random();
    col.set([b * (tint > 0.8 ? 1 : 0.85), b * 0.9, b * (tint < 0.2 ? 1 : 0.85)], i * 3);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(geom, new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
  stars.frustumCulled = false;
  group.add(stars);

  const sunGeom = new THREE.BufferGeometry();
  sunGeom.setAttribute('position', new THREE.Float32BufferAttribute([sunDir.x * radius, sunDir.y * radius, sunDir.z * radius], 3));
  const sun = new THREE.Points(sunGeom, new THREE.PointsMaterial({
    size: 26, sizeAttenuation: false, map: glowTexture(), color: 0xfff1c9,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  sun.frustumCulled = false;
  group.add(sun);
  return group;
}
