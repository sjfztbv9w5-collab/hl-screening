// Signal-Liga: gemeinsame Browser-Helfer (Daten laden, Speicher, Navigation, Formatierung).
const UI = (() => {
  const G = GameCore;
  const bust = () => '?t=' + Math.floor(Date.now() / 300000);

  async function getJson(name) {
    const res = await fetch(G.GAME.DATA_URL + name + bust(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'nicht gefunden' : 'HTTP ' + res.status);
    return res.json();
  }
  const tryJson = name => getJson(name).catch(() => null);

  // Eigene Aufstellungen liegen nur auf diesem Gerät (localStorage)
  const mem = {};
  function loadTeam(id) {
    try { const s = localStorage.getItem('sl_team_' + id); if (s) return JSON.parse(s); } catch (e) {}
    return mem[id] || { picks: [], captain: null };
  }
  function saveTeam(id, team) {
    mem[id] = team;
    try { localStorage.setItem('sl_team_' + id, JSON.stringify(team)); return true; } catch (e) { return false; }
  }

  const nf = (n, d = 0) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = n => nf(n, 2) + ' $';
  const mwFmt = n => nf(n, 1) + ' $';
  const pts = n => (n === null || n === undefined) ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '±') + nf(Math.abs(n));
  const ptsClass = n => (n === null || n === undefined) ? 'muted' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted';
  const when = ms => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function nav(active) {
    const items = [['hl_screening.html', 'Screener'], ['transfermarkt.html', 'Transfermarkt'], ['aufstellung.html', 'Aufstellung'],
      ['team-der-woche.html', 'Team der Woche'], ['regelwerk.html', 'Regelwerk']];
    return '<nav class="nav">' + items.map(([h, l]) =>
      `<a href="${h}" class="${h === active ? 'on' : ''}">${l}</a>`).join('') + '</nav>';
  }

  function phaseBanner(st) {
    if (st.phase === 'live') return `<div class="banner live"><b>KW ${st.active.kw} läuft</b> · Aufstellung gesperrt · Abrechnung ${when(st.active.end)}</div>`;
    return `<div class="banner"><b>Transferfenster KW ${st.active.kw}</b> · Abgabe bis ${when(st.active.start)}</div>`;
  }

  function formBars(form) {
    return '<span class="form">' + (form || []).map(v => {
      if (v === null) return '<i class="na" title="keine Daten"></i>';
      const h = Math.max(3, Math.min(22, Math.round(Math.abs(v) / 1000 * 22)));
      return `<i class="${v >= 0 ? 'p' : 'n'}" style="height:${h}px" title="${pts(v)}"></i>`;
    }).join('') + '</span>';
  }

  return { G, getJson, tryJson, loadTeam, saveTeam, nf, money, mwFmt, pts, ptsClass, when, esc, nav, phaseBanner, formBars };
})();
