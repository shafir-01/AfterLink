const KEY = 'afterlink.sound.muted';

export type SoundName = 'snap' | 'chime' | 'thud' | 'footstep' | 'powerdown' | 'tick' | 'swell';

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

const write = (muted: boolean) => {
  try {
    localStorage.setItem(KEY, muted ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
};

type Ctor = typeof AudioContext;

/** Web Audio synthesis only. The context is created on the first user gesture. */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bed: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private bedLevel = 1;
  private stepTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private armed = false;
  muted = read();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getMuted = () => this.muted;

  /** Starts the audio context on the first pointer or key press. Safe to call many times. */
  arm() {
    if (this.armed || typeof window === 'undefined') return;
    this.armed = true;
    const go = () => {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      this.start();
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    write(muted);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    if (muted) this.stopSteps();
    this.listeners.forEach((l) => l());
  }

  toggle = () => this.setMuted(!this.muted);

  private start() {
    if (this.ctx) return;
    const C: Ctor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!C) return;
    try {
      this.ctx = new C();
    } catch {
      return;
    }
    const master = this.ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.9;
    master.connect(this.ctx.destination);
    this.master = master;
    void this.ctx.resume().catch(() => undefined);
    this.startBed();
    this.listeners.forEach((l) => l());
  }

  private ready(): { ctx: AudioContext; out: GainNode } | null {
    if (!this.ctx || !this.master || this.muted) return null;
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    return { ctx: this.ctx, out: this.master };
  }

  private tone(freq: number, at: number, dur: number, peak: number, type: OscillatorType = 'sine', glideTo?: number) {
    const r = this.ready();
    if (!r) return;
    const o = r.ctx.createOscillator();
    const g = r.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(r.out);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  private noise(at: number, dur: number, peak: number, freq: number, q = 1, type: BiquadFilterType = 'bandpass') {
    const r = this.ready();
    if (!r) return;
    const len = Math.max(1, Math.floor(r.ctx.sampleRate * dur));
    const buf = r.ctx.createBuffer(1, len, r.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = r.ctx.createBufferSource();
    src.buffer = buf;
    const f = r.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(r.out);
    src.start(at);
  }

  play(name: SoundName) {
    const r = this.ready();
    if (!r) return;
    const t = r.ctx.currentTime;
    switch (name) {
      case 'snap':
        this.noise(t, 0.05, 0.35, 3200, 0.8);
        this.tone(1250, t, 0.09, 0.12, 'triangle', 520);
        break;
      case 'chime':
        this.tone(659.25, t, 0.9, 0.07);
        this.tone(987.77, t + 0.11, 1.1, 0.05);
        break;
      case 'thud':
        this.tone(96, t, 0.28, 0.4, 'sine', 48);
        this.noise(t, 0.06, 0.12, 400, 0.7, 'lowpass');
        break;
      case 'footstep':
        this.noise(t, 0.07, 0.16, 260, 0.9, 'lowpass');
        this.tone(130, t, 0.06, 0.05, 'sine', 80);
        break;
      case 'powerdown':
        this.tone(220, t, 1.6, 0.12, 'sawtooth', 38);
        this.tone(330, t, 1.2, 0.05, 'sine', 55);
        this.setBed(0.35, 1.4);
        break;
      case 'tick':
        this.tone(2400, t, 0.03, 0.09, 'square');
        break;
      case 'swell':
        [220, 277.18, 329.63, 440].forEach((f, i) => {
          const at = t + i * 0.12;
          const g = r.ctx.createGain();
          const o = r.ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(0.06, at + 0.9);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 2.2);
          o.connect(g).connect(r.out);
          o.start(at);
          o.stop(at + 2.3);
        });
        break;
    }
  }

  /** Quiet steps, repeating until stopSteps. */
  startSteps(intervalMs = 520) {
    if (this.stepTimer || this.muted) return;
    this.play('footstep');
    this.stepTimer = setInterval(() => this.play('footstep'), intervalMs);
  }

  stopSteps() {
    if (this.stepTimer) clearInterval(this.stepTimer);
    this.stepTimer = null;
  }

  private startBed() {
    if (!this.ctx || !this.master || this.bed) return;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    [110, 164.81, 220.5].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 0.05 + i * 0.03;
      lg.gain.value = 4;
      lfo.connect(lg).connect(o.detune);
      o.connect(filter);
      o.start();
      lfo.start();
    });
    filter.connect(gain).connect(this.master);
    this.bed = { gain, filter };
    this.setBed(this.bedLevel, 3);
  }

  /** 0..1 of how connected the field is. Lower is a thinner, quieter bed. */
  setBed(level: number, seconds = 1.5) {
    this.bedLevel = Math.max(0, Math.min(1, level));
    if (!this.ctx || !this.bed) return;
    const t = this.ctx.currentTime;
    this.bed.gain.gain.setTargetAtTime(0.004 + 0.022 * this.bedLevel, t, seconds / 3);
    this.bed.filter.frequency.setTargetAtTime(260 + 520 * this.bedLevel, t, seconds / 3);
  }
}

export const sound = new SoundEngine();
