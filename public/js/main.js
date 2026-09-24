// JEVBOX — orchestrates the fight: scene, fighters, referee, Jev decisions,
// combat resolution + juice, rounds/knockdowns/scoring, camera and HUD.
import * as THREE from 'three';
import { buildArena } from './arena.js';
import { Fighter } from './fighter.js';
import { Referee } from './referee.js';
import { VFX } from './vfx.js';
import { Director } from './camera.js';
import { UI } from './ui.js';
import { Commentary } from './commentary.js';
import { ArenaAudio } from './audio.js';
import { ROSTER, MOVES, MAT_Y, MIN_SEP, ACTION_SET, settings, makeProfile, rosterById, urlPicks, applyTraitOverrides } from './config.js';
import { renderPortraits } from './portraits.js';
import { SelectScreen } from './select.js';

const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const DAMAGE_SCALE = 0.62;         // global pacing knob: lower = longer fights
const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten!'];

// ---------------- renderer / scene ----------------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
$('scene').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 120);
camera.position.set(0, 9, 14);

const arena = buildArena(scene);
const audio = new ArenaAudio();
const vfx = new VFX(scene, camera, renderer, arena.glowTex);
const director = new Director(camera, renderer.domElement);
if (settings.capture) vfx.final.uniforms.uGrain.value = 0;
const ui = new UI(camera);
const commentary = new Commentary((voice, text, priority) => {
  ui.line(voice, text, priority);
  audio.speak(text, { who: voice === 'JIM' ? 'commA' : 'commB', rate: 1.12, pitch: voice === 'JIM' ? 0.95 : 1.05, priority });
});
const say = (key, d, priority = 1) => commentary.say(key, d, { priority, now: sim.time });

// ---------------- sim state ----------------
const sim = {
  phase: 'loading', time: 0, round: 1, rounds: settings.rounds, roundSec: settings.roundSec, roundLeft: settings.roundSec,
  card: [], source: settings.forceLocalAI ? 'local' : 'jev', thinking: false, lastLatency: null, decisions: 0, tokens: 0,
  hype: 0.6, hypeTarget: 0.6, hitStop: 0, slowmo: 0, slowScale: 1, speed: settings.speed, over: false,
  log: [], errors: [], lastReq: 0, lastDecideT: -10, timeline: [], kd: null, breakLeft: 0, useLocal: settings.forceLocalAI,
  cardTotal: (f) => sim.card.reduce((s, r) => s + (f.key === 'red' ? r.r : r.b), 0),
  cardLive: (f) => sim.cardTotal(f) + f.roundPts - f.kdRound * 2,
};
window.__sim = sim;
window.addEventListener('error', (e) => sim.errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => sim.errors.push(String(e.reason)));
const log = (m) => { sim.log.push(`[${sim.time.toFixed(1)}] ${m}`); if (sim.log.length > 80) sim.log.shift(); };

// ---------------- game hooks used by fighters ----------------
let fighters, ref;
const lastStep = { red: 0, blue: 0 };
const panOf = (p) => { const v = p.clone().project(camera); return THREE.MathUtils.clamp(v.x * 0.7, -0.8, 0.8); };
const game = {
  get time() { return sim.time; },
  onStep(f, speed) {
    const now = performance.now();
    if (now - lastStep[f.key] < 90) return;
    lastStep[f.key] = now;
    audio.step(speed, panOf(f.pos));
  },
  strikeStart(att, name, tImpact) {
    att.opp.incoming(att, name, tImpact);
    maybeDecide(0.7);
  },
  whoosh(att, name) {
    const p = { jab: 0.3, cross: 0.55, hook: 0.6, uppercut: 0.6, body: 0.5, haymaker: 1, push: 0.35 }[name] ?? 0.5;
    audio.whoosh(p, panOf(att.pos));
  },
  impact: (att, def, name, gloveW) => resolveImpact(att, def, name, gloveW),
  ropeHit(f, speed) {
    audio.ropes(Math.min(1, speed / 2.5));
    director.shake(0.12);
    say('ropes', { def: f.name }, 0);
  },
  onFloor(f) {
    audio.fall(1);
    vfx.dust(f.pos.clone().setY(MAT_Y), 50, 0.8);
    director.shake(0.55);
    arena.cameraFlashes(22);
    audio.cheer(1.4);
  },
  onTaunt(f) { say('taunt', { att: f.name, def: f.opp.name }); bumpHype(0.25); },
  onFeint(f) {
    ui.label(f.opp.rig.world('head', new THREE.Vector3()), 'BAITED!', 'tag counter');
    say('feint', { att: f.name, def: f.opp.name });
  },
  onSpecial(f) {
    // Street Fighter style super flash: freeze, cut-in, camera punch-in
    const sp = f.special;
    sim.hitStop = Math.max(sim.hitStop, 0.95);
    ui.superCutin(f, portraits[f.profile.id]?.bust, sp);
    vfx.pulse({ aberr: 0.02, flash: 0.35, color: sp.color });
    vfx.flash(f.rig.world('chestTop', new THREE.Vector3()), 2.4, sp.color, 1);
    vfx.shock(f.pos.clone().setY(MAT_Y + 0.05), 2.2, sp.color, 0.6, true);
    arena.flashLED(sp.color, 1.5);
    arena.cameraFlashes(24);
    director.cut('closeup', { target: f.rig.world('head', new THREE.Vector3()), dir: new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw)), power: 1 }, 1.8);
    director.kick(8);
    audio.whoosh(1, 0); audio.cheer(1.6);
    audio.speak(sp.name.charAt(0) + sp.name.slice(1).toLowerCase() + '!', { who: 'announcer', rate: 1.05, pitch: 0.8, interrupt: true });
    say('special', { att: f.name, def: f.opp.name }, 3);
    for (const tr of trails) if (tr.f === f) tr.t.color.set(sp.color).multiplyScalar(1.6);
    bumpHype(0.8);
    log(`${f.name} SUPER: ${sp.name}`);
  },
  onReflex(f, act) { ui.reflex(f, act === 'block' ? 'REFLEX · GUARD UP' : 'REFLEX · SLIP'); },
  onIdle() { maybeDecide(0.9); },
  tryClinch(att) {
    const def = att.opp;
    if (def.down || att.distTo(def) > att.reach + 0.35) { att.toIdle(); return; }
    att.enter('clinch', 1.6);
    def.enter('clinched', 1.6);
    att.stats.clinches++;
    att.momentum += 3;
    sim.clinch = { t: 0 };
    say('clinch', { att: att.name, def: def.name });
  },
};

