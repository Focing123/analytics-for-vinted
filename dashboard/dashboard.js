import { barChart, hbarChart, scatterChart, attachBarTooltip, attachBarClick } from './charts.js';

const params = new URLSearchParams(location.search);
const inExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
const DB = inExt ? await import('../src/lib/db.js') : null;
const $ = (id) => document.getElementById(id);
const ROW = 56;
const VINTED = 'https://www.vinted.fr';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('fr-FR');
const money = (v) => nf.format(Math.round(v * 100) / 100) + ' €';
// Annonce vocale (zone aria-live) pour les lecteurs d'écran
let announceTimer;
function announce(msg) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { const r = $('sr-status'); r.textContent = ''; setTimeout(() => { r.textContent = msg; }, 50); }, 400);
}
// Emoji porteur de sens : texte alternatif pour les lecteurs d'écran
const ico = (emoji, label) => `<span role="img" aria-label="${label}" title="${label}">${emoji}</span>`;

// ------------------------------------------------------------------- état
const S = {
  sid: null, items: [], idx: new Uint32Array(0), sim: new Uint16Array(0), score: new Float32Array(0),
  sort: { key: 'f', dir: 'desc' }, extra: { owner: '', sig: '' }, tab: 'overview', queryId: 0, agg: null, pendingAppend: [], sellers: [],
};
const worker = new Worker('analysis-worker.js');

// ------------------------------------------------------------ filtres
const numVal = (id) => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
function filters() {
  return {
    q: $('f-q').value.trim(), pmin: numVal('f-pmin'), pmax: numVal('f-pmax'), lmin: numVal('f-lmin'), lmax: numVal('f-lmax'),
    brand: $('f-brand').value.trim(), state: $('f-state').value.trim(), minSim: numVal('f-sim'),
    demand: $('f-demand').checked, biz: $('f-biz').checked, owner: S.extra.owner, sig: S.extra.sig,
  };
}
let qTimer;
const requery = () => { clearTimeout(qTimer); qTimer = setTimeout(runQuery, 180); };
function runQuery(say = true) {
  S.say = say; // n'annonce le nombre de résultats que pour une action de l'utilisateur
  worker.postMessage({ t: 'query', id: ++S.queryId, filters: filters(), sort: S.sort });
  renderTags();
}
['f-q', 'f-pmin', 'f-pmax', 'f-lmin', 'f-lmax', 'f-brand', 'f-state', 'f-sim', 'f-demand', 'f-biz'].forEach((id) => $(id).addEventListener('input', requery));
$('f-reset').onclick = () => {
  document.querySelectorAll('.filters input').forEach((i) => { if (i.type === 'checkbox') i.checked = false; else i.value = ''; });
  S.extra = { owner: '', sig: '' }; runQuery();
};
function renderTags() {
  const t = [];
  if (S.extra.owner) t.push(['owner', 'Vendeur ' + S.extra.owner]);
  if (S.extra.sig) t.push(['sig', 'Produit : ' + S.extra.sig.slice(0, 28)]);
  $('f-tags').innerHTML = t.map(([k, l]) => `<span class="tag">${esc(l)}<button data-clear="${k}" aria-label="Retirer">×</button></span>`).join('');
}
$('f-tags').onclick = (e) => { const k = e.target.dataset.clear; if (k) { S.extra[k] = ''; runQuery(); } };

// ----------------------------------------------------------- résultat worker
worker.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'loaded') { fillDatalists(); runQuery(false); if (S.tab === 'sellers') loadSellers(); if (S.tab === 'products') loadProducts(); }
  else if (m.t === 'result') {
    if (m.id !== S.queryId) return; // résultat périmé
    S.idx = m.idx; S.sim = m.sim; S.score = m.score; S.agg = m.agg;
    renderKpis(m.kpis); renderItems(true); if (S.tab === 'overview') renderCharts();
    if (S.say) announce(`${nf.format(m.kpis.n)} annonces correspondent aux filtres.`);
  } else if (m.t === 'sellers') renderSellers(m.list);
  else if (m.t === 'products') renderProducts(m.list);
  else if (m.t === 'seller') renderDrawer(m.seller);
  else if (m.t === 'profile-ok') {
    clearTimeout(S.pt);
    S.pt = setTimeout(() => { if (S.tab === 'sellers') loadSellers(); if (drawerOwner) openSeller(drawerOwner); runQuery(false); }, 600);
  }
};

