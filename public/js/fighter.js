// Fighter: combat state machine + procedural pose controller driving the Rig.
//
// Jev picks a strategic action ~1/s. On top of that the fighter has:
//  - strike phases (wind-up / strike / hold / recover) with a real glove path;
//    whether it lands is decided by where the glove actually ends up
//  - a reflex layer: when the opponent telegraphs a punch, the fighter may
//    block or slip, biased by how defensive Jev's last distribution was
//  - autonomous footwork that manages range between decisions
import * as THREE from 'three';
import { Rig } from './rig.js';
import { MOVES, COMBOS, STRIKES, ACTION_SET, MAT_Y, RING_BOUND } from './config.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _c = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// torso deltas (on top of the guard pose) for each strike kind + hand, per phase
const TORSO = {
  straightL: { wind: { sYaw: 0.06, hipY: -0.01 }, strike: { sYaw: -0.34, pYaw: -0.06, sPitch: 0.1, hipZ: 0.08 } },
  straightR: { wind: { sYaw: 0.1, pYaw: -0.05 }, strike: { sYaw: 0.55, pYaw: 0.38, sPitch: 0.12, hipZ: 0.11 } },
  hookL: { wind: { sYaw: 0.24, hipY: -0.03 }, strike: { sYaw: -0.55, pYaw: -0.28, hipY: -0.05 } },
  hookR: { wind: { sYaw: -0.22, hipY: -0.03 }, strike: { sYaw: 0.62, pYaw: 0.32, hipY: -0.05 } },
  upperR: { wind: { hipY: -0.12, sYaw: -0.14, sPitch: 0.24, sRoll: -0.12 }, strike: { hipY: 0.04, sYaw: 0.42, pYaw: 0.22, sPitch: -0.1 } },
  upperL: { wind: { hipY: -0.12, sYaw: 0.14, sPitch: 0.24, sRoll: 0.12 }, strike: { hipY: 0.04, sYaw: -0.4, pYaw: -0.2, sPitch: -0.1 } },
  bodyL: { wind: { hipY: -0.13, sPitch: 0.26, sYaw: 0.16, sRoll: 0.12 }, strike: { hipY: -0.17, sPitch: 0.34, sYaw: -0.42, pYaw: -0.16 } },
  bodyR: { wind: { hipY: -0.13, sPitch: 0.26, sYaw: -0.16, sRoll: -0.12 }, strike: { hipY: -0.17, sPitch: 0.34, sYaw: 0.45, pYaw: 0.2 } },
  overhandR: { wind: { sYaw: -0.42, sPitch: -0.14, hipZ: -0.09, sRoll: 0.12 }, strike: { sYaw: 0.78, pYaw: 0.38, sPitch: 0.42, hipZ: 0.15, sRoll: -0.16 } },
  pushB: { wind: { hipZ: -0.06, sPitch: -0.03, sYaw: 0.25 }, strike: { hipZ: 0.17, sPitch: 0.24, sYaw: 0.25 } },
};
const TELEGRAPH = { jab: 0.5, cross: 0.85, hook: 1.0, uppercut: 1.0, body: 0.8, haymaker: 1.7, push: 0.7, lead_upper: 0.7, check_hook: 0.8, body_jab: 0.55 };

export class Fighter {
  constructor(profile, scene, game) {
    this.profile = profile;
    this.key = profile.key;
    this.name = profile.name;
    this.nick = profile.nick;
    this.color = profile.color;
    this.css = profile.css;
    this.traits = profile.traits;
    this.game = game;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.rig = new Rig(profile.look, profile.traits);
    this.group.add(this.rig.root);
    this.rig.onStep = (side, speed) => game.onStep(this, speed);

    const t = profile.traits, L = this.rig.L;
    this.dmgMul = 0.62 + 0.38 * t.mass;
    this.speedMul = (0.9 + 0.1 * t.legLen) * (1.1 - 0.1 * t.mass);
    this.handSpeed = 1.12 - 0.12 * t.mass;
    this.chin = 0.72 + 0.28 * t.mass;
    // reach (centre-to-centre) at which a glove can touch a same-size opponent's head
    const shY = L.baseHip + 0.08 + L.abd + L.chest - L.shDrop;
    const headY = L.baseHip + 0.08 + L.abd + L.chest + L.neck + L.headR * 0.9;
    const horiz = Math.sqrt(Math.max(0.05, L.armReach ** 2 - (headY - shY) ** 2 - 0.12 ** 2));
    this.reach = horiz + 0.12 + 0.07 + L.gloveR * 0.85;
    // fighting style: biases Jev's distribution + a per-fight random jitter so no two fights look alike
    const st = profile.styleDef || { mult: {}, reflex: 1, range: 0, bounce: 1, aggression: 1 };
    this.style = st;
    this.styleMult = {};
    for (const a of ACTION_SET) this.styleMult[a] = (st.mult[a] ?? 1) * rnd(0.7, 1.35);
    this.reflexSkill = st.reflex * rnd(0.85, 1.15);
    this.aggression = st.aggression * rnd(0.85, 1.15);
    this.idealDist = this.reach - 0.04 + st.range;
    this.special = profile.special;
    this.top = L.baseHip + 0.08 + L.abd + L.chest;   // chest-top height in stance

    const disc = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.52, 48),
      new THREE.MeshBasicMaterial({ color: profile.color, transparent: true, opacity: 0.32, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.012;
    this.group.add(disc);
    this.disc = disc;
    this.opp = null;
    this.reset(0, 0, 0);
  }

  reset(x, z, yaw) {
    this.hp = 100; this.stamina = 100; this.maxStamina = 100; this.poise = 100; this.guard = 100;
    this.momentum = 0; this.knockdowns = 0; this.kdRound = 0;
    this.stats = { thrown: 0, landed: 0, blockedOn: 0, whiffed: 0, power: 0, dmg: 0, dmgTaken: 0, slipped: 0, blocks: 0,
      maxCombo: 0, counters: 0, staggers: 0, clinches: 0, pushes: 0, head: 0, bodyL: 0, reflexes: 0 };
    this.roundPts = 0;
    this.comboCtr = 0;
    this.lastActions = [];
    this.landedLog = []; this.takenLog = [];
    this.state = 'idle'; this.st = 0; this.dur = Infinity;
    this.strike = null; this.pending = null; this.thenStrike = null;
    this.lastJev = null; this.intent = '-';
    this.flags = { blocking: false, dodging: false, taunting: false };
    this.kb = new THREE.Vector3();
    this.reflex = null; this.autoCounter = 0; this.counterUntil = 0;
    this.circleDir = Math.random() < 0.5 ? 1 : -1; this.circleFlipT = 0;
    this.walkTarget = null; this.faceTarget = null; this.onArrive = null;
    this.variant = null; this.blockStun = 0; this.flashT = 0;
    this.downPose = null; this.ko = false;
    this.meter = 0; this.raiseHand = false;
    this.rig.rag = null; this.rig.ragW = 0; this.rig.ragTarget = 0;
    this.yaw = yaw;
    this.group.position.set(x, MAT_Y, z);
    this.group.rotation.y = yaw;
    this.group.updateMatrixWorld(true);
    const rig = this.rig;
    for (const k in rig.P) { rig.P[k] = 0; rig.C[k] = 0; }
    rig.plantFeet(this.group.matrixWorld, yaw);
    rig.resetGloves();
  }

  // ---------------- queries ----------------
  get pos() { return this.group.position; }
  distTo(o) { return Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z); }
  get rocked() { return this.poise < 30; }
  get inRange() { return this.opp && this.distTo(this.opp) <= this.reach + 0.3; }
  get down() { return ['falling', 'down', 'getup', 'ko'].includes(this.state); }
  get time() { return this.game.time; }

