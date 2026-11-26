// Signal-Liga: gemeinsame Spiellogik für die Spielseiten (Browser) und den Server-Job (game-collect.js).
// Regeln: siehe regelwerk.html. Zeiten gelten in Berliner Zeit.

const GAME = {
  BUDGET: 500,
  MIN_MW: 5,
  PICKS: 10,
  POINT_CAP: 2000,
  FORMATIONS: ['4-4-2', '4-3-3', '3-4-3', '5-3-2', '3-5-2', '4-5-1', '5-4-1'],   // Krypto-Aktien-Rohstoffe
  CATS: ['Krypto', 'Aktien', 'Rohstoffe'],
  // Technik-Schwellen auf der Skala des Screeners (Netto-Score = Long-Score + Short-Score, typ. −4…+4)
  TECH_STRONG: 0.5,     // ✅/⛔️: Ø 21 Tage ≥ +0,5 bzw. ≤ −0,5 …
  TECH_SHARE: 0.7,      // … und an ≥ 70 % der Tage in diese Richtung
  TECH_SOLID: 0.2,      // *️⃣: Ø 14 Tage ≥ +0,2 …
  TECH_MAX_FLIPS: 4,    // … mit höchstens 4 Richtungswechseln
  DATA_URL: 'https://raw.githubusercontent.com/sjfztbv9w5-collab/hl-screening/data/game/'
};

const TECH = {
  '✅': 'stark (3 Wochen)', '*️⃣': 'solide (2 Wochen)', '❔': 'wechselhaft (2 Wochen)', '⛔️': 'Totalausfall (3 Wochen)'
};
const TECH_REVERSE = { '✅': '⛔️', '⛔️': '✅', '*️⃣': '❔', '❔': '*️⃣' };

// ---------- Kategorien ----------
const COMMODITIES = /^(GOLD|SILVER|COPPER|PLATINUM|PALLADIUM|CL|WTI|OIL|BRENT|BRENTOIL|NATGAS|NG|URANIUM|URNM|ALUMINIUM|ALUMINUM|NICKEL|ZINC|WHEAT|CORN|SOY|SOYBEAN|COFFEE|COCOA|SUGAR|COTTON|LUMBER|CATTLE|XAU|XAG)$/;
const FX = /^(EUR|JPY|GBP|CHF|AUD|CAD|NZD|CNH|CNY|MXN|KRW|INR|BRL|DXY|USD[A-Z]*)$/;

function baseName(name) { return name.includes(':') ? name.split(':')[1] : name; }
function categoryOf(asset) {
  if (!asset.dex) return 'Krypto';
  const b = baseName(asset.name);
  if (FX.test(b)) return null;          // Devisen spielen nicht mit
  if (COMMODITIES.test(b)) return 'Rohstoffe';
  return 'Aktien';                      // Aktien, Pre-IPO, Indizes und ETFs
}

// ---------- Berliner Zeit ----------
const _fmt = (typeof Intl !== 'undefined') ? new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
}) : null;
function berlinParts(ms) {
  const p = {};
  _fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, wd: p.weekday };
}
function berlinOffsetMs(ms) {
  const p = berlinParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}
// Berliner Ortszeit -> UTC-Millisekunden
function berlinToUtc(y, m, d, h, min = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - berlinOffsetMs(guess);
  t = guess - berlinOffsetMs(t);
  return t;
}
function berlinDayKey(ms) {
  const p = berlinParts(ms);
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}
// ISO-Woche zu einem Kalenderdatum (y, m, d)
function isoWeek(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return { year: dt.getUTCFullYear(), week: Math.ceil(((dt - yStart) / 86400000 + 1) / 7) };
}