function bumpHype(x) { sim.hype = Math.min(2, sim.hype + x); }

// ---------------- combat resolution ----------------
const _hd = new THREE.Vector3(), _bd = new THREE.Vector3(), _dir = new THREE.Vector3();
function resolveImpact(att, def, name, gloveW) {
  const mv = MOVES[name];
  const isPunch = name !== 'push';
  if (sim.phase !== 'live') return 'miss';
  if (isPunch) att.stats.thrown++;
  if (def.down) return 'miss';
  def.rig.world('head', _hd);
  def.rig.world('waist', _bd).lerp(def.rig.world('chestTop', new THREE.Vector3()), 0.45);
  const bodyShot = mv.target === 'body' || mv.target === 'chest';
  const tPos = bodyShot ? _bd : _hd;
  const r = bodyShot ? 0.36 : 0.25;
  _dir.subVectors(tPos, att.rig.world(mv.hand === 'R' ? 'shR' : 'shL', new THREE.Vector3())).setY(0).normalize();
  const miss = gloveW.distanceTo(tPos) > r;
  // is the defender facing the attacker? (guards only work to the front)
  const defFwd = new THREE.Vector3(Math.sin(def.yaw), 0, Math.cos(def.yaw));
  const toAtt = new THREE.Vector3().subVectors(att.pos, def.pos).setY(0).normalize();
  const facing = defFwd.dot(toAtt) > 0.25;

  if (miss) {
    att.comboCtr = 0;
    if (isPunch) att.stats.whiffed++;
    if (def.flags.dodging) {
      def.stats.slipped++;
      def.meter = Math.min(100, def.meter + 6);
      def.roundPts += 1.5;
      def.counterUntil = sim.time + 1.2;
      def.momentum += 5; att.momentum -= 5;
      ui.label(def.rig.world('head', new THREE.Vector3()), def.variant === 'duck' ? 'DUCKED!' : 'SLIPPED!', 'tag slip');
      say(def.variant === 'duck' ? 'duck' : 'slip', { att: att.name, def: def.name });
      // good slips sometimes fire straight back
      const probs = def.lastJev && def.lastJev.probabilities;
      const aggr = probs ? ['jab', 'cross', 'hook', 'uppercut', 'combo'].reduce((s, k) => s + (probs[k] || 0), 0) : 0.4;
      if (Math.random() < 0.25 + aggr * 0.5) def.autoCounter = sim.time + rnd(0.12, 0.22);
      bumpHype(0.12);
      log(`${att.name} ${name} slipped by ${def.name}`);
      return 'slipped';
    }
    if (att.distTo(def) > att.reach + 0.1 && Math.random() < 0.5) say('miss', { att: att.name }, 0);
    log(`${att.name} ${name} misses`);
    return 'miss';
  }

  if (name === 'push') {
    att.stats.pushes++;
    att.roundPts += 0.5;
    def.kb.addScaledVector(_dir, mv.shove);
    def.poise = Math.max(0, def.poise - mv.poise);
    if (def.strike) def.endStrike();
    if (!def.down && !['clinched'].includes(def.state)) def.enter('hit', 0.3);
    def.rig.imp.chest.kick(-4, 0, 0);
    att.momentum += 2;
    audio.punch(0.25, { blocked: true, pan: panOf(def.pos) });
    vfx.shock(gloveW, 0.5, 0xffffff, 0.2);
    say('push', { att: att.name, def: def.name });
    return 'hit';
  }

  let dmg = rnd(mv.dmg[0], mv.dmg[1]) * att.dmgMul * DAMAGE_SCALE;
  let poiseDmg = mv.poise;
  const body = mv.target === 'body';
  let blocked = def.flags.blocking && facing && !(body && Math.random() < 0.45);
  const notes = [];
  if (blocked) {
    const weak = def.guard < 30;
    dmg *= Math.max(weak ? 0.5 : 0.18, att.strike && att.strike.special ? att.strike.special.pierce : 0);
    poiseDmg *= 0.3;
    def.guard = Math.max(0, def.guard - 16);
    def.stamina = Math.max(0, def.stamina - 3);
    if (weak) notes.push('GUARD BROKEN');
  } else {
    if (def.flags.taunting) { dmg *= 1.5; notes.push('PUNISHED'); }
    if (def.rocked) dmg *= 1.15;
    if (sim.time < att.counterUntil) { dmg *= 1.35; att.counterUntil = 0; notes.push('COUNTER'); }
    if (att.comboCtr >= 2) dmg *= Math.min(1.4, 1 + 0.07 * att.comboCtr);
    if (Math.random() < 0.05 + (def.rocked ? 0.08 : 0) + (name === 'uppercut' || name === 'haymaker' ? 0.05 : 0)) { dmg *= 1.45; notes.push('CRITICAL'); }
    if (!facing) { dmg *= 1.2; notes.push('BLINDSIDE'); }
  }
  if (att.strike && att.strike.special) { dmg *= att.strike.special.dmgMul; notes.push('SUPER'); }
  if (body && !blocked) {
    def.stamina = Math.max(0, def.stamina - mv.drain);
    def.maxStamina = Math.max(55, def.maxStamina - 2.5);
  }
  dmg = Math.max(blocked ? 0 : 1, Math.round(dmg));
  const power = THREE.MathUtils.clamp(dmg / 13, 0.05, 1) * (blocked ? 0.6 : 1);

  const result = def.takeHit({ dmg, poiseDmg, dirW: _dir.clone(), kind: mv.kind, blocked, power, body });
  att.landedLog.push(sim.time);
  att.stats.dmg += dmg;
  def.stats.dmgTaken += dmg;
  att.roundPts += blocked ? 0.4 : mv.pts + (dmg >= 9 ? 1 : 0) + (notes.includes('COUNTER') ? 1 : 0);
  if (blocked) {
    att.stats.blockedOn++;
    def.stats.blocks++;
    att.comboCtr = 0;
    def.roundPts += 0.3;
  } else {
    att.stats.landed++;
    att.comboCtr++;
    att.stats.maxCombo = Math.max(att.stats.maxCombo, att.comboCtr);
    if (name !== 'jab') att.stats.power++;
    if (body) att.stats.bodyL++;
    if (notes.includes('COUNTER')) att.stats.counters++;
    def.comboCtr = 0;
    att.momentum += 4 + power * 8;
    def.momentum -= 4 + power * 8;
  }

  // super meter: landing fills it faster than taking
  if (!(att.strike && att.strike.special)) att.meter = Math.min(100, att.meter + dmg * (blocked ? 1 : 2.4));
  def.meter = Math.min(100, def.meter + dmg * 1.5);

  // ---- juice ----
  const heavy = !blocked && power > 0.5;
  const pan = panOf(def.pos);
  sim.hitStop = Math.max(sim.hitStop, blocked ? 0.035 : 0.045 + power * 0.1 + (notes.length ? 0.04 : 0));
  vfx.impact(gloveW, _dir, power, att.color, { blocked, body });
  arena.impact(gloveW, blocked ? 0.2 : power);
  audio.punch(power, { blocked, body, pan });
  director.shake(blocked ? 0.1 : 0.14 + power * 0.5);
  director.kick(blocked ? 0.5 : power * 7);
  if (heavy) {
    director.punchIn(tPos, _dir, power);
    vfx.pulse({ aberr: 0.008 + power * 0.012, flash: 0.08 + power * 0.1, color: att.color });
    arena.flashLED(att.color, power);
    arena.cameraFlashes(Math.round(4 + power * 12));
    ui.vignette(att.css, 0.25 + power * 0.3);
    if (power > 0.75) audio.cheer(power); else audio.ooh(0.8);
  }
  ui.label(tPos, blocked ? 'BLOCK' : `${dmg}`, blocked ? 'tag block' : `dmg ${dmg >= 9 ? "big" : ""}`);
  for (const n of notes) ui.label(tPos.clone().setY(tPos.y + 0.25), n, `tag ${n === 'COUNTER' ? 'counter' : 'crit'}`);
  bumpHype(blocked ? 0.04 : 0.1 + power * 0.35);
  const d = { att: att.name, def: def.name };
  if (blocked) say('blocked', d, 0);
  else if (notes.includes('COUNTER')) say('counter', d, 2);
  else if (att.strike && att.strike.combo && att.strike.i > 0) say('combo', d, heavy ? 2 : 1);
  else say(name, d, heavy ? 2 : name === 'jab' ? 0 : 1);
  log(`${att.name} ${name} ${blocked ? 'blocked' : 'lands'} ${dmg} → ${def.name} hp ${Math.round(def.hp)} ${notes.join(',')}`);

  if (result === 'stagger') {
    att.stats.staggers++;
    att.roundPts += 2;
    ui.label(def.rig.world('head', new THREE.Vector3()).setY(def.pos.y + 2.1), 'ROCKED!', 'tag crit');
    say('rocked', d, 2);
    sim.slowmo = Math.max(sim.slowmo, 0.45);
    audio.heartbeat();
    bumpHype(0.4);
  }
  if (result === 'down') knockdown(def, att, _dir.clone().multiplyScalar(2.2 + power * 3.2));
  return blocked ? 'blocked' : 'hit';
}