  spatial() {
    const p = this.pos;
    const cornered = Math.abs(p.x) > 2.5 && Math.abs(p.z) > 2.5;
    const mx = Math.max(Math.abs(p.x), Math.abs(p.z));
    return { cornered, on_ropes: !cornered && mx > 2.65, dist_to_center: +Math.hypot(p.x, p.z).toFixed(2) };
  }

  statusTags() {
    const s = [];
    if (this.hp < 30) s.push('hurt');
    if (this.stamina < 22) s.push('gassed');
    if (this.rocked) s.push('rocked');
    if (this.guard < 30) s.push('guard broken');
    const sp = this.spatial();
    if (sp.cornered) s.push('cornered');
    else if (sp.on_ropes) s.push('on the ropes');
    if (this.momentum > 25) s.push('dominating');
    if (this.momentum < -25) s.push('overwhelmed');
    if (this.time < this.counterUntil) s.push('counter ready');
    const atk = this.lastActions.filter((a) => STRIKES.has(a));
    if (atk.length >= 3 && atk.slice(-3).every((a) => a === atk[atk.length - 1])) s.push('predictable');
    return s;
  }

  recordAction(a) {
    this.lastActions.push(a);
    if (this.lastActions.length > 8) this.lastActions.shift();
  }

  tempo() {
    let t = 1 / this.handSpeed;
    if (this.stamina < 30) t *= 1.18;
    if (this.stamina < 12) t *= 1.15;
    if (this.poise < 30) t *= 1.12;
    return t;
  }

  // ---------------- commands ----------------
  // Jev's pick (already sampled from its distribution)
  command(a, answer) {
    if (!ACTION_SET.has(a)) a = 'advance';
    this.lastJev = answer || this.lastJev;
    this.intent = a;
    if (this.locked) return;
    if (['hit', 'stagger', 'clinch', 'clinched'].includes(this.state)) { this.pending = a; return; }
    if (this.state === 'strike' && this.strike && this.strike.phase !== 'rec' && this.strike.phase !== 'wind') { this.pending = a; return; }
    if (a === this.state && ['block', 'advance', 'circle', 'retreat', 'rest'].includes(a)) { this.dur = Math.max(this.dur, this.st + 0.9); return; }
    this.start(a);
  }

  get locked() {
    return ['falling', 'down', 'getup', 'ko', 'walk', 'wait', 'sit', 'celebrate', 'dejected', 'frozen'].includes(this.state);
  }

  enter(state, dur = Infinity) {
    this.state = state;
    this.st = 0;
    this.dur = dur;
    this.flags.blocking = this.flags.dodging = this.flags.taunting = false;
    if (state !== 'strike' && this.strike) this.endStrike();
  }

  start(a) {
    this.recordAction(a);
    this.pending = null;
    this.thenStrike = null;
    const opp = this.opp;
    const dist = this.distTo(opp);
    if (a === 'special' && this.meter < 100) a = 'combo';
    if (STRIKES.has(a) || a === 'clinch') {
      if (dist > this.reach + (a === 'clinch' ? 0.3 : 0.62)) {       // too far: close in first, then throw
        this.thenStrike = a;
        this.enter('advance', 2.2);
        return;
      }
      if (a === 'clinch') { this.game.tryClinch(this); return; }
      if (a === 'special') {
        this.meter = 0;
        this.enter('strike');
        this.strike = { queue: [...this.special.seq], i: 0, combo: true, special: this.special };
        this.stamina = Math.max(0, this.stamina - 10);
        this.game.onSpecial(this);
        this.nextStrike(true);
        return;
      }
      let queue = a === 'combo' ? [...pick(COMBOS)] : [a];
      let cost = queue.reduce((s, n) => s + MOVES[n].cost, 0) * (a === 'combo' ? 0.8 : 1);
      if (this.stamina < cost) {
        if (this.stamina >= MOVES.jab.cost) { queue = ['jab']; cost = MOVES.jab.cost; } else { this.enter('rest', 1.2); return; }
      }
      this.stamina -= cost;
      this.enter('strike');
      this.strike = { queue, i: 0, combo: queue.length > 1 };
      this.nextStrike(true);
      return;
    }
    switch (a) {
      case 'block': this.enter('block', 1.1); break;
      case 'dodge': this.enter('dodge', 0.52); this.variant = pick(['slipL', 'slipR', 'duck', 'pull']); break;
      case 'retreat': this.enter('retreat', 0.95); break;
      case 'circle': {
        this.enter('circle', 1.1);
        // strafe toward open space
        _v.subVectors(opp.pos, this.pos).setY(0).normalize();
        const px = -_v.z, pz = _v.x;
        const a1 = Math.max(Math.abs(this.pos.x + px), Math.abs(this.pos.z + pz));
        const a2 = Math.max(Math.abs(this.pos.x - px), Math.abs(this.pos.z - pz));
        this.circleDir = a1 < a2 ? 1 : -1;
        break;
      }
      case 'rest': this.enter('rest', 1.4); break;
      case 'weave':
        this.enter('weave', 0.62);
        this.variant = Math.random() < 0.5 ? 1 : -1;
        break;
      case 'feint':
        if (this.stamina < 2) { this.enter('rest', 1); break; }
        this.stamina -= 2;
        this.enter('feint', 0.34);
        this.variant = pick(['L', 'R']);
        this._baited = false;
        break;
      case 'taunt':
        this.enter('taunt', 1.5);
        this.variant = pick(['shimmy', 'beckon', 'showboat']);
        this.game.onTaunt(this);
        break;
      case 'advance':
      default:
        this.enter('advance', 1.6);
    }
  }

