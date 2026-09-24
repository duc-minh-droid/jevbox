// DOM HUD: health plates with delayed damage ghosts, momentum/scorecard,
// Jev brain panels, commentary lower-third, floating 3D-anchored labels,
// callouts, stats drawer, round-break and result overlays.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BAD = new Set(['hurt', 'gassed', 'rocked', 'guard broken', 'cornered', 'on the ropes', 'overwhelmed', 'predictable']);
const GOOD = new Set(['dominating', 'counter ready']);

export class UI {
  constructor(camera) {
    this.camera = camera;
    this.labels = [];
    this.prev = { red: {}, blue: {} };
    this.ltTimer = 0;
  }

  // ---------- fighters / splash ----------
  setFighters(red, blue) {
    for (const f of [red, blue]) {
      $(`${f.key}-name`).textContent = f.name;
      $(`${f.key}-nick`).textContent = `"${f.nick}"`;
    }
    $('st-red').textContent = red.name;
    $('st-blue').textContent = blue.name;
    this.prev = { red: {}, blue: {} };
  }
  setAiLine(text) { $('ai-line').textContent = text; }

  vsSplash(red, blue, portraits, ms = 2300) {
    for (const f of [red, blue]) {
      $(`vs-${f.key}-img`).src = portraits[f.profile.id]?.full || '';
      $(`vs-${f.key}-name`).textContent = f.name;
      $(`vs-${f.key}-nick`).textContent = f.nick;
    }
    const v = $('vs');
    v.classList.remove('hidden', 'out');
    return new Promise((res) => {
      setTimeout(() => v.classList.add('out'), ms);
      setTimeout(() => { v.classList.add('hidden'); res(); }, ms + 450);
    });
  }

  superCutin(f, img, special) {
    const c = $('cutin');
    $('ci-img').src = img || '';
    $('ci-who').textContent = `${f.name} · SUPER`;
    $('ci-move').textContent = special.name;
    c.style.setProperty('--cc', '#' + special.color.toString(16).padStart(6, '0'));
    c.classList.remove('hidden');
    c.style.animation = 'none'; void c.offsetWidth; c.style.animation = '';
    c.querySelector('.ci-band').style.animation = 'none'; void c.offsetWidth; c.querySelector('.ci-band').style.animation = '';
    clearTimeout(this._ci);
    this._ci = setTimeout(() => c.classList.add('hidden'), 1000);
  }

  cmpRow(label, lv, rv, ln, rn, relative = false) {
    const max = Math.max(ln, rn, 1e-6);
    const min = relative ? Math.min(ln, rn) * 0.8 : 0;
    const pl = ((ln - min) / (max - min || 1)) * 100, pr = ((rn - min) / (max - min || 1)) * 100;
    return `<div class="cmp"><span class="lv ${ln > rn ? 'win' : ''}">${esc(lv)}</span><div class="bar l"><i style="width:${pl}%"></i></div>` +
      `<span class="lbl">${esc(label)}</span><div class="bar r"><i style="width:${pr}%"></i></div><span class="rv ${rn > ln ? 'win' : ''}">${esc(rv)}</span></div>`;
  }

  statRows(R, B) {
    const acc = (s) => (s.thrown ? Math.round((100 * s.landed) / s.thrown) : 0);
    return [
      ['LANDED', R.stats.landed, B.stats.landed],
      ['THROWN', R.stats.thrown, B.stats.thrown],
      ['ACCURACY', acc(R.stats), acc(B.stats), '%'],
      ['POWER SHOTS', R.stats.power, B.stats.power],
      ['DAMAGE', Math.round(R.stats.dmg), Math.round(B.stats.dmg)],
      ['BODY SHOTS', R.stats.bodyL, B.stats.bodyL],
      ['COUNTERS', R.stats.counters, B.stats.counters],
      ['SLIPS', R.stats.slipped, B.stats.slipped],
      ['BLOCKS', R.stats.blocks, B.stats.blocks],
      ['BEST COMBO', R.stats.maxCombo, B.stats.maxCombo],
      ['KNOCKDOWNS', B.knockdowns, R.knockdowns],
    ].map(([l, a, b, u = '']) => this.cmpRow(l, a + u, b + u, a, b)).join('');
  }

