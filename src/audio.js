// Звуки синтезируются на WebAudio, файлов нет
export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  // Браузер разрешает звук только после действия пользователя
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);

      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, len);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      // Гул двигателя: пила через фильтр, высота зависит от скорости
      this.engOsc = this.ctx.createOscillator();
      this.engOsc.type = 'sawtooth';
      this.engOsc.frequency.value = 50;
      this.engFilter = this.ctx.createBiquadFilter();
      this.engFilter.type = 'lowpass';
      this.engFilter.frequency.value = 220;
      this.engGain = this.ctx.createGain();
      this.engGain.gain.value = 0;
      this.engOsc.connect(this.engFilter).connect(this.engGain).connect(this.master);
      this.engOsc.start();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.5;
  }

  tone(type, f0, f1, dur, gain, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noise(f0, f1, dur, gain, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(f0, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  shot() {
    this.tone('square', 760, 190, 0.07, 0.07);
    this.noise(4200, 900, 0.05, 0.1);
  }

  bolt() {
    this.tone('sawtooth', 420, 140, 0.16, 0.05);
  }

  missile() {
    this.noise(500, 3800, 0.55, 0.22);
    this.tone('sawtooth', 110, 320, 0.4, 0.07);
  }

  boom(size = 1) {
    this.noise(1400, 50, 0.5 + 0.35 * size, 0.42 * Math.min(1.4, size));
    this.tone('sine', 130, 28, 0.45 + 0.25 * size, 0.38);
  }

  hit() {
    this.noise(2600, 300, 0.16, 0.3);
    this.tone('square', 190, 70, 0.14, 0.12);
  }

  spark() {
    this.tone('square', 1500, 700, 0.04, 0.05);
  }

  pickup() {
    this.tone('square', 660, 660, 0.08, 0.09);
    this.tone('square', 880, 880, 0.08, 0.09, 0.08);
    this.tone('square', 1320, 1320, 0.14, 0.09, 0.16);
  }

  lock() {
    this.tone('square', 1250, 1250, 0.05, 0.06);
  }

  alarm() {
    this.tone('square', 620, 620, 0.12, 0.09);
    this.tone('square', 460, 460, 0.12, 0.09, 0.14);
  }

  click() {
    this.tone('square', 900, 600, 0.05, 0.07);
  }

  fanfare(win) {
    const notes = win ? [392, 523, 659, 784] : [330, 262, 196, 147];
    notes.forEach((f, i) => this.tone('square', f, f, 0.22, 0.1, i * 0.16));
  }

  // speed 0…1, вызывается каждый кадр; active = false глушит двигатель
  engine(speed, boost, active = true) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engOsc.frequency.setTargetAtTime(42 + speed * 46 + (boost ? 30 : 0), t, 0.08);
    this.engFilter.frequency.setTargetAtTime(180 + speed * 260 + (boost ? 700 : 0), t, 0.08);
    this.engGain.gain.setTargetAtTime(active ? 0.1 + (boost ? 0.12 : 0) : 0, t, 0.1);
  }
}