// ---------------- knockdowns ----------------
function knockdown(def, att, impulse) {
  def.knockdowns++;
  def.kdRound++;
  att.roundPts += 3;
  const tko = def.knockdowns >= 3;
  const zero = def.hp <= 0;
  def.knockdown(zero || tko || Math.random() < 0.3, impulse);
  if (att.strike) att.endStrike();
  let getUpAt;
  if (tko) getUpAt = 99;
  else if (zero) getUpAt = Math.random() < 0.14 && def.knockdowns < 2 ? rint(8, 9) : 99;
  else getUpAt = rint(3, 7) + (def.hp < 30 ? 2 : 0);
  sim.kd = { f: def, att, t: 0, count: 0, getUpAt, rising: false, tko, zero };
  sim.phase = 'knockdown';
  sim.slowmo = 1.3;
  sim.hitStop = 0.16;
  vfx.pulse({ aberr: 0.03, flash: 0.35, color: 0xffffff });
  director.shake(0.8);
  director.kick(10);
  ui.callout('KNOCKDOWN', { cls: att.key, sub: `${def.name} IS DOWN` });
  say('knockdown', { att: att.name, def: def.name }, 3);
  audio.cheer(2);
  sim.hype = 2;
  arena.cameraFlashes(28);
  setTimeout(() => { if (sim.kd && sim.kd.f === def) director.cut('knockdown', { f: def }); }, 500);
  // attacker to the farthest neutral corner
  const corners = [[2.75, -2.75], [-2.75, 2.75]];
  const c = corners.sort((p, q) => Math.hypot(q[0] - def.pos.x, q[1] - def.pos.z) - Math.hypot(p[0] - def.pos.x, p[1] - def.pos.z))[0];
  att.walkTo(c[0], c[1], null, new THREE.Vector3(0, MAT_Y, 0));
  ref.set('count', { f: def });
  log(`KNOCKDOWN ${def.name} (${def.knockdowns}) getUpAt=${getUpAt}`);
}

