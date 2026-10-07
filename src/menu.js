import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { R_EARTH, EARTH_RATE, gmstAt, subPoint, latLonToVec3 } from './orbits.js';
import { createSchemaGlobe, glowTexture } from './earth.js';
import { instance } from './models.js';

const RING_SEGMENTS = 128;

// Стартовый экран: глобус-схема с группировками в реальном времени
export class Menu {
  constructor(renderer, catalog) {
    this.renderer = renderer;
    this.catalog = catalog;
    this.simT = 0; // секунды от catalog.epoch
    this.timeScale = 60;
    this.pixelRatio = 2;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x040913);
    this.camera = new THREE.PerspectiveCamera(36, 1, 500, 400000);

    this.globe = createSchemaGlobe();
    this.scene.add(this.globe.group);

    // Фон: редкие тусклые звёзды
    const starPos = new Float32Array(900 * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < 900; i++) starPos.set(v.randomDirection().multiplyScalar(250000).toArray(), i * 3);
    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.scene.add(new THREE.Points(starGeom, new THREE.PointsMaterial({
      color: 0x8fa9d6, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false,
    })));

    const { starlink, rassvet } = catalog;
    const slGeom = new THREE.BufferGeometry();
    this.slAttr = new THREE.BufferAttribute(starlink.pos, 3);
    slGeom.setAttribute('position', this.slAttr);
    this.slPoints = new THREE.Points(slGeom, new THREE.PointsMaterial({
      color: 0x86b4ff, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.6, depthWrite: false,
    }));
    this.slPoints.frustumCulled = false;
    this.scene.add(this.slPoints);

    this.rings = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: 0xffa02e, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.rings.frustumCulled = false;
    this.scene.add(this.rings);
    this.rebuildRings();

