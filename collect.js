// Server-seitiger Scan (GitHub Actions). Schreibt in OUT_DIR (Standard: data):
//   history.csv          – jede Ausführung angehängt (alle Kennzahlen je Asset)
//   latest_ranking.csv   – letzter Lauf
//   latest_raw.json.gz   – Rohdaten (Kerzen) des letzten Laufs, nur wenn RAW=1
//   chart_7d.json        – kompakter Rangverlauf der letzten 7 Tage für die Grafik der Seite
//                          (Format wie der Browser-Verlauf: [{ts, list: [[name, score, ±1], …]}], Liste nach Rang)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { runScan, scoringCsv, csvLine, SCORING_HEADER } = require('./screen-core.js');

(async () => {
  const out = process.env.OUT_DIR || 'data';
  fs.mkdirSync(out, { recursive: true });
  const ts = Date.now();
  const scan = await runScan(m => console.log(m), () => {});
  if (!scan.ranked.length) throw new Error('Keine Assets bewertet – Abbruch, nichts geschrieben.');

  const histFile = path.join(out, 'history.csv');
  if (!fs.existsSync(histFile)) fs.writeFileSync(histFile, csvLine(SCORING_HEADER) + '\n');
  fs.appendFileSync(histFile, scoringCsv(ts, scan.ranked, false));
  fs.writeFileSync(path.join(out, 'latest_ranking.csv'), scoringCsv(ts, scan.ranked));
  writeChart7d(histFile, path.join(out, 'chart_7d.json'), ts);
  if (process.env.RAW === '1') {
    fs.writeFileSync(path.join(out, 'latest_raw.json.gz'),
      zlib.gzipSync(JSON.stringify({ ts: new Date(ts).toISOString(), assets: scan.raw })));
  }
  console.log(`OK: ${scan.checked} Assets geprüft, ${scan.ranked.length} bewertet.`);
})().catch(e => { console.error(e); process.exit(1); });

// Baut chart_7d.json aus history.csv neu auf (eine Quelle der Wahrheit, keine Fortschreibung).
// Spalten: run_ts,rank,name,dex,direction,score,… – die ersten sechs enthalten nie Kommas.
function writeChart7d(histFile, outFile, now) {
  const cutoff = now - 7 * 24 * 3600 * 1000;
  const runs = new Map();
  const lines = fs.readFileSync(histFile, 'utf8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',', 6);
    if (c.length < 6) continue;
    const t = Date.parse(c[0]);
    if (!(t >= cutoff)) continue;
    if (!runs.has(t)) runs.set(t, []);
    runs.get(t).push([+c[1], c[2], parseFloat(c[5]), c[4] === 'LONG' ? 1 : -1]);
  }
  const data = [...runs.entries()].sort((a, b) => a[0] - b[0]).map(([t, rows]) => ({
    ts: t,
    list: rows.sort((a, b) => a[0] - b[0]).map(r => [r[1], r[2], r[3]])
  }));
  fs.writeFileSync(outFile, JSON.stringify({ generated: new Date(now).toISOString(), days: 7, runs: data }));
  console.log(`chart_7d.json: ${data.length} Läufe`);
}