function updateKnockdown(dt) {
  const kd = sim.kd;
  if (!kd) return;
  kd.t += dt;
  if (kd.t < 1.8) return;
  const c = Math.floor((kd.t - 1.8) / 1.0) + 1;
  ref.data.countT = kd.t - 1.8;
  if (c > kd.count && !kd.rising) {
    kd.count = c;
    if (kd.tko && c >= 3) { endFight(kd.att, kd.f, 'TKO'); return; }
    ui.callout(String(Math.min(10, c)), { cls: 'count', dur: 900 });
    audio.speak(COUNT_WORDS[Math.min(10, c)], { who: 'ref', rate: 1.1, pitch: 0.85, interrupt: true });
    audio.blip(false);
    if (c >= 10) { endFight(kd.att, kd.f, 'KO'); return; }
    if (c >= kd.getUpAt) {
      kd.rising = true;
      if (kd.zero) kd.f.hp = 8;
      kd.f.poise = 55;
      kd.f.getUp();
      say('getup', { def: kd.f.name }, 2);
      audio.cheer(1);
    }
  }
  if (kd.rising && kd.f.state === 'idle') {
    // back to the action
    sim.kd = null;
    sim.phase = 'live';
    ref.set('break');
    kd.att.enter('idle');
    director.cut('broadcast');
    ui.callout('FIGHT!', { cls: 'hold', dur: 900 });
    setTimeout(() => ui.clearCallout(), 900);
    audio.whistleRef();
  }
}

// ---------------- clinch ----------------
function updateClinch(dt) {
  if (!sim.clinch) return;
  const [a, b] = fighters;
  const inClinch = (f) => f.state === 'clinch' || f.state === 'clinched';
  if (!inClinch(a) || !inClinch(b)) { sim.clinch = null; return; }
  sim.clinch.t += dt;
  // pull together
  const d = new THREE.Vector3().subVectors(b.pos, a.pos).setY(0);
  const len = d.length();
  d.normalize();
  const err = len - 0.5;
  a.pos.addScaledVector(d, err * 0.5 * Math.min(1, dt * 8));
  b.pos.addScaledVector(d, -err * 0.5 * Math.min(1, dt * 8));
  if (sim.clinch.t > 1.6) {
    sim.clinch = null;
    ref.set('break');
    audio.speak('Break!', { who: 'ref', rate: 1.2, pitch: 0.8 });
    a.kb.addScaledVector(d, -1.6);
    b.kb.addScaledVector(d, 1.6);
    a.toIdle(); b.toIdle();
  }
}

// ---------------- scoring ----------------
function closeRound() {
  const [R, B] = fighters;
  const diff = R.roundPts - B.roundPts;
  let rs = 10, bs = 10;
  if (Math.abs(diff) >= 1.5) {
    const dominant = Math.abs(diff) >= 9;
    if (diff > 0) bs = dominant ? 8 : 9; else rs = dominant ? 8 : 9;
  }
  rs -= R.kdRound; bs -= B.kdRound;
  const m = Math.max(rs, bs);
  rs = Math.max(7, rs + 10 - m); bs = Math.max(7, bs + 10 - m);
  const card = { r: rs, b: bs };
  sim.card.push(card);
  const w = rs > bs ? R : bs > rs ? B : null;
  if (w) say('roundWin', { att: w.name }, 1);
  log(`round ${sim.card.length}: ${rs}-${bs}`);
  R.roundPts = B.roundPts = 0;
  R.kdRound = B.kdRound = 0;
  return card;
}

// ---------------- Jev decisions ----------------
function recent(logArr) { const c = sim.time - 10; return logArr.filter((t) => t >= c).length; }
function patternOf(f) {
  const a = f.lastActions.slice(-5);
  if (!a.length) return 'none yet';
  const counts = {};
  for (const x of a) counts[x] = (counts[x] || 0) + 1;
  const [top, n] = Object.entries(counts).sort((p, q) => q[1] - p[1])[0];
  return n >= 3 ? `predictable: ${n} of last ${a.length} were "${top}"` : `mixed: ${a.join(', ')}`;
}
function fighterState(f) {
  const o = f.opp, sp = f.spatial();
  return {
    hp: Math.round(f.hp), stamina: Math.round(f.stamina), max_stamina: Math.round(f.maxStamina),
    poise: Math.round(f.poise), guard: Math.round(f.guard), momentum: Math.round(f.momentum),
    status: f.statusTags(), action: f.state === 'strike' && f.strike ? f.strike.name : f.state,
    last_actions: f.lastActions.slice(-4),
    in_range: f.distTo(o) <= f.reach + 0.3, reach: +f.reach.toFixed(2),
    cornered: sp.cornered, on_ropes: sp.on_ropes, dist_to_center: sp.dist_to_center,
    hits_landed_last_10s: recent(f.landedLog), hits_taken_last_10s: recent(f.takenLog),
    counter_ready: sim.time < f.counterUntil, knockdowns_suffered: f.knockdowns,
    opponent_pattern: patternOf(o),
    punches_thrown: f.stats.thrown, punches_landed: f.stats.landed,
    accuracy_pct: f.stats.thrown ? Math.round((100 * f.stats.landed) / f.stats.thrown) : 0,
    behind_on_cards: sim.cardLive(f) < sim.cardLive(o),
    fighter: `${f.name} "${f.nick}"`, fighting_style: f.style.label,
    super_meter: Math.round(f.meter), special_ready: f.meter >= 100, special_move: f.special.name,
  };
}
function fightState() {
  const [R, B] = fighters;
  return {
    fight: {
      round: Math.min(sim.rounds, sim.round), total_rounds: sim.rounds,
      seconds_left_in_round: Math.max(0, Math.round(sim.roundLeft)),
      distance: +R.distTo(B).toFixed(2),
      recent_events: sim.log.slice(-5),
    },
    red: fighterState(R),
    blue: fighterState(B),
  };
}
function sampleChoice(answer, f) {
  // the distribution IS the decision: sample it (reweighted by the fighter's style +
  // this fight's random jitter) so behaviour varies but stays Jev-driven
  let pickA = answer && answer.choice;
  if (answer && answer.probabilities) {
    const entries = Object.entries(answer.probabilities).filter(([n]) => ACTION_SET.has(n) && (n !== 'special' || f.meter >= 100))
      .map(([n, p]) => [n, p * (f.styleMult[n] ?? 1)]);
    const total = entries.reduce((s, [, p]) => s + p, 0);
    let r = Math.random() * (total || 1);
    for (const [n, p] of entries) { r -= p; if (r <= 0) { pickA = n; break; } }
  }
  return ACTION_SET.has(pickA) ? pickA : 'advance';
}
function maybeDecide(minGap) {
  if (sim.time - sim.lastDecideT > minGap) requestDecisions();
}
async function requestDecisions() {
  if (sim.phase !== 'live' || sim.thinking) return;
  const now = performance.now();
  if (now - sim.lastReq < 450) return;
  sim.lastReq = now;
  sim.thinking = true;
  sim.lastDecideT = sim.time;
  const state = fightState();
  try {
    const r = await fetch('/api/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, forceFallback: sim.useLocal }),
    });
    const d = await r.json();
    sim.lastResponse = d;
    sim.source = d.source === 'jev' ? 'jev' : sim.useLocal ? 'local' : 'fallback';
    sim.lastLatency = d.latencyMs ?? null;
    if (d.usage) sim.tokens += (d.usage.input_tokens || 0) + (d.usage.output_tokens || 0);
    if (d.reason && !sim.useLocal) sim.errors.push('fallback: ' + d.reason);
    sim.decisions++;
    if (sim.phase === 'live') {
      const a = d.answers || {};
      for (const [f, key] of [[fighters[0], 'red_action'], [fighters[1], 'blue_action']]) {
        if (a[key]) f.command(sampleChoice(a[key], f), a[key]);
      }
      if (a.crowd_hype && typeof a.crowd_hype.score === 'number') sim.hypeTarget = THREE.MathUtils.clamp(a.crowd_hype.score - 1, 0, 2);
    }
  } catch (e) {
    sim.errors.push('fetch failed: ' + e);
    sim.source = 'err';
  }
  sim.thinking = false;
}

