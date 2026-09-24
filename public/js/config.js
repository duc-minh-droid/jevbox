// Shared constants, roster, fighting styles, specials and move definitions.

export const params = new URLSearchParams(location.search);

export const MAT_Y = 0.8;            // ring canvas height above arena floor
export const ROPE_HALF = 3.6;        // ropes run at ±ROPE_HALF
export const POST_HALF = 3.75;       // corner posts
export const RING_BOUND = 3.15;      // max |x|,|z| for a fighter's centre
export const MIN_SEP = 0.7;          // fighters can't overlap closer than this
export const ROPE_HEIGHTS = [0.45, 0.85, 1.25];
export const CORNER_COLORS = { red: { color: 0xff3b4e, css: '#ff3b4e' }, blue: { color: 0x3b8bff, css: '#3b8bff' } };

export const ACTIONS = [
  'advance', 'retreat', 'circle',
  'jab', 'cross', 'hook', 'uppercut', 'body', 'combo', 'haymaker',
  'lead_upper', 'check_hook', 'body_jab',
  'push', 'clinch', 'block', 'dodge', 'weave', 'feint', 'rest', 'taunt', 'special',
];
export const ACTION_SET = new Set(ACTIONS);
export const STRIKES = new Set(['jab', 'cross', 'hook', 'uppercut', 'body', 'combo', 'haymaker', 'push', 'lead_upper', 'check_hook', 'body_jab', 'special']);

// Strike definitions. Timings are game-seconds (scaled by fighter tempo).
// hand: L = lead (orthodox left), R = rear, B = both.
// kind drives the glove path, elbow pole and torso motion.
export const MOVES = {
  jab:        { hand: 'L', kind: 'straight', target: 'head', wind: 0.07, strike: 0.09, hold: 0.05, rec: 0.15, cost: 5,  dmg: [3, 4],   poise: 8,  pts: 1 },
  cross:      { hand: 'R', kind: 'straight', target: 'head', wind: 0.11, strike: 0.11, hold: 0.06, rec: 0.22, cost: 10, dmg: [6, 9],   poise: 15, pts: 2 },
  hook:       { hand: 'L', kind: 'hook',     target: 'head', wind: 0.13, strike: 0.13, hold: 0.06, rec: 0.24, cost: 11, dmg: [7, 10],  poise: 19, pts: 2 },
  uppercut:   { hand: 'R', kind: 'upper',    target: 'chin', wind: 0.15, strike: 0.12, hold: 0.07, rec: 0.26, cost: 12, dmg: [8, 11],  poise: 23, pts: 2 },
  body:       { hand: 'L', kind: 'body',     target: 'body', wind: 0.12, strike: 0.12, hold: 0.06, rec: 0.24, cost: 9,  dmg: [4, 7],   poise: 9,  pts: 1.5, drain: 10 },
  haymaker:   { hand: 'R', kind: 'overhand', target: 'head', wind: 0.32, strike: 0.16, hold: 0.08, rec: 0.38, cost: 18, dmg: [13, 17], poise: 34, pts: 3 },
  lead_upper: { hand: 'L', kind: 'upper',    target: 'chin', wind: 0.1,  strike: 0.1,  hold: 0.06, rec: 0.2,  cost: 9,  dmg: [6, 9],   poise: 18, pts: 1.5 },
  check_hook: { hand: 'L', kind: 'hook',     target: 'head', wind: 0.1,  strike: 0.12, hold: 0.05, rec: 0.22, cost: 10, dmg: [6, 9],   poise: 15, pts: 2, pivot: true },
  body_jab:   { hand: 'L', kind: 'straight', target: 'body', wind: 0.08, strike: 0.1,  hold: 0.05, rec: 0.16, cost: 5,  dmg: [2, 4],   poise: 4,  pts: 1, drain: 6, dip: true },
  push:       { hand: 'B', kind: 'push',     target: 'chest', wind: 0.10, strike: 0.12, hold: 0.08, rec: 0.2,  cost: 4,  dmg: [0, 0],  poise: 7,  pts: 0.5, shove: 2.8 },
};
export const COMBOS = [
  ['jab', 'cross'],
  ['jab', 'cross', 'hook'],
  ['jab', 'body', 'hook'],
  ['cross', 'hook', 'uppercut'],
  ['jab', 'jab', 'cross'],
  ['body_jab', 'cross', 'hook'],
  ['jab', 'lead_upper', 'cross'],
  ['hook', 'body', 'hook'],
];

