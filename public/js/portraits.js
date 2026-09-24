// Renders each roster fighter's actual rig into portrait images (bust + full body)
// with an offscreen renderer, for the character-select screen and super cut-ins.
import * as THREE from 'three';
import { Rig } from './rig.js';

export function renderPortraits(roster) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0x9aa8d0, 0x1a1420, 1.1));
  const key = new THREE.DirectionalLight(0xfff1e0, 2.4);
  key.position.set(1.5, 3, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 2.2);
  rim.position.set(-2.5, 2, -2);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
  const out = {};

  for (const entry of roster) {
    const g = new THREE.Group();
    scene.add(g);
    const rig = new Rig(entry.look, entry.traits);
    g.add(rig.root);
    g.rotation.y = 0.35;
    g.updateMatrixWorld(true);
    rig.plantFeet(g.matrixWorld, 0.35);
    // fighting pose: guard up, slight crouch, looking at camera
    rig.P.pYaw = -0.4; rig.P.sYaw = 0.1; rig.P.sPitch = 0.1; rig.P.hipY = -0.03;
    for (const k in rig.P) rig.C[k] = rig.P[k];
    rig.lookTarget = new THREE.Vector3(-0.6, 1.6, 3);
    const top = rig.L.baseHip + 0.08 + rig.L.abd + rig.L.chest;
    rig.gloveTarget.L.set(0.2, top - 0.1, 0.26);
    rig.gloveTarget.R.set(-0.2, top - 0.06, 0.2);
    rig.resetGloves();
    rig.gloveTarget.L.set(0.2, top - 0.1, 0.26);
    rig.gloveTarget.R.set(-0.2, top - 0.06, 0.2);
    for (let i = 0; i < 40; i++) rig.update(1 / 60, g.matrixWorld, 0.35);
    const headY = rig.J.head.y;

    renderer.setSize(256, 256);
    cam.aspect = 1; cam.fov = 26; cam.updateProjectionMatrix();
    cam.position.set(0.3, headY + 0.04, 1.15);
    cam.lookAt(0.02, headY - 0.13, 0);
    renderer.render(scene, cam);
    const bust = renderer.domElement.toDataURL('image/png');

    renderer.setSize(360, 560);
    cam.aspect = 360 / 560; cam.fov = 30; cam.updateProjectionMatrix();
    cam.position.set(0.45, headY * 0.6, 3.3);
    cam.lookAt(0, headY * 0.5, 0);
    renderer.render(scene, cam);
    const full = renderer.domElement.toDataURL('image/png');

    out[entry.id] = { bust, full };
    scene.remove(g);
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