// ---------------- fight flow ----------------
const MARK = { red: [-0.75, -0.75], blue: [0.75, 0.75] };
const CORNER = { red: [-3.0, -3.0], blue: [3.0, 3.0] };
const center = new THREE.Vector3(0, MAT_Y, 0);

function schedule(delay, fn) { sim.timeline.push({ at: sim.real + delay, fn }); }

function placeInCorners() {
  const [R, B] = fighters;
  R.reset(CORNER.red[0], CORNER.red[1], Math.PI / 4);
  B.reset(CORNER.blue[0], CORNER.blue[1], -Math.PI * 3 / 4);
  for (const f of fighters) { f.enter('wait'); f.faceTarget = center; }
  ref.reset();
}

function walkToMarks(then) {
  let n = 0;
  for (const f of fighters) {
    const m = MARK[f.key];
    f.walkTo(m[0], m[1], () => { f.faceTarget = f.opp.pos; if (++n === 2 && then) then(); }, f.opp.pos);
  }
  ref.set('watch');
}

function startRound() {
  sim.phase = 'live';
  sim.roundLeft = sim.roundSec;
  for (const f of fighters) { f.faceTarget = null; f.enter('idle'); f.kdRound = 0; }
  ui.callout('FIGHT!', { dur: 1000 });
  audio.bell(1);
  audio.cheer(1.2);
  director.cut('broadcast');
  requestDecisions();
}

function announceRound() {
  const n = sim.round;
  ui.callout(n === sim.rounds && n > 1 ? 'FINAL ROUND' : `ROUND ${n}`, { hold: true, sub: n === 1 ? 'TOUCH GLOVES' : '' });
  audio.speak(n === sim.rounds && n > 1 ? 'Final round!' : `Round ${COUNT_WORDS[n] ? COUNT_WORDS[n].toLowerCase() : n}!`, { who: 'announcer', rate: 0.95, pitch: 0.8 });
  say('round', { n }, 2);
  schedule(1.6 / sim.speed, startRound);
}

function beginWalkout(full) {
  sim.phase = 'walkout';
  $('intro').classList.add('hidden');
  $('hud').classList.remove('hidden');
  const [R, B] = fighters;
  if (full) {
    audio.cheer(1.5);
    ui.callout('FIGHT NIGHT', { sub: 'LIVE FROM THE JEVBOX ARENA', dur: 2200 });
    audio.speak('Ladies and gentlemen! Welcome to fight night!', { who: 'announcer', rate: 0.92, pitch: 0.75 });
    say('intro', { att: R.name, def: B.name }, 2);
    schedule(2.4, () => {
      director.cut('faceoff', { f: R });
      ui.callout(R.name, { cls: 'red', sub: `"${R.nick.toUpperCase()}"`, dur: 2600 });
      R.enter('celebrate'); R.faceTarget = camera.position;
      audio.speak(`In the red corner... ${R.name}... ${R.nick}!`, { who: 'announcer', rate: 0.9, pitch: 0.75 });
      audio.cheer(1);
    });
    schedule(5.4, () => {
      R.enter('wait'); R.faceTarget = center;
      director.cut('faceoff', { f: B });
      ui.callout(B.name, { cls: 'blue', sub: `"${B.nick.toUpperCase()}"`, dur: 2600 });
      B.enter('celebrate'); B.faceTarget = camera.position;
      audio.speak(`And in the blue corner... ${B.name}... ${B.nick}!`, { who: 'announcer', rate: 0.9, pitch: 0.75 });
      audio.cheer(1);
    });
    schedule(8.4, () => {
      B.enter('wait');
      director.cut('broadcast');
      walkToMarks(announceRound);
    });
  } else {
    director.cut('broadcast');
    walkToMarks(announceRound);
  }
}

