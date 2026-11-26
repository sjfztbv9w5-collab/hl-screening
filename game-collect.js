// Signal-Liga: Server-Teil (läuft im stündlichen collect-Job nach dem Scan).
// Schreibt nach <OUT_DIR>/game/:
//   index.json            – Übersicht (Phase, Spieltage, Stand)
//   <ID>.json             – eingefrorener Transfermarkt eines Spieltags (MW, Technik, Form, Algo-/Passiv-FC)
//   <ID>_entry.json       – Einstiegskurse Mo 12:00
//   <ID>_result.json      – Abrechnung Sa 20:00 inkl. Team der Woche
//   live.json             – laufende Punkte des aktiven Spieltags (stündlich)
// Alle Kurse kommen aus 1h-Kerzen zum exakten Zeitpunkt, deshalb sind verspätete Läufe unkritisch.
const fs = require('fs');
const path = require('path');
const G = require('./game-core.js');
const { post } = require('./screen-core.js');

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));

// Ø-Netto-Score (Long + Short) je Asset und Berliner Kalendertag aus history.csv
function techDaily(histFile, untilMs) {
  const sums = new Map();
  const lines = fs.readFileSync(histFile, 'utf8').split('\n');
  const from = untilMs - 35 * 86400000;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',', 8);
    if (c.length < 8) continue;
    const t = Date.parse(c[0]);
    if (!(t >= from && t <= untilMs)) continue;
    const key = c[2] + '\u0000' + G.berlinDayKey(t);
    const v = parseFloat(c[6]) + parseFloat(c[7]);
    if (!isFinite(v)) continue;
    const s = sums.get(key) || [0, 0];
    s[0] += v; s[1]++;
    sums.set(key, s);
  }
  const out = {};
  [...sums.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).forEach(([k, s]) => {
    const [name] = k.split('\u0000');
    (out[name] = out[name] || []).push(Math.round(s[0] / s[1] * 100) / 100);
  });
  return out;
}

async function fetchCandles(names, startTime, endTime) {
  const res = {};
  for (let i = 0; i < names.length; i += 5) {
    const batch = names.slice(i, i + 5);
    const got = await Promise.allSettled(batch.map(coin =>
      post({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime, endTime } })));
    got.forEach((g, j) => { if (g.status === 'fulfilled' && Array.isArray(g.value)) res[batch[j]] = g.value; });
    await new Promise(r => setTimeout(r, 150));
  }
  return res;
}

function listingPoints(listings, candles, st) {
  const pts = {};
  listings.forEach(l => {
    const c = candles[l.name];
    if (!c) return;
    const p = G.pointsFor(G.priceAt(c, st.start), G.priceAt(c, st.end), l.dir);
    if (p !== null) pts[l.id] = p;
  });
  return pts;
}

function buildListings(raw, daily, freezeAt) {
  const assets = [];
  raw.forEach(a => {
    const cat = G.categoryOf(a);
    if (!cat) return;
    assets.push({ name: a.name, dex: a.dex || '', cat, base: G.baseName(a.name),
      liq: G.avgDailyVolume(a.candles || [], freezeAt) + a.oi, oi: a.oi });
  });
  // Gleiches Underlying auf mehreren HIP-3-DEXs: nur das liquideste behalten
  const best = new Map();
  assets.forEach(a => { const k = a.cat + '|' + a.base; if (!best.has(k) || best.get(k).liq < a.liq) best.set(k, a); });
  const valued = G.computeMarketValues([...best.values()]);
  const listings = [];
  valued.forEach(a => {
    const d = daily[a.name] || [];
    ['L', 'S'].forEach(dir => listings.push({
      id: a.name + '|' + dir, name: a.name, label: a.base + (dir === 'L' ? ' ▲' : ' ▼'), base: a.base, dex: a.dex,
      cat: a.cat, dir, mw: a.mw, liq: Math.round(a.liq), tech: G.techFor(d, dir),
      score: d.length ? Math.round(d[d.length - 1] * (dir === 'L' ? 100 : -100)) / 100 : null
    }));
  });
  return listings;
}

