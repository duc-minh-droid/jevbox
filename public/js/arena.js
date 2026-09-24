// The venue: ring platform, springy ropes, posts, stools, LED apron, lighting rig
// with fake volumetric cones, an instanced low-poly crowd that reacts to hype,
// camera flashes, and a hanging jumbotron with live score.
import * as THREE from 'three';
import { MAT_Y, ROPE_HALF, POST_HALF, ROPE_HEIGHTS, CORNER_COLORS as PROFILES } from './config.js';

const flat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.7, ...o });

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData = { canvas: c, g };
  return t;
}

function matTexture() {
  return canvasTex(1024, 1024, (g, W) => {
    const grd = g.createRadialGradient(W / 2, W / 2, 50, W / 2, W / 2, W * 0.75);
    grd.addColorStop(0, '#26314f');
    grd.addColorStop(1, '#131a2c');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, W);
    // canvas weave noise
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`;
      g.fillRect(Math.random() * W, Math.random() * W, 2, 2);
    }
    // edge band
    g.strokeStyle = '#0b0f1c';
    g.lineWidth = 46;
    g.strokeRect(23, 23, W - 46, W - 46);
    // corner triangles: canvas (W,0) -> world (-x,-z) red ; (0,W) -> (+x,+z) blue
    const tri = (x, y, dx, dy, col) => {
      g.fillStyle = col;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx, y); g.lineTo(x, y + dy); g.closePath(); g.fill();
    };
    tri(W - 46, 46, -190, 190, 'rgba(255,59,78,0.9)');
    tri(46, W - 46, 190, -190, 'rgba(59,139,255,0.9)');
    tri(46, 46, 120, 120, 'rgba(255,255,255,0.12)');
    tri(W - 46, W - 46, -120, -120, 'rgba(255,255,255,0.12)');
    // centre logo
    g.save();
    g.translate(W / 2, W / 2);
    g.strokeStyle = 'rgba(255,195,77,0.5)';
    g.lineWidth = 10;
    g.beginPath(); g.arc(0, 0, 210, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 3;
    g.beginPath(); g.arc(0, 0, 232, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(210,218,238,0.42)';
    g.font = '900 128px Oswald, Impact, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('JEVBOX', 0, -8);
    g.font = '600 30px Inter, sans-serif';
    g.fillStyle = 'rgba(255,195,77,0.95)';
    g.fillText('A I   F I G H T   N I G H T', 0, 86);
    g.restore();
  });
}

function bannerTexture(text, bg, fg) {
  return canvasTex(1024, 128, (g, W, H) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = fg;
    g.font = '800 72px Oswald, Impact, sans-serif';
    g.textBaseline = 'middle';
    const seg = g.measureText(text + '   ').width;
    for (let x = 10; x < W; x += seg) g.fillText(text, x, H / 2 + 4);
  });
}

// additive gradient cone to fake a light shaft
function lightCone(color, height, radius) {
  const geo = new THREE.CylinderGeometry(0.12, radius, height, 24, 1, true);
  geo.translate(0, -height / 2, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.16 } },
    vertexShader: `varying float vH; varying vec3 vN; varying vec3 vV;
      void main(){ vH = -position.y; vec4 wp = modelMatrix*vec4(position,1.0);
        vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vH; varying vec3 vN; varying vec3 vV;
      void main(){ float h = clamp(vH/${height.toFixed(2)},0.0,1.0);
        float rim = pow(abs(dot(vN,vV)), 1.6);
        float a = uOpacity * (1.0-h) * (0.35 + h*0.65) * rim;
        gl_FragColor = vec4(uColor*a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 5;
  return m;
}

class Rope {
  // a sagging, springy rope between two posts, rebuilt as a tube each frame
  constructor(a, b, outward, color, scene) {
    this.a = a.clone(); this.b = b.clone(); this.n = outward.clone();
    this.N = 22;
    this.rest = [];
    this.disp = [];
    this.vel = [];
    this.axis = b.clone().sub(a);
    this.len = this.axis.length();
    this.axis.normalize();
    for (let i = 0; i < this.N; i++) {
      this.rest.push(a.clone().lerp(b, i / (this.N - 1)));
      this.disp.push(new THREE.Vector3());
      this.vel.push(new THREE.Vector3());
    }
    this.R = 6; this.r = 0.032;
    const verts = this.N * this.R;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(verts * 3);
    this.nrm = new Float32Array(verts * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    const idx = [];
    for (let i = 0; i < this.N - 1; i++) for (let j = 0; j < this.R; j++) {
      const a0 = i * this.R + j, a1 = i * this.R + (j + 1) % this.R, b0 = a0 + this.R, b1 = a1 + this.R;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.03 }));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.energy = 0;
    this.rebuild();
  }
  update(dt, bodies) {
    const k = 120, kn = 700, c = 5;
    const n = this.n, N = this.N;
    for (let s = 0; s < 2; s++) {
      const h = dt / 2;
      for (let i = 1; i < N - 1; i++) {
        const d = this.disp[i], v = this.vel[i], dl = this.disp[i - 1], dr = this.disp[i + 1];
        v.x += (-k * d.x + kn * (dl.x + dr.x - 2 * d.x) - c * v.x) * h;
        v.y += (-k * d.y + kn * (dl.y + dr.y - 2 * d.y) - c * v.y - 0) * h;
        v.z += (-k * d.z + kn * (dl.z + dr.z - 2 * d.z) - c * v.z) * h;
      }
      for (let i = 1; i < N - 1; i++) this.disp[i].addScaledVector(this.vel[i], h);
    }
    // bodies push the rope outward
    let pushed = 0;
    for (const b of bodies) {
      const rel = b.pos.clone().sub(this.a);
      const along = rel.dot(this.axis);
      const out = rel.dot(n);
      const y = this.a.y;
      if (y < b.pos.y + 0.1 || y > b.pos.y + 1.7) continue;
      for (let i = 1; i < N - 1; i++) {
        const ai = (i / (N - 1)) * this.len;
        const s = Math.abs(ai - along);
        if (s > b.r) continue;
        const need = out + Math.sqrt(b.r * b.r - s * s);
        const cur = this.disp[i].dot(n);
        if (cur < need) {
          const dv = need - cur;
          this.disp[i].addScaledVector(n, dv);
          const vn = this.vel[i].dot(n);
          if (vn < 0) this.vel[i].addScaledVector(n, -vn);
          pushed = Math.max(pushed, dv);
        }
      }
    }
    this.energy = pushed;
    this.rebuild();
  }
  rebuild() {
    const up = new THREE.Vector3(0, 1, 0), n = this.n, p = new THREE.Vector3(), dir = new THREE.Vector3();
    let o = 0;
    for (let i = 0; i < this.N; i++) {
      p.copy(this.rest[i]).add(this.disp[i]);
      for (let j = 0; j < this.R; j++) {
        const a = (j / this.R) * Math.PI * 2;
        dir.copy(up).multiplyScalar(Math.cos(a)).addScaledVector(n, Math.sin(a));
        this.pos[o] = p.x + dir.x * this.r; this.nrm[o++] = dir.x;
        this.pos[o] = p.y + dir.y * this.r; this.nrm[o++] = dir.y;
        this.pos[o] = p.z + dir.z * this.r; this.nrm[o++] = dir.z;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}

export function buildArena(scene) {
  const arena = { ropes: [], leds: [], cones: [], flashes: [], ledColor: new THREE.Color(0xffc34d), ledPulse: 0 };

  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x05060a, 0.028);

  // ---- lights ----
  scene.add(new THREE.HemisphereLight(0x6677aa, 0x0a0a12, 0.45));
  const key = new THREE.SpotLight(0xfff1dc, 150, 30, 0.6, 0.6, 1.6);
  key.position.set(0, 11, 0.5);
  key.target.position.set(0, MAT_Y, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.camera.near = 4; key.shadow.camera.far = 16;
  scene.add(key, key.target);
  arena.key = key;
  const spotCols = [0xff3b4e, 0xfff4e6, 0x3b8bff, 0xfff4e6];
  const spotPos = [[-6, -6], [6, -6], [6, 6], [-6, 6]];
  spotPos.forEach(([x, z], i) => {
    const s = new THREE.SpotLight(spotCols[i], 40, 26, 0.42, 0.6, 1.6);
    s.position.set(x, 8.5, z);
    s.target.position.set(x * 0.08, MAT_Y, z * 0.08);
    scene.add(s, s.target);
    const cone = lightCone(spotCols[i], 9.5, 2.4);
    cone.position.copy(s.position);
    cone.lookAt(s.target.position);
    cone.rotateX(-Math.PI / 2);
    scene.add(cone);
    arena.cones.push(cone);
  });
  const topCone = lightCone(0xfff1dc, 10.5, 4.2);
  topCone.position.set(0, 11, 0.5);
  topCone.material.uniforms.uOpacity.value = 0.022;
  scene.add(topCone);
  const rim = new THREE.DirectionalLight(0x5a4dff, 0.5);
  rim.position.set(-10, 4, 8);
  scene.add(rim);
  arena.impactLight = new THREE.PointLight(0xffe2a8, 0, 3.5, 2);
  scene.add(arena.impactLight);

  // ---- floor + barrier ----
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: 0x0b0d14, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const barrierTex = bannerTexture('JEVBOX  •  AI FIGHT NIGHT  •  POWERED BY JEV  •', '#0a0d18', '#ffc34d');
  barrierTex.wrapS = THREE.RepeatWrapping;
  barrierTex.repeat.set(2, 1);
  const barrierMat = new THREE.MeshStandardMaterial({ map: barrierTex, emissive: 0xffffff, emissiveMap: barrierTex, emissiveIntensity: 0.2, roughness: 0.5 });
  arena.barrierTex = barrierTex;
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.9, 0.12), barrierMat);
    const a = (i * Math.PI) / 2;
    b.position.set(Math.sin(a) * 6.2, 0.45, Math.cos(a) * 6.2);
    b.rotation.y = a;
    scene.add(b);
  }

  // ---- ring platform ----
  const apronTex = bannerTexture('JEVBOX  ★  ', '#10131f', '#e9ecf5');
  apronTex.wrapS = THREE.RepeatWrapping;
  apronTex.repeat.set(1.5, 1);
  const apron = new THREE.Mesh(new THREE.BoxGeometry(8.4, MAT_Y - 0.06, 8.4),
    new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.7, emissive: 0xffffff, emissiveMap: apronTex, emissiveIntensity: 0.07 }));
  apron.position.y = (MAT_Y - 0.06) / 2;
  apron.receiveShadow = true;
  scene.add(apron);
  const mat = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.12, 8.6), new THREE.MeshStandardMaterial({ map: matTexture(), roughness: 0.92 }));
  mat.position.y = MAT_Y - 0.06;
  mat.receiveShadow = true;
  scene.add(mat);
  // LED strip around the platform lip
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffc34d, toneMapped: false });
  arena.ledMat = ledMat;
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(8.64, 0.04, 0.04), ledMat);
    const a = (i * Math.PI) / 2;
    s.position.set(Math.sin(a) * 4.31, MAT_Y - 0.14, Math.cos(a) * 4.31);
    s.rotation.y = a;
    scene.add(s);
  }

  // ---- posts, pads, stools ----
  const cornerCols = { '-1,-1': PROFILES.red.color, '1,1': PROFILES.blue.color, '1,-1': 0xe8e8e8, '-1,1': 0xe8e8e8 };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * POST_HALF, z = sz * POST_HALF;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 1.7, 8), flat(0xb8bcc8, { metalness: 0.8, roughness: 0.3 }));
    post.position.set(x, MAT_Y + 0.85, z);
    post.castShadow = true;
    scene.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(cornerCols[`${sx},${sz}`]).multiplyScalar(0.6) }));
    cap.position.set(x, MAT_Y + 1.72, z);
    scene.add(cap);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.05, 0.3), flat(cornerCols[`${sx},${sz}`], { roughness: 0.5 }));
    pad.position.set(x - sx * 0.12, MAT_Y + 0.85, z - sz * 0.12);
    pad.rotation.y = Math.PI / 4;
    pad.castShadow = true;
    scene.add(pad);
  }
  arena.stools = {};
  for (const [k, sx] of [['red', -1], ['blue', 1]]) {
    const g = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 8), flat(PROFILES[k].color));
    seat.position.y = 0.5;
    g.add(seat);
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), flat(0x222222));
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.15, 0.25, Math.sin(a) * 0.15);
      g.add(leg);
    }
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.position.set(sx * 3.25, MAT_Y, sx * 3.25);
    g.visible = false;
    scene.add(g);
    arena.stools[k] = g;
  }

  // ---- ropes ----
  const ropeCols = [0x8e94a3, 0xa3162a, 0x8e94a3];
  ROPE_HEIGHTS.forEach((h, i) => {
    const y = MAT_Y + h;
    const c = [
      [new THREE.Vector3(-ROPE_HALF, y, -ROPE_HALF), new THREE.Vector3(ROPE_HALF, y, -ROPE_HALF), new THREE.Vector3(0, 0, -1)],
      [new THREE.Vector3(ROPE_HALF, y, -ROPE_HALF), new THREE.Vector3(ROPE_HALF, y, ROPE_HALF), new THREE.Vector3(1, 0, 0)],
      [new THREE.Vector3(ROPE_HALF, y, ROPE_HALF), new THREE.Vector3(-ROPE_HALF, y, ROPE_HALF), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(-ROPE_HALF, y, ROPE_HALF), new THREE.Vector3(-ROPE_HALF, y, -ROPE_HALF), new THREE.Vector3(-1, 0, 0)],
    ];
    for (const [a, b, n] of c) arena.ropes.push(new Rope(a, b, n, ropeCols[i], scene));
  });

  // ---- truss + jumbotron ----
  const truss = flat(0x2a2e3a, { metalness: 0.7, roughness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(12.5, 0.25, 0.25), truss);
    const a = (i * Math.PI) / 2;
    beam.position.set(Math.sin(a) * 6, 8.6, Math.cos(a) * 6);
    beam.rotation.y = a;
    scene.add(beam);
  }
  const boardTex = canvasTex(1024, 400, () => {});
  arena.boardTex = boardTex;
  const board = new THREE.Group();
  const screenMat = new THREE.MeshBasicMaterial({ map: boardTex, color: 0xb0b0b0 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.35, 3.3), flat(0x12141c, { metalness: 0.5 }));
  board.add(box);
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 1.2), screenMat);
    const a = (i * Math.PI) / 2;
    s.position.set(Math.sin(a) * 1.66, 0, Math.cos(a) * 1.66);
    s.rotation.y = a;
    board.add(s);
  }
  board.position.set(0, 7.2, 0);
  scene.add(board);
  arena.board = board;

  // ---- tiered stands + instanced crowd ----
  const standMat = flat(0x141722, { roughness: 0.9 });
  const ROWS = 9;
  const seats = [];
  for (let r = 0; r < ROWS; r++) {
    const d = 7.0 + r * 0.9, y = 0.25 + r * 0.45;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const len = 2 * d + 0.9;
      const step = new THREE.Mesh(new THREE.BoxGeometry(len, 0.45, 0.9), standMat);
      step.position.set(Math.sin(a) * (d + 0.45), y / 2, Math.cos(a) * (d + 0.45));
      step.scale.y = y / 0.45;
      step.rotation.y = a;
      step.receiveShadow = true;
      scene.add(step);
      // seats along this side, aisle gaps near the corners and the middle
      for (let s = -d + 0.4; s <= d - 0.4; s += 0.62) {
        if (Math.abs(s) < 0.5 || Math.random() < 0.06) continue;
        const along = s + (Math.random() - 0.5) * 0.12;
        const px = Math.sin(a) * (d + 0.45) + Math.cos(a) * along;
        const pz = Math.cos(a) * (d + 0.45) - Math.sin(a) * along;
        seats.push({ x: px, y, z: pz, yaw: Math.atan2(-px, -pz), r });
      }
    }
  }
  const nC = seats.length;
  const bodyGeo = new THREE.CylinderGeometry(0.15, 0.2, 0.62, 5);
  bodyGeo.translate(0, 0.31, 0);
  const headGeo = new THREE.IcosahedronGeometry(0.11, 0);
  const armGeo = new THREE.BoxGeometry(0.06, 0.42, 0.06);
  armGeo.translate(0, 0.21, 0);
  const cMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
  const bodies = new THREE.InstancedMesh(bodyGeo, cMat, nC);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8 }), nC);
  const armsL = new THREE.InstancedMesh(armGeo, cMat, nC);
  const armsR = new THREE.InstancedMesh(armGeo, cMat, nC);
  const shirts = [0x2b2f3d, 0x3d2b2b, 0x1f2a44, 0x444444, 0x5a4a2a, 0x2a4a3a, 0x6a6a72, 0x1b1b1f];
  const skins = [0x8d5a3f, 0xc68a64, 0xe2b594, 0x5a3a28, 0xf0c8a8, 0xa46e4c];
  const col = new THREE.Color();
  seats.forEach((s, i) => {
    // fans near a corner lean that corner's colours
    const redSide = s.x + s.z < -4, blueSide = s.x + s.z > 4;
    const r = Math.random();
    if (redSide && r < 0.35) col.setHex(PROFILES.red.color).multiplyScalar(0.7);
    else if (blueSide && r < 0.35) col.setHex(PROFILES.blue.color).multiplyScalar(0.7);
    else col.setHex(shirts[(Math.random() * shirts.length) | 0]);
    bodies.setColorAt(i, col); armsL.setColorAt(i, col); armsR.setColorAt(i, col);
    heads.setColorAt(i, col.setHex(skins[(Math.random() * skins.length) | 0]));
    s.phase = Math.random() * 10;
    s.excite = Math.random();
    s.fan = redSide ? 'red' : blueSide ? 'blue' : null;
  });
  for (const m of [bodies, heads, armsL, armsR]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
  arena.crowd = { seats, bodies, heads, armsL, armsR };

  // camera flash sprites
  const flashTex = canvasTex(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(220,235,255,0.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  });
  arena.glowTex = flashTex;
  for (let i = 0; i < 28; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
    sp.scale.setScalar(0.9);
    sp.visible = false;
    scene.add(sp);
    arena.flashes.push({ sp, t: 1 });
  }

  // ---------- API ----------
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qa = new THREE.Quaternion(), Z_AXIS = new THREE.Vector3(0, 0, 1), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
  let crowdAcc = 0;
  arena.update = (dt, t, hype, bodiesForRopes, favor = 0) => {
    for (const r of arena.ropes) r.update(Math.min(dt, 0.033), bodiesForRopes);
    // LED pulse
    arena.ledPulse = Math.max(0, arena.ledPulse - dt * 1.8);
    const base = new THREE.Color(0xffc34d).multiplyScalar(0.28 + 0.06 * Math.sin(t * 2));
    arena.ledMat.color.copy(base).lerp(arena.ledColor, Math.min(1, arena.ledPulse)).multiplyScalar(1 + arena.ledPulse * 1.2);
    arena.impactLight.intensity *= Math.exp(-dt * 14);
    arena.barrierTex.offset.x = (t * 0.03) % 1;
    for (const c of arena.cones) c.material.uniforms.uOpacity.value = 0.03 + 0.01 * Math.sin(t * 1.3 + c.userData.phase);
    // flashes
    for (const f of arena.flashes) {
      if (f.t >= 1) continue;
      f.t += dt * 7;
      f.sp.material.opacity = Math.max(0, 1 - f.t);
      if (f.t >= 1) f.sp.visible = false;
    }
    // crowd at ~30Hz
    crowdAcc += dt;
    if (crowdAcc < 1 / 30) return;
    const cdt = crowdAcc; crowdAcc = 0;
    const { seats, bodies, heads, armsL, armsR } = arena.crowd;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      // fans get louder when their fighter is doing well
      let h = hype + (s.fan === 'red' ? -favor : s.fan === 'blue' ? favor : 0) * 0.5;
      const active = h > 0.35 + s.excite * 1.2;
      const jump = active ? Math.max(0, Math.sin(t * (6 + s.excite * 3) + s.phase)) * 0.12 * Math.min(1, h) : Math.sin(t * 1.5 + s.phase) * 0.008;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.yaw);
      pos.set(s.x, s.y + jump, s.z);
      m4.compose(pos, q, scl);
      bodies.setMatrixAt(i, m4);
      pos.y += 0.74;
      m4.compose(pos, q, scl);
      heads.setMatrixAt(i, m4);
      // arms: down by the sides, pumping overhead when excited
      const up = active ? 1 : 0;
      s.arm = (s.arm ?? 0) + (up - (s.arm ?? 0)) * Math.min(1, cdt * 6);
      const wave = active ? Math.sin(t * 9 + s.phase) * 0.3 : 0;
      for (const [mesh, side] of [[armsL, 1], [armsR, -1]]) {
        // rotate about the body's forward axis, swinging outward from down to overhead
        const down = Math.PI + 0.12 * side;
        const upA = side > 0 ? Math.PI * 2 - 0.35 : 0.35;
        const ang = down + (upA - down) * s.arm + wave * s.arm * side;
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.yaw);
        qa.setFromAxisAngle(Z_AXIS, ang);
        const ox = Math.cos(s.yaw) * 0.19 * side, oz = -Math.sin(s.yaw) * 0.19 * side;
        pos.set(s.x + ox, s.y + jump + 0.58, s.z + oz);
        m4.compose(pos, q.multiply(qa), scl);
        mesh.setMatrixAt(i, m4);
      }
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    armsL.instanceMatrix.needsUpdate = true;
    armsR.instanceMatrix.needsUpdate = true;
  };
  arena.cones.forEach((c, i) => { c.userData.phase = i * 1.7; });

  arena.flashLED = (hex, amt = 1) => {
    arena.ledColor.setHex(hex);
    arena.ledPulse = Math.min(1.5, arena.ledPulse + amt);
  };
  arena.impact = (p, power) => {
    arena.impactLight.position.copy(p);
    arena.impactLight.intensity = 4 + power * 26;
  };
  arena.cameraFlashes = (n) => {
    const seats = arena.crowd.seats;
    for (let i = 0; i < n; i++) {
      const f = arena.flashes.find((x) => x.t >= 1);
      if (!f) return;
      const s = seats[(Math.random() * seats.length) | 0];
      f.sp.position.set(s.x, s.y + 0.95, s.z);
      f.sp.visible = true;
      f.t = -Math.random() * 1.5;   // staggered pops
      f.sp.material.opacity = 0;
    }
  };
  arena.setBoard = (d) => {
    const { g, canvas } = arena.boardTex.userData;
    const W = canvas.width, H = canvas.height;
    g.fillStyle = '#05070d'; g.fillRect(0, 0, W, H);
    g.textBaseline = 'middle';
    // header
    g.fillStyle = '#ffc34d';
    g.font = '700 54px Oswald, Impact, sans-serif';
    g.textAlign = 'center';
    g.fillText(d.header, W / 2, 56);
    g.fillStyle = '#ffffff';
    g.font = '800 120px Oswald, Impact, sans-serif';
    g.fillText(d.clock, W / 2, 190);
    // names + hp
    for (const [side, f, x, align] of [[-1, d.red, 40, 'left'], [1, d.blue, W - 40, 'right']]) {
      g.textAlign = align;
      g.fillStyle = f.css;
      g.font = '800 64px Oswald, Impact, sans-serif';
      g.fillText(f.name, x, 150);
      g.fillStyle = '#c9d1e6';
      g.font = '600 40px Inter, sans-serif';
      g.fillText(`${Math.round(f.hp)} HP`, x, 215);
      const bw = 330, bx = side < 0 ? 40 : W - 40 - bw;
      g.fillStyle = '#1b2030'; g.fillRect(bx, 262, bw, 26);
      g.fillStyle = f.css;
      const w = bw * Math.max(0, f.hp) / 100;
      g.fillRect(side < 0 ? bx : bx + bw - w, 262, w, 26);
    }
    g.textAlign = 'center';
    g.fillStyle = '#8b95ad';
    g.font = '600 42px Inter, sans-serif';
    g.fillText(d.footer, W / 2, 340);
    arena.boardTex.needsUpdate = true;
  };

  return arena;
}