// Fighting styles bias Jev's distribution (multipliers) and shape footwork/defence.
// Each fight also rolls a random jitter on top, so the same fighter never boxes identically twice.
export const STYLES = {
  slugger:  { label: 'Slugger', mult: { haymaker: 2.2, hook: 1.5, uppercut: 1.4, jab: 0.7, dodge: 0.6, circle: 0.7, weave: 0.8 }, reflex: 0.8, range: -0.03, bounce: 0.6, aggression: 1.2 },
  outboxer: { label: 'Out-boxer', mult: { jab: 2.1, cross: 1.3, body_jab: 1.4, circle: 1.8, retreat: 1.3, check_hook: 1.6, haymaker: 0.4, clinch: 0.6 }, reflex: 1.2, range: 0.1, bounce: 1.25, aggression: 0.9 },
  counter:  { label: 'Counter-puncher', mult: { dodge: 2, block: 1.3, weave: 1.6, feint: 1.6, cross: 1.3, check_hook: 1.4, combo: 0.8 }, reflex: 1.45, range: 0.05, bounce: 1, aggression: 0.8 },
  swarmer:  { label: 'Swarmer', mult: { combo: 2, body: 1.8, weave: 1.7, advance: 1.4, hook: 1.3, lead_upper: 1.5, retreat: 0.4, circle: 0.6 }, reflex: 1, range: -0.1, bounce: 1.1, aggression: 1.3 },
  brawler:  { label: 'Brawler', mult: { haymaker: 1.6, push: 1.8, clinch: 1.5, body: 1.3, uppercut: 1.3, dodge: 0.4, taunt: 1.5 }, reflex: 0.65, range: -0.06, bounce: 0.45, aggression: 1.15 },
  showman:  { label: 'Showman', mult: { taunt: 3, feint: 2, combo: 1.5, weave: 1.5, lead_upper: 1.3, block: 0.6 }, reflex: 1.1, range: 0.02, bounce: 1.4, aggression: 1.05 },
};