function endRound() {
  const idx = sim.round;
  sim.phase = 'break';
  audio.bell(2);
  say('roundEnd', { n: idx }, 2);
  const card = closeRound();
  sim.kd = null;
  sim.clinch = null;
  if (idx >= sim.rounds) { decideOnCards(); return; }
  for (const f of fighters) {
    if (f.strike) f.endStrike();
    const c = CORNER[f.key];
    f.walkTo(c[0] * 0.98, c[1] * 0.98, () => { f.enter('sit'); f.faceTarget = center; }, center);
    // corner work: recover between rounds
    f.hp = Math.min(100, f.hp + 6);
    f.stamina = Math.min(f.maxStamina, f.stamina + 45);
    f.poise = 100;
    f.guard = 100;
    f.momentum *= 0.3;
  }
  arena.stools.red.visible = arena.stools.blue.visible = true;
  ref.set('neutral', { x: 2.7, z: -2.7 });
  director.cut('wide');
  sim.round++;
  sim.breakLeft = settings.breakSec;
  schedule(1.2, () => ui.showBreak(sim, fighters, idx, card));
}

function updateBreak(dt) {
  sim.breakLeft -= dt;
  ui.breakCountdown(sim.breakLeft, sim.round);
  if (sim.breakLeft <= 0 && sim.phase === 'break') {
    sim.phase = 'walkout';
    ui.hideBreak();
    arena.stools.red.visible = arena.stools.blue.visible = false;
    director.cut('broadcast');
    walkToMarks(announceRound);
  }
}

function decideOnCards() {
  const [R, B] = fighters;
  const rt = sim.cardTotal(R), bt = sim.cardTotal(B);
  if (rt === bt) endFight(null, null, 'DRAW');
  else endFight(rt > bt ? R : B, rt > bt ? B : R, 'DECISION');
}