  cardChips(card) {
    return card.map((r, i) => `<span><b>R${i + 1}</b>${r.r}–${r.b}</span>`).join('');
  }

  // ---------- per-frame HUD ----------
  update(sim, fighters) {
    for (const f of fighters) {
      const k = f.key, p = this.prev[k];
      const hp = Math.max(0, f.hp) / 100;
      if (p.hp !== hp) {
        $(`${k}-hp`).style.transform = `scaleX(${hp})`;
        $(`${k}-ghost`).style.transform = `scaleX(${hp})`;
        $(`${k}-hpn`).textContent = Math.ceil(f.hp);
        $(`${k}-hp`).parentElement.classList.toggle('low', f.hp < 30);
        if (p.hp !== undefined && hp < p.hp - 0.03) {
          const plate = $(`plate-${k}`);
          plate.classList.remove('hit'); void plate.offsetWidth; plate.classList.add('hit');
        }
        p.hp = hp;
      }
      $(`${k}-st`).style.width = `${f.stamina}%`;
      $(`${k}-po`).style.width = `${f.poise}%`;
      $(`${k}-po`).parentElement.classList.toggle('danger', f.poise < 30);
      const tags = sim.phase === 'live' || sim.phase === 'knockdown' ? f.statusTags().join('|') : '';
      if (p.tags !== tags) {
        p.tags = tags;
        $(`${k}-chips`).innerHTML = (tags ? tags.split('|') : []).map((t) => `<span class="${BAD.has(t) ? 'bad' : GOOD.has(t) ? 'good' : ''}">${esc(t)}</span>`).join('');
      }
      const sup = $(`${k}-sup`);
      sup.style.width = `${Math.min(100, f.meter)}%`;
      sup.parentElement.classList.toggle('ready', f.meter >= 100);
      const kd = f.knockdowns;
      if (p.kd !== kd) { p.kd = kd; $(`${k}-kd`).innerHTML = '<i></i>'.repeat(kd); }
      // brain
      $(`${k}-intent`).textContent = f.state === 'strike' && f.strike ? f.strike.name : f.intent;
      const j = f.lastJev;
      const key = j ? JSON.stringify(j.probabilities || j.choice) : '';
      if (p.jev !== key) {
        p.jev = key;
        let html = '';
        if (j && j.probabilities) {
          const entries = Object.entries(j.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5);
          html = entries.map(([n, v]) => `<div class="prob ${n === f.intent ? 'chosen' : ''}"><span class="n">${esc(n)}</span><span class="b"><i style="width:${(v * 100).toFixed(0)}%"></i></span><span class="v">${(v * 100).toFixed(0)}%</span></div>`).join('');
        } else if (!j) {
          html = '<div class="prob"><span class="n">waiting…</span></div>';
        } else if (j && j.choice) {
          html = `<div class="prob chosen"><span class="n">${esc(j.choice)}</span><span class="b"><i style="width:100%"></i></span><span class="v">local</span></div>`;
        }
        $(`${k}-probs`).innerHTML = html;
      }
      $(`brain-${k}`).classList.toggle('thinking', sim.thinking);
    }
    // centre
    const [R, B] = fighters;
    const rnd = Math.min(sim.rounds, sim.round);
    $('round-pill').innerHTML = `ROUND ${rnd} <span>/ ${sim.rounds}</span>`;
    const left = Math.max(0, sim.roundLeft);
    const clk = $('clock');
    clk.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    clk.classList.toggle('urgent', sim.phase === 'live' && left < 10);
    clk.classList.toggle('paused', sim.phase === 'knockdown');
    const cr = sim.cardTotal(R), cb = sim.cardTotal(B);
    $('card-red').textContent = cr;
    $('card-blue').textContent = cb;
    const lr = sim.cardLive(R) > sim.cardLive(B), lb = sim.cardLive(B) > sim.cardLive(R);
    $('card-red').classList.toggle('lead', lr);
    $('card-blue').classList.toggle('lead', lb);
    const md = R.momentum - B.momentum;
    $('mom').style.left = `${50 - Math.max(-46, Math.min(46, md))}%`;
    const badge = $('src-badge');
    badge.textContent = sim.source === 'jev' ? 'JEV LIVE' : sim.source === 'local' ? 'LOCAL AI' : sim.source.toUpperCase();
    badge.className = 'badge ' + (sim.source === 'jev' ? 'jev' : sim.source === 'err' ? 'err' : 'fallback');
    $('latency').textContent = sim.lastLatency != null ? `${sim.lastLatency}ms · ${sim.decisions} calls` : '';
    $('thinking').textContent = sim.thinking ? '● thinking' : '';
    if (!$('stats').classList.contains('hidden')) this.fillStats(sim, fighters);
  }