  // ---------------- strikes ----------------
  nextStrike(first) {
    const s = this.strike;
    const name = s.queue[s.i];
    const mv = MOVES[name];
    const tempo = this.tempo() * (s.special ? s.special.tempo : 1);
    s.name = name;
    s.mv = mv;
    s.phase = 'wind';
    s.t = 0;
    s.dur = { wind: mv.wind * tempo * (first ? 1 : 0.5), strike: mv.strike * tempo, hold: mv.hold, rec: mv.rec * tempo };
    s.hand = mv.hand;
    // a straight right after a jab etc. alternates naturally; hooks in a combo take the free hand
    if (!first && mv.hand !== 'B' && s.prevHand === mv.hand && mv.kind !== 'straight') s.hand = mv.hand === 'L' ? 'R' : 'L';
    s.prevHand = s.hand;
    s.resolved = false;
    s.result = null;
    s.aimW = null;
    const dist = this.distTo(this.opp);
    s.lunge = THREE.MathUtils.clamp(dist - (this.reach - 0.06), 0, 0.42);
    s.start = { L: new THREE.Vector3(), R: new THREE.Vector3() };
    s.windT = {};
    this.game.strikeStart(this, name, s.dur.wind + s.dur.strike);
  }

  endStrike() {
    this.rig.glove.L.direct = false;
    this.rig.glove.R.direct = false;
    this.strike = null;
  }

  aimPoint(target, out) {
    const r = this.opp.rig;
    if (target === 'body') r.neutralBodyLocal(out);
    else if (target === 'chest') r.neutralBodyLocal(out).setY(out.y + 0.12);
    else if (target === 'chin') r.chinLocal(out);
    else r.neutralHeadLocal(out);
    return out.applyMatrix4(this.opp.group.matrixWorld);
  }

  updateStrike(dt) {
    const s = this.strike, rig = this.rig;
    s.t += dt;
    const mv = s.mv;
    const side = s.hand === 'L' ? 1 : -1;
    if ((s.phase === 'wind' || s.phase === 'strike') && s.lunge > 0) {
      const step = (s.lunge * dt) / (s.dur.wind + s.dur.strike);
      _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.pos.addScaledVector(_v, step);
    }
    if (mv.pivot && (s.phase === 'strike' || s.phase === 'hold')) {
      // check hook: pivot off the lead foot and step out of the line
      _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.pos.x += -_v.z * this.circleDir * 1.9 * dt;
      this.pos.z += _v.x * this.circleDir * 1.9 * dt;
    }
    const hands = s.hand === 'B' ? ['L', 'R'] : [s.hand];
    if (s.phase === 'wind') {
      for (const h of hands) {
        const hs = h === 'L' ? 1 : -1;
        rig.guardPos(h, _v);
        const k = mv.kind;
        if (k === 'straight') _v.add(_w.set(0, -0.02, -0.05));
        else if (k === 'hook') _v.add(_w.set(hs * 0.1, 0, -0.04));
        else if (k === 'upper') _v.add(_w.set(0, -0.22, -0.03));
        else if (k === 'body') _v.add(_w.set(hs * 0.06, -0.26, 0));
        else if (k === 'overhand') _v.add(_w.set(hs * 0.14, 0.2, -0.32));
        else if (k === 'push') _v.set(hs * 0.14, this.top - 0.12, 0.12);
        (s.windT[h] = s.windT[h] || new THREE.Vector3()).copy(_v);
      }
      if (s.t >= s.dur.wind) {
        s.phase = 'strike';
        s.t = 0;
        s.aimW = this.aimPoint(mv.target, new THREE.Vector3());
        if (s.hand === 'B') s.aimW2 = s.aimW.clone();
        for (const h of hands) { rig.glove[h].direct = true; s.start[h].copy(rig.glove[h].pos); }
        this.game.whoosh(this, s.name);
      }
    }
    if (s.phase === 'strike') {
      const k = Math.min(1, s.t / s.dur.strike);
      const e = k * k * (3 - 2 * k) * 0.35 + k * k * 0.65;   // accelerate into the target
      _inv.copy(this.group.matrixWorld).invert();
      for (const h of hands) {
        const hs = h === 'L' ? 1 : -1;
        const aim = _u.copy(s.aimW).applyMatrix4(_inv);
        if (s.hand === 'B') aim.x += hs * 0.13;
        this.strikePath(mv.kind, hs, s.start[h], aim, e, rig.glove[h].pos, h);
      }
      if (k >= 1 && !s.resolved) {
        s.resolved = true;
        const gl = hands[0] === 'L' ? 'glL' : 'glR';
        s.result = this.game.impact(this, this.opp, s.name, rig.world(gl, new THREE.Vector3()));
        s.phase = 'hold';
        s.t = 0;
      }
    } else if (s.phase === 'hold') {
      if (s.result === 'blocked') for (const h of hands) rig.glove[h].pos.lerp(rig.gloveTarget[h], dt * 6);
      if (s.t >= s.dur.hold) {
        s.phase = 'rec';
        s.t = 0;
        for (const h of hands) { rig.glove[h].direct = false; rig.glove[h].vel.multiplyScalar(0); }
      }
    } else if (s.phase === 'rec') {
      const last = s.i >= s.queue.length - 1;
      if (s.t >= s.dur.rec * (last ? 1 : 0.3)) {
        if (!last && s.result !== 'slipped') {
          s.i++;
          this.nextStrike(false);
        } else {
          this.endStrike();
          this.toIdle();
        }
      }
    }
  }