// Spieltag zum Montag (y, m, d): Abgabe Mo 12:00, Abrechnung Sa 20:00 (Berlin)
function spieltagFromMonday(y, m, d) {
  const w = isoWeek(y, m, d);
  const sat = new Date(Date.UTC(y, m - 1, d + 5));
  return {
    id: w.year + '-W' + String(w.week).padStart(2, '0'),
    kw: w.week,
    start: berlinToUtc(y, m, d, 12),
    end: berlinToUtc(sat.getUTCFullYear(), sat.getUTCMonth() + 1, sat.getUTCDate(), 20),
    monday: { y, m, d }
  };
}
function shiftSpieltag(st, weeks) {
  const dt = new Date(Date.UTC(st.monday.y, st.monday.m - 1, st.monday.d + 7 * weeks));
  return spieltagFromMonday(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
// Spielstand zu einem Zeitpunkt:
//   phase 'live'  -> active = laufender Spieltag (gesperrt), last = vorheriger
//   phase 'pause' -> active = nächster Spieltag (Transferfenster), last = gerade abgerechneter
function gameState(now = Date.now()) {
  const p = berlinParts(now);
  const wdIdx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.wd];
  const mon = new Date(Date.UTC(p.y, p.m - 1, p.d - wdIdx));
  const thisWeek = spieltagFromMonday(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate());
  if (now < thisWeek.start) return { phase: 'pause', active: thisWeek, last: shiftSpieltag(thisWeek, -1) };
  if (now < thisWeek.end) return { phase: 'live', active: thisWeek, last: shiftSpieltag(thisWeek, -1) };
  return { phase: 'pause', active: shiftSpieltag(thisWeek, 1), last: thisWeek };
}

// ---------- Kennzahlen ----------
function round05(x) { return Math.round(x * 2) / 2; }
// Marktwerte: Liquidität L = Ø-Tagesvolumen (7 Tage, aus 1h-Kerzen) + Open Interest; MW = 500 $ × L / ΣL der Kategorie
function computeMarketValues(assets) {
  const sums = {};
  assets.forEach(a => { sums[a.cat] = (sums[a.cat] || 0) + a.liq; });
  return assets.map(a => ({ ...a, mw: Math.max(GAME.MIN_MW, round05(GAME.BUDGET * a.liq / sums[a.cat])) }));
}
function avgDailyVolume(candles, until) {
  const from = until - 7 * 86400000;
  let s = 0;
  candles.forEach(c => { if (c.t >= from && c.t < until) s += parseFloat(c.v) * parseFloat(c.c); });
  return s / 7;
}
// Preis zu einem Zeitpunkt: Eröffnung der 1h-Kerze, die genau dann beginnt (sonst letzter Schlusskurs davor)
function priceAt(candles, t) {
  let best = null;
  for (const c of candles) {
    if (c.t === t) return parseFloat(c.o);
    if (c.t + 3600000 <= t) best = parseFloat(c.c);
  }
  return best;
}
function pointsFor(entry, exit, dir) {
  if (!(entry > 0) || !(exit > 0)) return null;
  const p = Math.round((exit / entry - 1) * 10000) * (dir === 'S' ? -1 : 1);
  return Math.max(-GAME.POINT_CAP, Math.min(GAME.POINT_CAP, p));
}

// Technik-Einstufung aus täglichen Ø-Netto-Scores (chronologisch, letzter Wert = Stichtag).
// Unabhängige Einschätzung der Signale – keine Punkteprognose. Short-Listings werden mit dem
// gespiegelten Score bewertet: Long ✅ ⇔ Short ⛔️ und umgekehrt.
function classifyTech(daily) {
  const d21 = daily.slice(-21), d14 = daily.slice(-14);
  if (d21.length < 7) return '❔';
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const m21 = mean(d21);
  if (m21 >= GAME.TECH_STRONG && d21.filter(v => v > 0).length >= GAME.TECH_SHARE * d21.length) return '✅';
  if (m21 <= -GAME.TECH_STRONG && d21.filter(v => v < 0).length >= GAME.TECH_SHARE * d21.length) return '⛔️';
  let flips = 0;
  for (let i = 1; i < d14.length; i++) if (Math.sign(d14[i]) !== Math.sign(d14[i - 1]) && d14[i] !== 0) flips++;
  if (mean(d14) >= GAME.TECH_SOLID && flips <= GAME.TECH_MAX_FLIPS) return '*️⃣';
  return '❔';
}
function techFor(daily, dir) {
  return classifyTech(dir === 'S' ? daily.map(v => -v) : daily);
}

function parseFormation(f) { return f.split('-').map(Number); }
function formationOf(counts) { return counts.join('-'); }

// ---------- Optimierer ----------
// Bestes Team: 10 Listings, Budget, erlaubte Formationen, genau ein Kapitän (Wert × 2).
// items: [{id, cat, mw, value}] -> {total, formation, picks:[ids], captain}
function bestTeam(items, budget = GAME.BUDGET) {
  const B = Math.round(budget * 2);
  const NEG = -1e15;
  const perCat = GAME.CATS.map(c => items.filter(i => i.cat === c && i.value !== null && i.value !== undefined));
  const maxK = 6;
  // Je Kategorie: dp[k][f][b] = max Summe mit k Picks, f Kapitäne (0/1), Kosten genau b (halbe $)
  const catRes = perCat.map(list => {
    const n = list.length;
    const size = (maxK + 1) * 2 * (B + 1);
    const idx = (k, f, b) => (k * 2 + f) * (B + 1) + b;
    const layers = [];
    let dp = new Float64Array(size).fill(NEG);
    dp[idx(0, 0, 0)] = 0;
    for (let i = 0; i < n; i++) {
      const it = list[i], w = Math.round(it.mw * 2), v = it.value;
      const nd = Float64Array.from(dp);
      const choice = new Uint8Array(size);          // 0 = nicht genommen, 1 = genommen, 2 = als Kapitän
      for (let k = 0; k < maxK; k++) for (let f = 0; f < 2; f++) for (let b = 0; b + w <= B; b++) {
        const cur = dp[idx(k, f, b)];
        if (cur === NEG) continue;
        const a = idx(k + 1, f, b + w);
        if (cur + v > nd[a]) { nd[a] = cur + v; choice[a] = 1; }
        if (f === 0) {
          const c = idx(k + 1, 1, b + w);
          if (cur + 2 * v > nd[c]) { nd[c] = cur + 2 * v; choice[c] = 2; }
        }
      }
      layers.push(choice);
      dp = nd;
    }
    const recon = (k, f, b) => {
      const picks = []; let cap = null;
      for (let i = n - 1; i >= 0 && k > 0; i--) {
        const ch = layers[i][idx(k, f, b)];
        if (!ch) continue;
        picks.push(list[i].id);
        if (ch === 2) { cap = list[i].id; f = 0; }
        b -= Math.round(list[i].mw * 2); k--;
      }
      return { picks, cap };
    };
    return { dp, idx, recon };
  });
  let best = null;
  for (const f of GAME.FORMATIONS) {
    const [k1, k2, k3] = parseFormation(f);
    // Kategorien 1 und 2 kombinieren (Kosten genau), danach Kategorie 3 mit Restbudget
    for (const capCat of [0, 1, 2]) {
      const fl = [0, 0, 0]; fl[capCat] = 1;
      const A = catRes[0], Bc = catRes[1], C = catRes[2];
      // bestC[r] = max über Kosten ≤ r
      const bestC = new Float64Array(B + 1).fill(NEG), argC = new Int32Array(B + 1).fill(-1);
      for (let b = 0; b <= B; b++) {
        const v = C.dp[C.idx(k3, fl[2], b)];
        if (b > 0 && bestC[b - 1] >= v) { bestC[b] = bestC[b - 1]; argC[b] = argC[b - 1]; }
        else { bestC[b] = v; argC[b] = v === NEG ? -1 : b; }
      }
      for (let a = 0; a <= B; a++) {
        const va = A.dp[A.idx(k1, fl[0], a)];
        if (va === NEG) continue;
        for (let b = 0; a + b <= B; b++) {
          const vb = Bc.dp[Bc.idx(k2, fl[1], b)];
          if (vb === NEG) continue;
          const r = B - a - b, vc = bestC[r];
          if (vc === NEG) continue;
          const tot = va + vb + vc;
          if (!best || tot > best.total) best = { total: tot, formation: f, a, b, c: argC[r], fl: fl.slice() };
        }
      }
    }
  }
  if (!best) return null;
  const [k1, k2, k3] = parseFormation(best.formation);
  const parts = [catRes[0].recon(k1, best.fl[0], best.a), catRes[1].recon(k2, best.fl[1], best.b), catRes[2].recon(k3, best.fl[2], best.c)];
  return {
    total: Math.round(best.total), formation: best.formation,
    picks: parts.flatMap(p => p.picks), captain: parts.map(p => p.cap).find(x => x) || null,
    cost: (best.a + best.b + best.c) / 2
  };
}

// Punkte eines Teams: Summe, Kapitän doppelt
function teamPoints(team, points) {
  if (!team || !team.picks) return null;
  let s = 0, any = false;
  team.picks.forEach(id => {
    const p = points[id];
    if (p === null || p === undefined) return;
    any = true; s += p * (id === team.captain ? 2 : 1);
  });
  return any ? s : null;
}

// Prüft eine eigene Aufstellung
function validateTeam(picks, listings) {
  const byId = Object.fromEntries(listings.map(l => [l.id, l]));
  const counts = [0, 0, 0]; let cost = 0;
  picks.forEach(id => { const l = byId[id]; if (!l) return; counts[GAME.CATS.indexOf(l.cat)]++; cost += l.mw; });
  const formation = formationOf(counts);
  const errors = [];
  if (picks.length !== GAME.PICKS) errors.push(`${picks.length}/10 Picks`);
  if (cost > GAME.BUDGET + 1e-9) errors.push('Budget überschritten');
  if (picks.length === GAME.PICKS && !GAME.FORMATIONS.includes(formation)) errors.push(`Formation ${formation} nicht erlaubt`);
  return { ok: errors.length === 0, errors, formation, counts, cost: Math.round(cost * 100) / 100 };
}

const GameCore = {
  GAME, TECH, TECH_REVERSE, categoryOf, baseName, berlinParts, berlinToUtc, berlinDayKey, isoWeek,
  spieltagFromMonday, shiftSpieltag, gameState, computeMarketValues, avgDailyVolume, priceAt, pointsFor,
  classifyTech, techFor, bestTeam, teamPoints, validateTeam, parseFormation, round05
};
if (typeof module !== 'undefined') module.exports = GameCore;
