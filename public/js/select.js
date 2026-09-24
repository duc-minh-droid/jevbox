// Street Fighter-style character select: pick RED then BLUE from the roster grid.
import { STYLES } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// combat stats derived from body traits (same formulas the Fighter uses)
export function statsOf(e) {
  const t = e.traits;
  return {
    POWER: 0.62 + 0.38 * t.mass,
    SPEED: 1.12 - 0.12 * t.mass,
    REACH: t.armLen * (0.9 + 0.1 * t.height),
    CHIN: 0.72 + 0.28 * t.mass,
    FOOTWORK: (0.9 + 0.1 * t.legLen) * (1.1 - 0.1 * t.mass),
    CARDIO: 1.1 - 0.15 * (t.mass - 1) - 0.25 * ((t.belly ?? 1) - 1),
  };
}

export class SelectScreen {
  constructor(roster, portraits, { onPick, onReady, blip }) {
    this.roster = roster;
    this.portraits = portraits;
    this.onPick = onPick;
    this.onReady = onReady;
    this.blip = blip || (() => {});
    this.picks = { red: null, blue: null };
    this.turn = 'red';
    this.cursor = 0;
    this.active = true;
    // stat ranges across the roster so bars read relative to the field
    const all = roster.map(statsOf);
    this.range = {};
    for (const k of Object.keys(all[0])) {
      const v = all.map((s) => s[k]);
      this.range[k] = [Math.min(...v), Math.max(...v)];
    }
    this.buildGrid();
    this.bind();
    this.refresh();
  }

  buildGrid() {
    const g = $('sel-grid');
    g.innerHTML = this.roster.map((e, i) =>
      `<div class="tile" data-i="${i}"><img src="${this.portraits[e.id]?.bust || ''}" alt=""><div class="tn">${esc(e.name)}</div></div>`).join('') +
      `<div class="tile random" data-i="random">?<small>RANDOM</small></div>`;
    g.querySelectorAll('.tile').forEach((t) => {
      t.addEventListener('mouseenter', () => { if (t.dataset.i !== 'random') { this.cursor = +t.dataset.i; this.refresh(); } });
      t.addEventListener('click', () => this.pick(t.dataset.i === 'random' ? 'random' : +t.dataset.i));
    });
    $('sel-red').addEventListener('click', () => this.repick('red'));
    $('sel-blue').addEventListener('click', () => this.repick('blue'));
  }

  bind() {
    this.onKey = (e) => {
      if (!this.active || e.target.tagName === 'SELECT') return;
      const n = this.roster.length, cols = 3;
      if (e.key === 'ArrowRight') this.cursor = (this.cursor + 1) % n;
      else if (e.key === 'ArrowLeft') this.cursor = (this.cursor + n - 1) % n;
      else if (e.key === 'ArrowDown') this.cursor = Math.min(n - 1, this.cursor + cols);
      else if (e.key === 'ArrowUp') this.cursor = Math.max(0, this.cursor - cols);
      else if (e.key === 'Enter') { if (this.turn === 'done') this.onReady(); else this.pick(this.cursor); return; }
      else if (e.key.toLowerCase() === 'x') { this.pick('random'); return; }
      else if (e.key === 'Backspace') { this.undo(); return; }
      else return;
      e.preventDefault();
      this.blip(true);
      this.refresh();
    };
    addEventListener('keydown', this.onKey);
  }

  pick(i) {
    if (this.turn === 'done') return;
    if (i === 'random') i = Math.floor(Math.random() * this.roster.length);
    this.picks[this.turn] = this.roster[i];
    this.cursor = i;
    this.blip(false);
    this.onPick(this.turn, this.roster[i]);
    this.turn = this.turn === 'red' && !this.picks.blue ? 'blue' : 'done';
    this.refresh();
  }
  repick(side) {
    if (!this.picks[side]) return;
    this.picks[side] = null;
    this.turn = side;
    this.refresh();
  }
  undo() {
    if (this.picks.blue) this.repick('blue');
    else if (this.picks.red) this.repick('red');
  }

  refresh() {
    const hover = this.roster[this.cursor];
    for (const side of ['red', 'blue']) {
      const e = this.picks[side] || (this.turn === side ? hover : null);
      $(`sel-${side}`).classList.toggle('active', this.turn === side);
      $(`sel-${side}`).classList.toggle('locked', !!this.picks[side]);
      const img = $(`sel-${side}-img`);
      const src = e ? this.portraits[e.id]?.full || '' : '';
      if (img.getAttribute('src') !== src) {
        img.setAttribute('src', src);
        img.classList.remove('swap'); void img.offsetWidth; img.classList.add('swap');
      }
      img.style.visibility = e ? 'visible' : 'hidden';
      $(`sel-${side}-name`).textContent = e ? e.name : '—';
      $(`sel-${side}-nick`).textContent = e ? `"${e.nick}" · ${e.hometown} · ${e.record}` : '';
      $(`sel-${side}-style`).textContent = e ? STYLES[e.style].label : '';
      $(`sel-${side}-super`).textContent = e ? e.special.name : '';
      $(`sel-${side}-bio`).textContent = e ? e.bio : '';
      const st = e ? statsOf(e) : null;
      $(`sel-${side}-stats`).innerHTML = st ? Object.entries(st).map(([k, v]) => {
        const [lo, hi] = this.range[k];
        const pct = 25 + ((v - lo) / (hi - lo || 1)) * 75;
        return `<label>${k}</label><div class="sb"><i style="width:${pct.toFixed(0)}%"></i></div>`;
      }).join('') : '';
    }
    document.querySelectorAll('#sel-grid .tile').forEach((t) => {
      const i = t.dataset.i === 'random' ? -1 : +t.dataset.i;
      const e = this.roster[i];
      t.classList.toggle('cur', i === this.cursor && this.turn !== 'done');
      t.classList.toggle('pick-red', !!e && this.picks.red === e);
      t.classList.toggle('pick-blue', !!e && this.picks.blue === e);
      t.querySelectorAll('.tag1').forEach((x) => x.remove());
      if (e && this.picks.red === e) t.insertAdjacentHTML('beforeend', '<span class="tag1 r">P1</span>');
      if (e && this.picks.blue === e) t.insertAdjacentHTML('beforeend', '<span class="tag1 b">P2</span>');
    });
    const title = $('sel-title');
    title.innerHTML = this.turn === 'red' ? 'CHOOSE <b class="red">RED CORNER</b>'
      : this.turn === 'blue' ? 'CHOOSE <b class="blue">BLUE CORNER</b>' : '<b class="gold">READY TO FIGHT?</b>';
    $('start').disabled = this.turn !== 'done';
  }

  hide() { this.active = false; $('intro').classList.add('hidden'); }
  show() { this.active = true; $('intro').classList.remove('hidden'); this.refresh(); }
}