function fillDatalists() {
  const count = (k) => { const m = new Map(); for (const it of S.items) if (it[k]) m.set(it[k], (m.get(it[k]) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 300); };
  $('brands').innerHTML = count('b').map(([v, n]) => `<option value="${esc(v)}">${n}</option>`).join('');
  $('states').innerHTML = count('st').map(([v, n]) => `<option value="${esc(v)}">${n}</option>`).join('');
}

// ------------------------------------------------------------------- KPIs
function renderKpis(k) {
  const cells = [
    [nf.format(k.n) + (k.n !== k.total ? ` <small class="muted">/ ${nf.format(k.total)}</small>` : ''), 'annonces'],
    [nf.format(k.sellers), 'vendeurs'],
    [money(k.median), 'prix médian'],
    [k.avgLikes.toFixed(1), 'likes moyens'],
    [nf.format(k.demand), '« En demande »'],
    [money(k.value), 'valeur totale'],
    [nf.format(k.suspects), 'vendeurs suspects ›', k.suspects ? 'alert click' : ''],
  ];
  $('kpis').innerHTML = cells.map(([v, l, c]) => c && c.includes('click')
    ? `<button type="button" class="kpi ${c}" data-act="suspects" aria-label="${k.suspects} vendeurs suspects. Ouvrir la liste."><b>${v}</b><span>${l}</span></button>`
    : `<div class="kpi ${c || ''}"><b>${v}</b><span>${l}</span></div>`).join('');
}
// La carte « vendeurs suspects » ouvre l'onglet Vendeurs (≥ 2 annonces similaires)
$('kpis').onclick = (e) => {
  if (!e.target.closest('[data-act="suspects"]')) return;
  $('s-sim').value = 2; setTab('sellers');
};

// ----------------------------------------------------------------- graphiques
function renderCharts() {
  const a = S.agg; if (!a) return;
  barChart($('c-price'), a.priceHist, { labelEvery: 3 });
  barChart($('c-likes'), a.likesHist);
  scatterChart($('c-scatter'), a.scatter);
  hbarChart($('c-brands'), a.brands, { suffix: '' });
  hbarChart($('c-sellers'), a.topSellers.map((s) => ({ ...s, label: 'Vendeur ' + s.label })), { color: '--c1' });
  barChart($('c-age'), a.ageHist, { color: '--c2' });
  hbarChart($('c-states'), a.states, { color: '--c1' });
  chartA11y();
}

/**
 * Alternative accessible à chaque graphique : résumé texte (role="img") + liste de données.
 * Quand une barre filtre au clic, la liste contient des boutons : même action, au clavier.
 */
function chartA11y() {
  const a = S.agg;
  const pickBrand = (d) => { if (d.label === '—') return; $('f-brand').value = d.label; setTab('items'); runQuery(); };
  const pickState = (d) => { if (d.label === '—') return; $('f-state').value = d.label; setTab('items'); runQuery(); };
  const sellers = a.topSellers.map((s) => ({ ...s, label: 'Vendeur ' + s.label, o: s.label }));
  describe('c-price', 'Répartition des prix', a.priceHist, (d) => pickRange('f-pmin', 'f-pmax', { ...d, lo: Math.round(d.lo * 100) / 100 }), 'annonces');
  describe('c-likes', 'Répartition des likes', a.likesHist, (d) => pickRange('f-lmin', 'f-lmax', d), 'annonces');
  describe('c-brands', 'Marques les plus présentes', a.brands, pickBrand, 'annonces');
  describe('c-sellers', 'Vendeurs les plus actifs', sellers, (d) => openSeller(d.o), 'annonces');
  describe('c-age', 'Ancienneté estimée des comptes', a.ageHist, null, 'annonces');
  describe('c-states', 'États des articles', a.states, pickState, 'annonces');

  // nuage de points : résumé par quartile de prix
  const pts = [...a.scatter].sort((x, y) => x[0] - y[0]);
  const q = Math.max(1, Math.ceil(pts.length / 4));
  const rows = [];
  for (let i = 0; i < pts.length; i += q) {
    const g = pts.slice(i, i + q);
    rows.push({ label: `${money(g[0][0])} à ${money(g[g.length - 1][0])}`, value: (g.reduce((s, p) => s + p[1], 0) / g.length).toFixed(1).replace('.', ',') });
  }
  describe('c-scatter', 'Prix contre likes', rows, null, 'likes en moyenne',
    `Nuage de points : ${pts.length} annonces échantillonnées. Likes moyens par tranche de prix : ${rows.map((r) => `${r.label}, ${r.value}`).join(' ; ') || 'aucune donnée'}.`);
}

function describe(id, title, bins, onPick, unit, customLabel) {
  const canvas = $(id);
  const summary = bins.filter((b) => b.value).map((b) => `${b.label} : ${b.value}`).join(' ; ');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', customLabel || `${title}. ${summary || 'Aucune donnée'}.`);
  let d = canvas.parentElement.querySelector('.chart-data');
  if (!d) { d = document.createElement('details'); d.className = 'chart-data'; canvas.after(d); }
  const open = d.open;
  const act = document.activeElement; // pendant une collecte, la liste est reconstruite : on garde le focus
  const keep = d.contains(act) ? (act.dataset.i ?? 'summary') : null;
  d._bins = bins; d._pick = onPick;
  d.innerHTML = `<summary>${onPick ? 'Liste des tranches (utilisable au clavier)' : 'Voir les données'}</summary>` + (onPick
    ? `<ul>${bins.map((b, i) => `<li><button type="button" class="btn small" data-i="${i}" ${b.value ? '' : 'disabled'}>${esc(b.label)} — ${esc(b.value)} ${unit}</button></li>`).join('')}</ul>`
    : `<table class="tbl"><caption class="sr-only">${esc(title)}</caption><tbody>${bins.map((b) => `<tr><th scope="row">${esc(b.label)}</th><td class="num">${esc(b.value)} ${unit}</td></tr>`).join('')}</tbody></table>`);
  d.open = open;
  if (keep !== null) (keep === 'summary' ? d.querySelector('summary') : d.querySelector(`[data-i="${keep}"]`))?.focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.chart-data button[data-i]');
  if (!b) return;
  const d = b.closest('.chart-data');
  if (d._pick) d._pick(d._bins[+b.dataset.i]);
});
attachBarTooltip($('c-age'), $('tip'));
attachBarTooltip($('c-price'), $('tip'), 'cliquer pour voir ces produits');
attachBarTooltip($('c-likes'), $('tip'), 'cliquer pour voir ces produits');