  // glove path in local space from S to aim, eased progress e
  strikePath(kind, side, S, aim, e, out, hand) {
    const L = this.rig.L;
    // stop the glove a little short of the target centre so the leather meets the face
    const C = _c;
    if (kind === 'hook') C.set(aim.x + side * 0.44, (S.y + aim.y) / 2 + 0.02, (S.z + aim.z) / 2 + 0.06);
    else if (kind === 'body') C.set(aim.x + side * 0.38, aim.y - 0.05, (S.z + aim.z) / 2);
    else if (kind === 'upper') C.set((S.x + aim.x) / 2, Math.min(S.y, aim.y) - 0.2, aim.z - 0.14);
    else if (kind === 'overhand') C.set(side * 0.32, Math.max(S.y, aim.y) + 0.36, (S.z + aim.z) / 2 - 0.05);
    else C.lerpVectors(S, aim, 0.5);
    _w.subVectors(aim, C).normalize();
    const I = _v.copy(aim).addScaledVector(_w, -L.gloveR * 0.85);
    // quadratic bezier S -> C -> I
    const a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, c = e * e;
    out.set(a * S.x + b * C.x + c * I.x, a * S.y + b * C.y + c * I.y, a * S.z + b * C.z + c * I.z);
  }

  // ---------------- reflexes ----------------
  canReflex() {
    if (['idle', 'advance', 'retreat', 'circle', 'rest', 'taunt'].includes(this.state)) return true;
    return this.state === 'strike' && this.strike && (this.strike.phase === 'rec' || this.strike.phase === 'wind');
  }

  incoming(att, name, tImpact) {
    if (!this.canReflex() || this.reflex) return;
    const probs = this.lastJev && this.lastJev.probabilities;
    const defMass = probs ? (probs.block || 0) + (probs.dodge || 0) : 0.25;
    let p = (0.2 + defMass * 0.95) * (TELEGRAPH[name] ?? 0.8) * (0.35 + 0.65 * this.poise / 100) * (this.stamina < 15 ? 0.5 : 1) * this.reflexSkill;
    if (this.state === 'rest' || this.state === 'taunt') p *= 0.45;
    if (Math.random() > Math.min(0.85, p)) return;
    const delay = rnd(0.09, 0.2) + (this.poise < 40 ? 0.06 : 0);
    const pd = probs ? (probs.dodge || 0.02) / ((probs.dodge || 0.02) + (probs.block || 0.02)) : 0.5;
    let act = Math.random() < pd * (name === 'haymaker' || name === 'hook' ? 1.35 : 1) ? 'dodge' : 'block';
    if (act === 'dodge' && delay + 0.07 > tImpact) act = 'block';
    if (act === 'block' && delay + 0.035 > tImpact) return;       // too slow to react
    let variant = null;
    if (act === 'dodge' && (name === 'hook' || name === 'haymaker' || name === 'check_hook') && Math.random() < 0.35 * this.styleMult.weave) {
      act = 'weave';
      variant = Math.random() < 0.5 ? 1 : -1;
    } else if (act === 'dodge') {
      if (name === 'hook' || name === 'haymaker') variant = Math.random() < 0.6 ? 'duck' : 'pull';
      else if (name === 'uppercut' || name === 'body') variant = 'pull';
      else variant = pick(['slipL', 'slipR', 'slipL', 'pull']);
    }
    this.reflex = { at: this.time + delay, act, variant };
  }

  // ---------------- damage ----------------
  // returns 'blocked' | 'hit' | 'stagger' | 'down'
  takeHit({ dmg, poiseDmg, dirW, kind, blocked, power, body }) {
    const rig = this.rig;
    _inv.copy(this.group.matrixWorld).invert();
    const d = _v.copy(dirW).transformDirection(_inv);
    const kick = 6 + power * 16;
    if (blocked) {
      rig.imp.chest.kick(-2 * power, 0, 0);
      rig.imp.head.kick(-3 * power, d.x * 2, 0);
      for (const h of ['L', 'R']) rig.glove[h].vel.addScaledVector(d, 1.5 + power * 2);
      this.kb.addScaledVector(dirW, 0.4 + power * 0.8);
      this.hp = Math.max(1, this.hp - dmg);
      this.blockStun = 0.14;
      return 'blocked';
    }
    this.hp = Math.max(0, this.hp - dmg);
    this.poise = Math.max(0, this.poise - poiseDmg / this.chin);
    this.flashT = 0.16;
    this.takenLog.push(this.time);
    if (body) {
      rig.imp.chest.kick(kick * 0.7, d.x * 3, -d.x * 3);
      rig.imp.hip.kick(d.x * 0.3, -0.4, d.z * 0.6);
      rig.imp.head.kick(kick * 0.3, 0, 0);
    } else {
      rig.imp.head.kick(d.z * kick - Math.max(0, d.y) * kick * 1.4, d.x * kick * 1.2, -d.x * kick * 0.5);
      rig.imp.chest.kick(d.z * kick * 0.35, d.x * kick * 0.35, -d.x * kick * 0.2);
      rig.imp.hip.kick(d.x * 0.25, 0, d.z * 0.5);
    }
    this.kb.addScaledVector(dirW, (0.7 + power * 1.8) / Math.sqrt(this.traits.mass));
    if (this.strike) this.endStrike();
    this.reflex = null;
    if (this.hp <= 0) return 'down';
    if (this.poise <= 0) {
      this.poise = 42;
      if ((this.hp < 45 && Math.random() < 0.55) || (power > 0.85 && this.hp < 60)) return 'down';
      this.enter('stagger', 1.25);
      return 'stagger';
    }
    this.enter('hit', 0.2 + power * 0.28);
    return 'hit';
  }

  knockdown(lie, impulseW) {
    this.enter('falling', 0.95);
    // physics takes over the fall
    _inv.copy(this.group.matrixWorld).invert();
    const imp = impulseW ? impulseW.clone().transformDirection(_inv).multiplyScalar(impulseW.length()) : new THREE.Vector3(0, 0, -2);
    imp.y += 0.6;
    this.rig.startRagdoll(imp);
    this.downPose = lie ? 'lie' : 'sit';
    this.flags.blocking = this.flags.dodging = false;
    this.rig.setFootMode('manual', this.group.matrixWorld);
    this.pending = null;
    this.reflex = null;
    this._floored = false;
  }

  getUp() {
    this.enter('getup', 1.5);
    this.rig.ragTarget = 0;
    this.pending = null;
  }

  koNow() {
    this.ko = true;
    if (!this.down) this.knockdown(true);
    this.downPose = 'lie';
  }