function endFight(winner, loser, method) {
  if (sim.over) return;
  sim.over = true;
  sim.phase = 'over';
  sim.kd = null;
  sim.hype = 2;
  const [R, B] = fighters;
  const scoreStr = `${sim.cardTotal(R)}–${sim.cardTotal(B)}`;
  audio.bell(method === 'KO' || method === 'TKO' ? 6 : 3);
  audio.cheer(2.5);
  arena.cameraFlashes(28);
  if (method === 'KO' || method === 'TKO') {
    loser.koNow();
    say(method === 'KO' ? 'ko' : 'tko', { att: winner.name, def: loser.name }, 3);
    ui.callout(method === 'KO' ? 'K.O.!' : 'T.K.O.', { cls: winner.key, sub: `${winner.name} WINS`, hold: true });
    sim.slowmo = 2.2;
    director.cut('ko', { f: loser });
    vfx.pulse({ aberr: 0.04, flash: 0.5, color: 0xffffff });
  } else if (winner) {
    say('decision', { att: winner.name }, 3);
    ui.callout('DECISION', { sub: `${winner.name} WINS ${scoreStr}`, cls: winner.key, hold: true });
    loser.enter('dejected');
  } else {
    say('draw', {}, 3);
    ui.callout('DRAW', { sub: scoreStr, hold: true });
    for (const f of fighters) f.enter('dejected');
  }
  if (winner) {
    const cel = () => { winner.enter('celebrate'); winner.faceTarget = new THREE.Vector3(camera.position.x, MAT_Y, camera.position.z); };
    if (method === 'KO' || method === 'TKO') schedule(1.2, cel); else cel();
    schedule(2.6, () => {
      winner.raiseHand = true;
      ref.set('raise', { f: winner });
      director.cut('winner', { f: winner });
      vfx.confetti(winner.pos.clone());
      const how = { KO: 'by knockout', TKO: 'by technical knockout', DECISION: `by decision, ${scoreStr}` }[method];
      audio.speak(`Your winner... ${how}... ${winner.name}!`, { who: 'announcer', rate: 0.9, pitch: 0.75, interrupt: true });
    });
  } else {
    ref.set('watch');
    director.cut('wide');
  }
  const round = Math.min(sim.rounds, sim.round);
  const t = sim.roundSec - sim.roundLeft;
  const sub = method === 'DRAW' ? `Scorecards ${scoreStr}` :
    method === 'DECISION' ? `Unanimous decision · ${scoreStr}` :
      `Round ${round} · ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  schedule(4.5, () => {
    ui.clearCallout();
    ui.showResult(sim, fighters, { method: { KO: 'KNOCKOUT', TKO: 'TECHNICAL KNOCKOUT', DECISION: 'DECISION', DRAW: 'DRAW' }[method], winner, sub });
  });
  log(`FIGHT OVER: ${method} ${winner ? winner.name : ''}`);
}

function rematch() {
  audio.blip();
  sim.timeline = [];
  Object.assign(sim, { over: false, time: 0, round: 1, card: [], kd: null, clinch: null, hitStop: 0, slowmo: 0, hype: 0.7, hypeTarget: 0.7, roundLeft: sim.roundSec });
  ui.hideResult(); ui.hideBreak(); ui.clearCallout();
  arena.stools.red.visible = arena.stools.blue.visible = false;
  spawnFighters(fighters[0].profile, fighters[1].profile);
  beginWalkout(false);
}

// ---------------- boot ----------------
let trails = [];
let picks = { red: rosterById(urlPicks.red || 'kane'), blue: rosterById(urlPicks.blue || 'voss') };

function spawnFighters(redEntry, blueEntry) {
  for (const f of fighters || []) scene.remove(f.group);
  for (const tr of trails) scene.remove(tr.t.mesh);
  const mirror = redEntry.id === blueEntry.id;
  fighters = [
    new Fighter(applyTraitOverrides(makeProfile(redEntry, 'red')), scene, game),
    new Fighter(applyTraitOverrides(makeProfile(blueEntry, 'blue', mirror)), scene, game),
  ];
  fighters[0].opp = fighters[1];
  fighters[1].opp = fighters[0];
  sim.fighters = { red: fighters[0], blue: fighters[1] };
  trails = [];
  for (const f of fighters) for (const h of ['L', 'R']) trails.push({ f, h, t: vfx.addTrail(f.profile.look.gloves), prev: new THREE.Vector3(), init: false });
  ui.setFighters(fighters[0], fighters[1]);
  placeInCorners();
}

function prewarmVoices() {
  const [R0, B0] = fighters;
  audio.prewarm([
    ['announcer', 'Ladies and gentlemen! Welcome to fight night!'],
    ['announcer', `In the red corner... ${R0.name}... ${R0.nick}!`],
    ['announcer', `And in the blue corner... ${B0.name}... ${B0.nick}!`],
    ['announcer', 'Round one!'], ['announcer', 'Round two!'], ['announcer', 'Final round!'],
    ...[R0, B0].map((f) => ['announcer', f.special.name.charAt(0) + f.special.name.slice(1).toLowerCase() + '!']),
    ...COUNT_WORDS.slice(1).map((w) => ['ref', w]),
    ['ref', 'Break!'],
  ]);
}

ref = new Referee(scene, () => {});
spawnFighters(picks.red, picks.blue);

const portraits = renderPortraits(ROSTER);
const health = await fetch('/api/health').then((r) => r.json()).catch(() => ({ keyConfigured: false }));
const xi = await audio.prefetch();
ui.setAiLine((health.keyConfigured ? 'Jev API key detected — fighters think live.' : 'No TYPESAFE_API_KEY on the server — local heuristic brain.') +
  (xi ? ' · ElevenLabs voices + arena audio on.' : ' · Browser voices (add ELEVENLABS_API_KEY for real ones).'));
if (!health.keyConfigured) { sim.useLocal = true; sim.source = 'local'; $('opt-ai').value = 'local'; }
if (settings.forceLocalAI) $('opt-ai').value = 'local';
$('opt-rounds').value = String(settings.rounds);
if ([...$('opt-len').options].some((o) => o.value === String(settings.roundSec))) $('opt-len').value = String(settings.roundSec);
sim.phase = 'intro';
director.cut('intro');

let starting = false;
async function startFight() {
  if (starting || select.turn !== 'done') return;
  starting = true;
  audio.init();
  audio.blip();
  sim.rounds = +$('opt-rounds').value;
  sim.roundSec = +$('opt-len').value;
  sim.roundLeft = sim.roundSec;
  sim.useLocal = $('opt-ai').value === 'local';
  sim.source = sim.useLocal ? 'local' : 'jev';
  spawnFighters(select.picks.red, select.picks.blue);
  prewarmVoices();
  select.hide();
  audio.whoosh(1, 0);
  audio.speak(`${fighters[0].name}... versus... ${fighters[1].name}!`, { who: 'announcer', rate: 0.95, pitch: 0.75 });
  await ui.vsSplash(fighters[0], fighters[1], portraits);
  starting = false;
  beginWalkout(true);
}
const select = new SelectScreen(ROSTER, portraits, {
  onPick: (side, entry) => {
    picks[side] = entry;
    const other = side === 'red' ? 'blue' : 'red';
    spawnFighters(side === 'red' ? entry : picks.red, side === 'blue' ? entry : picks.blue);
    void other;
  },
  onReady: startFight,
  blip: (up) => audio.blip(up),
});
if (urlPicks.red && urlPicks.blue) { select.pick(ROSTER.indexOf(picks.red)); select.pick(ROSTER.indexOf(picks.blue)); }
$('start').onclick = startFight;
$('rematch').onclick = rematch;
$('res-close').onclick = () => ui.hideResult();
$('res-new').onclick = () => {
  audio.blip();
  sim.timeline = [];
  Object.assign(sim, { over: false, phase: 'intro', time: 0, round: 1, card: [], kd: null, clinch: null, hitStop: 0, slowmo: 0, roundLeft: sim.roundSec });
  ui.hideResult(); ui.hideBreak(); ui.clearCallout();
  $('hud').classList.add('hidden');
  arena.stools.red.visible = arena.stools.blue.visible = false;
  select.picks = { red: null, blue: null };
  select.turn = 'red';
  select.show();
  placeInCorners();
  director.cut('intro');
};

// ---------------- dock + keys ----------------
const SPEEDS = [1, 2, 4, 0.5];
function setSpeed(s) { sim.speed = s; $('speed-label').textContent = `${s}×`; $('btn-speed').classList.toggle('on', s !== 1); }
setSpeed(sim.speed);
$('voice-label').textContent = audio.commentaryVoice ? 'ON' : 'OFF';
$('btn-voice').classList.toggle('on', audio.commentaryVoice);
director.onModeChange = (m) => { $('cam-label').textContent = m === 'auto' ? 'AUTO' : 'FREE'; $('btn-cam').classList.toggle('on', m === 'free'); };
const actions = {
  cam: () => director.setMode(director.mode === 'auto' ? 'free' : 'auto'),
  speed: () => setSpeed(SPEEDS[(SPEEDS.indexOf(sim.speed) + 1) % SPEEDS.length]),
  sound: () => { audio.setMuted(!audio.muted); $('btn-sound').classList.toggle('muted', audio.muted); },
  voice: () => { audio.commentaryVoice = !audio.commentaryVoice; $('voice-label').textContent = audio.commentaryVoice ? 'ON' : 'OFF'; $('btn-voice').classList.toggle('on', audio.commentaryVoice); },
  brain: () => { $('hud').classList.toggle('nobrain'); $('btn-brain').classList.toggle('on'); },
  stats: () => { $('stats').classList.toggle('hidden'); $('btn-stats').classList.toggle('on'); ui.fillStats(sim, fighters); },
  restart: () => { if (sim.phase !== 'intro') rematch(); },
};
for (const k of Object.keys(actions)) $(`btn-${k}`).onclick = () => { audio.blip(); actions[k](); };
$('stats-close').onclick = actions.stats;
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || sim.phase === 'intro') return;
  const k = e.key.toLowerCase();
  if (k === 'c') actions.cam();
  else if (k === 'm') actions.sound();
  else if (k === 'v') actions.voice();
  else if (k === 'b') actions.brain();
  else if (k === 's') actions.stats();
  else if (k === 'r') actions.restart();
  else if (['1', '2', '3', '4'].includes(k)) setSpeed([1, 2, 4, 0.5][+k - 1]);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  vfx.resize(innerWidth, innerHeight);
});

// ---------------- main loop ----------------
let prev = performance.now();
let hudAcc = 0, boardAcc = 0, chatterAcc = 0, decideAcc = 0, heartAcc = 0;
sim.real = 0;
const _g = new THREE.Vector3();
function frame(forcedDt, skipRender = false) {
  const now = performance.now();
  const realDt = forcedDt ?? Math.min(0.05, (now - prev) / 1000);
  prev = now;
  sim.real += realDt;

  // timeline (real-time choreography)
  for (let i = sim.timeline.length - 1; i >= 0; i--) {
    if (sim.real >= sim.timeline[i].at) { const e = sim.timeline.splice(i, 1)[0]; e.fn(); }
  }

  // time scaling: hit-stop freezes, slow-mo on big moments
  let scale = sim.speed;
  if (sim.slowmo > 0) { sim.slowmo -= realDt; scale *= 0.3; }
  sim.slowScale += (scale - sim.slowScale) * Math.min(1, realDt * 12);
  let dt = realDt * sim.slowScale;
  if (sim.hitStop > 0) { sim.hitStop -= realDt; dt = 0; }
  if (sim.phase === 'intro') dt = realDt;
  sim.time += dt;

  if (sim.phase === 'live') {
    sim.roundLeft -= dt;
    decideAcc += dt;
    if (decideAcc >= 1.1) { decideAcc = 0; requestDecisions(); }
    if (sim.roundLeft <= 0) endRound();
  } else if (sim.phase === 'knockdown') updateKnockdown(dt);
  else if (sim.phase === 'break') updateBreak(dt);

  for (const f of fighters) f.update(dt);
  updateClinch(dt);
  // keep bodies apart
  const [A, B] = fighters;
  if (!A.down && !B.down && !sim.clinch && dt > 0) {
    const d = new THREE.Vector3().subVectors(B.pos, A.pos).setY(0);
    const len = d.length();
    if (len < MIN_SEP && len > 1e-4) {
      d.multiplyScalar((MIN_SEP - len) / len / 2);
      A.pos.sub(d); B.pos.add(d);
    }
  }
  ref.update(dt, fighters, camera.position);

  // crowd hype eases toward Jev's read + recent action
  sim.hypeTarget = Math.max(0.25, sim.hypeTarget - dt * 0.02);
  sim.hype += (sim.hypeTarget - sim.hype) * Math.min(1, realDt * 0.6);
  audio.setHype(sim.hype);
  const favor = THREE.MathUtils.clamp((A.momentum - B.momentum) / 40, -1, 1);
  arena.update(dt > 0 ? dt : realDt * 0.2, sim.real, sim.hype, [...fighters.map((f) => ({ pos: f.pos, r: 0.32 })), { pos: ref.pos, r: 0.3 }], -favor);

  // glove trails
  for (const tr of trails) {
    tr.f.rig.world(tr.h === 'L' ? 'glL' : 'glR', _g);
    const speed = tr.init && realDt > 0 ? _g.distanceTo(tr.prev) / Math.max(1e-4, dt || realDt) : 0;
    tr.init = true;
    tr.prev.copy(_g);
    if (dt > 0 || !tr.t.init) tr.t.update(_g, speed, camera.position, realDt);
  }

  vfx.update(dt > 0 ? dt : realDt * 0.08, realDt, sim.real);
  director.update(realDt, { fighters, hype: sim.hype });
  if (!skipRender) vfx.render();
  ui.updateLabels(realDt);

  // rocked heartbeat
  heartAcc += realDt;
  if (heartAcc > 0.9 && sim.phase === 'live') {
    heartAcc = 0;
    if (fighters.some((f) => f.rocked || f.hp < 20)) audio.heartbeat();
  }

  // commentary: situational + filler
  chatterAcc += realDt;
  if (chatterAcc > 1.5 && sim.phase === 'live') {
    chatterAcc = 0;
    for (const f of fighters) {
      const sp = f.spatial();
      if (sp.cornered && !f._wasCornered) say('cornered', { def: f.name }, 1);
      f._wasCornered = sp.cornered;
      if (f.stamina < 22 && !f._wasGassed) say('gassed', { def: f.name }, 1);
      f._wasGassed = f.stamina < 22;
      if (f.momentum > 30 && !f._wasDom) say('momentum', { att: f.name }, 1);
      f._wasDom = f.momentum > 30;
    }
    if (sim.time - commentary.lastT > 7) say('quiet', {}, 0);
  }

  hudAcc += realDt;
  if (hudAcc > 0.08 && sim.phase !== 'intro') { hudAcc = 0; ui.update(sim, fighters); }
  boardAcc += realDt;
  if (boardAcc > 0.25) {
    boardAcc = 0;
    const left = Math.max(0, sim.roundLeft);
    const clock = sim.phase === 'intro' || sim.phase === 'walkout' && sim.round === 1 && sim.time < 3 ? 'FIGHT NIGHT' : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    arena.setBoard({
      header: sim.phase === 'over' ? 'FINAL' : `ROUND ${Math.min(sim.round, sim.rounds)} OF ${sim.rounds}`,
      clock,
      red: { name: A.name, hp: A.hp, css: A.css },
      blue: { name: B.name, hp: B.hp, css: B.css },
      footer: `CARD ${sim.cardTotal(A)} – ${sim.cardTotal(B)}   ·   ${sim.source === 'jev' ? 'POWERED BY JEV' : 'LOCAL AI'}`,
    });
  }
}
renderer.setAnimationLoop(() => frame());
// debug: advance the sim headlessly, e.g. __sim.advance(10) — returns ms per frame
sim.advance = (seconds, fps = 60, render = false) => {
  const t0 = performance.now();
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) frame(1 / fps, !render);
  return (performance.now() - t0) / n;
};

document.fonts.ready.then(() => $('loading').classList.add('hidden'));
