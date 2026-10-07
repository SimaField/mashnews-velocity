// Экранное управление для телефона: джойстик под левый палец, кнопки под правый.
// Кнопки «зажимают» те же клавиши, что и клавиатура, поэтому бою всё равно, чем управляют.
const STICK_RADIUS = 52; // ход ручки джойстика, пиксели
const DEAD_ZONE = 0.1;

const MARKUP = `
  <div class="t-zone"><div class="t-base"><div class="t-knob"></div></div></div>
  <button class="t-btn t-fire" data-hold="Space">ОГОНЬ</button>
  <button class="t-btn t-boost" data-hold="ShiftLeft">ФОРСАЖ</button>
  <button class="t-btn t-missile" data-tap="KeyF">РАКЕТА<b></b></button>
  <button class="t-btn t-target" data-tap="KeyT">ЦЕЛЬ</button>
  <button class="t-btn t-pause" aria-label="Пауза">II</button>`;

// Захват указателя: палец может съехать с кнопки, а отпускание всё равно должно прийти ей.
// Браузер отказывает, если указатель уже неактивен, — это не повод ронять обработчик.
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // отпускание придёт обычным путём
  }
}

export class TouchControls {
  constructor(root, input, onPause) {
    this.root = root;
    this.input = input;
    root.innerHTML = MARKUP;
    this.zone = root.querySelector('.t-zone');
    this.base = root.querySelector('.t-base');
    this.knob = root.querySelector('.t-knob');
    this.missiles = root.querySelector('.t-missile b');
    this.stickPointer = null;
    this.shown = -1;

    this.zone.addEventListener('pointerdown', (e) => this.stickStart(e));
    this.zone.addEventListener('pointermove', (e) => this.stickMove(e));
    for (const type of ['pointerup', 'pointercancel']) this.zone.addEventListener(type, (e) => this.stickEnd(e));

    for (const btn of root.querySelectorAll('[data-hold]')) {
      const set = (on) => (e) => {
        e.preventDefault();
        if (on) capture(btn, e.pointerId);
        btn.classList.toggle('on', on);
        if (input.enabled || !on) input.hold(btn.dataset.hold, on);
      };
      btn.addEventListener('pointerdown', set(true));
      btn.addEventListener('pointerup', set(false));
      btn.addEventListener('pointercancel', set(false));
    }
    for (const btn of root.querySelectorAll('[data-tap]')) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (input.enabled) input.tap(btn.dataset.tap);
      });
    }
    root.querySelector('.t-pause').addEventListener('click', onPause);
    // Долгое нажатие не должно вызывать меню браузера
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setVisible(on) {
    this.root.classList.toggle('hidden', !on);
    if (!on) this.release();
  }

  // Отпускает всё: при паузе палец может остаться на кнопке, а событие «отпустил» не прийти
  release() {
    this.stickPointer = null;
    this.zone.classList.remove('on');
    this.base.style.left = this.base.style.top = '';
    this.knob.style.transform = '';
    this.input.stick.x = this.input.stick.y = 0;
    for (const btn of this.root.querySelectorAll('[data-hold]')) {
      btn.classList.remove('on');
      this.input.hold(btn.dataset.hold, false);
    }
  }

  setMissiles(n) {
    if (n === this.shown) return;
    this.shown = n;
    this.missiles.textContent = n;
    this.missiles.parentElement.classList.toggle('empty', n === 0);
  }

  // Основание джойстика встаёт под палец, где бы он ни коснулся левой части экрана
  stickStart(e) {
    if (this.stickPointer !== null) return;
    e.preventDefault();
    this.stickPointer = e.pointerId;
    capture(this.zone, e.pointerId);
    const box = this.zone.getBoundingClientRect();
    const half = this.base.offsetWidth / 2;
    this.cx = Math.min(Math.max(e.clientX, box.left + half), box.right - half);
    this.cy = Math.min(Math.max(e.clientY, box.top + half), box.bottom - half);
    this.base.style.left = `${this.cx - box.left}px`;
    this.base.style.top = `${this.cy - box.top}px`;
    this.zone.classList.add('on');
    this.stickMove(e);
  }

  stickMove(e) {
    if (e.pointerId !== this.stickPointer) return;
    let dx = e.clientX - this.cx, dy = e.clientY - this.cy;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx *= STICK_RADIUS / len;
      dy *= STICK_RADIUS / len;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // Небольшая мёртвая зона и плавный рост у центра: мелкие поправки курса не дёргают корабль
    const curve = (v) => {
      const a = Math.abs(v) / STICK_RADIUS;
      return a < DEAD_ZONE ? 0 : Math.sign(v) * ((a - DEAD_ZONE) / (1 - DEAD_ZONE)) ** 1.4;
    };
    if (this.input.enabled) {
      this.input.stick.x = curve(dx);
      this.input.stick.y = curve(dy);
    }
  }

  stickEnd(e) {
    if (e.pointerId !== this.stickPointer) return;
    this.stickPointer = null;
    this.zone.classList.remove('on');
    this.base.style.left = this.base.style.top = '';
    this.knob.style.transform = '';
    this.input.stick.x = this.input.stick.y = 0;
  }
}
