const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

try { process.loadEnvFile(); } catch { /* no .env — fallback mode */ }

const API_KEY = process.env.TYPESAFE_API_KEY || '';
const PORT = process.env.PORT || 3000;
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const DECIDE_TIMEOUT_MS = 6000;

const ACTION_CRITERIA = {
  advance: 'Close the distance. Use when in_range is false; a punch chosen out of range also auto-advances first',
  retreat: 'Step back to create space and breathe; bad when cornered or on the ropes',
  circle: 'Strafe laterally to a better angle — the right way off the ropes or out of a corner',
  jab: 'Fast lead-hand punch. 5 stamina, ~4 dmg, very hard to react to, sets up everything else',
  cross: 'Straight rear-hand power punch. 10 stamina, ~9 dmg',
  hook: 'Looping lead hook to the head. 11 stamina, ~10 dmg; goes around a high guard',
  uppercut: 'Rear uppercut up the middle. 12 stamina, ~11 dmg, big poise damage — great vs a shelled-up or rocked opponent',
  body: 'Hook to the body. 9 stamina, ~6 dmg but drains the opponent\'s stamina and max stamina; often sneaks under a high guard',
  combo: '2–3 punch combination (e.g. jab-cross-hook). ~20 stamina; overwhelms, but you are committed while throwing',
  haymaker: 'Huge overhand. 18 stamina, ~18 dmg, heavily telegraphed (easy to slip) — best against a rocked, tired or predictable opponent',
  push: 'Two-hand shove, no damage — breaks pressure and buys space when cornered',
  clinch: 'Tie the opponent up for ~1.6s. Recover stamina and poise while the action pauses — smart when hurt or gassed',
  block: 'High guard: head punches do ~20% damage (50% if guard is worn down); body shots may still get through',
  dodge: 'Slip/duck/pull back — a slipped punch whiffs completely and opens a counter window (+35% on your next hit)',
  rest: 'Breathe in place: fast stamina recovery, but wide open',
  taunt: 'Showboat: small stamina gain and pumps the crowd, but you take +50% damage if hit',
  lead_upper: 'Lead-hand uppercut. 9 stamina, ~8 dmg, quick — splits a high guard at close range',
  check_hook: 'Lead hook while pivoting off to the side. 10 stamina, ~8 dmg — punishes a charging opponent and turns you off the ropes',
  body_jab: 'Level-change jab to the stomach. 5 stamina, ~3 dmg, drains stamina, safe way to score vs a high guard',
  feint: 'Fake a punch. 2 stamina, no damage — baits the opponent into blocking or slipping, then you punch the opening',
  weave: 'Bob and weave under punches while stepping in — evades hooks and overhands and sets up a counter',
  special: 'Your signature SUPER move. Only when special_ready is true — a devastating multi-hit sequence. Otherwise it becomes a combo',
};
const ACTIONS = Object.keys(ACTION_CRITERIA);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// Per-IP sliding-window rate limits (in-memory, per server instance). The keys are
// server-side only, but a public URL means anyone can call these endpoints.
const hits = new Map();
function limited(req, bucket, max, windowMs) {
  if (!process.env.VERCEL && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.ip)) return false;   // local dev / prebuild scripts
  const k = `${bucket}|${req.ip}`, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(k, arr);
  if (hits.size > 5000) for (const [key, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(key);
  return arr.length > max;
}
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(API_KEY) });
});