  toIdle() {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.start(p);
      return;
    }
    this.enter('idle');
    this.game.onIdle(this);
  }

  walkTo(x, z, then, face) {
    if (this.down && this.state !== 'getup') return;
    this.enter('walk');
    this.walkTarget = new THREE.Vector3(x, MAT_Y, z);
    this.onArrive = then || null;
    this.faceTarget = face || null;
  }

  // ---------------- per-frame ----------------
  update(dt) {
    const opp = this.opp, rig = this.rig;
    if (dt <= 0) return;
    this.st += dt;

    // passive recovery
    if (!this.down) {
      const cardio = 1.1 - 0.15 * (this.traits.mass - 1) - 0.25 * ((this.traits.belly ?? 1) - 1);
      const regen = ['rest', 'sit', 'clinch'].includes(this.state) ? 0 : 3.2 * cardio;
      this.stamina = Math.min(this.maxStamina, this.stamina + regen * dt);
      this.poise = Math.min(100, this.poise + 4.5 * dt);
      this.guard = Math.min(100, this.guard + 7 * dt);
    }
    this.momentum += (this.momentum > 0 ? -1 : 1) * Math.min(Math.abs(this.momentum), 1.4 * dt);
    this.blockStun = Math.max(0, this.blockStun - dt);

    // reflex fires
    if (this.reflex && this.time >= this.reflex.at) {
      const r = this.reflex;
      this.reflex = null;
      if (this.canReflex()) {
        this.recordAction(r.act);
        this.enter(r.act, r.act === 'block' ? 0.7 : r.act === 'weave' ? 0.62 : 0.5);
        this.variant = r.variant;
        this.stats.reflexes++;
        this.game.onReflex(this, r.act);
      }
    }
    if (this.autoCounter && this.time >= this.autoCounter) {
      this.autoCounter = 0;
      if (['dodge', 'idle', 'block'].includes(this.state) && this.stamina > 14) this.start(Math.random() < 0.55 ? 'cross' : 'hook');
    }

    // knockback + rope bounce
    if (this.kb.lengthSq() > 1e-4) {
      this.pos.addScaledVector(this.kb, dt);
      this.kb.multiplyScalar(Math.exp(-6 * dt));
    }

    const toOpp = _u.subVectors(opp.pos, this.pos).setY(0);
    const dist = toOpp.length();
    toOpp.divideScalar(dist || 1);
    let faceYaw = Math.atan2(toOpp.x, toOpp.z);
    let turnRate = 10;

    switch (this.state) {
      case 'idle': {
        // footwork: hold ideal range, drift around the opponent, bounce
        const err = dist - this.idealDist;
        const v = Math.abs(err) < 0.08 ? 0 : THREE.MathUtils.clamp(err * 2.2, -0.9, 0.9) * this.speedMul;
        this.pos.addScaledVector(toOpp, v * dt);
        this.circleFlipT -= dt;
        if (this.circleFlipT <= 0) { this.circleFlipT = rnd(1.5, 4); if (Math.random() < 0.5) this.circleDir *= -1; }
        this.pos.x += -toOpp.z * this.circleDir * 0.3 * dt;
        this.pos.z += toOpp.x * this.circleDir * 0.3 * dt;
        break;
      }
      case 'advance': {
        const want = this.thenStrike ? this.reach + (this.thenStrike === 'clinch' ? 0.1 : 0.25) : this.idealDist;
        if (dist <= want) {
          if (this.thenStrike) { const a = this.thenStrike; this.thenStrike = null; this.lastActions.pop(); this.start(a); }
          else this.toIdle();
          break;
        }
        this.pos.addScaledVector(toOpp, 2.1 * this.speedMul * dt);
        break;
      }
      case 'retreat':
        this.pos.addScaledVector(toOpp, -1.6 * this.speedMul * dt);
        break;
      case 'circle':
        this.pos.x += (-toOpp.z * this.circleDir * 1.7 - toOpp.x * 0.15) * this.speedMul * dt;
        this.pos.z += (toOpp.x * this.circleDir * 1.7 - toOpp.z * 0.15) * this.speedMul * dt;
        break;
      case 'block':
        this.flags.blocking = this.st > 0.05;
        this.pos.addScaledVector(toOpp, -0.15 * dt);
        break;
      case 'dodge':
        this.flags.dodging = this.st > 0.03 && this.st < 0.42;
        if (this.variant === 'pull') this.pos.addScaledVector(toOpp, -0.7 * dt);
        break;
      case 'rest':
        this.stamina = Math.min(this.maxStamina, this.stamina + 11 * dt);
        break;
      case 'weave':
        this.flags.dodging = this.st > 0.05 && this.st < 0.5;
        this.pos.addScaledVector(toOpp, (dist > this.idealDist - 0.1 ? 0.45 : 0) * dt);
        if (this.st >= this.dur) this.counterUntil = this.time + 0.9;
        break;
      case 'feint':
        if (!this._baited && this.st > 0.05) {
          this._baited = true;
          opp.incoming(this, this.variant === 'L' ? 'jab' : 'cross', 0.22);
        }
        if (this.st >= this.dur) {
          // punish whatever the bait drew out
          const next = opp.state === 'block' ? pick(['body', 'lead_upper', 'body_jab'])
            : opp.state === 'dodge' || opp.state === 'weave' ? pick(['hook', 'cross']) : null;
          this.st = 0; this.dur = Infinity;
          if (next && this.stamina > 8) { this.game.onFeint(this, true); this.start(next); } else this.toIdle();
        }
        break;
      case 'taunt':
        this.flags.taunting = true;
        this.stamina = Math.min(this.maxStamina, this.stamina + 5 * dt);
        break;
      case 'strike':
        turnRate = 14;
        this.updateStrike(dt);
        break;
      case 'stagger':
        this.pos.x += Math.sin(this.st * 4.3 + this.hp) * 0.5 * dt;
        this.pos.z += Math.cos(this.st * 3.1) * 0.5 * dt;
        turnRate = 2;
        break;
      case 'clinch': case 'clinched':
        this.stamina = Math.min(this.maxStamina, this.stamina + (this.state === 'clinch' ? 8 : 3) * dt);
        this.poise = Math.min(100, this.poise + 8 * dt);
        break;
      case 'walk': {
        _v.subVectors(this.walkTarget, this.pos).setY(0);
        const d = _v.length();
        if (d < 0.08) {
          const cb = this.onArrive;
          this.onArrive = null;
          this.enter('wait');
          if (cb) cb(this);
          break;
        }
        _v.divideScalar(d);
        this.pos.addScaledVector(_v, Math.min(d, 1.45 * dt));
        faceYaw = Math.atan2(_v.x, _v.z);
        turnRate = 6;
        break;
      }
      case 'wait': case 'sit': case 'dejected': case 'celebrate': case 'frozen':
        turnRate = 4;
        break;
      case 'falling':
        turnRate = 0;
        if (this.st > 0.62 && !this._floored) { this._floored = true; this.game.onFloor(this); rig.imp.hip.kick(0, 1.2, 0); }
        if (this.st >= this.dur) { this.state = 'down'; this.st = 0; this.dur = Infinity; }
        break;
      case 'down': case 'ko':
        turnRate = 0;
        break;
      case 'getup':
        turnRate = 3;
        if (this.st > this.dur * 0.55 && rig.footMode === 'manual') rig.setFootMode('auto', this.group.matrixWorld);
        break;
    }
    if (this.faceTarget && ['walk', 'wait', 'sit', 'celebrate', 'dejected'].includes(this.state) && (this.state !== 'walk' || this.walkTarget.distanceTo(this.pos) < 0.5)) {
      faceYaw = Math.atan2(this.faceTarget.x - this.pos.x, this.faceTarget.z - this.pos.z);
    }

    // timed states end
    if (this.st >= this.dur && !['falling', 'strike', 'walk'].includes(this.state)) {
      if (this.state === 'getup') { this.enter('idle'); this.game.onIdle(this); }
      else if (this.state === 'clinch' || this.state === 'clinched') { /* game breaks the clinch */ }
      else this.toIdle();
    }

    // ring bounds -> ropes push back
    for (const ax of ['x', 'z']) {
      if (Math.abs(this.pos[ax]) > RING_BOUND) {
        const sgn = Math.sign(this.pos[ax]);
        const over = Math.abs(this.pos[ax]) - RING_BOUND;
        this.pos[ax] = sgn * RING_BOUND;
        if (this.kb[ax] * sgn > 0.6) this.game.ropeHit(this, Math.abs(this.kb[ax]));
        if (this.kb[ax] * sgn > 0) this.kb[ax] *= -0.45;
        if (over > 0.001 && this.state === 'retreat') this.dur = Math.min(this.dur, this.st + 0.1);
      }
    }

    if (turnRate > 0) this.yaw += angDiff(this.yaw, faceYaw) * Math.min(1, dt * turnRate);
    this.group.rotation.y = this.yaw;
    this.group.position.y = MAT_Y;
    this.group.updateMatrixWorld(true);

    // opponent's torso + head are solid for my gloves
    if (!this.down) {
      _inv.copy(this.group.matrixWorld).invert();
      const o = opp.rig, cols = rig.colliders;
      if (!cols.length) for (let i = 0; i < 2; i++) cols.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 });
      o.world('waist', cols[0].a).applyMatrix4(_inv);
      o.world('chestTop', cols[0].b).applyMatrix4(_inv);
      cols[0].r = 0.14 * o.thick * Math.sqrt(opp.traits.belly ?? 1);
      o.world('head', cols[1].a).applyMatrix4(_inv);
      cols[1].b.copy(cols[1].a);
      cols[1].r = 0.12;
    } else rig.colliders.length = 0;
    // a sitting knockdown: the ragdoll crumple settles into a seated pose
    if (this.state === 'down' && this.downPose === 'sit' && this.st > 0.6) rig.ragTarget = 0;
    this.pose(dt, dist);
    rig.update(dt, this.group.matrixWorld, this.yaw);

    // hit flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      rig.setTint(0xff2020, this.flashT > 0 ? this.flashT * 4 : 0);
    }
  }

  // ---------------- pose controller ----------------
  pose(dt, dist) {
    const rig = this.rig, P = rig.P, top = this.top;
    const t = this.time;
    const tired = 1 - this.stamina / 100;
    // guard base
    P.hipX = 0; P.hipY = -0.03 - tired * 0.04; P.hipZ = 0;
    P.pYaw = -0.45; P.pPitch = 0.04; P.pRoll = 0;
    P.sYaw = 0.12; P.sPitch = 0.12 + tired * 0.08; P.sRoll = 0;
    P.hPitch = 0; P.hYaw = 0; P.hRoll = 0;
    P.breath = Math.max(tired, this.state === 'rest' ? 1 : 0);
    rig.rate = 12;
    rig.rates = {};
    rig.bounce = 0;
    rig.lookWeight = 1;
    rig.browAngle = this.rocked ? -0.35 : 0.25;
    rig.stance.L[0] = 0.13; rig.stance.L[1] = 0.19; rig.stance.L[2] = -0.2;
    rig.stance.R[0] = -0.15; rig.stance.R[1] = -0.2; rig.stance.R[2] = -0.85;
    rig.stepThresh = 0.13;
    rig.gloveK = 340;
    // look at the opponent's head
    this.opp.rig.neutralHeadLocal(_c).applyMatrix4(this.opp.group.matrixWorld);
    _inv.copy(this.group.matrixWorld).invert();
    rig.lookTarget = (rig.lookTarget || new THREE.Vector3()).copy(_c).applyMatrix4(_inv);
    const gL = rig.gloveTarget.L, gR = rig.gloveTarget.R;
    rig.guardPos('L', gL);
    rig.guardPos('R', gR);
    gL.y -= tired * 0.08; gR.y -= tired * 0.06;
    rig.poleTarget.L.set(0.55, -1, -0.35);
    rig.poleTarget.R.set(-0.55, -1, -0.35);
    const apply = (o) => { for (const k in o) P[k] += o[k]; };

    switch (this.state) {
      case 'idle': case 'advance': case 'retreat': case 'circle':
        rig.bounce = (this.state === 'idle' ? 1 - tired * 0.6 : 0.4) * this.style.bounce;
        if (this.state === 'advance') { P.sPitch += 0.08; P.hipZ = 0.03; }
        if (this.state === 'retreat') { P.sPitch -= 0.04; }
        // hands feint / pump slightly
        gL.z += Math.sin(t * 3.1 + 1) * 0.02;
        gR.y += Math.sin(t * 2.3) * 0.012;
        break;
      case 'strike': {
        const s = this.strike;
        if (!s) break;
        const key = s.mv.kind + (s.hand === 'B' ? 'B' : s.hand);
        const td = TORSO[key] || TORSO.straightL;
        rig.rate = 20;
        if (s.mv.dip && s.phase !== 'rec') { P.hipY -= 0.13; P.sPitch += 0.18; }
        if (s.phase === 'wind') apply(td.wind);
        else if (s.phase === 'strike' || s.phase === 'hold') apply(td.strike);
        else if (s.phase === 'rec') apply(td.strike), rig.rate = 9;
        if (s.phase === 'rec') for (const k in td.strike) P[k] -= td.strike[k] * Math.min(1, s.t / (s.dur.rec * 0.7));
        // elbow poles by punch type
        const sd = s.hand === 'L' ? 1 : -1;
        const pole = s.hand === 'L' ? rig.poleTarget.L : rig.poleTarget.R;
        if (s.phase !== 'rec') {
          const k = s.mv.kind;
          if (k === 'hook') pole.set(sd, 0.45, -0.2);
          else if (k === 'upper') pole.set(sd * 0.3, -1, 0.45);
          else if (k === 'body') pole.set(sd, -0.2, -0.1);
          else if (k === 'overhand') pole.set(sd * 0.7, 0.9, -0.3);
          else if (k === 'push') { rig.poleTarget.L.set(0.6, -0.6, 0); rig.poleTarget.R.set(-0.6, -0.6, 0); }
          else pole.set(sd * 0.45, -1, -0.2);
        }
        if (s.phase === 'wind') for (const h in s.windT) rig.gloveTarget[h].copy(s.windT[h]);
        // the free hand tucks to the chin
        if (s.hand === 'L') gR.set(-0.08, top + 0.1, 0.16);
        else if (s.hand === 'R') gL.set(0.09, top + 0.08, 0.22);
        rig.stepThresh = 0.16;
        break;
      }
      case 'block':
        P.hipY -= 0.07; P.sPitch = 0.26; P.sYaw = 0.3; P.pYaw = -0.3;
        gL.set(0.075, top + 0.17, 0.2);
        gR.set(-0.075, top + 0.17, 0.18);
        rig.poleTarget.L.set(0.25, -1, 0.1);
        rig.poleTarget.R.set(-0.25, -1, 0.1);
        rig.rates = { sPitch: 24, hipY: 24 };
        if (this.blockStun > 0) P.sPitch -= 0.15;
        break;
      case 'dodge': {
        const on = this.st < 0.38;
        rig.rate = on ? 26 : 12;
        if (on) {
          const v = this.variant;
          if (v === 'slipL') { P.hipX = 0.11; P.sRoll = -0.48; P.hipY -= 0.07; P.sYaw -= 0.2; }
          else if (v === 'slipR') { P.hipX = -0.11; P.sRoll = 0.48; P.hipY -= 0.07; P.sYaw += 0.25; }
          else if (v === 'duck') { P.hipY -= 0.26; P.sPitch = 0.55; P.pPitch = 0.15; }
          else { P.hipZ = -0.17; P.sPitch = -0.32; P.pPitch = -0.1; }
        }
        gL.y += 0.04; gR.y += 0.05;
        break;
      }
      case 'weave': {
        const k = Math.min(1, this.st / 0.55), u = Math.sin(Math.PI * k);
        rig.rate = 22;
        P.hipY -= 0.24 * u; P.sPitch = 0.12 + 0.42 * u;
        P.hipX = Math.cos(Math.PI * k) * 0.12 * this.variant; P.sRoll = -Math.cos(Math.PI * k) * 0.3 * this.variant;
        gL.y += 0.05; gR.y += 0.05;
        rig.stepThresh = 0.1;
        break;
      }
      case 'feint': {
        const u = Math.sin(Math.PI * Math.min(1, this.st / 0.3));
        rig.rate = 24;
        if (this.variant === 'L') { gL.z += 0.14 * u; P.sYaw -= 0.18 * u; P.hipY -= 0.04 * u; }
        else { gR.z += 0.1 * u; P.sYaw += 0.25 * u; P.sPitch += 0.08 * u; }
        rig.gloveK = 520;
        break;
      }
      case 'rest':
        P.hipY -= 0.03; P.sPitch = 0.26;
        gL.set(0.16, top - 0.2, 0.22);
        gR.set(-0.16, top - 0.22, 0.18);
        rig.gloveK = 120;
        break;
      case 'taunt': {
        rig.rate = 10;
        const v = this.variant;
        if (v === 'shimmy') {
          gL.set(0.5, top - 0.35, 0.1); gR.set(-0.5, top - 0.35, 0.1);
          P.sRoll = Math.sin(t * 13) * 0.2; P.sPitch = -0.15; P.sYaw = 0; P.pYaw = -0.1;
          rig.poleTarget.L.set(1, -0.5, -0.4); rig.poleTarget.R.set(-1, -0.5, -0.4);
        } else if (v === 'beckon') {
          gL.set(0.12, top + 0.02, 0.44 + Math.sin(t * 11) * 0.08);
          P.sPitch = -0.05; P.hRoll = 0.15;
        } else {
          gL.set(0.26, top - 0.6, 0.05); gR.set(-0.26, top - 0.6, 0.05);
          P.hYaw = Math.sin(t * 6) * 0.35; P.hRoll = Math.sin(t * 6 + 1) * 0.2; P.sPitch = -0.1;
          rig.bounce = 1;
        }
        rig.gloveK = 160;
        break;
      }
      case 'hit':
        gL.y -= 0.05; gR.y -= 0.04; gL.x += 0.05; gR.x -= 0.05;
        P.sPitch -= 0.08;
        break;
      case 'stagger': {
        rig.rate = 7;
        const w = this.st * 5;
        P.hipX = Math.sin(w) * 0.09; P.pRoll = Math.sin(w + 1) * 0.12; P.hipY -= 0.12;
        P.sRoll = Math.sin(w * 0.7) * 0.18; P.hRoll = Math.sin(w * 1.3) * 0.3; P.hPitch = 0.2;
        gL.set(0.22, top - 0.32, 0.18); gR.set(-0.22, top - 0.35, 0.14);
        rig.gloveK = 90;
        rig.lookWeight = 0.35;
        rig.stepThresh = 0.09;
        break;
      }
      case 'clinch': case 'clinched': {
        P.sPitch = 0.34; P.sYaw = 0; P.pYaw = -0.1; P.hYaw = this.state === 'clinch' ? 0.45 : -0.45; P.hPitch = 0.15;
        if (this.state === 'clinch') { gL.set(0.22, top - 0.02, 0.56); gR.set(-0.22, top - 0.06, 0.56); }
        else { gL.set(0.26, top - 0.26, 0.38); gR.set(-0.26, top - 0.26, 0.38); }
        rig.poleTarget.L.set(1, 0, -0.3); rig.poleTarget.R.set(-1, 0, -0.3);
        rig.gloveK = 160;
        break;
      }
      case 'walk': case 'wait':
        rig.stance.L[0] = 0.11; rig.stance.L[1] = 0.03; rig.stance.L[2] = 0;
        rig.stance.R[0] = -0.11; rig.stance.R[1] = -0.03; rig.stance.R[2] = 0;
        rig.stepThresh = this.state === 'walk' ? 0.2 : 0.1;
        P.pYaw = 0; P.sYaw = 0; P.sPitch = 0.05; P.hipY = 0.02;
        gL.set(0.2, top - 0.35, 0.12 + Math.sin(t * 7) * (this.state === 'walk' ? 0.08 : 0));
        gR.set(-0.2, top - 0.35, 0.12 - Math.sin(t * 7) * (this.state === 'walk' ? 0.08 : 0));
        rig.poleTarget.L.set(0.6, -1, -0.6); rig.poleTarget.R.set(-0.6, -1, -0.6);
        rig.gloveK = 120;
        if (this.state === 'wait') { rig.bounce = 0.5; gL.set(0.12, top + 0.0, 0.22); gR.set(-0.12, top + 0.02, 0.2); rig.gloveK = 200; }
        break;
      case 'sit':
        rig.setFootMode('manual', this.group.matrixWorld);
        rig.footLocalTarget.L.set(0.24, 0, 0.38); rig.footLocalTarget.R.set(-0.24, 0, 0.38);
        P.hipY = 0.64 - rig.L.baseHip; P.hipZ = -0.05; P.pYaw = 0; P.sYaw = 0; P.pPitch = -0.12; P.sPitch = 0.2;
        P.breath = 1;
        gL.set(0.23, 0.66, 0.28); gR.set(-0.23, 0.66, 0.28);
        rig.poleTarget.L.set(0.8, -0.4, -0.5); rig.poleTarget.R.set(-0.8, -0.4, -0.5);
        rig.rate = 5; rig.gloveK = 100;
        break;
      case 'celebrate':
        P.pYaw = 0; P.sYaw = 0; P.sPitch = -0.12; P.hPitch = -0.25;
        P.hipY = Math.abs(Math.sin(t * 5)) * 0.1 - 0.02;
        gL.set(0.3, top + 0.55, 0.05); gR.set(-0.3, top + 0.55, 0.05);
        rig.poleTarget.L.set(1, 0.2, 0); rig.poleTarget.R.set(-1, 0.2, 0);
        rig.lookWeight = 0; rig.gloveK = 180; rig.stepThresh = 0.1;
        rig.stance.L[0] = 0.13; rig.stance.L[1] = 0.03; rig.stance.L[2] = 0;
        rig.stance.R[0] = -0.13; rig.stance.R[1] = -0.03; rig.stance.R[2] = 0;
        if (this.raiseHand) { gR.set(-0.12, top + 0.62, 0.05); gL.set(0.22, top - 0.3, 0.12); P.hipY = 0; }
        break;
      case 'dejected':
        P.pYaw = 0; P.sYaw = 0; P.sPitch = 0.3; P.hPitch = 0.55; rig.lookWeight = 0;
        gL.set(0.2, top - 0.45, 0.14); gR.set(-0.2, top - 0.45, 0.14); rig.gloveK = 80;
        rig.stance.L[1] = 0.05; rig.stance.R[1] = -0.05; rig.stance.L[2] = 0; rig.stance.R[2] = 0;
        break;
      case 'falling': case 'down': case 'ko': case 'getup': {
        rig.lookWeight = 0;
        const L = rig.L;
        const lie = this.downPose === 'lie';
        if (this.state === 'getup') {
          // push up through a kneel, then back to guard
          const k = this.st / this.dur;
          rig.rate = 5;
          if (k < 0.45) {
            P.hipY = 0.45 - L.baseHip; P.hipZ = -0.05; P.pPitch = 0.1; P.sPitch = 0.45; P.pYaw = 0; P.sYaw = 0; P.hPitch = 0.3;
            rig.footLocalTarget.L.set(0.15, 0, 0.3); rig.footLocalTarget.R.set(-0.15, 0, -0.25);
            gL.set(0.2, 0.3, 0.3); gR.set(-0.2, 0.35, 0.2);
          } else {
            rig.footLocalTarget.L.set(0.13, 0, 0.19); rig.footLocalTarget.R.set(-0.15, 0, -0.2);
            P.sPitch = 0.2;
          }
          break;
        }
        const early = this.state === 'falling' && this.st < 0.25;
        rig.rate = early ? 10 : 5.5;
        if (early) {
          P.hipY = -0.3; P.pPitch = 0.25; P.sPitch = 0.35; P.hPitch = 0.4;
          gL.set(0.25, top - 0.45, 0.2); gR.set(-0.25, top - 0.45, 0.2);
          rig.footLocalTarget.L.set(0.15, 0, 0.12); rig.footLocalTarget.R.set(-0.15, 0, -0.12);
        } else if (lie) {
          P.hipY = 0.13 - L.baseHip; P.hipZ = -0.55; P.pPitch = -1.5; P.sPitch = 0; P.sYaw = 0; P.pYaw = 0; P.hPitch = -0.1; P.hRoll = 0.5;
          gL.set(0.62, 0.1, -0.85); gR.set(-0.58, 0.1, -0.95);
          rig.footLocalTarget.L.set(0.18, 0, 0.32); rig.footLocalTarget.R.set(-0.14, 0, 0.36);
          rig.poleTarget.L.set(0.3, 1, 0); rig.poleTarget.R.set(-0.3, 1, 0);
        } else {
          P.hipY = 0.13 - L.baseHip; P.hipZ = -0.25; P.pPitch = -0.45; P.sPitch = 0.35; P.pYaw = 0; P.sYaw = 0; P.hPitch = 0.45;
          P.hRoll = Math.sin(t * 1.3) * 0.15;
          gL.set(0.32, 0.1, -0.35); gR.set(-0.32, 0.1, -0.35);
          rig.footLocalTarget.L.set(0.2, 0, 0.5); rig.footLocalTarget.R.set(-0.18, 0, 0.45);
          rig.poleTarget.L.set(0.6, 0.3, -0.6); rig.poleTarget.R.set(-0.6, 0.3, -0.6);
          rig.lookWeight = 0.15;
        }
        rig.gloveK = 70;
        break;
      }
    }
    if (rig.footMode === 'manual' && !this.down && this.state !== 'sit') rig.setFootMode('auto', this.group.matrixWorld);
  }
}
