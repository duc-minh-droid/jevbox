// Fight juice: particle sparks + sweat + dust + confetti, velocity streaks,
// billboard shockwaves, glow flashes, glove motion trails, and a post stack
// (bloom + chromatic aberration / vignette / grain / flash grading).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const rnd = (a, b) => a + Math.random() * (b - a);

class PointPool {
  constructor(scene, n, additive) {
    this.n = n;
    this.items = [];
    const g = this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.shape = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('shape', new THREE.BufferAttribute(this.shape, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: innerHeight * 0.6 } },
      vertexShader: `attribute float size; attribute float alpha; attribute float shape; attribute vec3 color;
        varying vec3 vC; varying float vA; varying float vS;
        uniform float uScale;
        void main(){ vC = color; vA = alpha; vS = shape;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA; varying float vS;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c);
          float a = vS > 0.5 ? step(max(abs(c.x), abs(c.y)), 0.35) : smoothstep(0.5, 0.0, d);
          if (a * vA < 0.01) discard;
          ${additive ? 'gl_FragColor = vec4(vC * a * vA, a * vA);' : 'gl_FragColor = vec4(vC, a * vA);'} }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mat = mat;
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    for (let i = 0; i < n; i++) this.items.push({ life: 0, max: 1 });
    this.cursor = 0;
  }
  spawn(o) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.n;
    it.p = (it.p || new THREE.Vector3()).copy(o.p);
    it.v = (it.v || new THREE.Vector3()).copy(o.v);
    it.c = (it.c || new THREE.Color()).set(o.c);
    it.life = it.max = o.life;
    it.s0 = o.size; it.s1 = o.sizeEnd ?? o.size * 0.3;
    it.drag = o.drag ?? 2; it.grav = o.grav ?? 0; it.shape = o.shape ?? 0;
    it.floor = o.floor ?? -1e9; it.spin = o.spin ?? 0;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      const it = this.items[i];
      if (it.life <= 0) { this.alpha[i] = 0; continue; }
      it.life -= dt;
      it.v.multiplyScalar(Math.exp(-it.drag * dt));
      it.v.y -= it.grav * dt;
      it.p.addScaledVector(it.v, dt);
      if (it.p.y < it.floor) { it.p.y = it.floor; it.v.y *= -0.3; it.v.x *= 0.6; it.v.z *= 0.6; }
      const k = Math.max(0, it.life / it.max);
      this.pos[i * 3] = it.p.x; this.pos[i * 3 + 1] = it.p.y; this.pos[i * 3 + 2] = it.p.z;
      this.col[i * 3] = it.c.r; this.col[i * 3 + 1] = it.c.g; this.col[i * 3 + 2] = it.c.b;
      this.size[i] = it.s1 + (it.s0 - it.s1) * k;
      this.alpha[i] = Math.min(1, k * 1.6);
      this.shape[i] = it.shape;
    }
    for (const a of ['position', 'color', 'size', 'alpha', 'shape']) this.geo.attributes[a].needsUpdate = true;
  }
}

class StreakPool {
  constructor(scene, n) {
    this.n = n;
    this.items = [];
    this.pos = new Float32Array(n * 6);
    this.col = new Float32Array(n * 6);
    const g = this.geo = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    for (let i = 0; i < n; i++) this.items.push({ life: 0 });
    this.cursor = 0;
  }
  spawn(p, v, color, life, len) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.n;
    it.p = (it.p || new THREE.Vector3()).copy(p);
    it.v = (it.v || new THREE.Vector3()).copy(v);
    it.c = (it.c || new THREE.Color()).set(color);
    it.life = it.max = life;
    it.len = len;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      const it = this.items[i], o = i * 6;
      if (it.life <= 0) { for (let j = 0; j < 6; j++) this.col[o + j] = 0; continue; }
      it.life -= dt;
      it.v.multiplyScalar(Math.exp(-5 * dt));
      it.v.y -= 4 * dt;
      it.p.addScaledVector(it.v, dt);
      const k = Math.max(0, it.life / it.max);
      this.pos[o] = it.p.x; this.pos[o + 1] = it.p.y; this.pos[o + 2] = it.p.z;
      this.pos[o + 3] = it.p.x - it.v.x * it.len; this.pos[o + 4] = it.p.y - it.v.y * it.len; this.pos[o + 5] = it.p.z - it.v.z * it.len;
      const b = k * 2.2;
      this.col[o] = it.c.r * b; this.col[o + 1] = it.c.g * b; this.col[o + 2] = it.c.b * b;
      this.col[o + 3] = 0; this.col[o + 4] = 0; this.col[o + 5] = 0;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

class Trail {
  // ribbon behind a glove; brightens with glove speed
  constructor(scene, color) {
    this.M = 16;
    this.pts = [];
    for (let i = 0; i < this.M; i++) this.pts.push(new THREE.Vector3());
    this.pos = new Float32Array(this.M * 2 * 3);
    this.col = new Float32Array(this.M * 2 * 3);
    const g = this.geo = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < this.M - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    scene.add(this.mesh);
    this.color = new THREE.Color(color);
    this.energy = 0;
    this.init = false;
  }
  update(p, speed, camPos, dt) {
    if (!this.init) { for (const q of this.pts) q.copy(p); this.init = true; }
    for (let i = this.M - 1; i > 0; i--) this.pts[i].copy(this.pts[i - 1]);
    this.pts[0].copy(p);
    const target = THREE.MathUtils.clamp((speed - 2.5) / 5, 0, 1);
    this.energy += (target - this.energy) * Math.min(1, dt * (target > this.energy ? 30 : 8));
    const side = new THREE.Vector3(), d = new THREE.Vector3(), view = new THREE.Vector3();
    for (let i = 0; i < this.M; i++) {
      const a = this.pts[i], b = this.pts[Math.min(this.M - 1, i + 1)];
      d.subVectors(i === this.M - 1 ? this.pts[i - 1] : a, i === this.M - 1 ? a : b);
      if (i === this.M - 1) d.negate();
      view.subVectors(camPos, a).normalize();
      side.crossVectors(d, view);
      if (side.lengthSq() < 1e-8) side.set(0, 1, 0);
      side.normalize();
      const k = 1 - i / (this.M - 1);
      const w = 0.075 * k;
      const o = i * 6;
      this.pos[o] = a.x + side.x * w; this.pos[o + 1] = a.y + side.y * w; this.pos[o + 2] = a.z + side.z * w;
      this.pos[o + 3] = a.x - side.x * w; this.pos[o + 4] = a.y - side.y * w; this.pos[o + 5] = a.z - side.z * w;
      const b2 = this.energy * k * k * 0.75;
      for (const off of [0, 3]) { this.col[o + off] = this.color.r * b2; this.col[o + off + 1] = this.color.g * b2; this.col[o + off + 2] = this.color.b * b2; }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, uAberr: { value: 0 }, uVig: { value: 0.68 }, uGrain: { value: 0.035 },
    uTime: { value: 0 }, uFlash: { value: 0 }, uFlashColor: { value: new THREE.Color(1, 1, 1) }, uSat: { value: 0.98 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uAberr, uVig, uGrain, uTime, uFlash, uSat; uniform vec3 uFlashColor;
    varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5; float d = length(c);
      vec2 off = c * (0.002 + uAberr) * (0.4 + d * 1.6);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);
      col = mix(col, uFlashColor * max(l, 0.6) * 1.6, uFlash);
      col *= 1.0 - uVig * smoothstep(0.3, 0.85, d);
      float n = fract(sin(dot(vUv * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class VFX {
  constructor(scene, camera, renderer, glowTex) {
    this.scene = scene; this.camera = camera; this.renderer = renderer;
    this.glow = new PointPool(scene, 700, true);
    this.soft = new PointPool(scene, 900, false);
    this.streaks = new StreakPool(scene, 260);
    this.trails = [];
    this.shocks = [];
    const ringGeo = new THREE.RingGeometry(0.72, 1, 48);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      m.visible = false;
      m.renderOrder = 11;
      scene.add(m);
      this.shocks.push({ m, t: 1, flat: false });
    }
    this.flashes = [];
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
      s.visible = false;
      s.renderOrder = 12;
      scene.add(s);
      this.flashes.push({ s, t: 1 });
    }
    // post stack
    const composer = this.composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.2, 0.4, 0.96);
    composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    composer.addPass(this.final);
    composer.addPass(new OutputPass());
    this.aberr = 0; this.flashAmt = 0;
  }

  addTrail(color) { const t = new Trail(this.scene, color); this.trails.push(t); return t; }

  // --- emitters ---
  impact(pos, dir, power, color, { blocked = false, body = false } = {}) {
    const n = Math.round((blocked ? 10 : 18) + power * 40);
    const hot = blocked ? 0xbfd6ff : 0xffe2a0;
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(-0.6, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(2, 6 + power * 7)).addScaledVector(dir, rnd(1, 4));
      this.streaks.spawn(pos, v, i % 3 === 0 ? color : hot, rnd(0.12, 0.3 + power * 0.25), 0.028);
    }
    for (let i = 0; i < 4 + power * 10; i++) {
      this.glow.spawn({ p: pos, v: new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(1.5 + power * 2),
        c: i % 2 ? hot : color, life: rnd(0.12, 0.3), size: rnd(0.04, 0.09) * (1 + power), drag: 5 });
    }
    this.flash(pos, 0.3 + power * 0.9, blocked ? 0x9ec3ff : 0xfff0c8, 0.35 + power * 0.5);
    this.shock(pos, 0.25 + power * 0.9, blocked ? 0x9ec3ff : color, 0.22 + power * 0.1);
    if (!blocked) this.sweat(pos, dir, Math.round(6 + power * 22), body);
  }
  sweat(pos, dir, n, body) {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(0, 1.2), rnd(-1, 1)).multiplyScalar(rnd(0.6, 2.4)).addScaledVector(dir, rnd(0.8, 2.6));
      this.soft.spawn({ p: pos, v, c: body ? 0xdfe8f5 : 0xcfe3ff, life: rnd(0.4, 0.9), size: rnd(0.02, 0.045), sizeEnd: 0.015, drag: 0.6, grav: 9.8, floor: 0.82 });
    }
  }
  dust(pos, n = 40, radius = 0.6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const p = pos.clone().add(new THREE.Vector3(Math.cos(a) * radius * 0.3, 0.05, Math.sin(a) * radius * 0.3));
      const v = new THREE.Vector3(Math.cos(a), rnd(0.2, 0.9), Math.sin(a)).multiplyScalar(rnd(0.8, 2.6));
      this.soft.spawn({ p, v, c: 0x9aa3b8, life: rnd(0.6, 1.3), size: rnd(0.08, 0.2), sizeEnd: 0.35, drag: 3, grav: -0.2 });
    }
    this.shock(pos.clone().setY(pos.y + 0.02), 1.6, 0xc9d3ea, 0.5, true);
  }
  confetti(center, n = 260) {
    const cols = [0xffc34d, 0xff3b4e, 0x3b8bff, 0xffffff, 0x5ce1a6, 0xff7ad9];
    for (let i = 0; i < n; i++) {
      const p = center.clone().add(new THREE.Vector3(rnd(-3, 3), rnd(4, 6.5), rnd(-3, 3)));
      this.soft.spawn({ p, v: new THREE.Vector3(rnd(-0.6, 0.6), rnd(-0.5, 0.3), rnd(-0.6, 0.6)), c: cols[i % cols.length],
        life: rnd(3, 5.5), size: rnd(0.05, 0.08), sizeEnd: 0.05, drag: 1.6, grav: 1.4, shape: 1, floor: 0.82 });
    }
  }
  shock(pos, scale, color, dur = 0.25, flat = false) {
    const s = this.shocks.find((x) => x.t >= 1) || this.shocks[0];
    s.m.position.copy(pos);
    s.m.material.color.set(color);
    s.scale = scale; s.t = 0; s.dur = dur; s.flat = flat;
    s.m.visible = true;
  }
  flash(pos, size, color, strength = 1) {
    const f = this.flashes.find((x) => x.t >= 1) || this.flashes[0];
    f.s.position.copy(pos);
    f.s.material.color.set(color);
    f.size = size; f.t = 0; f.k = strength;
    f.s.visible = true;
  }
  pulse({ aberr = 0, flash = 0, color = 0xffffff } = {}) {
    this.aberr = Math.max(this.aberr, aberr);
    if (flash > this.flashAmt) { this.flashAmt = flash; this.final.uniforms.uFlashColor.value.set(color); }
  }

  update(dt, realDt, time) {
    this.glow.update(dt);
    this.soft.update(dt);
    this.streaks.update(dt);
    for (const s of this.shocks) {
      if (s.t >= 1) continue;
      s.t += realDt / s.dur;
      const k = Math.min(1, s.t);
      s.m.scale.setScalar(s.scale * (0.2 + (1 - (1 - k) * (1 - k)) * 1.2));
      s.m.material.opacity = (1 - k) * 0.9;
      if (s.flat) s.m.rotation.set(-Math.PI / 2, 0, 0);
      else s.m.quaternion.copy(this.camera.quaternion);
      if (s.t >= 1) s.m.visible = false;
    }
    for (const f of this.flashes) {
      if (f.t >= 1) continue;
      f.t += realDt * 9;
      f.s.scale.setScalar(f.size * (0.6 + f.t * 0.8));
      f.s.material.opacity = Math.max(0, 1 - f.t) * (f.k ?? 1);
      if (f.t >= 1) f.s.visible = false;
    }
    this.aberr *= Math.exp(-realDt * 7);
    this.flashAmt *= Math.exp(-realDt * 10);
    const u = this.final.uniforms;
    u.uAberr.value = this.aberr;
    u.uFlash.value = this.flashAmt;
    u.uTime.value = time % 100;
  }

  render() { this.composer.render(); }
  resize(w, h) {
    this.composer.setSize(w, h);
    this.glow.mat.uniforms.uScale.value = h * 0.6;
    this.soft.mat.uniforms.uScale.value = h * 0.6;
  }
}