// Roster. traits: height (torso), armLen (reach), legLen (footwork), mass (power + chin, slower), belly (gut)
export const ROSTER = [
  {
    id: 'kane', name: 'KANE', nick: 'The Hammer', hometown: 'Detroit, USA', record: '24-3-0', style: 'slugger',
    bio: 'Factory-floor power. Walks through fire to land one shot.',
    traits: { height: 1.0, armLen: 0.97, legLen: 1.0, mass: 1.22, belly: 1.0 },
    look: { skin: 0xb9785a, hair: 0x17110e, trunks: 0xc4142c, trim: 0xf4d35e, gloves: 0xd81b34, shoes: 0x1a1a1f, sock: 0xeeeeee, hairStyle: 'buzz', beard: 'full', chain: true },
    special: { name: 'HAMMER TIME', seq: ['hook', 'haymaker'], dmgMul: 1.7, tempo: 0.8, pierce: 0.6, color: 0xffb020 },
  },
  {
    id: 'voss', name: 'VOSS', nick: 'Ice Water', hometown: 'Malmö, Sweden', record: '19-1-1', style: 'outboxer',
    bio: 'Long levers, cold eyes. Never where you punch.',
    traits: { height: 1.05, armLen: 1.15, legLen: 1.08, mass: 0.95, belly: 0.9 },
    look: { skin: 0xe2b594, hair: 0xd9c38a, trunks: 0x1d4fd8, trim: 0xffffff, gloves: 0x2563eb, shoes: 0xf2f2f2, sock: 0x1d4fd8, hairStyle: 'mohawk', tattoo: 0x1a2a44 },
    special: { name: 'BLIZZARD', seq: ['jab', 'jab', 'cross', 'hook', 'cross'], dmgMul: 1.3, tempo: 0.62, pierce: 0.3, color: 0x9fe3ff },
  },
  {
    id: 'riku', name: 'RIKU', nick: 'Typhoon', hometown: 'Osaka, Japan', record: '31-2-0', style: 'swarmer',
    bio: 'Small, relentless, all angles. Fights in a phone booth.',
    traits: { height: 0.93, armLen: 0.93, legLen: 0.97, mass: 0.86, belly: 0.9 },
    look: { skin: 0xe8c09a, hair: 0x0e0e12, trunks: 0x111118, trim: 0xe23a3a, gloves: 0xf2f2f2, shoes: 0x111118, sock: 0xffffff, hairStyle: 'topknot', headband: 0xe23a3a },
    special: { name: 'TYPHOON RUSH', seq: ['body', 'hook', 'body', 'lead_upper', 'hook', 'uppercut'], dmgMul: 1.25, tempo: 0.58, pierce: 0.35, color: 0xff5a5a },
  },
  {
    id: 'bruno', name: 'BRUNO', nick: 'The Wall', hometown: 'São Paulo, Brazil', record: '27-6-2', style: 'brawler',
    bio: 'Chin of granite, belly of feijoada. You will get tired first.',
    traits: { height: 1.02, armLen: 1.0, legLen: 0.92, mass: 1.55, belly: 1.45 },
    look: { skin: 0x9a6446, hair: 0x2a1a10, trunks: 0x15803d, trim: 0xfacc15, gloves: 0xfacc15, shoes: 0x14532d, sock: 0xfacc15, hairStyle: 'bald', beard: 'full', belt: true },
    special: { name: 'CONCRETE CRUSHER', seq: ['push', 'haymaker'], dmgMul: 1.9, tempo: 0.85, pierce: 0.7, color: 0x84cc16 },
  },
  {
    id: 'zola', name: 'ZOLA', nick: 'Black Mamba', hometown: 'Lagos, Nigeria', record: '22-0-0', style: 'counter',
    bio: 'Unbeaten. Makes you miss, makes you pay.',
    traits: { height: 1.06, armLen: 1.2, legLen: 1.05, mass: 1.0, belly: 0.9 },
    look: { skin: 0x5a3a28, hair: 0x0a0a0c, trunks: 0x6d28d9, trim: 0xf4d35e, gloves: 0x111114, shoes: 0x6d28d9, sock: 0x111114, hairStyle: 'dreads', facepaint: 0xf4d35e },
    special: { name: 'MAMBA STRIKE', seq: ['lead_upper', 'cross', 'uppercut'], dmgMul: 1.55, tempo: 0.6, pierce: 0.5, color: 0xc084fc },
  },
  {
    id: 'ivan', name: 'IVAN', nick: 'The Bear', hometown: 'Novosibirsk, Russia', record: '16-4-0', style: 'slugger',
    bio: 'Old-school amateur pedigree. Still wears the headgear.',
    traits: { height: 1.08, armLen: 1.05, legLen: 1.0, mass: 1.35, belly: 1.1 },
    look: { skin: 0xf0c8a8, hair: 0x8a6a3a, trunks: 0xf2f2f2, trim: 0xd81b34, gloves: 0xd81b34, shoes: 0xf2f2f2, sock: 0xf2f2f2, hairStyle: 'buzz', mustache: true, headgear: 0xd81b34, socksHigh: true },
    special: { name: 'RED WINTER', seq: ['cross', 'cross', 'haymaker'], dmgMul: 1.6, tempo: 0.75, pierce: 0.55, color: 0xff3b3b },
  },
  {
    id: 'marco', name: 'MARCO', nick: 'El Toro', hometown: 'Guadalajara, Mexico', record: '35-5-1', style: 'swarmer',
    bio: 'Body, body, body — then the head falls.',
    traits: { height: 0.98, armLen: 0.98, legLen: 0.98, mass: 1.15, belly: 1.15 },
    look: { skin: 0xc68a64, hair: 0x120c08, trunks: 0x111114, trim: 0xf4b400, gloves: 0x0f7a3a, shoes: 0x111114, sock: 0xf4b400, hairStyle: 'short', bandana: 0xc81e32, tattoo: 0x2a1a14, beard: 'goatee' },
    special: { name: 'EL TORO', seq: ['body', 'body', 'hook', 'uppercut'], dmgMul: 1.45, tempo: 0.66, pierce: 0.5, color: 0xf4b400 },
  },
  {
    id: 'jayden', name: 'JAYDEN', nick: 'Showtime', hometown: 'Miami, USA', record: '12-1-0', style: 'showman',
    bio: 'Fast hands, big mouth, bigger highlight reel.',
    traits: { height: 1.0, armLen: 1.04, legLen: 1.1, mass: 0.9, belly: 0.85 },
    look: { skin: 0x7a4e34, hair: 0x140c08, trunks: 0xf4f4f4, trim: 0xf472b6, gloves: 0xf472b6, shoes: 0xf4f4f4, sock: 0xf472b6, hairStyle: 'afro', chain: true, belt: true },
    special: { name: 'SHOWSTOPPER', seq: ['jab', 'hook', 'uppercut', 'haymaker'], dmgMul: 1.45, tempo: 0.62, pierce: 0.45, color: 0xf472b6, taunt: true },
  },
];
export const rosterById = (id) => ROSTER.find((r) => r.id === id) || ROSTER[0];