function buildQuestions() {
  const fighterInstructions = (who) => ({
    question: `You are ${who}, a boxer in a live fight. Choose your single next action.`,
    guidance:
      'Fight like a real boxer. Weigh in_range, stamina, poise, guard, momentum, ring position and the opponent\'s ' +
      'recent pattern. Establish the jab, mix head and body, and vary your attacks — repeating yourself makes you ' +
      'predictable and easy to slip and counter. If cornered or on the ropes, circle out or push rather than retreating deeper. ' +
      'If hurt, rocked, gassed or overwhelmed, prioritise survival (block, dodge, circle, clinch) until you stabilise. ' +
      'If the opponent is rocked, gassed or shelled up, press: uppercuts, body shots and combinations. Haymakers are for ' +
      'finishing, not leading. Counter windows reward punching right after a slip. Judges score clean punches, power shots, ' +
      'counters, slips and knockdowns each round — if behind_on_cards late, take risks; if ahead, box smart. ' +
      'Your fighting_style describes your personality — lean into it. When special_ready is true, save the special ' +
      'for a moment it will land (opponent rocked, gassed, cornered or just missed).',
  });
  return {
    red_action: { type: 'choice', instructions: fighterInstructions('RED'), criteria: ACTION_CRITERIA },
    blue_action: { type: 'choice', instructions: fighterInstructions('BLUE'), criteria: ACTION_CRITERIA },
    crowd_hype: {
      type: 'score',
      instructions: 'How excited should the crowd be about the fight right now?',
      criteria: [
        'Quiet: little action, fighters circling or resting',
        'Warm: regular exchanges and hits landing',
        'Electric: heavy hits landing, someone rocked or a knockdown is imminent',
      ],
    },
  };
}

// Local heuristic brain: returns a probability distribution (so the client can
// sample it and show it on the HUD exactly like a Jev answer).
function fallbackChoice(self, opp) {
  const w = Object.fromEntries(ACTIONS.map((a) => [a, 0.01]));
  const add = (k, v) => { w[k] += v; };
  const status = new Set(self.status || []);
  const oppStatus = new Set(opp.status || []);
  const oppAttacking = ['jab', 'cross', 'hook', 'uppercut', 'body', 'combo', 'haymaker'].includes(opp.action);
  if (!self.in_range) {
    add('advance', 3); add('circle', 0.6); add('jab', 0.6);
    if (self.stamina < 35) add('rest', 1.5);
  } else {
    add('jab', 2); add('cross', 1.3); add('hook', 1); add('body', 1); add('combo', 1.1);
    add('uppercut', 0.6); add('block', 0.7); add('dodge', 0.8); add('circle', 0.4); add('haymaker', 0.25);
    if (oppAttacking) { add('dodge', 1.4); add('block', 1.2); }
    if (oppStatus.has('rocked') || opp.hp < 30) { add('haymaker', 1.8); add('uppercut', 1.4); add('combo', 1.5); }
    if (oppStatus.has('gassed')) { add('body', 1); add('combo', 0.8); }
    if (self.counter_ready) { add('cross', 2); add('hook', 1.5); }
    if (opp.action === 'block') { add('body', 1.5); add('uppercut', 1.2); add('body_jab', 1); add('feint', 1); add('lead_upper', 1); }
    add('lead_upper', 0.5); add('body_jab', 0.6); add('check_hook', 0.4); add('feint', 0.4); add('weave', 0.5);
    if (self.special_ready) add('special', oppStatus.has('rocked') || opp.hp < 40 ? 6 : 2.5);
  }
  if (!self.special_ready) w.special = 0;
  if (self.cornered || self.on_ropes) { add('circle', 2.5); add('push', 1.2); add('check_hook', 1.2); w.retreat = 0.01; }
  if (status.has('rocked') || self.hp < 25) { add('clinch', 2); add('block', 1.5); add('dodge', 1); add('circle', 1); }
  if (self.stamina < 20) { add('rest', 2); add('clinch', 1); add('block', 0.8); for (const k of ['combo', 'haymaker', 'uppercut']) w[k] *= 0.2; }
  if (self.behind_on_cards) { add('combo', 0.6); add('haymaker', 0.4); }
  if (self.momentum > 20 && Math.random() < 0.3) add('taunt', 0.5);
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  const probabilities = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, +(v / total).toFixed(3)]));
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
}

function fallbackAnswers(state) {
  const recentHits = (state.fight.recent_events || []).filter((e) => /lands|KNOCKDOWN/i.test(e)).length;
  return {
    red_action: fallbackChoice(state.red, state.blue),
    blue_action: fallbackChoice(state.blue, state.red),
    crowd_hype: { type: 'score', score: Math.min(3, 1 + recentHits * 0.5) },
  };
}

