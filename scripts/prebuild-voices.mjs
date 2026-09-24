// Pre-generates the announcer / referee lines for every roster fighter and matchup
// into audio-cache/ (via the local server's /api/tts), so a deployed site rarely
// needs to spend ElevenLabs credits. Run with the server up:  node scripts/prebuild-voices.mjs
const BASE = process.env.BASE || 'http://localhost:3000';

// keep in sync with public/js/config.js ROSTER
const ROSTER = [
  ['KANE', 'The Hammer', 'HAMMER TIME'], ['VOSS', 'Ice Water', 'BLIZZARD'], ['RIKU', 'Typhoon', 'TYPHOON RUSH'],
  ['BRUNO', 'The Wall', 'CONCRETE CRUSHER'], ['ZOLA', 'Black Mamba', 'MAMBA STRIKE'], ['IVAN', 'The Bear', 'RED WINTER'],
  ['MARCO', 'El Toro', 'EL TORO'], ['JAYDEN', 'Showtime', 'SHOWSTOPPER'],
];
const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase();
const lines = [
  ['announcer', 'Ladies and gentlemen! Welcome to fight night!'],
  ['announcer', 'Round one!'], ['announcer', 'Round two!'], ['announcer', 'Round three!'], ['announcer', 'Round four!'], ['announcer', 'Final round!'],
  ...['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten!', 'Break!'].map((w) => ['ref', w]),
];
for (const [name, nick, sp] of ROSTER) {
  lines.push(['announcer', `In the red corner... ${name}... ${nick}!`]);
  lines.push(['announcer', `And in the blue corner... ${name}... ${nick}!`]);
  lines.push(['announcer', `${cap(sp)}!`]);
  lines.push(['announcer', `Your winner... by knockout... ${name}!`]);
  lines.push(['announcer', `Your winner... by technical knockout... ${name}!`]);
  for (const [other] of ROSTER) lines.push(['announcer', `${name}... versus... ${other}!`]);
}

let ok = 0, fail = 0;
for (let i = 0; i < lines.length; i += 4) {
  await Promise.all(lines.slice(i, i + 4).map(async ([role, text]) => {
    const r = await fetch(`${BASE}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, text }) });
    if (r.ok) ok++; else { fail++; console.log('fail', r.status, text); }
  }));
}
console.log(`voices: ${ok} ok, ${fail} failed, ${lines.length} total`);