async function updateGame(out, scan, histFile, now = Date.now()) {
  const dir = path.join(out, 'game');
  fs.mkdirSync(dir, { recursive: true });
  const st = G.gameState(now);
  const file = id => path.join(dir, id + '.json');
  const index = readJson(path.join(dir, 'index.json')) || { spieltage: [] };

  // 1) Transfermarkt für den aktiven Spieltag einfrieren (in der Pause; beim ersten Lauf auch nachträglich)
  let snap = readJson(file(st.active.id));
  let lastSnap = readJson(file(st.last.id));
  const needSnap = !snap;
  const needResult = lastSnap && !fs.existsSync(file(st.last.id + '_result')) && now >= st.last.end;
  if (needSnap || needResult) {
    const oldest = G.shiftSpieltag(st.active, -4);
    const names = [...new Set(scan.raw.map(a => a.name).concat(lastSnap ? lastSnap.listings.map(l => l.name) : []))];
    console.log(`Signal-Liga: lade 1h-Kerzen seit ${new Date(oldest.start).toISOString()} für ${names.length} Assets…`);
    const candles = await fetchCandles(names, oldest.start - 2 * 3600000, now);

    if (needResult) {
      const points = listingPoints(lastSnap.listings, candles, st.last);
      const items = lastSnap.listings.map(l => ({ id: l.id, cat: l.cat, mw: l.mw, value: points[l.id] }));
      const tdw = G.bestTeam(items);
      writeJson(file(st.last.id + '_result'), {
        id: st.last.id, settledAt: now, points, teamOfWeek: tdw,
        algoPoints: G.teamPoints(lastSnap.algo, points), passivPoints: G.teamPoints(lastSnap.passiv, points)
      });
      console.log(`Signal-Liga: ${st.last.id} abgerechnet, Team der Woche ${tdw ? tdw.total : '–'} Punkte.`);
    }

    if (needSnap) {
      const daily = techDaily(histFile, now);
      const listings = buildListings(scan.raw, daily, now);
      const formSt = [4, 3, 2, 1].map(k => G.shiftSpieltag(st.active, -k));
      const formPts = formSt.map(s => listingPoints(listings, candles, s));
      listings.forEach(l => {
        l.form = formPts.map(p => (p[l.id] === undefined ? null : p[l.id]));
        const f = l.form.filter(v => v !== null);
        l.avg = f.length ? Math.round(f.reduce((a, b) => a + b, 0) / f.length) : null;
      });
      const algo = G.bestTeam(listings.map(l => ({ id: l.id, cat: l.cat, mw: l.mw,
        value: l.score === null ? null : Math.round(l.score * 100) })));
      const passivPicks = listings.filter(l => l.dir === 'L').sort((a, b) => b.mw - a.mw).slice(0, 10).map(l => l.id);
      snap = {
        id: st.active.id, kw: st.active.kw, start: st.active.start, end: st.active.end, frozenAt: now,
        late: now > st.active.start, formIds: formSt.map(s => s.id), listings,
        algo: algo && { picks: algo.picks, formation: algo.formation },
        passiv: { picks: passivPicks }
      };
      writeJson(file(st.active.id), snap);
      console.log(`Signal-Liga: Transfermarkt ${st.active.id} eingefroren (${listings.length} Listings).`);
    }
  }

  // 2) Einstiegskurse Mo 12:00 und laufende Punkte
  if (st.phase === 'live' && snap) {
    const entryF = file(st.active.id + '_entry');
    let entry = readJson(entryF);
    if (!entry) {
      const prices = {};
      scan.raw.forEach(a => { const p = G.priceAt(a.candles || [], st.active.start); if (p) prices[a.name] = p; });
      entry = { id: st.active.id, at: st.active.start, prices };
      writeJson(entryF, entry);
    }
    const mark = Object.fromEntries(scan.raw.map(a => [a.name, a.markPx]));
    const points = {};
    snap.listings.forEach(l => {
      const p = G.pointsFor(entry.prices[l.name], mark[l.name], l.dir);
      if (p !== null) points[l.id] = p;
    });
    writeJson(path.join(dir, 'live.json'), { id: st.active.id, asOf: now, points });
  }

  // 3) Übersicht
  const ids = new Set(index.spieltage);
  fs.readdirSync(dir).forEach(f => { const m = f.match(/^(\d{4}-W\d{2})\.json$/); if (m) ids.add(m[1]); });
  writeJson(path.join(dir, 'index.json'), {
    updated: now, phase: st.phase, active: st.active.id, last: st.last.id,
    spieltage: [...ids].sort(),
    results: fs.readdirSync(dir).map(f => (f.match(/^(\d{4}-W\d{2})_result\.json$/) || [])[1]).filter(Boolean).sort()
  });
}

module.exports = { updateGame, techDaily, buildListings };