app.post('/api/decide', async (req, res) => {
  const state = req.body && req.body.state;
  if (state && state.red && state.blue && state.fight && limited(req, 'decide', 120, 60_000)) {
    return res.json({ source: 'fallback', reason: 'rate limited', answers: fallbackAnswers(state), latencyMs: 0 });
  }
  if (!state || !state.red || !state.blue || !state.fight) {
    return res.status(400).json({ error: 'missing state.red/state.blue/state.fight' });
  }
  if (req.body.forceFallback) {
    return res.json({ source: 'fallback', reason: 'local brain selected', answers: fallbackAnswers(state), latencyMs: 0 });
  }
  if (!API_KEY) {
    return res.json({ source: 'fallback', reason: 'TYPESAFE_API_KEY not set', answers: fallbackAnswers(state) });
  }

  const questions = buildQuestions();
  const started = Date.now();
  try {
    const upstream = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: 'jev-latest', questions }),
      signal: AbortSignal.timeout(DECIDE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.json({ source: 'fallback', reason: `typesafe ${upstream.status}: ${text.slice(0, 200)}`, answers: fallbackAnswers(state), latencyMs });
    }
    const data = await upstream.json();
    res.json({ source: 'jev', latencyMs, model: data.model, usage: data.usage, answers: data.answers });
  } catch (err) {
    res.json({ source: 'fallback', reason: String((err && err.message) || err), answers: fallbackAnswers(state), latencyMs: Date.now() - started });
  }
});

// ---------------- ElevenLabs: voices + generated arena SFX ----------------
// The key never leaves the server. Every clip is cached on disk by content hash,
// so each line / sound effect costs credits once.
const XI_KEY = process.env.ELEVENLABS_API_KEY || '';
const XI_URL = 'https://api.elevenlabs.io/v1';
// Committed clips live in audio-cache/ (read-only on Vercel); new ones go to a writable dir.
const SEED_DIR = path.join(__dirname, 'audio-cache');
const CACHE_DIR = process.env.VERCEL ? path.join(require('os').tmpdir(), 'jevbox-cache') : SEED_DIR;
for (const d of ['tts', 'sfx']) fs.mkdirSync(path.join(CACHE_DIR, d), { recursive: true });
const DAILY_TTS_CHARS = +(process.env.DAILY_TTS_CHARS || 20000);   // cap on newly generated speech per instance per day
let ttsBudget = { day: new Date().toDateString(), used: 0 };

const VOICE_ROLES = {
  announcer: { voice: 'pNInz6obpgDQGcFmaJgB', model: 'eleven_multilingual_v2', settings: { stability: 0.3, similarity_boost: 0.8, style: 0.65, use_speaker_boost: true } }, // Adam
  commA: { voice: 'onwK4e9ZLuTAKqWW03F9', model: 'eleven_flash_v2_5', settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true } }, // Daniel
  commB: { voice: 'IKne3meq5aSn9XLyUdCD', model: 'eleven_flash_v2_5', settings: { stability: 0.35, similarity_boost: 0.75, style: 0.45, use_speaker_boost: true } }, // Charlie
  ref: { voice: 'pqHfZKP75CvOlQylNhV4', model: 'eleven_flash_v2_5', settings: { stability: 0.55, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }, // Bill
};

