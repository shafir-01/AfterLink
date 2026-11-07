/** Every sound is synthesised, so nothing has to load and the page works offline. */
export type Cue = 'snap' | 'chime' | 'thud' | 'step' | 'down' | 'up' | 'drop';

class Sound {
  private ctx: AudioContext | null = null;
  private chimedAt = 0;
  muted = false;

  /** A browser only allows audio after a gesture. */
  wake() {
    if (this.muted) return;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private tone(freq: number, to: number, ms: number, gain: number, type: OscillatorType, delay = 0) {
    const ctx = this.ctx!;
    const start = ctx.currentTime + delay / 1000;
    const end = start + ms / 1000;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), end);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }

  private noise(ms: number, gain: number, hz: number) {
    const ctx = this.ctx!;
    const length = Math.ceil((ctx.sampleRate * ms) / 1000);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = hz;
    amp.gain.value = gain;
    source.connect(filter).connect(amp).connect(ctx.destination);
    source.start();
  }

  play(cue: Cue) {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    switch (cue) {
      case 'snap':
        this.noise(70, 0.32, 3400);
        this.tone(1900, 320, 90, 0.07, 'triangle');
        break;
      case 'chime': {
        const now = performance.now();
        if (now - this.chimedAt < 700) return;
        this.chimedAt = now;
        this.tone(1320, 1310, 340, 0.022, 'sine');
        this.tone(1980, 1970, 300, 0.012, 'sine', 70);
        break;
      }
      case 'thud':
        this.tone(120, 46, 240, 0.22, 'sine');
        this.noise(60, 0.07, 240);
        break;
      case 'step':
        this.noise(36, 0.05, 900);
        break;
      case 'down':
        this.tone(480, 42, 900, 0.09, 'sawtooth');
        this.tone(240, 30, 1100, 0.07, 'sine');
        break;
      case 'up':
        this.tone(220, 660, 500, 0.05, 'sine');
        break;
      case 'drop':
        this.tone(740, 560, 110, 0.05, 'sine');
        break;
    }
  }
}

export const sound = new Sound();
