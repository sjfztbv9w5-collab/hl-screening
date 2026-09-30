// Server-seitiger Scan (GitHub Actions). Schreibt in OUT_DIR (Standard: data):
//   history.csv          – jede Ausführung angehängt (alle Kennzahlen je Asset)
//   latest_ranking.csv   – letzter Lauf
//   latest_raw.json.gz   – Rohdaten (Kerzen) des letzten Laufs, nur wenn RAW=1
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
  if (process.env.RAW === '1') {
    fs.writeFileSync(path.join(out, 'latest_raw.json.gz'),
      zlib.gzipSync(JSON.stringify({ ts: new Date(ts).toISOString(), assets: scan.raw })));
  }
  console.log(`OK: ${scan.checked} Assets geprüft, ${scan.ranked.length} bewertet.`);
})().catch(e => { console.error(e); process.exit(1); });