const SFX_PROMPTS = {
  crowd_loop: { text: 'Large indoor boxing arena crowd ambience, thousands of people murmuring and chattering, distant shouts, steady, no music', duration: 20, influence: 0.5 },
  cheer: { text: 'Huge boxing arena crowd erupts in a loud roaring cheer, applause and whistles', duration: 5, influence: 0.6 },
  ooh: { text: 'Arena crowd reacts with a loud collective "ooooh" after a big hit', duration: 2.5, influence: 0.6 },
  roar: { text: 'Stadium crowd goes wild, screaming and stomping after a knockout', duration: 7, influence: 0.6 },
  bell: { text: 'Single boxing ring bell ding, bright brass bell, short', duration: 1.2, influence: 0.7 },
  punch_heavy: { text: 'Heavy boxing glove punch landing hard on a face, deep meaty leather impact, close up', duration: 0.6, influence: 0.7 },
  punch_body: { text: 'Boxing glove body shot to the ribs, dull thud, leather impact', duration: 0.5, influence: 0.7 },
  punch_light: { text: 'Quick light boxing jab hitting, snappy leather slap', duration: 0.5, influence: 0.7 },
  block: { text: 'Boxing glove punch blocked by gloves, padded leather smack', duration: 0.5, influence: 0.7 },
  fall: { text: 'Boxer body falls heavily onto the boxing ring canvas, thud and ropes rattle', duration: 1.5, influence: 0.6 },
};

const inflight = new Map();
function cached(file, make) {
  const seed = path.join(SEED_DIR, path.relative(CACHE_DIR, file));
  if (fs.existsSync(seed)) return Promise.resolve(fs.readFileSync(seed));
  if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
  if (inflight.has(file)) return inflight.get(file);
  const p = make().then((buf) => { fs.writeFileSync(file, buf); inflight.delete(file); return buf; })
    .catch((e) => { inflight.delete(file); throw e; });
  inflight.set(file, p);
  return p;
}
async function xiPost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
const sendMp3 = (res, buf) => { res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000' }); res.send(buf); };

app.get('/api/voice/status', (req, res) => {
  res.json({ enabled: Boolean(XI_KEY), roles: Object.keys(VOICE_ROLES), sfx: Object.keys(SFX_PROMPTS) });
});

app.post('/api/tts', async (req, res) => {
  const { text, role } = req.body || {};
  const r = VOICE_ROLES[role];
  if (!XI_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not set' });
  if (!r || typeof text !== 'string' || !text.trim() || text.length > 160) return res.status(400).json({ error: 'bad text/role' });
  const hash = crypto.createHash('sha1').update(`${role}|${r.voice}|${r.model}|${text}`).digest('hex');
  const file = path.join(CACHE_DIR, 'tts', `${hash}.mp3`);
  const isCached = fs.existsSync(path.join(SEED_DIR, 'tts', `${hash}.mp3`)) || fs.existsSync(file);
  if (!isCached) {
    // only uncached lines cost credits, so only they are limited
    const today = new Date().toDateString();
    if (ttsBudget.day !== today) ttsBudget = { day: today, used: 0 };
    if (ttsBudget.used + text.length > DAILY_TTS_CHARS || limited(req, 'tts', 40, 10 * 60_000)) {
      return res.status(429).json({ error: 'voice budget exhausted — using browser voices' });
    }
    ttsBudget.used += text.length;
  }
  try {
    const buf = await cached(file, () =>
      xiPost(`${XI_URL}/text-to-speech/${r.voice}?output_format=mp3_44100_128`, { text, model_id: r.model, voice_settings: r.settings }));
    sendMp3(res, buf);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/api/sfx/:name', async (req, res) => {
  const s = SFX_PROMPTS[req.params.name];
  if (!s) return res.status(404).end();
  const seeded = fs.existsSync(path.join(SEED_DIR, 'sfx', `${req.params.name}.mp3`)) || fs.existsSync(path.join(CACHE_DIR, 'sfx', `${req.params.name}.mp3`));
  if (!seeded && limited(req, 'sfx', 12, 10 * 60_000)) return res.status(429).end();
  if (!XI_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not set' });
  try {
    const buf = await cached(path.join(CACHE_DIR, 'sfx', `${req.params.name}.mp3`), () =>
      xiPost(`${XI_URL}/sound-generation`, { text: s.text, duration_seconds: s.duration, prompt_influence: s.influence }));
    sendMp3(res, buf);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

module.exports = app;   // Vercel runs the exported app as a function

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`jevbox server on http://localhost:${PORT}  (typesafe key: ${API_KEY ? 'configured' : 'MISSING — fallback mode'}, elevenlabs: ${XI_KEY ? 'configured' : 'off — browser voices + synth audio'})`);
  });
}
