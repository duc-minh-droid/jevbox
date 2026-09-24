// Templated two-voice ringside commentary (no LLM).
const LINES = {
  intro: ['Welcome to fight night! {att} and {def} — two AI minds, one ring.', 'The atmosphere is electric tonight. This one has been a long time coming.'],
  round: ['Round {n}! Here we go.', 'Round {n} is underway.', 'Bell rings for round {n} — let\'s see the adjustments.'],
  jab: ['{att} pops the jab.', 'Sharp jab from {att}.', '{att} sticks the jab in {def}\'s face.', 'Quick hands — the jab lands again.'],
  cross: ['{att} lands a CLEAN right hand!', 'Straight down the pipe from {att}!', '{def}\'s head snaps back off that cross!'],
  hook: ['Left hook lands for {att}!', '{att} wraps a hook around the guard!', 'WHAT a hook from {att}!'],
  uppercut: ['UPPERCUT! {att} splits the guard!', '{att} comes up the middle — right on the chin!', 'Beautiful uppercut from {att}!'],
  body: ['{att} digs to the body.', 'Downstairs from {att} — that saps the legs.', 'Big body shot! {def} felt that one.'],
  combo: ['{att} lets the hands go!', 'Punches in bunches from {att}!', 'Lovely combination from {att}!'],
  haymaker: ['{att} swings for the fences — AND IT LANDS!', 'A monstrous overhand from {att}!', 'THAT ONE HURT! Huge shot from {att}!'],
  blocked: ['{def} catches it on the gloves.', 'Blocked — {def}\'s guard holds.', '{def} shells up and eats it on the arms.'],
  slip: ['{def} slips it! Nothing but air!', 'Slick head movement from {def}!', '{def} makes {att} miss — and that opens a counter.'],
  duck: ['{def} ducks right under it!', 'Under the hook goes {def}!'],
  counter: ['COUNTER! {att} makes {def} pay!', 'Beautiful counter shot from {att}!', 'Textbook counter from {att}!'],
  push: ['{att} shoves {def} off.', 'Physical — {att} pushes {def} back.'],
  clinch: ['They tie up — {att} needed that.', '{att} grabs on and slows everything down.'],
  miss: ['{att} is short with that one.', '{att} can\'t find the range.', 'Whiff from {att}.'],
  taunt: ['{att} is showboating! Dangerous game.', '{att} drops the hands and taunts! The crowd loves it.', '{att} is talking to {def} in there!'],
  rocked: ['{def} IS HURT! The legs are going!', '{def} is on wobbly legs!', 'Big trouble for {def}!'],
  knockdown: ['DOWN GOES {def}! DOWN GOES {def}!', '{att} PUTS {def} ON THE CANVAS!', 'KNOCKDOWN! {def} is down!'],
  getup: ['{def} beats the count! We continue!', '{def} is up! What heart!', 'He\'s up — but how much is left for {def}?'],
  ropes: ['{def} is bounced into the ropes!', 'Back to the ropes goes {def}!'],
  cornered: ['{def} is trapped in the corner!', '{def}\'s back is to the ropes — bad place to be.'],
  gassed: ['{def} is breathing hard. The tank is emptying.', '{def} looks exhausted.'],
  reflex: ['Great reactions from {def}!', '{def} read that one early.'],
  ko: ['IT\'S ALL OVER! {att} WINS BY KNOCKOUT!', 'THAT\'S IT! {att} finishes it!', 'LIGHTS OUT! {att} by K.O.!'],
  tko: ['The referee waves it off! {att} wins by TKO!', 'Three knockdowns — it\'s stopped! {att} by TKO!'],
  decision: ['We go to the scorecards — {att} gets the nod.', 'The final bell! {att} takes the decision.'],
  draw: ['The judges can\'t split them — it\'s a draw!', 'Dead even on the cards. A draw!'],
  roundEnd: ['That\'s the bell for round {n}.', 'End of round {n} — both back to their corners.'],
  roundWin: ['I\'d give that round to {att}.', '{att} edged that round — cleaner work.', 'Clear round for {att}.'],
  quiet: ['A tactical chess match right now.', 'The pace settles. Someone needs to take over.', 'Feinting, probing… the crowd wants more.', 'Watch the footwork — both managing distance beautifully.'],
  lead_upper: ['Lead uppercut from {att} — right through the middle!', '{att} sneaks the lead uppercut in!'],
  check_hook: ['Check hook from {att} — pivots out and lands!', '{att} turns {def} with a check hook. Veteran move.'],
  body_jab: ['{att} goes downstairs with the jab.', 'Jab to the body from {att} — smart work.'],
  feint: ['{att} feints — and {def} bites!', 'Beautiful feint from {att}, {def} fell for it.', 'Head games from {att}!'],
  special: ['HERE IT COMES! {att} UNLEASHES THE SUPER!', 'OH MY — {att} HITS THE SIGNATURE MOVE!', '{att} IS GOING FOR IT ALL!'],
  momentum: ['{att} is taking over this fight!', 'All the momentum is with {att} now.'],
};

export class Commentary {
  constructor(onLine) {
    this.onLine = onLine;
    this.last = {};
    this.flip = false;
    this.lastT = -99;
    this.cool = {};
  }
  say(key, d = {}, { priority = 1, now = 0 } = {}) {
    const pool = LINES[key];
    if (!pool) return;
    // low-priority chatter doesn't spam: small per-key cooldown
    if (priority < 2 && now - (this.cool[key] ?? -99) < 3.5) return;
    if (priority < 1 && now - this.lastT < 2.5) return;
    this.cool[key] = now;
    let i = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && i === this.last[key]) i = (i + 1) % pool.length;
    this.last[key] = i;
    const text = pool[i].replaceAll('{att}', d.att ?? '').replaceAll('{def}', d.def ?? '').replaceAll('{n}', d.n ?? '');
    this.flip = !this.flip;
    this.lastT = now;
    this.onLine(this.flip ? 'JIM' : 'MAX', text, priority);
  }
}