  fillStats(sim, [R, B]) {
    $('stat-rows').innerHTML = this.statRows(R, B);
    $('stat-cards').innerHTML = this.cardChips(sim.card);
  }

  reflex(f, text) {
    const el = $(`${f.key}-reflex`);
    el.textContent = text;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; }, 1400);
  }

  // ---------- commentary ----------
  line(voice, text, priority) {
    const now = $('lt-now'), old = $('lt-old');
    old.innerHTML = now.innerHTML;
    now.innerHTML = `<span class="voice">${esc(voice)}</span><span class="txt">${esc(text)}</span>`;
    now.classList.remove('enter', 'hot'); void now.offsetWidth;
    now.classList.add('enter');
    if (priority >= 2) now.classList.add('hot');
  }

  // ---------- floating labels ----------
  label(worldPos, text, cls = '') {
    const el = document.createElement('div');
    el.className = `fl ${cls}`;
    el.innerHTML = `<span class="in">${esc(text)}</span>`;
    $('labels').appendChild(el);
    const jitter = new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.15, 0);
    this.labels.push({ el, p: worldPos.clone().add(jitter), t: 0 });
    if (this.labels.length > 14) { const o = this.labels.shift(); o.el.remove(); }
  }
  updateLabels(realDt) {
    const w = innerWidth, h = innerHeight, v = new THREE.Vector3();
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const L = this.labels[i];
      L.t += realDt;
      if (L.t > 1.05) { L.el.remove(); this.labels.splice(i, 1); continue; }
      v.copy(L.p).project(this.camera);
      const vis = v.z < 1;
      L.el.style.display = vis ? '' : 'none';
      L.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
    }
  }

  // ---------- callouts ----------
  callout(text, { sub = '', cls = '', hold = false, dur = 1600 } = {}) {
    const c = $('callout');
    c.innerHTML = `<div class="co ${cls} ${hold ? 'hold' : ''}">${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    clearTimeout(this._co);
    if (!hold) this._co = setTimeout(() => { c.innerHTML = ''; }, dur);
  }
  clearCallout() { $('callout').innerHTML = ''; }
  vignette(color, amount) {
    const v = $('flash-vignette');
    v.style.setProperty('--c', color);
    v.style.transition = 'none';
    v.style.opacity = amount;
    void v.offsetWidth;
    v.style.transition = 'opacity .7s';
    v.style.opacity = 0;
  }

  // ---------- overlays ----------
  showBreak(sim, [R, B], roundIdx, card) {
    $('break-kicker').textContent = `END OF ROUND ${roundIdx}`;
    $('break-score').innerHTML = `<span class="r">${card.r}</span><span class="dash">—</span><span class="b">${card.b}</span>`;
    $('break-rows').innerHTML = this.statRows(R, B) + `<div class="cards">${this.cardChips(sim.card)}</div>`;
    $('break').classList.remove('hidden');
  }
  breakCountdown(n, next) { $('break-next').textContent = `Round ${next} starts in ${Math.max(0, Math.ceil(n))}`; }
  hideBreak() { $('break').classList.add('hidden'); }

  showResult(sim, [R, B], { method, winner, sub }) {
    $('res-method').textContent = method;
    $('res-name').textContent = winner ? winner.name : 'DRAW';
    $('res-name').style.color = winner ? winner.css : '#fff';
    $('res-sub').textContent = sub;
    $('res-rows').innerHTML = this.statRows(R, B);
    $('res-cards').innerHTML = this.cardChips(sim.card);
    $('result').classList.remove('hidden');
  }
  hideResult() { $('result').classList.add('hidden'); }
}
