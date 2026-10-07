// Клавиатура и мышь для боя. Пока enabled = false, события игнорируются
// и браузерные действия клавиш не блокируются.
const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyT', 'KeyV', 'ShiftLeft', 'ShiftRight',
]);

export class Input {
  constructor() {
    this.enabled = false;
    this.keys = new Set();
    this.keysHit = new Set();
    this.buttons = new Set();
    this.buttonsHit = new Set();
    this.dx = 0;
    this.dy = 0;

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.keysHit.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.buttons.add(e.button);
      this.buttonsHit.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || !document.pointerLockElement) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
    window.addEventListener('blur', () => this.reset());
  }

  reset() {
    this.keys.clear();
    this.keysHit.clear();
    this.buttons.clear();
    this.buttonsHit.clear();
    this.dx = this.dy = 0;
  }

  down(code) {
    return this.keys.has(code);
  }

  // Нажатие в этом кадре (сбрасывается в endFrame)
  pressed(code) {
    return this.keysHit.has(code);
  }

  mouseDown(button) {
    return this.buttons.has(button);
  }

  mousePressed(button) {
    return this.buttonsHit.has(button);
  }

  takeMouse(out) {
    out.x = this.dx;
    out.y = this.dy;
    this.dx = this.dy = 0;
    return out;
  }

  endFrame() {
    this.keysHit.clear();
    this.buttonsHit.clear();
  }
}
