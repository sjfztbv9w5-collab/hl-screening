// Gemeinsame Logik für Browser-Seite (hl_screening.html) und Server-Job (collect.js).
// Nicht ohne Abstimmung ändern: Scoring-Änderungen wirken auf Seite UND Datensammlung.

const API_URL = "https://api.hyperliquid.xyz/info";
const MIN_VOL_USD = 1_000_000;
const MIN_OI_USD = 1_000_000;
const FUNDING_CLAMP_8H = 0.0005;
const FUNDING_CROWD_THRESHOLD = 0.8 * FUNDING_CLAMP_8H;
const HOURS_BACK = 24 * 7;
const CONCURRENCY = 5;

// ---------- API ----------
async function post(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// Alle Perp-DEXs: Haupt-DEX (Krypto) + HIP-3-DEXs (Aktien, Rohstoffe, Indizes, FX …).
// HIP-3-Assets heißen "dex:NAME" (z. B. "xyz:GOLD") und werden auch so für Kerzen abgefragt.
async function getDexList() {
  const dexes = [''];
  try {
    const list = await post({ type: "perpDexs" });
    if (Array.isArray(list)) list.forEach(d => { if (d && d.name) dexes.push(d.name); });
  } catch (e) {}
  return dexes;
}

async function getDexAssets(dex) {
  const dexArg = dex ? { dex } : {};
  const [meta, assetCtxs] = await post({ type: "metaAndAssetCtxs", ...dexArg });
  let capped = [];
  try { capped = await post({ type: "perpsAtOpenInterestCap", ...dexArg }); } catch (e) { capped = []; }
  const cappedSet = new Set(Array.isArray(capped) ? capped : []);
  const out = [];
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const ctx = assetCtxs[i];
    if (!ctx) return;
    const markPx = parseFloat(ctx.markPx);
    const dayVol = parseFloat(ctx.dayNtlVlm);
    const oi = parseFloat(ctx.openInterest) * markPx;
    const funding = parseFloat(ctx.funding);
    if (!(dayVol >= MIN_VOL_USD) || !(oi >= MIN_OI_USD)) return;
    if (cappedSet.has(u.name)) return;
    out.push({ name: u.name, dex, markPx, dayVol, oi, funding, maxLeverage: u.maxLeverage });
  });
  return out;
}

async function getUniverseAndCtxs() {
  const dexes = await getDexList();
  const out = [];
  for (const dex of dexes) {
    try { out.push(...await getDexAssets(dex)); }
    catch (e) { if (dex === '') throw e; }   // Fehler im Haupt-DEX abbrechen, bei HIP-3 überspringen
  }
  return out;
}

async function getHourlyCandles(coin) {
  const end = Date.now();
  const start = end - HOURS_BACK * 3600 * 1000;
  return post({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: start, endTime: end } });
}

// ---------- Indikatoren (unverändert) ----------
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) { avgGain += gains[i]; avgLoss += losses[i]; }
  avgGain /= period; avgLoss /= period;
  let rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  out[period] = 100 - 100 / (1 + rs);
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    out[i + 1] = 100 - 100 / (1 + rs);
  }
  return out;
}

function findSwings(series, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < series.length - lookback; i++) {
    const window = series.slice(i - lookback, i + lookback + 1);
    const mx = Math.max(...window), mn = Math.min(...window);
    if (series[i] === mx) highs.push(i);
    if (series[i] === mn) lows.push(i);
  }
  return { highs, lows };
}