// Clic sur une barre : on règle le filtre correspondant et on affiche les produits de la tranche
function pickRange(minId, maxId, d) {
  $(minId).value = d.lo > 0 ? d.lo : '';
  $(maxId).value = d.hi == null ? '' : d.hi;
  $('tip').hidden = true;
  setTab('items'); runQuery();
}
attachBarClick($('c-likes'), (d) => pickRange('f-lmin', 'f-lmax', d));
attachBarClick($('c-price'), (d) => pickRange('f-pmin', 'f-pmax', { ...d, lo: Math.round(d.lo * 100) / 100 }));
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.tab === 'overview') renderCharts(); renderItems(false); }, 120); });

// ------------------------------------------------- tableau d'annonces virtualisé
const COLS = [['', null], ['Titre', 't'], ['Marque', 'b'], ['Taille', null], ['État', 'st'], ['Prix', 'p'], ['Likes', 'f'], ['Vendeur', 'o'], ['Suspect', 'score']];
function renderHead() {
  $('items-head').innerHTML = COLS.map(([l, k], i) => {
    const sorted = S.sort.key === k;
    const cls = `${sorted ? 'sorted' : ''} ${['p', 'f'].includes(k) ? 'num' : ''}`;
    const aria = sorted ? ` aria-sort="${S.sort.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    if (!k) return `<span role="columnheader" aria-colindex="${i + 1}">${l || '<span class="sr-only">Photo</span>'}</span>`;
    return `<span role="columnheader" aria-colindex="${i + 1}" class="${cls}"${aria}><button type="button" data-k="${k}">${l}${sorted ? (S.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></span>`;
  }).join('');
}
$('items-head').onclick = (e) => {
  const k = e.target.dataset.k; if (!k) return;
  S.sort = { key: k, dir: S.sort.key === k && S.sort.dir === 'desc' ? 'asc' : 'desc' };
  const label = COLS.find((c) => c[1] === k)[0];
  announce(`Tri par ${label}, ordre ${S.sort.dir === 'asc' ? 'croissant' : 'décroissant'}.`);
  renderHead(); runQuery(false);
  $('items-head').querySelector(`[data-k="${k}"]`).focus(); // le bouton est reconstruit : on lui rend le focus
};

// Une seule ligne est dans l'ordre de tabulation (tabindex 0) : Tab entre dans le tableau, Tab en sort.
// Les flèches déplacent ensuite la ligne active ("roving tabindex").
function rowHtml(k, tab) {
  const it = S.items[S.idx[k]]; if (!it) return '';
  const sim = S.sim[k], sc = S.score[k];
  const susp = sim >= 2
    ? `<button type="button" class="badge" data-o="${esc(it.o)}" tabindex="${tab}" aria-label="Vendeur suspect : ${sim} annonces similaires, score ${sc.toFixed(0)}. Ouvrir la fiche du vendeur." title="${sim} annonces similaires chez ce vendeur — cliquer pour la fiche">🕵 ${sim} · ${sc.toFixed(0)}</button>`
    : (sc >= 5 ? `<span class="badge ok" title="Score vendeur ${sc.toFixed(0)}">score ${sc.toFixed(0)}</span>` : '');
  const flags = (Number(it.o) > 3e9 ? ' ' + ico('🆕', 'compte récent') : '') + (it.biz ? ' ' + ico('🏢', 'vendeur professionnel') : '') + (it.d ? ' ' + ico('🔥', 'en demande') : '');
  return `<div class="row" role="row" aria-rowindex="${k + 2}" data-k="${k}" tabindex="${tab}">
    <div role="cell" aria-colindex="1"><img loading="lazy" src="${esc(it.th)}" alt=""></div>
    <div role="cell" aria-colindex="2" class="t"><a href="${VINTED}${esc(it.u)}" target="_blank" rel="noopener" tabindex="${tab}" title="${esc(it.t)} (s'ouvre dans un nouvel onglet)">${esc(it.t)}</a></div>
    <div role="cell" aria-colindex="3" class="sub">${esc(it.b)}</div><div role="cell" aria-colindex="4" class="sub">${esc(it.sz)}</div><div role="cell" aria-colindex="5" class="sub">${esc(it.st)}</div>
    <div role="cell" aria-colindex="6" class="num">${money(it.p)}</div><div role="cell" aria-colindex="7" class="num"><span aria-hidden="true">❤ </span>${it.f}<span class="sr-only"> likes</span></div>
    <div role="cell" aria-colindex="8" class="sub"><button type="button" class="linklike seller" data-o="${esc(it.o)}" tabindex="${tab}" aria-label="Vendeur ${esc(it.o)}. Ouvrir la fiche.">${esc(it.o)}</button>${flags}</div>
    <div role="cell" aria-colindex="9">${susp}</div></div>`;
}

function renderItems(resetScroll) {
  const sc = $('items-scroll');
  $('items-spacer').style.height = S.idx.length * ROW + 'px';
  $('items-table').setAttribute('aria-rowcount', S.idx.length + 1); // + la ligne d'en-têtes
  if (resetScroll) sc.scrollTop = 0;
  paint();
  if (!S.idx.length) $('items-rows').innerHTML = '<div role="row"><div role="cell" class="empty">Aucune annonce pour ces filtres.</div></div>';
}

function paint() {
  const sc = $('items-scroll'), rowsEl = $('items-rows');
  const start = Math.max(0, Math.floor(sc.scrollTop / ROW) - 6);
  const end = Math.min(S.idx.length, start + Math.ceil(sc.clientHeight / ROW) + 12);
  // le contenu est reconstruit à chaque défilement : on mémorise l'élément focalisé pour le restaurer
  const act = document.activeElement;
  let restore = null;
  if (rowsEl.contains(act)) {
    const r = act.closest('.row');
    if (r) { restore = { k: +r.dataset.k, child: act === r ? -1 : [...r.querySelectorAll('a,button')].indexOf(act) }; S.activeK = restore.k; }
  }
  const active = S.activeK >= start && S.activeK < end ? S.activeK : start; // sinon la 1re ligne visible est l'entrée du tableau
  let html = '';
  for (let k = start; k < end; k++) html += rowHtml(k, k === active ? 0 : -1);
  rowsEl.style.transform = `translateY(${start * ROW}px)`;
  rowsEl.innerHTML = html;
  if (restore) {
    const r = rowsEl.querySelector(`.row[data-k="${restore.k}"]`);
    if (r) (restore.child >= 0 ? r.querySelectorAll('a,button')[restore.child] || r : r).focus({ preventScroll: true });
  }
}

function setActiveRow(k) {
  S.activeK = k;
  $('items-rows').querySelectorAll('.row').forEach((r) => {
    const t = +r.dataset.k === k ? 0 : -1;
    r.tabIndex = t; r.querySelectorAll('a,button').forEach((c) => { c.tabIndex = t; });
  });
}

function focusRow(k) {
  const sc = $('items-scroll');
  const top = k * ROW;
  if (top < sc.scrollTop) sc.scrollTop = top;
  else if (top + ROW > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + ROW - sc.clientHeight;
  S.activeK = k;
  paint();
  const r = $('items-rows').querySelector(`.row[data-k="${k}"]`);
  if (r) { setActiveRow(k); r.focus({ preventScroll: true }); }
}

let raf; $('items-scroll').addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); });
$('items-rows').addEventListener('focusin', (e) => { const r = e.target.closest('.row'); if (r) setActiveRow(+r.dataset.k); });
$('items-rows').addEventListener('keydown', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  const k = +row.dataset.k, last = S.idx.length - 1, page = Math.max(1, Math.floor($('items-scroll').clientHeight / ROW) - 1);
  const target = { ArrowDown: k + 1, ArrowUp: k - 1, PageDown: k + page, PageUp: k - page, Home: 0, End: last }[e.key];
  if (target !== undefined) { e.preventDefault(); focusRow(Math.min(last, Math.max(0, target))); return; }
  if (e.key === 'Enter' && e.target === row) { e.preventDefault(); row.querySelector('a').click(); } // Entrée sur la ligne : ouvre l'annonce
});
$('items-rows').onclick = (e) => {
  const b = e.target.closest('button[data-o]');
  if (b) { openSeller(b.dataset.o); return; }
  if (e.target.closest('a')) return; // le lien du titre s'ouvre tout seul
  const row = e.target.closest('.row');
  if (row) row.querySelector('a').click(); // clic ailleurs sur la ligne : ouvre l'annonce
};

// ---------------------------------------------------------------- vendeurs
function sellerOpts() {
  return { minSim: numVal('s-sim') || 1, recent: $('s-recent').checked, biz: $('s-biz').checked, q: $('s-q').value.trim() };
}
let st;
const loadSellers = () => worker.postMessage({ t: 'sellers', id: 1, opts: sellerOpts() });
['s-sim', 's-recent', 's-biz', 's-q'].forEach((id) => $(id).addEventListener('input', () => { clearTimeout(st); st = setTimeout(loadSellers, 200); }));

function renderSellers(list) {
  S.sellers = list;
  if (!list.length) { $('sellers-table').innerHTML = '<tr><td class="empty">Aucun vendeur avec ces critères.</td></tr>'; return; }
  $('sellers-table').innerHTML = `<caption class="sr-only">Vendeurs suspects, du score le plus élevé au plus faible</caption><thead><tr><th scope="col">Vendeur</th><th scope="col" class="num">Similaires / annonces</th><th scope="col">Même prix</th><th scope="col">Photo réutilisée</th>
    <th scope="col" class="num">Avis</th><th scope="col" class="num">Abonnés</th><th scope="col" class="num">Articles</th><th scope="col">Exemple</th><th scope="col" class="num">Score</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>` +
    list.map((s) => {
      const p = s.profile || {};
      const name = esc(p.login || s.o);
      return `<tr data-o="${esc(s.o)}" title="Cliquer pour la fiche du vendeur"><td><a class="link" href="${VINTED}/member/${esc(s.o)}" target="_blank" rel="noopener" title="Profil Vinted (nouvel onglet)">${name}</a>${s.recent ? ' ' + ico('🆕', 'compte récent') : ''}${(s.biz || p.business) ? ' ' + ico('🏢', 'vendeur professionnel') : ''}</td>
      <td class="num"><b>${s.sim}</b> / ${s.n}</td><td>${s.samePrice ? 'oui (' + money(s.price) + ')' : 'non'}</td><td>${s.dupPhoto ? 'oui' : 'non'}</td>
      <td class="num">${p.feedback ?? '—'}</td><td class="num">${p.followers ?? '—'}</td><td class="num">${p.total ?? '—'}</td>
      <td class="wrap">${esc(s.ex)}</td><td class="num"><span class="badge">${s.score}</span></td>
      <td><button type="button" class="btn small" data-sheet="${esc(s.o)}" aria-label="Fiche du vendeur ${name}">Fiche</button>
        <button type="button" class="btn small" data-o="${esc(s.o)}" aria-label="Voir les annonces du vendeur ${name}">Voir</button></td></tr>`;
    }).join('') + '</tbody>';
}
$('sellers-table').onclick = (e) => {
  if (e.target.closest('a')) return; // le lien du pseudo ouvre le profil Vinted
  const sheet = e.target.closest('button[data-sheet]');
  if (sheet) { openSeller(sheet.dataset.sheet); return; }
  const b = e.target.closest('button[data-o]');
  if (b) { S.extra.owner = b.dataset.o; setTab('items'); runQuery(); return; }
  const tr = e.target.closest('tr[data-o]');
  if (tr) openSeller(tr.dataset.o);
};

// ------------------------------------------------------------- fiche vendeur
// Boîte de dialogue modale : le reste de la page est rendu inerte (ni focus, ni lecteur d'écran),
// le focus entre dans la fiche et revient à l'élément déclencheur à la fermeture.
let drawerOwner = null, drawerOpener = null;
const pageRoots = () => [document.querySelector('header.top'), document.querySelector('.layout')];
function closeDrawer() {
  if (!drawerOwner && $('drawer').hidden) return;
  const o = drawerOwner;
  drawerOwner = null;
  $('drawer').hidden = true; $('backdrop').hidden = true;
  pageRoots().forEach((r) => { if (r) r.inert = false; });
  let target = drawerOpener && document.contains(drawerOpener) ? drawerOpener : null;
  // le déclencheur a pu être reconstruit (tableau virtualisé) : on cherche son équivalent
  if (!target && o) target = document.querySelector(`[data-o="${CSS.escape(o)}"], [data-sheet="${CSS.escape(o)}"]`);
  (target || document.querySelector('.tabs [aria-selected="true"]')).focus();
  drawerOpener = null;
}
$('backdrop').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOwner) closeDrawer(); });

function openSeller(o) {
  if (!drawerOwner) drawerOpener = document.activeElement;
  drawerOwner = o;
  worker.postMessage({ t: 'seller', o });
}

function renderDrawer(s) {
  if (!s || s.o !== drawerOwner) return;
  const p = s.profile || {};
  const mine = S.items.filter((it) => it.o === s.o).sort((a, b) => b.f - a.f);
  const mem = new Set(s.mem);
  const why = [];
  if (s.sim >= 2) why.push(`<b>${s.sim} annonces similaires</b> sur ${s.n} (titres quasi identiques)`);
  if (s.samePrice) why.push(`Toutes au <b>même prix</b> (${money(s.price)})`);
  if (s.dupPhoto) why.push('<b>Photo réutilisée</b> entre plusieurs annonces');
  if (s.recent) why.push('<b>Compte récent</b> (ID vendeur supérieur à 3 milliards)');
  if (s.biz || p.business) why.push('Compte <b>professionnel</b>');
  if (p.total != null) why.push(`Profil : <b>${p.feedback ?? '?'}</b> avis · <b>${p.followers ?? '?'}</b> abonnés · <b>${p.total}</b> articles`
    + (p.total >= 10 && p.feedback != null && p.feedback < 10 ? ' — gros stock, très peu d’avis' : ''));
  if (!why.length) why.push('Aucun signal particulier : vendeur ordinaire.');

  const wasHidden = $('drawer').hidden;
  const keep = !wasHidden && document.activeElement ? document.activeElement.dataset.a : null;
  const name = esc(p.login || 'Vendeur ' + s.o);
  $('drawer').innerHTML = `
    <div class="dh"><h2 id="drawer-title">Fiche vendeur : ${name}</h2><button type="button" class="x" aria-label="Fermer la fiche vendeur">×</button></div>
    <div class="chips"><span class="badge">score ${s.score}</span><span class="badge ok">${s.n} annonces chargées</span>
      <span class="badge ok">${s.likes} likes cumulés</span></div>
    <div><h3 class="h3">Pourquoi ce vendeur ressort</h3><ul class="why">${why.map((w) => `<li>${w}</li>`).join('')}</ul></div>
    <div class="actions">
      <a class="btn" href="${VINTED}/member/${esc(s.o)}" target="_blank" rel="noopener">Profil Vinted<span class="sr-only"> (nouvel onglet)</span> ↗</a>
      <button type="button" class="btn" data-a="filter">Filtrer les annonces</button>
      ${p.total == null && inExt ? '<button type="button" class="btn" data-a="profile">Charger le profil</button>' : ''}
    </div>
    <div><h3 class="h3">Ses annonces <span class="muted">(en orange : le groupe suspect)</span></h3></div>
    <ul class="listings">${mine.map((it) => `
      <li><a class="li ${mem.has(it.id) ? 'sus' : ''}" href="${VINTED}${esc(it.u)}" target="_blank" rel="noopener"
        aria-label="${esc(it.t)}, ${money(it.p)}, ${it.f} likes${mem.has(it.id) ? ', annonce du groupe suspect' : ''} (nouvel onglet)">
        <img loading="lazy" src="${esc(it.th)}" alt="">
        <div><div class="t">${esc(it.t)}</div><div class="m">${esc(it.b)}${it.sz ? ' · ' + esc(it.sz) : ''} · ${esc(it.st)}</div></div>
        <div class="num"><b>${money(it.p)}</b><div class="m">${it.f} likes</div></div></a></li>`).join('')}</ul>`;
  $('drawer').hidden = false; $('backdrop').hidden = false;
  pageRoots().forEach((r) => { if (r) r.inert = true; });
  if (wasHidden || !$('drawer').contains(document.activeElement)) {
    // 1re ouverture : le focus entre dans la fiche ; mise à jour (profil chargé) : on garde le bouton actif
    ($('drawer').querySelector(keep ? `[data-a="${keep}"]` : '.x') || $('drawer').querySelector('.x')).focus();
  }
}

$('drawer').onclick = (e) => {
  if (e.target.closest('.x')) return closeDrawer();
  const a = e.target.closest('[data-a]');
  if (a && a.dataset.a === 'filter') { S.extra.owner = drawerOwner; closeDrawer(); setTab('items'); runQuery(); return; }
  if (a && a.dataset.a === 'profile') { chrome.runtime.sendMessage({ type: 'vtl:profiles', owners: [drawerOwner] }); a.textContent = 'Chargement…'; a.disabled = true; announce('Chargement du profil du vendeur.'); }
};
// Piège à focus de secours : Tab / Maj+Tab restent dans la fiche
$('drawer').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const f = [...$('drawer').querySelectorAll('a[href], button:not([disabled])')];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
$('s-profiles').onclick = () => {
  const owners = S.sellers.slice(0, 40).map((s) => s.o);
  if (inExt && owners.length) chrome.runtime.sendMessage({ type: 'vtl:profiles', owners });
};

// ----------------------------------------------------------------- produits
const loadProducts = () => worker.postMessage({ t: 'products', id: 1 });
let productsList = [];
function renderProducts(list) {
  productsList = list;
  if (!list.length) { $('products-table').innerHTML = '<tr><td class="empty">Aucun produit présent chez plusieurs vendeurs.</td></tr>'; return; }
  $('products-table').innerHTML = `<caption class="sr-only">Produits présents chez plusieurs vendeurs</caption><thead><tr><th scope="col">Produit (exemple)</th><th scope="col" class="num">Vendeurs</th><th scope="col" class="num">Annonces</th><th scope="col" class="num">Prix</th><th scope="col" class="num">Likes cumulés</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>` +
    list.map((p, i) => `<tr><td class="wrap">${esc(p.title)}</td><td class="num"><span class="badge">${p.sellers}</span></td><td class="num">${p.n}</td>
      <td class="num">${money(p.pmin)}${p.pmax !== p.pmin ? ' – ' + money(p.pmax) : ''}</td><td class="num">${p.likes}</td>
      <td><button type="button" class="btn small" data-i="${i}" aria-label="Voir les annonces du produit : ${esc(p.title)}">Voir</button></td></tr>`).join('') + '</tbody>';
}
$('products-table').onclick = (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  S.extra.sig = productsList[+b.dataset.i].sig; setTab('items'); runQuery();
};

// -------------------------------------------------------------------- onglets
const TABS = ['overview', 'items', 'sellers', 'products'];
function setTab(t, focus = false) {
  S.tab = t;
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => {
    const on = b.dataset.tab === t;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1; // un seul onglet dans l'ordre de tabulation, les autres aux flèches
    if (on && focus) b.focus();
  });
  ['overview', 'items', 'sellers', 'products'].forEach((x) => { $('tab-' + x).hidden = x !== t; });
  if (t === 'overview') renderCharts();
  if (t === 'items') { renderHead(); renderItems(false); }
  if (t === 'sellers') loadSellers();
  if (t === 'products') loadProducts();
}
document.querySelector('.tabs').onclick = (e) => { const t = e.target.dataset.tab; if (t) setTab(t); };
// Navigation clavier du motif "tabs" : flèches gauche/droite (en boucle), Début, Fin
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(document.activeElement.dataset.tab);
  if (i < 0) return;
  const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  setTab(TABS[next], true);
});

// -------------------------------------------------------------------- exports
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('btn-csv').onclick = () => {
  const cols = ['id', 'url', 'titre', 'marque', 'taille', 'etat', 'prix', 'prix_total', 'likes', 'vendeur', 'pro', 'en_demande', 'photo', 'similaires', 'score_vendeur'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [cols.join(';')];
  for (let k = 0; k < S.idx.length; k++) {
    const it = S.items[S.idx[k]];
    lines.push([it.id, VINTED + it.u, q(it.t), q(it.b), q(it.sz), q(it.st), it.p, it.tp, it.f, it.o, it.biz ? 1 : 0, it.d ? 1 : 0, it.th, S.sim[k], S.score[k]].join(';'));
  }
  download(`vinted-${S.sid || 'export'}.csv`, '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
};
$('btn-json').onclick = () => download(`vinted-${S.sid || 'export'}.json`, JSON.stringify(S.items), 'application/json');
$('btn-del').onclick = async () => {
  if (!DB || !S.sid || !confirm('Supprimer définitivement cette session et ses annonces ?')) return;
  await DB.deleteSession(S.sid);
  location.search = '';
};

// ------------------------------------------------------------------ sessions
function setStatus(txt, live) { const s = $('status'); s.textContent = txt; s.classList.toggle('live', !!live); }

async function loadSession(sid) {
  S.sid = sid;
  const sess = DB ? await DB.getSession(sid) : { status: 'done' };
  S.items = DB ? await DB.getItems(sid) : S.items;
  worker.postMessage({ t: 'load', items: S.items });
  setStatus(sess && sess.status === 'running' ? `● collecte en cours · ${nf.format(S.items.length)}` : `${nf.format(S.items.length)} annonces`, sess && sess.status === 'running');
}

let appendTimer;
function listen() {
  const bc = new BroadcastChannel('vtl');
  bc.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'items' && m.sid === S.sid) {
      S.items.push(...m.items); S.pendingAppend.push(...m.items);
      setStatus(`● collecte en cours · ${nf.format(S.items.length)}`, true);
      clearTimeout(appendTimer);
      appendTimer = setTimeout(() => { worker.postMessage({ t: 'append', items: S.pendingAppend }); S.pendingAppend = []; }, 1200);
    } else if (m.type === 'done' && m.sid === S.sid) setStatus(`${nf.format(S.items.length)} annonces`, false);
    else if (m.type === 'profile') worker.postMessage({ t: 'profile', profile: m.profile });
    else if (m.type === 'profile-progress') $('s-progress').textContent = m.total ? `profils ${m.done}/${m.total}…` : '';
  };
}

async function init() {
  renderHead();
  // Mode démo (développement) : uniquement hors extension, depuis un serveur local, et seulement
  // une URL de même origine. Dans l'extension installée, un lien ?demo=... ne peut rien charger.
  if (params.get('demo') && !inExt && new URL(params.get('demo'), location.href).origin === location.origin) {
    S.items = await (await fetch(params.get('demo'))).json();
    S.sid = 'demo';
    worker.postMessage({ t: 'load', items: S.items });
    setStatus(`démo · ${nf.format(S.items.length)} annonces`, false);
    $('session').innerHTML = '<option>Démo</option>';
    if (params.get('tab')) setTab(params.get('tab'));
    return;
  }
  const sessions = DB ? await DB.listSessions() : [];
  $('session').innerHTML = sessions.length
    ? sessions.map((s) => `<option value="${esc(s.sid)}">${esc(new Date(s.startedAt).toLocaleString('fr-FR'))} — ${esc(s.label || 'recherche')} (${nf.format(s.count || 0)})</option>`).join('')
    : '<option>Aucune collecte</option>';
  const sid = params.get('sid') || (sessions[0] && sessions[0].sid);
  if (!sid) { $('kpis').innerHTML = '<div class="empty" style="grid-column:1/-1">Aucune collecte. Ouvre une recherche sur vinted.fr et clique sur « Analyser ».</div>'; return; }
  $('session').value = sid;
  $('session').onchange = () => { location.search = '?sid=' + $('session').value; };
  listen();
  await loadSession(sid);
}
init();