    const rsGeom = new THREE.BufferGeometry();
    this.rsAttr = new THREE.BufferAttribute(rassvet.pos, 3);
    rsGeom.setAttribute('position', this.rsAttr);
    const glow = glowTexture();
    this.rsGlow = new THREE.Points(rsGeom, new THREE.PointsMaterial({
      color: 0xffb23e, size: 34, sizeAttenuation: false, map: glow,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.rsCore = new THREE.Points(rsGeom, new THREE.PointsMaterial({
      color: 0xfff0cf, size: 7, sizeAttenuation: false, map: glow, transparent: true, depthWrite: false,
    }));
    this.rsGlow.frustumCulled = this.rsCore.frustumCulled = false;
    this.scene.add(this.rsGlow, this.rsCore);

    // Вращение мышью; обработчики висят на холсте под интерфейсом
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 9500;
    this.controls.maxDistance = 70000;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.3;
    // Начальный вид: над Россией
    latLonToVec3(38, 75, 34000, this.camera.position).applyAxisAngle(THREE.Object3D.DEFAULT_UP, gmstAt(catalog.epoch));

    // Модель выбранного аппарата рисуется отдельным проходом поверх глобуса
    this.previewScene = new THREE.Scene();
    this.previewCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    this.previewCamera.position.set(0, 4, 27);
    this.previewCamera.lookAt(0, 0, 0);
    this.previewScene.add(new THREE.AmbientLight(0xbfd8ff, 1.3));
    const key = new THREE.DirectionalLight(0xfff0d8, 2.6);
    key.position.set(4, 6, 5);
    this.previewScene.add(key);
    this.preview = null;
  }

  rebuildRings() {
    const rs = this.catalog.rassvet;
    const pts = new Float32Array(rs.count * RING_SEGMENTS * 6);
    let k = 0;
    for (let i = 0; i < rs.count; i++) {
      if (!rs.alive[i]) continue;
      const j = i * 3, r = rs.radius[i];
      for (let s = 0; s < RING_SEGMENTS; s++) {
        for (let e = 0; e < 2; e++) {
          const ang = ((s + e) / RING_SEGMENTS) * Math.PI * 2;
          const c = Math.cos(ang) * r, sn = Math.sin(ang) * r;
          pts[k++] = c * rs.e1[j] + sn * rs.e2[j];
          pts[k++] = c * rs.e1[j + 1] + sn * rs.e2[j + 1];
          pts[k++] = c * rs.e1[j + 2] + sn * rs.e2[j + 2];
        }
      }
    }
    this.rings.geometry.dispose();
    this.rings.geometry = new THREE.BufferGeometry();
    this.rings.geometry.setAttribute('position', new THREE.BufferAttribute(pts.subarray(0, k), 3));
  }

  // Каталог заново привязали к реальному времени
  resync() {
    this.simT = (Date.now() - this.catalog.epoch.getTime()) / 1000;
    this.rebuildRings();
  }

  now() {
    return new Date(this.catalog.epoch.getTime() + this.simT * 1000);
  }

  setPreview(shipId) {
    if (this.preview) this.previewScene.remove(this.preview);
    this.preview = shipId ? instance(shipId) : null;
    if (this.preview) {
      this.preview.rotation.set(0.25, 0.6, 0);
      this.previewScene.add(this.preview);
    }
  }

  activate() {
    this.controls.enabled = true;
    this.renderer.setPixelRatio(this.pixelRatio);
  }

  deactivate() {
    this.controls.enabled = false;
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    // Глобус встаёт по центру области справа от колонки меню (её размеры заданы
    // в style.css) и уменьшается, если вместе с оболочкой Starlink туда не влезает.
    // На узком экране колонка уходит наверх, глобус остаётся по центру.
    const column = w > 760 ? Math.min(400, w - 40) + THREE.MathUtils.clamp(w * 0.045, 20, 72) : 0;
    const shift = Math.round(column / 2);
    const fit = column ? Math.min(1, ((w - column) * 0.46) / (h * 0.33)) : 1;
    for (const cam of [this.camera, this.previewCamera]) {
      cam.aspect = w / h;
      cam.zoom = fit;
      if (shift) cam.setViewOffset(w, h, -shift, 0, w, h);
      else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
  }

  update(dt) {
    this.simT += dt * this.timeScale;
    const { starlink, rassvet, epoch } = this.catalog;
    starlink.update(this.simT);
    rassvet.update(this.simT);
    this.slAttr.needsUpdate = true;
    this.rsAttr.needsUpdate = true;
    this.gmst = gmstAt(epoch) + EARTH_RATE * this.simT;
    this.globe.group.rotation.y = this.gmst;
    this.controls.update();
    if (this.preview) this.preview.rotation.y += dt * 0.5;
  }

  render() {
    const r = this.renderer;
    r.autoClear = true;
    r.render(this.scene, this.camera);
    if (this.preview) {
      r.autoClear = false;
      r.clearDepth();
      r.render(this.previewScene, this.previewCamera);
      r.autoClear = true;
    }
  }

  // «Рассвет» под курсором (координаты в CSS-пикселях) или null
  pick(x, y) {
    const rs = this.catalog.rassvet;
    const cam = this.camera.position;
    let best = -1, bestD = 22 * 22;
    for (let i = 0; i < rs.count; i++) {
      if (!rs.alive[i]) continue;
      rs.position(i, _p);
      // Аппарат за диском Земли не выбирается
      _d.subVectors(_p, cam);
      const t = THREE.MathUtils.clamp(-cam.dot(_d) / _d.lengthSq(), 0, 1);
      if (_c.copy(cam).addScaledVector(_d, t).length() < R_EARTH) continue;
      _p.project(this.camera);
      const sx = (_p.x * 0.5 + 0.5) * this.w, sy = (-_p.y * 0.5 + 0.5) * this.h;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    rs.position(best, _p);
    const sp = subPoint(_p.x, _p.y, _p.z, this.gmst);
    return { name: rs.names[best], id: rs.ids[best], speed: rs.rate[best] * rs.radius[best], ...sp };
  }
}

const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _c = new THREE.Vector3();
