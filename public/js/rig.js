// Procedural low-poly humanoid rig.
//
// There is no skinning: every body part is a faceted mesh placed between two joint
// positions that are solved each frame. The solve is layered:
//   1. pose parameters (hip offset, pelvis/spine/head angles) ease toward targets
//   2. additive damped-spring impulses (hit reactions, head snaps, recoil)
//   3. procedural feet: planted in world space, step on an arc when they fall behind
//   4. two-bone IK for arms (to glove targets) and legs (to planted feet)
// Gloves follow targets through a spring (overshoot + settle), or are driven
// directly along a strike path by the fighter logic, and are pushed out of the
// opponent's body/head colliders so fists never sink through torsos.
// For knockdowns a verlet ragdoll takes over the joints and blends back out on get-up.
import * as THREE from 'three';

const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _d = V(), _x = V(), _y = V(), _z = V();
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);

const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// cylinder segment from joint A (y=0) to joint B (y=len); rA/rB radii at each end
function seg(rA, rB, len, sides = 6) {
  const g = new THREE.CylinderGeometry(rB, rA, len, sides, 1);
  g.translate(0, len / 2, 0);
  return g;
}
function ico(r, detail = 1) { return new THREE.IcosahedronGeometry(r, detail); }

// position/orient a +Y-aligned mesh from A toward B; `ref` picks the facet roll
function placeSeg(mesh, A, B, ref) {
  _y.subVectors(B, A);
  if (_y.lengthSq() < 1e-10) _y.set(0, 1, 0);
  _y.normalize();
  _z.copy(ref).addScaledVector(_y, -ref.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  mesh.quaternion.setFromRotationMatrix(_m);
  mesh.position.copy(A);
}

// analytic two-bone IK. Writes elbow/knee to outMid and the clamped end to outEnd.
function twoBone(S, T, a, b, pole, outMid, outEnd) {
  _a.subVectors(T, S);
  let d = _a.length();
  if (d < 1e-5) { _a.set(0, -1, 0); d = 1e-5; }
  _a.divideScalar(d);
  d = THREE.MathUtils.clamp(d, Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _b.copy(pole).addScaledVector(_a, -pole.dot(_a));
  if (_b.lengthSq() < 1e-8) _b.set(0, 0, 1).addScaledVector(_a, -_a.z);
  _b.normalize();
  outMid.copy(S).addScaledVector(_a, a * cosA).addScaledVector(_b, a * sinA);
  outEnd.copy(S).addScaledVector(_a, d);
}

class Spring3 {
  constructor(k = 180, c = 14) { this.x = V(); this.v = V(); this.k = k; this.c = c; }
  kick(x, y, z) { this.v.x += x; this.v.y += y; this.v.z += z; }
  update(dt) {
    const n = dt > 0.02 ? 2 : 1, h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v.x += (-this.k * this.x.x - this.c * this.v.x) * h;
      this.v.y += (-this.k * this.x.y - this.c * this.v.y) * h;
      this.v.z += (-this.k * this.x.z - this.c * this.v.z) * h;
      this.x.addScaledVector(this.v, h);
    }
  }
}

export const POSE_KEYS = ['hipX', 'hipY', 'hipZ', 'pYaw', 'pPitch', 'pRoll', 'sYaw', 'sPitch', 'sRoll', 'hPitch', 'hYaw', 'hRoll', 'breath'];

export class Rig {
  constructor(look, traits = { height: 1, armLen: 1, legLen: 1, mass: 1, belly: 1 }, { gloves = true } = {}) {
    this.look = look;
    this.traits = traits;
    this.root = new THREE.Group();
    const thick = Math.sqrt(traits.mass);
    this.thick = thick;
    const L = this.L = {
      thigh: 0.46 * traits.legLen, shin: 0.45 * traits.legLen, ankle: 0.075,
      hipW: 0.095 * thick, abd: 0.2 * traits.height, chest: 0.3 * traits.height, neck: 0.075 * traits.height,
      headR: 0.115, shW: 0.19 * thick, shDrop: 0.045,
      upper: 0.31 * traits.armLen, fore: 0.285 * traits.armLen, gloveR: gloves ? 0.095 : 0.045,
    };
    L.baseHip = (L.thigh + L.shin) * 0.93 + L.ankle;
    L.armReach = L.upper + L.fore + L.gloveR * 0.8;
    this.hasGloves = gloves;

    // --- pose state ---
    this.P = {};
    this.C = {};
    for (const k of POSE_KEYS) { this.P[k] = 0; this.C[k] = 0; }
    this.rate = 14;                 // default ease rate for pose params
    this.rates = {};                // per-key override for this frame
    this.bounce = 0;                // 0..1 boxer bounce
    this.bounceFreq = 2.3;
    this.lookTarget = null;         // local-space point the head tracks
    this.lookWeight = 1;
    this.gloveTarget = { L: V(), R: V() };
    this.glove = { L: { pos: V(), vel: V(), direct: false, prev: V() }, R: { pos: V(), vel: V(), direct: false, prev: V() } };
    this.gloveK = 340;
    this.gloveZeta = 0.72;
    this.poleTarget = { L: new THREE.Vector3(0.5, -1, -0.3), R: new THREE.Vector3(-0.5, -1, -0.3) };
    this.pole = { L: this.poleTarget.L.clone(), R: this.poleTarget.R.clone() };
    this.imp = { head: new Spring3(150, 11), chest: new Spring3(110, 10), hip: new Spring3(160, 16) };

    // stance: local [x, z, yaw] per foot
    this.stance = { L: [0.13, 0.19, -0.2], R: [-0.15, -0.2, -0.85] };
    this.footMode = 'auto';
    this.footLocalTarget = { L: V(), R: V() };
    this.feet = {
      L: { pos: V(), yaw: 0, stepping: false, t: 0, dur: 0.18, from: V(), to: V(), fromYaw: 0, toYaw: 0, h: 0.07, local: V(), localYaw: 0, planted: false },
      R: { pos: V(), yaw: 0, stepping: false, t: 0, dur: 0.18, from: V(), to: V(), fromYaw: 0, toYaw: 0, h: 0.07, local: V(), localYaw: 0, planted: false },
    };
    this.stepThresh = 0.13;
    this.onStep = null;
    this.vel = V();
    this._lastWorld = null;
    this.time = Math.random() * 10;
    this.blinkT = 2;

    // --- solved joints (local) ---
    this.J = {};
    for (const n of ['hip', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'waist', 'chestTop', 'shL', 'shR',
      'elL', 'elR', 'wrL', 'wrR', 'glL', 'glR', 'neckTop', 'head']) this.J[n] = V();
    this.Q = { pelvis: new THREE.Quaternion(), mid: new THREE.Quaternion(), chest: new THREE.Quaternion(), head: new THREE.Quaternion() };

    this.colliders = [];             // local-space capsules {a, b, r} the gloves can't enter
    this.rag = null;                 // verlet ragdoll state
    this.ragW = 0; this.ragTarget = 0;
    this.prevJ = {};
    for (const n in this.J) this.prevJ[n] = V();

    this.buildMeshes();
    this.resetGloves();
  }

  // ---------------- meshes ----------------
  buildMeshes() {
    const k = this.look, L = this.L, t = this.thick;
    const M = (c, opts = {}) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.62, metalness: 0.02, ...opts });
    this.mats = {
      skin: M(k.skin, { roughness: 0.55 }),
      hair: M(k.hair, { roughness: 0.9 }),
      trunks: M(k.trunks ?? k.pants, { roughness: 0.45, metalness: 0.08 }),
      trim: M(k.trim ?? 0xffffff, { roughness: 0.4 }),
      gloves: M(k.gloves ?? k.skin, { roughness: 0.28, metalness: 0.05 }),
      shoes: M(k.shoes, { roughness: 0.5 }),
      sock: M(k.sock ?? 0xffffff),
      shirt: M(k.shirt ?? k.skin),
      pants: M(k.pants ?? k.trunks ?? 0x222222),
      dark: M(0x111114, { roughness: 0.4 }),
      eye: new THREE.MeshBasicMaterial({ color: 0x0c0c10 }),
      mouth: M(k.gloves ?? 0x222222),
    };
    const add = (geo, mat, parent = this.root) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const isRef = !!k.shirt;
    const torsoMat = isRef ? this.mats.shirt : this.mats.skin;
    const legMat = isRef ? this.mats.pants : this.mats.skin;
    this.m = {};

    // pelvis / trunks
    const pelvis = new THREE.Group();
    this.root.add(pelvis);
    const tr = add(new THREE.CylinderGeometry(0.165 * t, 0.15 * t, 0.2, 7), isRef ? this.mats.pants : this.mats.trunks, pelvis);
    tr.scale.z = 0.72; tr.position.y = -0.01;
    if (!isRef) {
      const band = add(new THREE.CylinderGeometry(0.172 * t, 0.17 * t, 0.055, 7), this.mats.trim, pelvis);
      band.scale.z = 0.74; band.position.y = 0.1;
    } else {
      const belt = add(new THREE.CylinderGeometry(0.16 * t, 0.16 * t, 0.04, 7), this.mats.dark, pelvis);
      belt.scale.z = 0.72; belt.position.y = 0.1;
    }
    this.m.pelvis = pelvis;

    const belly = this.traits.belly ?? 1;
    this.m.abd = add(seg(0.13 * t * belly, 0.145 * t * Math.sqrt(belly), L.abd, 7), torsoMat);
    this.m.abd.scale.z = 0.7 * Math.sqrt(belly);
    if (belly > 1.08) {
      const gut = add(ico(0.12 * t * belly, 1), torsoMat, this.m.abd);
      gut.scale.set(1, 0.85, 0.75);
      gut.position.set(0, L.abd * 0.4, 0.04 * belly);
    }
    // chest: tapered, wide at the shoulders
    const chestG = seg(0.15 * t, 0.215 * t, L.chest, 7);
    this.m.chest = add(chestG, torsoMat);
    this.m.chest.scale.z = 0.62;
    if (!isRef) {
      // pecs / abs plates for a sculpted polygon look
      const pec = new THREE.BoxGeometry(0.12 * t, 0.09, 0.05);
      for (const s of [-1, 1]) {
        const p = add(pec, this.mats.skin, this.m.chest);
        p.position.set(s * 0.065 * t, L.chest * 0.68, 0.1 * t);
        p.rotation.y = s * 0.25;
      }
    } else {
      const tie = add(new THREE.BoxGeometry(0.08, 0.035, 0.03), this.mats.dark, this.m.chest);
      tie.position.set(0, L.chest * 0.95, 0.11 * t);
      const stripe = add(new THREE.BoxGeometry(0.015, L.chest * 0.9, 0.01), this.mats.dark, this.m.chest);
      stripe.position.set(0, L.chest * 0.47, 0.105 * t);
    }
    this.m.neck = add(seg(0.055 * Math.sqrt(t), 0.05 * Math.sqrt(t), L.neck + 0.04, 6), this.mats.skin);
    if (k.chain) {
      const gold = M(0xf4c542, { metalness: 0.9, roughness: 0.25 });
      const chain = add(new THREE.TorusGeometry(0.085 * t, 0.009, 4, 14), gold, this.m.chest);
      chain.position.set(0, L.chest * 0.93, 0.03);
      chain.rotation.x = Math.PI / 2 - 0.5;
      const pend = add(new THREE.OctahedronGeometry(0.022), gold, this.m.chest);
      pend.position.set(0, L.chest * 0.78, 0.125 * t);
    }
    if (k.belt) {
      const gold = M(0xf4c542, { metalness: 0.9, roughness: 0.25 });
      const plate = add(new THREE.BoxGeometry(0.13, 0.08, 0.02), gold, pelvis);
      plate.position.set(0, 0.08, 0.125 * t);
      const gem = add(new THREE.OctahedronGeometry(0.018), M(0xd81b34, { roughness: 0.2 }), pelvis);
      gem.position.set(0, 0.08, 0.14 * t);
    }

    // head
    const head = new THREE.Group();
    this.root.add(head);
    const skull = add(ico(L.headR, 1), this.mats.skin, head);
    skull.scale.set(0.9, 1.08, 0.98);
    const jaw = add(new THREE.BoxGeometry(0.13, 0.07, 0.1), this.mats.skin, head);
    jaw.position.set(0, -0.075, 0.03);
    if (k.hairStyle === 'buzz') {
      const cap = add(ico(L.headR * 1.04, 1), this.mats.hair, head);
      cap.scale.set(0.92, 0.62, 1.0); cap.position.set(0, 0.045, -0.012);
    } else if (k.hairStyle === 'mohawk') {
      const hawk = add(new THREE.BoxGeometry(0.035, 0.07, 0.2), this.mats.hair, head);
      hawk.position.set(0, 0.115, -0.01);
      const side = add(ico(L.headR * 1.02, 1), this.mats.hair, head);
      side.scale.set(0.93, 0.45, 0.98); side.position.set(0, 0.06, -0.02);
    } else if (k.hairStyle === 'bald') {
      const ring = add(new THREE.TorusGeometry(L.headR * 0.85, 0.02, 4, 10), this.mats.hair, head);
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.0;
    } else if (k.hairStyle === 'short') {
      const cap = add(ico(L.headR * 1.07, 1), this.mats.hair, head);
      cap.scale.set(0.94, 0.7, 1.0); cap.position.set(0, 0.05, -0.015);
    } else if (k.hairStyle === 'afro') {
      const fro = add(ico(L.headR * 1.55, 1), this.mats.hair, head);
      fro.scale.set(1, 0.85, 0.95); fro.position.set(0, 0.09, -0.03);
    } else if (k.hairStyle === 'topknot') {
      const cap = add(ico(L.headR * 1.04, 1), this.mats.hair, head);
      cap.scale.set(0.92, 0.62, 1.0); cap.position.set(0, 0.045, -0.012);
      const knot = add(ico(0.045, 1), this.mats.hair, head);
      knot.position.set(0, 0.13, -0.05);
      const tie = add(new THREE.CylinderGeometry(0.02, 0.02, 0.025, 6), this.mats.trim, head);
      tie.position.set(0, 0.1, -0.045); tie.rotation.x = 0.5;
    } else if (k.hairStyle === 'dreads') {
      const cap = add(ico(L.headR * 1.06, 1), this.mats.hair, head);
      cap.scale.set(0.95, 0.66, 1.02); cap.position.set(0, 0.05, -0.015);
      const dreadG = new THREE.CylinderGeometry(0.014, 0.01, 0.2, 4);
      dreadG.translate(0, -0.1, 0);
      this.m.dreads = [];
      for (let i = 0; i < 9; i++) {
        const a = -1.25 + (i / 8) * 2.5;
        const d = add(dreadG, this.mats.hair, head);
        d.position.set(Math.sin(a) * 0.1, 0.07, -Math.cos(a) * 0.09);
        d.rotation.set(-0.35 * Math.cos(a), 0, 0.35 * Math.sin(a));
        d.userData.base = d.rotation.clone();
        this.m.dreads.push(d);
      }
    }
    const acc = (c) => M(c, { roughness: 0.4 });
    if (k.bandana) {
      const cap = add(ico(L.headR * 1.08, 1), acc(k.bandana), head);
      cap.scale.set(0.95, 0.66, 1.02); cap.position.set(0, 0.05, -0.012);
      for (const sd of [-1, 1]) {
        const tail = add(new THREE.BoxGeometry(0.03, 0.09, 0.012), acc(k.bandana), head);
        tail.position.set(sd * 0.025, 0.0, -0.13); tail.rotation.set(0.4, 0, sd * 0.3);
      }
    }
    if (k.headband) {
      const band = add(new THREE.CylinderGeometry(L.headR * 0.99, L.headR * 1.0, 0.03, 10, 1, true), acc(k.headband), head);
      band.position.y = 0.05; band.scale.z = 1.05;
      band.material.side = THREE.DoubleSide;
      for (const sd of [-1, 1]) {
        const tail = add(new THREE.BoxGeometry(0.025, 0.12, 0.01), acc(k.headband), head);
        tail.position.set(sd * 0.02, 0.0, -0.125); tail.rotation.set(0.5, 0, sd * 0.25);
        tail.userData.tail = sd;
        (this.m.tails ||= []).push(tail);
      }
    }
    if (k.headgear) {
      const hg = acc(k.headgear);
      const shell = add(ico(L.headR * 1.18, 1), hg, head);
      shell.scale.set(0.98, 0.72, 1.02); shell.position.set(0, 0.055, -0.025);
      for (const sd of [-1, 1]) {
        const cheek = add(new THREE.BoxGeometry(0.04, 0.09, 0.1), hg, head);
        cheek.position.set(sd * 0.1, -0.03, 0.025);
      }
      const brow = add(new THREE.BoxGeometry(0.16, 0.035, 0.04), hg, head);
      brow.position.set(0, 0.075, 0.09);
    }
    if (k.beard === 'full') {
      const b = add(new THREE.BoxGeometry(0.14, 0.075, 0.1), this.mats.hair, head);
      b.position.set(0, -0.09, 0.035);
      for (const sd of [-1, 1]) {
        const burn = add(new THREE.BoxGeometry(0.02, 0.07, 0.05), this.mats.hair, head);
        burn.position.set(sd * 0.1, -0.03, 0.02);
      }
    } else if (k.beard === 'goatee') {
      const b = add(new THREE.BoxGeometry(0.05, 0.045, 0.03), this.mats.hair, head);
      b.position.set(0, -0.105, 0.075);
    }
    if (k.mustache || k.beard === 'full' || k.beard === 'goatee') {
      const m = add(new THREE.BoxGeometry(0.07, 0.016, 0.02), this.mats.hair, head);
      m.position.set(0, -0.035, 0.108);
      m.castShadow = false;
    }
    if (k.facepaint) {
      for (const sd of [-1, 1]) for (let i = 0; i < 2; i++) {
        const st = add(new THREE.BoxGeometry(0.035, 0.007, 0.008), new THREE.MeshBasicMaterial({ color: k.facepaint }), head);
        st.position.set(sd * 0.05, -0.005 - i * 0.016, 0.104);
        st.rotation.z = sd * 0.25;
        st.castShadow = false;
      }
    }
    const nose = add(new THREE.TetrahedronGeometry(0.025), this.mats.skin, head);
    nose.position.set(0, -0.005, 0.112); nose.rotation.set(0.6, 0.78, 0);
    this.m.eyes = [];
    this.m.brows = [];
    for (const s of [-1, 1]) {
      const eye = add(new THREE.BoxGeometry(0.026, 0.02, 0.01), this.mats.eye, head);
      eye.position.set(s * 0.042, 0.018, 0.106);
      eye.castShadow = false;
      this.m.eyes.push(eye);
      const brow = add(new THREE.BoxGeometry(0.04, 0.012, 0.012), this.mats.hair, head);
      brow.position.set(s * 0.043, 0.045, 0.105);
      brow.castShadow = false;
      brow.userData.side = s;
      this.m.brows.push(brow);
    }
    if (!isRef) {
      const guard = add(new THREE.BoxGeometry(0.05, 0.014, 0.015), this.mats.mouth, head);
      guard.position.set(0, -0.055, 0.1);
      guard.castShadow = false;
    }
    this.m.head = head;

    // arms
    for (const s of ['L', 'R']) {
      this.m['sh' + s] = add(ico(0.075 * t, 0), torsoMat);
      this.m['up' + s] = add(seg(0.058 * t, 0.048 * t, L.upper, 6), isRef ? this.mats.shirt : this.mats.skin);
      if (k.tattoo) {
        const ink = M(k.tattoo, { roughness: 0.6 });
        for (const y of [0.35, 0.45]) {
          const band = add(new THREE.CylinderGeometry(0.056 * t, 0.056 * t, 0.018, 6), ink, this.m['up' + s]);
          band.position.y = L.upper * y;
        }
      }
      this.m['el' + s] = add(ico(0.046 * t, 0), isRef ? this.mats.shirt : this.mats.skin);
      this.m['fo' + s] = add(seg(0.047 * t, 0.04 * t, L.fore, 6), this.mats.skin);
      const hand = new THREE.Group();
      this.root.add(hand);
      if (this.hasGloves) {
        const g = add(ico(L.gloveR, 1), this.mats.gloves, hand);
        g.scale.set(0.86, 1.1, 0.96);
        g.position.y = 0.0;
        const thumb = add(ico(0.04, 0), this.mats.gloves, hand);
        thumb.position.set(s === 'L' ? -0.06 : 0.06, -0.03, 0.035);
        const cuff = add(new THREE.CylinderGeometry(0.058, 0.065, 0.07, 7), this.mats.trim, hand);
        cuff.position.y = -L.gloveR * 0.95;
      } else {
        const h = add(new THREE.BoxGeometry(0.06, 0.09, 0.035), this.mats.skin, hand);
        h.position.y = 0.0;
      }
      this.m['gl' + s] = hand;

      // legs
      this.m['th' + s] = add(seg(0.088 * t, 0.062 * t, L.thigh, 6), legMat);
      if (!isRef) {
        const leg = add(seg(0.108 * t, 0.098 * t, L.thigh * 0.45, 7), this.mats.trunks, this.m['th' + s]);
        leg.position.y = -0.01;
      }
      this.m['kn' + s] = add(ico(0.06 * t, 0), legMat);
      this.m['sn' + s] = add(seg(0.06 * t, 0.042 * t, L.shin, 6), legMat);
      if (k.socksHigh) {
        const sock = add(seg(0.052 * t, 0.046 * t, L.shin * 0.55, 6), this.mats.sock, this.m['sn' + s]);
        sock.position.y = L.shin * 0.45;
      }
      const foot = new THREE.Group();
      this.root.add(foot);
      const shoe = add(new THREE.BoxGeometry(0.1, 0.09, 0.25), this.mats.shoes, foot);
      shoe.position.set(0, -0.03, 0.06);
      const pos = shoe.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {       // taper the toe
        if (pos.getZ(i) > 0) { pos.setX(i, pos.getX(i) * 0.8); if (pos.getY(i) > 0) pos.setY(i, pos.getY(i) - 0.035); }
      }
      shoe.geometry.computeVertexNormals();
      const sole = add(new THREE.BoxGeometry(0.105, 0.02, 0.26), this.mats.dark, foot);
      sole.position.set(0, -0.075, 0.06);
      if (!isRef) {
        const sock = add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 6), this.mats.sock, foot);
        sock.position.set(0, 0.04, 0);
      }
      this.m['ft' + s] = foot;
    }
  }

  setTint(hex, amount) {
    for (const k of ['skin', 'shirt']) this.mats[k].emissive.setHex(hex).multiplyScalar(amount);
  }

  // ---------------- helpers ----------------
  guardPos(side, out) {
    // default orthodox guard in local space, before the spring
    const L = this.L;
    const top = L.baseHip + 0.08 + L.abd + L.chest;
    if (side === 'L') out.set(0.1, top + 0.02, 0.3);
    else out.set(-0.11, top + 0.06, 0.2);
    return out;
  }
  resetGloves() {
    for (const s of ['L', 'R']) {
      this.guardPos(s, this.glove[s].pos);
      this.gloveTarget[s].copy(this.glove[s].pos);
      this.glove[s].vel.set(0, 0, 0);
    }
  }
  // world-space neutral head (where a punch should be aimed regardless of slips)
  neutralHeadLocal(out) {
    const L = this.L;
    return out.set(0, L.baseHip + 0.08 + L.abd + L.chest + L.neck + L.headR * 0.9, 0.07);
  }
  neutralBodyLocal(out) {
    const L = this.L;
    return out.set(0, L.baseHip + 0.08 + L.abd * 0.9, 0.12);
  }
  chinLocal(out) {
    const L = this.L;
    return out.set(0, L.baseHip + 0.08 + L.abd + L.chest + L.neck + L.headR * 0.35, 0.1);
  }
  shoulderLocal(side, out) { return out.copy(this.J[side === 'L' ? 'shL' : 'shR']); }

  plantFeet(world, worldYaw) {
    // snap feet under the stance (used on spawn / teleports)
    this._worldYaw = worldYaw;
    this.footMode = 'auto';
    this._lastWorld = null;
    for (const s of ['L', 'R']) {
      const f = this.feet[s], st = this.stance[s];
      f.pos.set(st[0], 0, st[1]).applyMatrix4(world);
      f.pos.y = world.elements[13];
      f.stepping = false;
      f.planted = true;
      f.yaw = this._worldYaw + st[2];
    }
  }

  setFootMode(mode, world) {
    if (mode === this.footMode) return;
    if (mode === 'manual') {
      _inv.copy(world).invert();
      for (const s of ['L', 'R']) {
        const f = this.feet[s];
        f.local.copy(f.pos).applyMatrix4(_inv);
        f.localYaw = f.yaw - this._worldYaw;
        f.stepping = false;
      }
    } else {
      for (const s of ['L', 'R']) {
        const f = this.feet[s];
        f.pos.copy(f.local).applyMatrix4(world);
        f.pos.y = world.elements[13];
        f.yaw = f.localYaw + this._worldYaw;
        f.stepping = false;
      }
    }
    this.footMode = mode;
  }

  // ---------------- per-frame solve ----------------
  // world: the parent group's matrixWorld (group sits on the mat, faces +Z)
  update(dt, world, worldYaw) {
    this._worldYaw = worldYaw;
    this.time += dt;
    const P = this.P, C = this.C, L = this.L, J = this.J, Q = this.Q;

    // pose params ease toward targets
    for (const k of POSE_KEYS) C[k] = damp(C[k], P[k], this.rates[k] ?? this.rate, dt);
    this.imp.head.update(dt);
    this.imp.chest.update(dt);
    this.imp.hip.update(dt);

    // world velocity of the root (for step prediction)
    const wx = world.elements[12], wz = world.elements[14];
    if (this._lastWorld && dt > 0) {
      const vx = (wx - this._lastWorld.x) / dt, vz = (wz - this._lastWorld.z) / dt;
      this.vel.x = damp(this.vel.x, vx, 12, dt);
      this.vel.z = damp(this.vel.z, vz, 12, dt);
    }
    this._lastWorld = this._lastWorld || V();
    this._lastWorld.set(wx, 0, wz);

    // ---- feet ----
    _inv.copy(world).invert();
    if (this.footMode === 'auto') this.updateFeet(dt, world);
    else {
      for (const s of ['L', 'R']) {
        const f = this.feet[s];
        f.local.lerp(this.footLocalTarget[s], 1 - Math.exp(-8 * dt));
        f.localYaw = damp(f.localYaw, this.footLocalTarget[s].w ?? 0, 8, dt);
      }
    }
    const ankL = J.ankleL, ankR = J.ankleR;
    const footLocal = (s, out) => {
      const f = this.feet[s];
      if (this.footMode === 'auto') {
        out.copy(f.pos).applyMatrix4(_inv);
        return f.yaw - worldYaw;
      }
      out.copy(f.local);
      return f.localYaw;
    };
    const yawL = footLocal('L', ankL); ankL.y += L.ankle;
    const yawR = footLocal('R', ankR); ankR.y += L.ankle;

    // ---- pelvis ----
    const bob = this.bounce * Math.abs(Math.sin(this.time * this.bounceFreq * Math.PI)) * 0.03;
    const hip = J.hip.set(C.hipX, L.baseHip + C.hipY + bob, C.hipZ).add(this.imp.hip.x);
    _e.set(C.pPitch, C.pYaw, C.pRoll);
    Q.pelvis.setFromEuler(_e);
    // keep the hips low enough that both feet can reach the floor
    const legMax = (L.thigh + L.shin) * 0.985;
    for (const [side, ank] of [[1, ankL], [-1, ankR]]) {
      _c.set(side * L.hipW, -0.03, 0).applyQuaternion(Q.pelvis).add(hip);
      const dx = _c.x - ank.x, dz = _c.z - ank.z;
      const h2 = dx * dx + dz * dz;
      const maxY = ank.y + Math.sqrt(Math.max(0.0025, legMax * legMax - h2));
      if (_c.y > maxY) hip.y -= (_c.y - maxY);
    }
    J.hipL.set(L.hipW, -0.03, 0).applyQuaternion(Q.pelvis).add(hip);
    J.hipR.set(-L.hipW, -0.03, 0).applyQuaternion(Q.pelvis).add(hip);

    // ---- spine ----
    const ci = this.imp.chest.x;
    _e.set(C.sPitch + ci.x, C.sYaw + ci.y, C.sRoll + ci.z);
    _q.setFromEuler(_e);
    Q.chest.copy(Q.pelvis).multiply(_q);
    Q.mid.copy(Q.pelvis).slerp(Q.chest, 0.5);
    J.waist.set(0, 0.08, 0).applyQuaternion(Q.pelvis).add(hip);
    _c.set(0, L.abd, 0).applyQuaternion(Q.mid);
    const abdTop = _d.copy(J.waist).add(_c);
    J.chestTop.set(0, L.chest, 0).applyQuaternion(Q.chest).add(abdTop);
    J.shL.set(L.shW, -L.shDrop, 0).applyQuaternion(Q.chest).add(J.chestTop);
    J.shR.set(-L.shW, -L.shDrop, 0).applyQuaternion(Q.chest).add(J.chestTop);

    // ---- head: look at target, blended with chest orientation, plus snap spring ----
    J.neckTop.set(0, L.neck, 0).applyQuaternion(Q.chest).add(J.chestTop);
    const hi = this.imp.head.x;
    if (this.lookTarget && this.lookWeight > 0) {
      _c.subVectors(this.lookTarget, J.neckTop);
      let yaw = Math.atan2(_c.x, _c.z);
      const pitch = -Math.atan2(_c.y, Math.hypot(_c.x, _c.z));
      // limit head yaw relative to the chest
      _e.setFromQuaternion(Q.chest, 'YXZ');
      const rel = angDiff(_e.y, yaw);
      yaw = _e.y + THREE.MathUtils.clamp(rel, -1.1, 1.1);
      _e.set(THREE.MathUtils.clamp(pitch, -0.6, 0.6), yaw, 0);
      _q.setFromEuler(_e);
      Q.head.copy(Q.chest).slerp(_q, this.lookWeight);
    } else Q.head.copy(Q.chest);
    _e.set(C.hPitch + hi.x, C.hYaw + hi.y, C.hRoll + hi.z);
    _q2.setFromEuler(_e);
    Q.head.multiply(_q2);
    J.head.set(0, L.headR * 0.95, 0.012).applyQuaternion(Q.head).add(J.neckTop);

    // ---- gloves (spring or direct) + arm IK ----
    for (const s of ['L', 'R']) {
      const g = this.glove[s];
      this.pole[s].lerp(this.poleTarget[s], 1 - Math.exp(-14 * dt));
      if (g.direct) {
        if (dt > 0) g.vel.subVectors(g.pos, g.prev).divideScalar(dt);
      } else if (dt > 0) {
        const k = this.gloveK, c = 2 * this.gloveZeta * Math.sqrt(k);
        const n = dt > 0.017 ? 3 : 2, h = dt / n, tgt = this.gloveTarget[s];
        for (let i = 0; i < n; i++) {
          g.vel.x += (k * (tgt.x - g.pos.x) - c * g.vel.x) * h;
          g.vel.y += (k * (tgt.y - g.pos.y) - c * g.vel.y) * h;
          g.vel.z += (k * (tgt.z - g.pos.z) - c * g.vel.z) * h;
          g.pos.addScaledVector(g.vel, h);
        }
      }
      // gloves can't sink into the opponent's torso / head
      for (const col of this.colliders) {
        _b.subVectors(col.b, col.a);
        const t2 = THREE.MathUtils.clamp(_c.subVectors(g.pos, col.a).dot(_b) / Math.max(1e-6, _b.lengthSq()), 0, 1);
        _d.copy(col.a).addScaledVector(_b, t2);
        _c.subVectors(g.pos, _d);
        const dist = _c.length(), min = col.r + L.gloveR * 0.8;
        if (dist < min) {
          if (dist < 1e-5) _c.set(0, 0, -1); else _c.divideScalar(dist);
          g.pos.addScaledVector(_c, min - dist);
          const vn = g.vel.dot(_c);
          if (vn < 0) g.vel.addScaledVector(_c, -vn * 1.3);
        }
      }
      g.prev.copy(g.pos);
      const S = s === 'L' ? J.shL : J.shR;
      _c.copy(this.pole[s]).applyQuaternion(Q.chest);
      twoBone(S, g.pos, L.upper, L.fore + L.gloveR * 0.8, _c, J['el' + s], J['gl' + s]);
      _d.subVectors(J['gl' + s], J['el' + s]).normalize();
      J['wr' + s].copy(J['el' + s]).addScaledVector(_d, L.fore);
    }

    // ---- legs IK ----
    for (const [s, yaw] of [['L', yawL], ['R', yawR]]) {
      _c.set(Math.sin(yaw) * 1, 0.25, Math.cos(yaw) * 1);
      if (this.footMode === 'manual') _c.set(Math.sin(yaw) * 0.3, 1, Math.cos(yaw) * 0.6);
      twoBone(J['hip' + s], J['ankle' + s], L.thigh, L.shin, _c, J['knee' + s], J['ankle' + s]);
    }

    if (this.rag) this.updateRagdoll(dt);
    for (const n in J) this.prevJ[n].copy(J[n]);
    this.place(yawL, yawR, dt);
  }

  // ---------------- ragdoll ----------------
  // impulse: local-space velocity kick (m/s) applied mostly to the upper body
  startRagdoll(impulse) {
    const J = this.J, pts = {};
    const names = ['hip', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'waist', 'chestTop', 'shL', 'shR', 'elL', 'elR', 'glL', 'glR', 'head'];
    const dt = 1 / 60;
    const upper = { head: 1, chestTop: 0.85, shL: 0.75, shR: 0.75, elL: 0.6, elR: 0.6, glL: 0.5, glR: 0.5, waist: 0.45, hip: 0.25, hipL: 0.2, hipR: 0.2 };
    for (const n of names) {
      const p = J[n].clone();
      const v = new THREE.Vector3().subVectors(J[n], this.prevJ[n]).divideScalar(dt).clampLength(0, 4);
      v.addScaledVector(impulse, upper[n] ?? 0.05);
      pts[n] = { p, o: p.clone().addScaledVector(v, -dt), r: n === 'head' ? 0.11 : n.startsWith('gl') ? 0.08 : n.startsWith('ankle') ? 0.05 : 0.07 };
    }
    const S = [];
    const stick = (a, b, kind = 'eq', k = 1) => S.push({ a: pts[a], b: pts[b], rest: pts[a].p.distanceTo(pts[b].p), kind, k });
    for (const [a, b] of [['hip', 'hipL'], ['hip', 'hipR'], ['hipL', 'hipR'], ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['hipR', 'kneeR'], ['kneeR', 'ankleR'],
      ['hip', 'waist'], ['waist', 'chestTop'], ['chestTop', 'shL'], ['chestTop', 'shR'], ['shL', 'shR'], ['shL', 'elL'], ['elL', 'glL'],
      ['shR', 'elR'], ['elR', 'glR'], ['chestTop', 'head']]) stick(a, b);
    // braces keep the torso a torso and the neck a neck
    for (const [a, b] of [['hip', 'chestTop'], ['hipL', 'shL'], ['hipR', 'shR'], ['hipL', 'shR'], ['hipR', 'shL'], ['waist', 'shL'], ['waist', 'shR'],
      ['head', 'shL'], ['head', 'shR'], ['hipL', 'waist'], ['hipR', 'waist']]) stick(a, b, 'eq', 0.6);
    // limbs may bend but not fold flat
    const L = this.L;
    S.push({ a: pts.hipL, b: pts.ankleL, rest: (L.thigh + L.shin) * 0.5, kind: 'min', k: 1 });
    S.push({ a: pts.hipR, b: pts.ankleR, rest: (L.thigh + L.shin) * 0.5, kind: 'min', k: 1 });
    S.push({ a: pts.shL, b: pts.glL, rest: L.armReach * 0.35, kind: 'min', k: 1 });
    S.push({ a: pts.shR, b: pts.glR, rest: L.armReach * 0.35, kind: 'min', k: 1 });
    S.push({ a: pts.head, b: pts.hip, rest: (L.abd + L.chest) * 0.9, kind: 'min', k: 1 });
    this.rag = { pts, sticks: S, t: 0 };
    this.ragW = 1;
    this.ragTarget = 1;
  }

  updateRagdoll(dt) {
    const R = this.rag;
    R.t += dt;
    this.ragW += (this.ragTarget - this.ragW) * Math.min(1, dt * (this.ragTarget > this.ragW ? 12 : 2.2));
    if (this.ragTarget === 0 && this.ragW < 0.02) { this.rag = null; this.ragW = 0; return; }
    if (dt > 0) {
      const n = 2, h = Math.min(dt, 0.033) / n;
      for (let s = 0; s < n; s++) {
        for (const k in R.pts) {
          const q = R.pts[k];
          const vx = (q.p.x - q.o.x) * 0.992, vy = (q.p.y - q.o.y) * 0.992, vz = (q.p.z - q.o.z) * 0.992;
          q.o.copy(q.p);
          q.p.x += vx; q.p.y += vy - 9.8 * h * h; q.p.z += vz;
        }
        for (let it = 0; it < 10; it++) {
          for (const c of R.sticks) {
            _a.subVectors(c.b.p, c.a.p);
            const d = _a.length() || 1e-6;
            if (c.kind === 'min' && d >= c.rest) continue;
            const diff = ((d - c.rest) / d) * 0.5 * c.k;
            c.a.p.addScaledVector(_a, diff);
            c.b.p.addScaledVector(_a, -diff);
          }
          for (const k in R.pts) {
            const q = R.pts[k];
            if (q.p.y < q.r) {
              q.p.y = q.r;
              // ground friction
              q.o.x += (q.p.x - q.o.x) * 0.35;
              q.o.z += (q.p.z - q.o.z) * 0.35;
              if (q.o.y < q.p.y - 0.001) q.o.y = q.p.y + (q.o.y - q.p.y) * -0.2;
            }
          }
        }
      }
    }
    // blend ragdoll joints over the pose
    const J = this.J, w = this.ragW, P = R.pts;
    for (const k in P) J[k].lerp(P[k].p, w);
    J.neckTop.lerpVectors(J.chestTop, J.head, 0.35);
    for (const s of ['L', 'R']) {
      _d.subVectors(J['gl' + s], J['el' + s]).normalize();
      J['wr' + s].copy(J['el' + s]).addScaledVector(_d, this.L.fore);
    }
    const basis = (xa, xb, ya, yb, out) => {
      _x.subVectors(xa, xb).normalize();
      _y.subVectors(ya, yb);
      _y.addScaledVector(_x, -_y.dot(_x)).normalize();
      _z.crossVectors(_x, _y);
      _m.makeBasis(_x, _y, _z);
      return out.setFromRotationMatrix(_m);
    };
    const Q = this.Q;
    Q.pelvis.slerp(basis(P.hipL.p, P.hipR.p, P.waist.p, P.hip.p, _q), w);
    Q.chest.slerp(basis(P.shL.p, P.shR.p, P.chestTop.p, P.waist.p, _q), w);
    Q.mid.copy(Q.pelvis).slerp(Q.chest, 0.5);
    Q.head.slerp(basis(P.shL.p, P.shR.p, P.head.p, P.chestTop.p, _q), w);
  }

  updateFeet(dt, world) {
    const feet = this.feet;
    const gy = world.elements[13];   // ground height under the rig
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const want = {};
    for (const s of ['L', 'R']) {
      const st = this.stance[s];
      const w = want[s] = { pos: new THREE.Vector3(st[0], 0, st[1]).applyMatrix4(world), yaw: this._worldYaw + st[2] };
      w.pos.y = gy;
      const f = feet[s];
      if (!f.planted) { f.pos.copy(w.pos); f.yaw = w.yaw; f.planted = true; }
      w.err = Math.hypot(w.pos.x - f.pos.x, w.pos.z - f.pos.z) + Math.abs(angDiff(f.yaw, w.yaw)) * 0.12;
    }
    const thresh = this.stepThresh * (speed > 1.2 ? 0.75 : 1);
    const anyStepping = feet.L.stepping || feet.R.stepping;
    if (!anyStepping || speed > 2.4) {
      const order = want.L.err >= want.R.err ? ['L', 'R'] : ['R', 'L'];
      for (const s of order) {
        const f = feet[s], w = want[s];
        if (f.stepping || w.err < thresh) continue;
        const other = feet[s === 'L' ? 'R' : 'L'];
        if (other.stepping && other.t < 0.6) continue;
        f.stepping = true;
        f.t = 0;
        f.dur = THREE.MathUtils.clamp(0.2 - speed * 0.025, 0.11, 0.2);
        f.from.copy(f.pos);
        f.to.copy(w.pos);
        f.to.x += this.vel.x * f.dur * 0.7;
        f.to.z += this.vel.z * f.dur * 0.7;
        f.fromYaw = f.yaw;
        f.toYaw = w.yaw;
        f.h = 0.045 + Math.min(0.06, speed * 0.02) + Math.min(0.05, w.err * 0.1);
        break;
      }
    }
    for (const s of ['L', 'R']) {
      const f = feet[s];
      if (!f.stepping) { f.pos.y = gy; continue; }
      f.t += dt / f.dur;
      const k = Math.min(1, f.t);
      const e = k * k * (3 - 2 * k);
      f.pos.lerpVectors(f.from, f.to, e);
      f.pos.y = gy + Math.sin(Math.PI * k) * f.h;
      f.yaw = f.fromYaw + angDiff(f.fromYaw, f.toYaw) * e;
      if (f.t >= 1) {
        f.stepping = false;
        f.pos.y = gy;
        if (this.onStep) this.onStep(s, speed);
      }
    }
  }

  place(yawL, yawR, dt) {
    const J = this.J, Q = this.Q, m = this.m, L = this.L;
    m.pelvis.position.copy(J.hip);
    m.pelvis.quaternion.copy(Q.pelvis);

    _a.set(0, 0, 1).applyQuaternion(Q.mid);
    placeSeg(m.abd, J.waist, _b.set(0, L.abd, 0).applyQuaternion(Q.mid).add(J.waist), _a);
    const breath = 1 + Math.sin(this.time * (2.2 + this.C.breath * 2.5)) * (0.012 + this.C.breath * 0.03);
    m.chest.position.copy(_b);
    m.chest.quaternion.copy(Q.chest);
    m.chest.scale.set(breath, 1, 0.62 * breath);
    _a.set(0, 0, 1).applyQuaternion(Q.chest);
    placeSeg(m.neck, _b.set(0, -0.02, 0).applyQuaternion(Q.chest).add(J.chestTop), J.head, _a);
    m.head.position.copy(J.head);
    m.head.quaternion.copy(Q.head);

    // blink
    this.blinkT -= dt;
    const blink = this.blinkT < 0 ? 0.15 : 1;
    if (this.blinkT < -0.1) this.blinkT = 1.5 + Math.random() * 4;
    for (const e of m.eyes) e.scale.y = blink;
    for (const b of m.brows) b.rotation.z = b.userData.side * (this.browAngle || 0);
    // hair / headband tails swing with head motion
    const hv = this.imp.head.v;
    if (m.dreads) for (const d of m.dreads) { d.rotation.x = d.userData.base.x - hv.x * 0.04 + Math.sin(this.time * 3 + d.position.x * 20) * 0.04; d.rotation.z = d.userData.base.z - hv.y * 0.04; }
    if (m.tails) for (const tl of m.tails) tl.rotation.x = 0.5 + Math.sin(this.time * 5 + tl.userData.tail) * 0.15 - hv.x * 0.05;

    for (const s of ['L', 'R']) {
      const sh = J['sh' + s], el = J['el' + s], wr = J['wr' + s], gl = J['gl' + s];
      _c.copy(this.pole[s]).applyQuaternion(Q.chest);
      m['sh' + s].position.copy(sh);
      m['sh' + s].quaternion.copy(Q.chest);
      placeSeg(m['up' + s], sh, el, _c);
      m['el' + s].position.copy(el);
      placeSeg(m['fo' + s], el, wr, _c);
      placeSeg(m['gl' + s], gl, _d.copy(gl).add(_a.subVectors(gl, el)), _c);
      m['gl' + s].position.copy(gl);

      const hp = J['hip' + s], kn = J['knee' + s], an = J['ankle' + s];
      const yaw = s === 'L' ? yawL : yawR;
      _c.set(Math.sin(yaw), 0, Math.cos(yaw));
      placeSeg(m['th' + s], hp, kn, _c);
      m['kn' + s].position.copy(kn);
      placeSeg(m['sn' + s], kn, an, _c);
      const ft = m['ft' + s];
      ft.position.copy(an);
      if (this.footMode === 'manual') {
        // lying/sitting: toes point up-ish along the shin
        _d.subVectors(an, kn).normalize();
        _e.set(-Math.PI / 2 + 0.3, yaw, 0);
        ft.quaternion.setFromEuler(_e);
      } else {
        const f = this.feet[s];
        const tilt = f.stepping ? Math.sin(Math.PI * Math.min(1, f.t)) * 0.35 : 0;
        _e.set(-tilt, yaw, 0);
        ft.quaternion.setFromEuler(_e);
      }
    }
  }

  // world positions for gameplay
  world(name, out) { return out.copy(this.J[name]).applyMatrix4(this.root.matrixWorld); }
}
