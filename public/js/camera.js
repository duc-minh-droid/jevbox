// Broadcast camera director: smooth side-on framing of the exchange, punch-in
// close-ups on big shots, low-angle knockdown shots, a slow KO orbit, wide
// between-round shots, and trauma-based shake. Free orbit when the user drags.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAT_Y } from './config.js';

export class Director {
  constructor(camera, dom) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 22;
    this.controls.enabled = false;
    this.mode = 'auto';
    this.shot = 'intro';
    this.shotT = 0;
    this.shotData = {};
    this.pos = new THREE.Vector3(0, 9, 14);
    this.look = new THREE.Vector3(0, MAT_Y + 1, 0);
    this.side = 1;
    this.trauma = 0;
    this.fovKick = 0;
    this.baseFov = 42;
    this.t = 0;
    this.onModeChange = null;
    dom.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === 2) this.setMode('free'); });
    dom.addEventListener('wheel', () => this.setMode('free'), { passive: true });
  }

  setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    this.controls.enabled = m === 'free';
    if (m === 'free') this.controls.target.copy(this.look);
    if (this.onModeChange) this.onModeChange(m);
  }

  cut(shot, data = {}, hold = 0) {
    this.shot = shot;
    this.shotT = 0;
    this.shotData = data;
    this.hold = hold;
    if (data.snap) this.snap = true;
  }

  // queue a temporary close-up that returns to broadcast
  punchIn(target, dir, power) {
    if (this.shot !== 'broadcast' && this.shot !== 'closeup') return;
    this.cut('closeup', { target: target.clone(), dir: dir.clone(), power }, 0.55 + power * 0.5);
  }

  shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }
  kick(amount) { this.fovKick = Math.min(12, this.fovKick + amount); }

  update(realDt, ctx) {
    this.t += realDt;
    this.shotT += realDt;
    const [a, b] = ctx.fighters;
    const mid = new THREE.Vector3().addVectors(a.pos, b.pos).multiplyScalar(0.5);
    const sep = a.pos.distanceTo(b.pos);
    const line = new THREE.Vector3().subVectors(b.pos, a.pos).setY(0).normalize();
    const perp = new THREE.Vector3(-line.z, 0, line.x);
    let wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3(), rate = 2.2;

    if (this.hold && this.shotT > this.hold && (this.shot === 'closeup')) this.cut('broadcast');

    switch (this.shot) {
      case 'intro': {
        const k = Math.min(1, this.shotT / 7);
        const ang = -2.2 + k * 1.9 + this.t * 0.04;
        const r = 13 - k * 5, h = 8 - k * 4.8;
        wantPos.set(Math.sin(ang) * r, h, Math.cos(ang) * r);
        wantLook.set(0, MAT_Y + 1.1, 0);
        rate = 3;
        break;
      }
      case 'faceoff': {
        // over-the-shoulder style framing of one fighter (data.f)
        const f = this.shotData.f;
        const fwd = new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw));
        wantPos.copy(f.pos).addScaledVector(fwd, 2.3).add(new THREE.Vector3(0, 1.55, 0)).addScaledVector(new THREE.Vector3(fwd.z, 0, -fwd.x), 0.6);
        wantLook.copy(f.pos).add(new THREE.Vector3(0, 1.35, 0));
        rate = 4;
        break;
      }
      case 'broadcast': default: {
        // keep the camera on the side it's already on to avoid axis flips
        const camSide = new THREE.Vector3().subVectors(this.pos, mid).dot(perp);
        if (Math.abs(camSide) > 0.5) this.side = Math.sign(camSide);
        const drift = Math.sin(this.t * 0.11) * 0.45 + Math.sin(this.t * 0.043) * 0.25;
        const dir = perp.clone().multiplyScalar(this.side).applyAxisAngle(THREE.Object3D.DEFAULT_UP, drift);
        const dist = 3.6 + sep * 1.1 + (ctx.hype > 1.4 ? -0.35 : 0);
        wantPos.copy(mid).addScaledVector(dir, dist).setY(MAT_Y + 1.9 + Math.sin(this.t * 0.17) * 0.35);
        // keep inside the arena, above the crowd barrier
        wantLook.copy(mid).setY(MAT_Y + 1.15);
        rate = 2.4;
        break;
      }
      case 'closeup': {
        const d = this.shotData;
        const side = new THREE.Vector3(-d.dir.z, 0, d.dir.x).multiplyScalar(this.side);
        wantPos.copy(d.target).addScaledVector(side, 2.2).addScaledVector(d.dir, -0.8).setY(d.target.y + 0.15);
        wantLook.copy(d.target);
        rate = 7;
        break;
      }
      case 'knockdown': {
        const f = this.shotData.f;
        const ang = this.shotData.ang ?? (this.shotData.ang = Math.atan2(this.pos.x - f.pos.x, this.pos.z - f.pos.z));
        const a2 = ang + this.shotT * 0.12;
        wantPos.set(f.pos.x + Math.sin(a2) * 2.2, MAT_Y + 0.7, f.pos.z + Math.cos(a2) * 2.2);
        wantLook.copy(f.pos).setY(MAT_Y + 0.5);
        rate = 3;
        break;
      }
      case 'ko': {
        const f = this.shotData.f;
        const a2 = this.shotT * 0.25 + (this.shotData.ang0 ?? (this.shotData.ang0 = Math.atan2(this.pos.x - f.pos.x, this.pos.z - f.pos.z)));
        const r = 1.9 + this.shotT * 0.15;
        wantPos.set(f.pos.x + Math.sin(a2) * r, MAT_Y + 1.5 + this.shotT * 0.12, f.pos.z + Math.cos(a2) * r);
        wantLook.copy(f.pos).setY(MAT_Y + 0.4);
        rate = 2;
        break;
      }
      case 'winner': {
        const f = this.shotData.f;
        const toC = new THREE.Vector3(-f.pos.x, 0, -f.pos.z).normalize();
        if (toC.lengthSq() < 0.01) toC.set(0, 0, 1);
        const a2 = Math.sin(this.shotT * 0.2) * 0.5;
        toC.applyAxisAngle(THREE.Object3D.DEFAULT_UP, a2);
        wantPos.copy(f.pos).addScaledVector(toC, 3.4).setY(MAT_Y + 1.4);
        wantLook.copy(f.pos).setY(MAT_Y + 1.35);
        rate = 2;
        break;
      }
      case 'wide': {
        const ang = this.t * 0.07;
        wantPos.set(Math.sin(ang) * 10, 6.5, Math.cos(ang) * 10);
        wantLook.set(0, MAT_Y + 0.6, 0);
        rate = 1.5;
        break;
      }
    }

    // shots inside the ring stay inside the ropes so they never block the view
    if (['knockdown', 'ko', 'closeup', 'winner'].includes(this.shot)) {
      wantPos.x = THREE.MathUtils.clamp(wantPos.x, -3.3, 3.3);
      wantPos.z = THREE.MathUtils.clamp(wantPos.z, -3.3, 3.3);
    }
    const cam = this.camera;
    if (this.mode === 'auto') {
      const k = this.snap ? 1 : 1 - Math.exp(-rate * realDt);
      this.snap = false;
      this.pos.lerp(wantPos, k);
      this.look.lerp(wantLook, Math.min(1, k * 1.4));
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
    } else {
      this.controls.update();
      this.pos.copy(cam.position);
      this.look.copy(this.controls.target);
    }
    // shake (trauma^2), fov kick
    this.trauma = Math.max(0, this.trauma - realDt * 1.6);
    const s = this.trauma * this.trauma;
    if (s > 0.0005) {
      const n = this.t * 38;
      cam.position.x += (Math.sin(n * 1.1) + Math.sin(n * 2.3) * 0.5) * s * 0.12;
      cam.position.y += (Math.sin(n * 1.7 + 2) + Math.sin(n * 3.1) * 0.5) * s * 0.1;
      cam.rotation.z += Math.sin(n * 1.3 + 4) * s * 0.035;
    }
    this.fovKick *= Math.exp(-realDt * 6);
    const fov = this.baseFov - this.fovKick + (this.shot === 'closeup' ? -6 : 0);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, realDt * 10); cam.updateProjectionMatrix(); }
  }
}