function scoreAsset(asset, candles) {
  const closes = candles.map(c => parseFloat(c.c));
  const vols = candles.map(c => parseFloat(c.v));
  if (closes.length < 30) return null;

  const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
  const ema20 = ema(closes, 20), ema50 = closes.length >= 50 ? ema(closes, 50) : new Array(closes.length).fill(null);
  const rsi14 = rsi(closes, 14);
  const last = closes.length - 1;
  if (ema12[last] === null || ema26[last] === null || rsi14[last] === null) return null;

  const ppo = (ema12[last] - ema26[last]) / ema26[last] * 100;

  const macdLine = closes.map((_, i) => (ema12[i] !== null && ema26[i] !== null) ? ema12[i] - ema26[i] : null);
  const validIdx = macdLine.map((v, i) => v !== null ? i : -1).filter(i => i >= 0);
  const validMacd = validIdx.map(i => macdLine[i]);
  const macdSignal = validMacd.length >= 9 ? ema(validMacd, 9) : [];

  let bullishCrossRecent = false, bearishCrossRecent = false;
  if (macdSignal.length >= 4) {
    for (let i = Math.max(1, macdSignal.length - 3); i < macdSignal.length; i++) {
      if (macdSignal[i - 1] === null || macdSignal[i] === null) continue;
      const prevDiff = validMacd[i - 1] - macdSignal[i - 1];
      const currDiff = validMacd[i] - macdSignal[i];
      if (prevDiff <= 0 && currDiff > 0) bullishCrossRecent = true;
      if (prevDiff >= 0 && currDiff < 0) bearishCrossRecent = true;
    }
  }

  const uptrendCtx = ema50[last] !== null && closes[last] > ema20[last] && ema20[last] > ema50[last];
  const downtrendCtx = ema50[last] !== null && closes[last] < ema20[last] && ema20[last] < ema50[last];

  const volAvg20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volAvg20 > 0 ? vols[last] / volAvg20 : 1.0;
  const volMult = volRatio > 1.5 ? 1.2 : (volRatio < 0.5 ? 0.8 : 1.0);

  const { highs: priceHighs, lows: priceLows } = findSwings(closes, 3);
  let divBullish = 0, divBearish = 0;
  if (priceLows.length >= 2) {
    const i1 = priceLows[priceLows.length - 2], i2 = priceLows[priceLows.length - 1];
    if (closes[i2] < closes[i1] && rsi14[i2] !== null && rsi14[i1] !== null && rsi14[i2] > rsi14[i1]) divBullish = 1.5;
  }
  if (priceHighs.length >= 2) {
    const i1 = priceHighs[priceHighs.length - 2], i2 = priceHighs[priceHighs.length - 1];
    if (closes[i2] > closes[i1] && rsi14[i2] !== null && rsi14[i1] !== null && rsi14[i2] < rsi14[i1]) divBearish = 1.5;
  }

  const funding = asset.funding;
  const r = rsi14[last];
  const warnings = [];

  // LONG
  let longScore = 0;
  if (ppo > 0) {
    if (ppo >= 0.5 && ppo <= 1.0) longScore += 1;
    else if (ppo > 1.0) longScore += 2;
  }
  if (bullishCrossRecent) longScore += 1;
  if (uptrendCtx && r >= 50 && r <= 70) longScore += 1;
  else if (r > 70) warnings.push("RSI>70 überhitzt");
  longScore += divBullish;
  if (divBearish) longScore -= divBearish;
  if (funding > FUNDING_CROWD_THRESHOLD) { longScore -= 1; warnings.push("Funding-Crowding gegen Long"); }
  longScore *= volMult;

  // SHORT
  let shortScore = 0;
  if (ppo < 0) {
    if (Math.abs(ppo) >= 0.5 && Math.abs(ppo) <= 1.0) shortScore -= 1;
    else if (Math.abs(ppo) > 1.0) shortScore -= 2;
  }
  if (bearishCrossRecent) shortScore -= 1;
  if (downtrendCtx && r >= 30 && r <= 50) shortScore -= 1;
  else if (r < 30) warnings.push("RSI<30 überverkauft, Bounce-Risiko");
  shortScore -= divBearish;
  if (divBullish) shortScore += divBullish;
  if (funding < -FUNDING_CROWD_THRESHOLD) { shortScore += 1; warnings.push("Funding-Crowding gegen Short (bereits überfüllt)"); }
  shortScore *= volMult;

  return {
    name: asset.name, dex: asset.dex || '', markPx: asset.markPx, ppo, rsi: r, funding,
    longScore: Math.round(longScore * 100) / 100,
    shortScore: Math.round(shortScore * 100) / 100,
    volMult, warnings
  };
}


// ---------- Gesamter Lauf ----------
function rankResults(results) {
  return results.map(r => {
    const long = Math.abs(r.longScore) >= Math.abs(r.shortScore);
    return { ...r, direction: long ? 'LONG' : 'SHORT', score: long ? r.longScore : r.shortScore };
  }).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

// Liefert Ranking sowie Rohdaten (Assetkennzahlen + 1h-Kerzen je Asset).
async function runScan(onStatus = () => {}, onProgress = () => {}) {
  onStatus('Lade Universe & Liquiditätsdaten…');
  const assets = await getUniverseAndCtxs();
  onStatus(`${assets.length} Assets liquide genug. Lade 7-Tage-Kerzen…`);

  const results = [], raw = [];
  let done = 0;
  for (let i = 0; i < assets.length; i += CONCURRENCY) {
    const batch = assets.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(a => getHourlyCandles(a.name)));
    settled.forEach((res, idx) => {
      done++;
      if (res.status === 'fulfilled') {
        raw.push({ ...batch[idx], candles: res.value });
        const r = scoreAsset(batch[idx], res.value);
        if (r) results.push(r);
      }
    });
    onProgress(Math.round(done / assets.length * 100));
    onStatus(`Lade Kerzen… ${done}/${assets.length}`);
    await new Promise(r => setTimeout(r, 120));
  }
  return { checked: assets.length, ranked: rankResults(results), raw };
}

// ---------- CSV ----------
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvLine(arr) { return arr.map(csvCell).join(','); }

const SCORING_HEADER = ['run_ts','rank','name','dex','direction','score','long_score','short_score',
  'price','ppo_pct','rsi','funding','vol_mult','warnings'];
function scoringRow(ts, rank, r) {
  return [new Date(ts).toISOString(), rank, r.name, r.dex || '', r.direction, r.score, r.longScore, r.shortScore,
    r.markPx, r.ppo.toFixed(4), r.rsi.toFixed(2), r.funding, r.volMult, r.warnings.join(' | ')];
}
function scoringCsv(ts, rows, withHeader = true) {
  const lines = rows.map((r, i) => csvLine(scoringRow(ts, i + 1, r)));
  return (withHeader ? [csvLine(SCORING_HEADER)] : []).concat(lines).join('\n') + '\n';
}
// Verlauf (kompakt, wie im Browser gespeichert): ts, rank, name, direction, score
function historyCsv(hist) {
  const lines = [csvLine(['run_ts', 'rank', 'name', 'direction', 'score'])];
  hist.forEach(run => run.list.forEach((e, i) =>
    lines.push(csvLine([new Date(run.ts).toISOString(), i + 1, e[0], e[2] === 1 ? 'LONG' : 'SHORT', e[1]]))));
  return lines.join('\n') + '\n';
}

if (typeof module !== 'undefined') {
  module.exports = { runScan, rankResults, scoreAsset, scoringCsv, historyCsv, csvLine, SCORING_HEADER, scoringRow,
    getUniverseAndCtxs, getHourlyCandles, post };
}