// Build a fight profile for a corner. Mirror matches recolour the blue corner.
export function makeProfile(entry, corner, mirror = false) {
  const look = { ...entry.look };
  if (mirror) {
    look.trunks = 0x1d4fd8; look.gloves = 0x2563eb; look.trim = 0xffffff; look.sock = 0x1d4fd8;
  }
  return {
    ...entry, look, key: corner,
    traits: { ...entry.traits },
    color: CORNER_COLORS[corner].color, css: CORNER_COLORS[corner].css,
    styleDef: STYLES[entry.style],
  };
}

// URL override: ?red=kane&blue=zola  or traits  ?redTraits=arm:1.2,mass:1.4
export const urlPicks = { red: params.get('red'), blue: params.get('blue') };
export function applyTraitOverrides(profile) {
  const p = params.get(`${profile.key}Traits`);
  if (!p) return profile;
  const map = { arm: 'armLen', leg: 'legLen', height: 'height', mass: 'mass', belly: 'belly' };
  for (const pair of p.split(',')) {
    const [n, v] = pair.split(':');
    if (map[n] && isFinite(+v)) profile.traits[map[n]] = Math.max(0.7, Math.min(1.6, +v));
  }
  return profile;
}

export const REF_LOOK = {
  skin: 0x8d5a3f, hair: 0x2a2a2a, shirt: 0xf1f1f1, pants: 0x15161a, shoes: 0x0d0d0f, tie: 0x0d0d0f, hairStyle: 'bald',
};

export const settings = {
  speed: Math.min(8, Math.max(0.25, parseFloat(params.get('speed') || '1'))),
  rounds: Math.max(1, Math.min(12, parseInt(params.get('rounds') || '3', 10))),
  roundSec: Math.max(15, Math.min(180, parseInt(params.get('roundsec') || '45', 10))),
  breakSec: 7,
  forceLocalAI: params.get('ai') === 'local',
  capture: params.has('capture'),        // README capture mode: no film grain (keeps GIFs small)
};
