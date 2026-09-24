// The referee: shadows the action from the side away from the camera, counts
// knockdowns with an arm chop per second, breaks clinches, raises the winner's hand.
import * as THREE from 'three';
import { Rig } from './rig.js';
import { REF_LOOK, MAT_Y } from './config.js';

const _v = new THREE.Vector3(), _inv = new THREE.Matrix4();
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export class Referee {
  constructor(scene, onStep) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.rig = new Rig(REF_LOOK, { height: 1.03, armLen: 1, legLen: 1.02, mass: 1.08 }, { gloves: false });
    this.group.add(this.rig.root);
    this.rig.onStep = onStep;
    const L = this.rig.L;
    this.top = L.baseHip + 0.08 + L.abd + L.chest;
    this.state = 'watch';
    this.st = 0;
    this.yaw = 0;
    this.target = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.data = {};
    this.reset();
  }

  get pos() { return this.group.position; }

  reset() {
    this.group.position.set(0, MAT_Y, -2.6);
    this.yaw = 0;
    this.group.rotation.y = 0;
    this.group.updateMatrixWorld(true);
    this.rig.plantFeet(this.group.matrixWorld, 0);
    this.rig.resetGloves();
    this.set('watch');
  }

  set(state, data = {}) { this.state = state; this.st = 0; this.data = data; }

  update(dt, fighters, camPos) {
    if (dt <= 0) return;
    this.st += dt;
    const [a, b] = fighters;
    const rig = this.rig, P = rig.P, top = this.top;
    const mid = _v.addVectors(a.pos, b.pos).multiplyScalar(0.5);
    let speed = 2.0;
    const look = this.lookAt.copy(mid);

    for (const k in P) P[k] = 0;
    P.sPitch = 0.06; P.hipY = 0.01;
    rig.rate = 9;
    rig.bounce = 0;
    rig.stance.L[0] = 0.12; rig.stance.L[1] = 0.03; rig.stance.L[2] = 0.15;
    rig.stance.R[0] = -0.12; rig.stance.R[1] = -0.03; rig.stance.R[2] = -0.15;
    rig.stepThresh = 0.18;
    rig.gloveK = 110;
    rig.gloveTarget.L.set(0.25, top - 0.5, 0.06);
    rig.gloveTarget.R.set(-0.25, top - 0.5, 0.06);
    rig.poleTarget.L.set(0.4, -1, -1); rig.poleTarget.R.set(-0.4, -1, -1);
    rig.lookWeight = 1;
    let wantX = this.target.x, wantZ = this.target.z;

    if (this.state === 'watch' || this.state === 'break') {
      // stand off to the side of the fighters' line, on the far side from the camera
      const line = new THREE.Vector3().subVectors(b.pos, a.pos).setY(0);
      const sep = line.length();
      line.normalize();
      const perp = new THREE.Vector3(-line.z, 0, line.x);
      const toCam = new THREE.Vector3(camPos.x - mid.x, 0, camPos.z - mid.z);
      let s = perp.dot(toCam) > 0 ? -1 : 1;
      const d = this.state === 'break' ? 0.55 : 1.9 + sep * 0.25;
      // if the far side is outside the ropes, take the near side instead
      const out = (sg) => Math.max(Math.abs(mid.x + perp.x * sg * d), Math.abs(mid.z + perp.z * sg * d)) - 3.05;
      if (this.state !== 'break' && out(s) > 0.5 && out(-s) < out(s)) s = -s;
      wantX = mid.x + perp.x * s * d;
      wantZ = mid.z + perp.z * s * d;
      if (this.state === 'break') {
        P.sPitch = 0.2;
        rig.gloveTarget.L.set(0.42, top - 0.05, 0.3);
        rig.gloveTarget.R.set(-0.42, top - 0.05, 0.3);
        rig.poleTarget.L.set(0.5, -1, 0); rig.poleTarget.R.set(-0.5, -1, 0);
        speed = 3;
        if (this.st > 1.1) this.set('watch');
      } else {
        // hands clasped loosely, slight crouch when the action is hot
        rig.gloveTarget.L.set(0.08, top - 0.42, 0.18);
        rig.gloveTarget.R.set(-0.08, top - 0.44, 0.17);
        P.sPitch = 0.12;
      }
    } else if (this.state === 'count') {
      const f = this.data.f;
      const dir = new THREE.Vector3(camPos.x - f.pos.x, 0, camPos.z - f.pos.z).normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      wantX = f.pos.x + side.x * 0.95 - dir.x * 0.1;
      wantZ = f.pos.z + side.z * 0.95 - dir.z * 0.1;
      look.copy(f.pos);
      speed = 3.2;
      P.sPitch = 0.35; P.hipY = -0.06;
      rig.lookTarget = null;
      // chop the count: arm up on the beat, then down toward the fighter
      const c = this.data.countT ?? -1;
      if (c >= 0) {
        const ph = c % 1;
        if (ph < 0.35) rig.gloveTarget.R.set(-0.18, top + 0.5, 0.18);
        else rig.gloveTarget.R.set(-0.14, top - 0.12, 0.5);
        rig.gloveK = 260;
        rig.poleTarget.R.set(-0.8, -0.3, -0.5);
        rig.gloveTarget.L.set(0.2, top - 0.35, 0.2);
      }
    } else if (this.state === 'raise') {
      const w = this.data.f;
      const fwd = new THREE.Vector3(Math.sin(w.yaw), 0, Math.cos(w.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);   // winner's right side (-X local)
      wantX = w.pos.x + right.x * 0.55;
      wantZ = w.pos.z + right.z * 0.55;
      look.copy(w.pos).addScaledVector(fwd, 3);
      speed = 2.2;
      if (this.st > 1.2) {
        w.rig.world('glR', _v);
        _inv.copy(this.group.matrixWorld).invert();
        rig.gloveTarget.L.copy(_v).applyMatrix4(_inv);
        rig.gloveTarget.L.y -= 0.05;
        rig.poleTarget.L.set(0.8, -0.2, -0.6);
        rig.gloveK = 200;
      }
    } else if (this.state === 'neutral') {
      wantX = this.data.x; wantZ = this.data.z;
      look.set(0, 0, 0);
    }

    // walk
    this.target.set(wantX, MAT_Y, wantZ);
    // keep a respectful distance from both fighters
    for (const f of fighters) {
      const dx = this.target.x - f.pos.x, dz = this.target.z - f.pos.z, d = Math.hypot(dx, dz);
      const min = this.state === 'count' && this.data.f === f ? 0.85 : this.state === 'raise' && this.data.f === f ? 0.5 : 0.95;
      if (d < min && d > 1e-4) { this.target.x = f.pos.x + (dx / d) * min; this.target.z = f.pos.z + (dz / d) * min; }
    }
    this.target.x = THREE.MathUtils.clamp(this.target.x, -3.05, 3.05);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -3.05, 3.05);
    const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z, d = Math.hypot(dx, dz);
    if (d > 0.05) {
      const step = Math.min(d, speed * dt * Math.min(1, d * 1.5));
      this.pos.x += (dx / d) * step;
      this.pos.z += (dz / d) * step;
    }
    const faceYaw = Math.atan2(look.x - this.pos.x, look.z - this.pos.z);
    this.yaw += angDiff(this.yaw, faceYaw) * Math.min(1, dt * 5);
    this.group.rotation.y = this.yaw;
    this.group.updateMatrixWorld(true);
    if (this.state !== 'count') {
      _inv.copy(this.group.matrixWorld).invert();
      rig.lookTarget = (rig.lookTarget || new THREE.Vector3()).copy(look).setY(MAT_Y + 1.4).applyMatrix4(_inv);
    }
    rig.update(dt, this.group.matrixWorld, this.yaw);
  }
}
