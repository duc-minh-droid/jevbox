// Procedural arena audio: every sound is synthesised with WebAudio — no assets.
// Punches, whooshes, blocks, footsteps, the bell, body falls, a living crowd bed
// with cheers / "ooh"s / whistles, a heartbeat for rocked fighters, and
// voices for the ring announcer, referee count and commentary.
//
// With an ElevenLabs key on the server, voices come from /api/tts (a voice actor
// per role) and generated arena recordings from /api/sfx layer on top of the synth.
// Without it everything falls back to synth + browser SpeechSynthesis.

export class ArenaAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.voiceOn = true;
    this.commentaryVoice = false;
    this.hype = 0.6;
    this._voices = [];
    this.xi = false;                 // ElevenLabs available on the server
    this.sampleData = {};            // name -> Promise<ArrayBuffer> (fetched before the context exists)
    this.samples = {};               // name -> AudioBuffer
    this.voiceCache = new Map();     // role|text -> Promise<ArrayBuffer>
    this.voiceNow = {};              // channel -> { src, priority }
    this.announcerQueue = Promise.resolve();
  }

  // ---------- ElevenLabs assets ----------
  async prefetch() {
    try {
      const st = await fetch('/api/voice/status').then((r) => r.json());
      this.xi = !!st.enabled;
      if (!this.xi) return false;
      this.commentaryVoice = true;
      for (const name of st.sfx) {
        this.sampleData[name] = fetch(`/api/sfx/${name}`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      }
      return true;
    } catch { return false; }
  }
  decodeSamples() {
    for (const [name, p] of Object.entries(this.sampleData)) {
      p.then(async (ab) => {
        if (!ab || this.samples[name]) return;
        try {
          this.samples[name] = await this.ctx.decodeAudioData(ab.slice(0));
          if (name === 'crowd_loop') this.startCrowdLoop();
        } catch { /* keep the synth version */ }
      });
    }
  }
  sample(name, { gain = 1, rate = 1, pan = 0, bus = this.sfx, at = 0 } = {}) {
    const buf = this.samples[name];
    if (!buf || !this.ok) return null;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain(), p = this.panner(pan);
    s.buffer = buf;
    s.playbackRate.value = rate;
    g.gain.value = gain;
    s.connect(g).connect(p).connect(bus);
    s.start(this.ctx.currentTime + at);
    return s;
  }
  startCrowdLoop() {
    if (this.crowdLoop || !this.samples.crowd_loop) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.samples.crowd_loop;
    s.loop = true;
    this.crowdLoopGain = this.ctx.createGain();
    this.crowdLoopGain.gain.value = 0;
    this.crowdLoopGain.gain.setTargetAtTime(0.75, this.ctx.currentTime, 1.5);
    s.connect(this.crowdLoopGain).connect(this.crowdOut);
    s.start();
    this.crowdLoop = s;
    this.murmurGain.gain.setTargetAtTime(0.06, this.ctx.currentTime, 1);   // the real crowd replaces the synth murmur
  }
  fetchVoice(role, text) {
    const k = `${role}|${text}`;
    if (!this.voiceCache.has(k)) {
      this.voiceCache.set(k, fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, role }) })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('tts ' + r.status))))
        .catch((e) => { this.voiceCache.delete(k); throw e; }));
    }
    return this.voiceCache.get(k);
  }
  prewarm(lines) { if (this.xi) for (const [role, text] of lines) this.fetchVoice(role, text).catch(() => {}); }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);

    // arena reverb (generated impulse response)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeIR(2.4, 2.8);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.35;
    this.revSend.connect(this.reverb).connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.95;
    this.sfx.connect(this.master);
    this.sfx.connect(this.revSend);

    this.noiseBuf = this.makeNoise(2, 'white');
    this.pinkBuf = this.makeNoise(4, 'pink');
    this.brownBuf = this.makeNoise(4, 'brown');
    this.startCrowd();
    this.loadVoices();
    // voice bus: PA-style high-pass, a touch of arena reverb, ducks the crowd while someone talks
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1.1;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 110;
    this.voiceBus.connect(hp).connect(this.master);
    this.voiceSend = ctx.createGain();
    this.voiceSend.gain.value = 0.18;
    hp.connect(this.voiceSend).connect(this.reverb);
    this.decodeSamples();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
    if (m && window.speechSynthesis) speechSynthesis.cancel();
  }

  // ---------- building blocks ----------
  makeNoise(sec, color) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (color === 'pink') {
        b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      } else if (color === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }
  makeIR(sec, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return buf;
  }
  noise(buf = this.noiseBuf, loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    if (!loop) s.playbackRate.value = 0.9 + Math.random() * 0.2;
    return s;
  }
  env(gainNode, t, a, peak, d, sustain = 0.0001) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + a);
    g.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + d);
  }
  panner(x = 0) {
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : this.ctx.createGain();
    if (p.pan) p.pan.value = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    return p;
  }
  get ok() { return this.ctx && this.ctx.state === 'running' && !this.muted; }

  // ---------- sfx ----------
  punch(power = 0.5, { blocked = false, body = false, pan = 0 } = {}) {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime, out = this.panner(pan);
    const synthGain = ctx.createGain();
    out.connect(synthGain).connect(this.sfx);
    // recorded impact on top; the synth layer then only adds weight
    const rec = blocked ? 'block' : body ? 'punch_body' : power > 0.45 ? 'punch_heavy' : 'punch_light';
    if (this.sample(rec, { gain: 0.5 + power * 0.7, rate: 0.9 + Math.random() * 0.2, pan })) synthGain.gain.value = 0.5;
    // low thump (pitch-dropping sine)
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine';
    const f0 = (blocked ? 110 : body ? 95 : 140) * (1.15 - power * 0.35) * (0.92 + Math.random() * 0.16);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16 + power * 0.1);
    this.env(og, t, 0.004, (blocked ? 0.55 : 0.95) * (0.55 + power * 0.6), 0.2 + power * 0.15);
    o.connect(og).connect(out);
    o.start(t); o.stop(t + 0.5);
    // leather slap
    const n = this.noise(), f = ctx.createBiquadFilter(), ng = ctx.createGain();
    f.type = blocked ? 'lowpass' : 'bandpass';
    f.frequency.value = blocked ? 900 : body ? 1200 : 1900 + power * 900;
    f.Q.value = blocked ? 0.7 : 0.9;
    this.env(ng, t, 0.002, (blocked ? 0.5 : 0.8) * (0.6 + power * 0.5), 0.07 + power * 0.05);
    n.connect(f).connect(ng).connect(out);
    n.start(t); n.stop(t + 0.3);
    // crack for heavy clean shots
    if (power > 0.55 && !blocked) {
      const c = this.noise(), hp = ctx.createBiquadFilter(), cg = ctx.createGain();
      hp.type = 'highpass'; hp.frequency.value = 3200;
      this.env(cg, t, 0.001, 0.45 * power, 0.035);
      c.connect(hp).connect(cg).connect(out);
      c.start(t); c.stop(t + 0.1);
      // sub boom
      const s = ctx.createOscillator(), sg = ctx.createGain();
      s.frequency.setValueAtTime(70, t);
      s.frequency.exponentialRampToValueAtTime(32, t + 0.45);
      this.env(sg, t, 0.005, 0.7 * power, 0.5);
      s.connect(sg).connect(out);
      s.start(t); s.stop(t + 0.6);
    }
  }

  whoosh(power = 0.5, pan = 0) {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime, dur = 0.12 + power * 0.14;
    const n = this.noise(), f = ctx.createBiquadFilter(), g = ctx.createGain(), out = this.panner(pan);
    f.type = 'bandpass'; f.Q.value = 1.8;
    f.frequency.setValueAtTime(450, t);
    f.frequency.exponentialRampToValueAtTime(2200 + power * 1500, t + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22 + power * 0.25, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g).connect(out).connect(this.sfx);
    n.start(t); n.stop(t + dur + 0.05);
  }

  step(speed = 1, pan = 0) {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime, out = this.panner(pan);
    out.connect(this.sfx);
    const n = this.noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = 500;
    this.env(g, t, 0.002, 0.08 + Math.min(0.1, speed * 0.04), 0.05);
    n.connect(f).connect(g).connect(out);
    n.start(t); n.stop(t + 0.1);
    if (Math.random() < 0.35) {     // shoe squeak on the canvas
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'triangle';
      const f0 = 2400 + Math.random() * 1400;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.linearRampToValueAtTime(f0 * (1.1 + Math.random() * 0.2), t + 0.05);
      this.env(og, t, 0.004, 0.035, 0.06);
      o.connect(og).connect(out);
      o.start(t); o.stop(t + 0.1);
    }
  }

  ropes(power = 0.5) {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.35);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 420;
    this.env(g, t, 0.01, 0.2 * power, 0.4);
    o.connect(f).connect(g).connect(this.sfx);
    o.start(t); o.stop(t + 0.5);
  }

  fall(power = 1) {
    if (!this.ok) return;
    this.sample('fall', { gain: 1.1 * power });
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [dt, p] of [[0, 1], [0.16, 0.45]]) {
      const n = this.noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.frequency.value = 380;
      this.env(g, t + dt, 0.005, 1.1 * power * p, 0.4);
      n.connect(f).connect(g).connect(this.sfx);
      n.start(t + dt); n.stop(t + dt + 0.5);
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.setValueAtTime(75, t + dt);
      o.frequency.exponentialRampToValueAtTime(30, t + dt + 0.5);
      this.env(og, t + dt, 0.005, 0.9 * power * p, 0.55);
      o.connect(og).connect(this.sfx);
      o.start(t + dt); o.stop(t + dt + 0.7);
    }
  }

  bell(times = 1) {
    if (!this.ok) return;
    if (this.samples.bell) {
      for (let i = 0; i < times; i++) this.sample('bell', { gain: 0.9, at: i * 0.36 });
      return;
    }
    const ctx = this.ctx;
    const partials = [[1, 1], [2.0, 0.35], [2.76, 0.55], [3.9, 0.22], [5.4, 0.18], [6.8, 0.1]];
    for (let i = 0; i < times; i++) {
      const t = ctx.currentTime + i * 0.34;
      for (const [r, a] of partials) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 830 * r;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.28 * a, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2 / Math.sqrt(r));
        o.connect(g).connect(this.sfx);
        o.start(t); o.stop(t + 2.4);
      }
    }
  }

  blip(up = true) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(up ? 660 : 880, t);
    o.frequency.exponentialRampToValueAtTime(up ? 1320 : 440, t + 0.08);
    this.env(g, t, 0.003, 0.12, 0.1);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.15);
  }

  whistleRef() {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.frequency.value = 2900;
    lfo.frequency.value = 38; lg.gain.value = 140;
    lfo.connect(lg).connect(o.frequency);
    this.env(g, t, 0.01, 0.12, 0.45, 0.05);
    o.connect(g).connect(this.sfx);
    o.start(t); lfo.start(t); o.stop(t + 0.5); lfo.stop(t + 0.5);
  }

  heartbeat() {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [dt, a] of [[0, 1], [0.22, 0.7]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(62, t + dt);
      o.frequency.exponentialRampToValueAtTime(40, t + dt + 0.15);
      this.env(g, t + dt, 0.01, 0.5 * a, 0.18);
      o.connect(g).connect(this.master);
      o.start(t + dt); o.stop(t + dt + 0.3);
    }
  }

  // ---------- crowd ----------
  startCrowd() {
    const ctx = this.ctx;
    this.crowdOut = ctx.createGain();
    this.crowdOut.gain.value = 0.55;
    this.crowdOut.connect(this.master);
    this.crowdOut.connect(this.revSend);
    // murmur: band-limited pink noise with a wandering amplitude
    const m = this.noise(this.pinkBuf, true), mf = ctx.createBiquadFilter();
    mf.type = 'bandpass'; mf.frequency.value = 520; mf.Q.value = 0.6;
    this.murmurGain = ctx.createGain();
    this.murmurGain.gain.value = 0.25;
    m.connect(mf).connect(this.murmurGain).connect(this.crowdOut);
    m.start();
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 0.37; lg.gain.value = 0.06;
    lfo.connect(lg).connect(this.murmurGain.gain);
    lfo.start();
    // roar: brighter noise that follows hype
    const r = this.noise(this.pinkBuf, true), rf = ctx.createBiquadFilter(), rf2 = ctx.createBiquadFilter();
    r.playbackRate.value = 1.3;
    rf.type = 'bandpass'; rf.frequency.value = 1100; rf.Q.value = 0.5;
    rf2.type = 'peaking'; rf2.frequency.value = 2600; rf2.gain.value = 5;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0.02;
    r.connect(rf).connect(rf2).connect(this.roarGain).connect(this.crowdOut);
    r.start();
    this._lastWhistle = 0;
  }

  setHype(h) {
    this.hype = h;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.roarGain.gain.setTargetAtTime(0.02 + Math.max(0, h - 0.3) * 0.16, t, 0.6);
    this.murmurGain.gain.setTargetAtTime(0.22 + h * 0.05, t, 0.8);
    if (h > 1.3 && t - this._lastWhistle > 2.5 && Math.random() < 0.02) { this._lastWhistle = t; this.crowdWhistle(); }
  }

  cheer(amount = 1) {
    if (!this.ok) return;
    if (this.sample(amount >= 1.8 ? 'roar' : 'cheer', { gain: Math.min(1.4, 0.45 + amount * 0.4), rate: 0.95 + Math.random() * 0.1, bus: this.crowdOut })) amount *= 0.35;
    const ctx = this.ctx, t = ctx.currentTime, dur = 1.4 + amount * 1.6;
    for (const fq of [900, 1500, 2600]) {
      const n = this.noise(this.pinkBuf), f = ctx.createBiquadFilter(), g = ctx.createGain();
      n.playbackRate.value = 1 + Math.random() * 0.3;
      f.type = 'bandpass'; f.frequency.value = fq * (0.9 + Math.random() * 0.2); f.Q.value = 1.2;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.35 * amount, t + 0.18);
      g.gain.setTargetAtTime(0.0001, t + 0.5, dur * 0.35);
      n.connect(f).connect(g).connect(this.crowdOut);
      n.start(t); n.stop(t + dur + 1);
    }
  }

  ooh(amount = 1) {
    if (!this.ok) return;
    if (this.sample('ooh', { gain: 0.9 * amount, rate: 0.95 + Math.random() * 0.1, bus: this.crowdOut })) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [f0, f1] of [[420, 300], [900, 640]]) {
      const n = this.noise(this.pinkBuf), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'bandpass'; f.Q.value = 6;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.linearRampToValueAtTime(f1, t + 1.0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(1.2 * amount, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      n.connect(f).connect(g).connect(this.crowdOut);
      n.start(t); n.stop(t + 1.4);
    }
  }

  crowdWhistle() {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), p = this.panner(Math.random() * 2 - 1);
    const f0 = 1800 + Math.random() * 800;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * 1.5, t + 0.25);
    o.frequency.linearRampToValueAtTime(f0 * 1.2, t + 0.6);
    this.env(g, t, 0.03, 0.05, 0.6, 0.01);
    o.connect(g).connect(p).connect(this.crowdOut);
    o.start(t); o.stop(t + 0.7);
  }

  // ---------- voice ----------
  loadVoices() {
    if (!window.speechSynthesis) return;
    const pick = () => {
      const vs = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
      this._voices = vs;
      const pref = (re) => vs.find((v) => re.test(v.name));
      this.announcerVoice = pref(/Guy|David|Daniel|Alex|Google UK English Male|Male/i) || vs[0];
      this.refVoice = pref(/Mark|George|Fred|Google US English|Ryan/i) || this.announcerVoice;
      this.commVoiceA = pref(/Christopher|Eric|Andrew|Google UK English Male/i) || this.announcerVoice;
      this.commVoiceB = pref(/Jenny|Aria|Zira|Samantha|Female/i) || this.announcerVoice;
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
  }
  speak(text, { who = 'announcer', rate = 1, pitch = 1, interrupt = false, volume = 1, priority = 1 } = {}) {
    if (this.muted || !this.voiceOn) return;
    if (who.startsWith('comm') && !this.commentaryVoice) return;
    if (this.xi && this.ctx) { this.speakXi(text, who, { interrupt, priority }); return; }
    if (!window.speechSynthesis) return;
    if (interrupt) speechSynthesis.cancel();
    if (who.startsWith('comm') && speechSynthesis.pending) return;   // never queue stale commentary
    const u = new SpeechSynthesisUtterance(text);
    u.voice = { announcer: this.announcerVoice, ref: this.refVoice, commA: this.commVoiceA, commB: this.commVoiceB }[who] || null;
    u.rate = rate; u.pitch = pitch; u.volume = volume;
    speechSynthesis.speak(u);
  }

  // ElevenLabs playback. Channels: announcer (queued), ref (interrupts), comm (drops stale / low-priority lines)
  speakXi(text, who, { interrupt, priority }) {
    const chan = who.startsWith('comm') ? 'comm' : who;
    const asked = this.ctx.currentTime;
    const play = async () => {
      let ab;
      try { ab = await this.fetchVoice(who, text); } catch { return; }
      const late = this.ctx.currentTime - asked;
      if (chan === 'comm' && late > (priority >= 2 ? 3 : 1.6)) return;     // about something long gone
      if (chan === 'ref' && late > 0.9) return;                               // stale count
      const cur = this.voiceNow[chan];
      if (cur && chan === 'comm' && priority < 2 && priority <= cur.priority) return;
      let buf;
      try { buf = await this.ctx.decodeAudioData(ab.slice(0)); } catch { return; }
      if (cur) { try { cur.src.stop(); } catch { /* already ended */ } }
      const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
      src.buffer = buf;
      g.gain.value = chan === 'announcer' ? 1.15 : chan === 'ref' ? 1.0 : 0.85;
      src.connect(g).connect(this.voiceBus);
      const entry = { src, priority };
      this.voiceNow[chan] = entry;
      this.duck(true);
      const done = new Promise((r) => { src.onended = r; });
      done.then(() => {
        if (this.voiceNow[chan] === entry) this.voiceNow[chan] = null;
        if (!Object.values(this.voiceNow).some(Boolean)) this.duck(false);
      });
      src.start();
      if (chan === 'announcer') await done;
    };
    if (chan === 'announcer' && !interrupt) this.announcerQueue = this.announcerQueue.then(play);
    else play();
  }
  duck(on) {
    if (!this.crowdOut) return;
    this.crowdOut.gain.setTargetAtTime(on ? 0.3 : 0.55, this.ctx.currentTime, on ? 0.08 : 0.5);
  }
}
