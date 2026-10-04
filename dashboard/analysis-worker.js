/**
 * Worker d'analyse : tout le calcul lourd (filtres, tris, agrégats, clustering de vendeurs)
 * tourne ici pour que l'interface reste fluide même avec des dizaines de milliers d'annonces.
 */
'use strict';

const STOP = new Set(['avec', 'pour', 'dans', 'tres', 'etat', 'neuf', 'neuve', 'new', 'the', 'and', 'des', 'les', 'une', 'pas', 'sur', 'lot', 'taille']);
const ACCENTS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
const RECENT_OWNER_ID = 3e9; // IDs > 3 milliards = comptes très récents (constaté en pratique)

let items = [];
let profiles = new Map();
let clusterSize = new Uint16Array(0);
let ownerScore = new Float32Array(0);
let sigs = [];
let sellers = [];
let products = [];

const tokenize = (title) =>
  (title || '').toLowerCase().normalize('NFD').replace(ACCENTS, '').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((t) => t.length >= 3 && !STOP.has(t));

function similar(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (inter < 2) return false; // un seul mot commun ("jeu", "coque"…) = trop vague
  return inter / (a.size + b.size - inter) >= 0.6;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
}

// ------------------------------------------------------------------ analyse
function scoreSeller(s) {
  const p = profiles.get(s.o);
  let score = 3 * (s.sim - 1) + Math.min(s.n - 1, 10) + (s.samePrice ? 2 : 0) + (s.dupPhoto ? 3 : 0) + (s.recent ? 2 : 0);
  if (p) {
    if (p.total != null && p.total >= 10 && p.feedback != null && p.feedback < 10) score += 3;
    if (p.business) score += 1;
  }
  return score;
}

function compute() {
  const n = items.length;
  const tokens = new Array(n);
  sigs = new Array(n);
  clusterSize = new Uint16Array(n);
  const byOwner = new Map();
  for (let i = 0; i < n; i++) {
    const t = tokenize(items[i].t);
    tokens[i] = new Set(t);
    sigs[i] = t.length >= 2 ? [...tokens[i]].sort().join(' ') : '';
    const o = items[i].o;
    let a = byOwner.get(o);
    if (!a) byOwner.set(o, (a = []));
    a.push(i);
  }

  sellers = [];
  for (const [o, list] of byOwner) {
    const m = list.length;
    let best = 1, bestRoot = 0, root = null;
    const parent = new Int32Array(m).map((_, k) => k);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { parent[find(a)] = find(b); };
    if (m >= 2) {
      if (m <= 300) {
        for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) if (similar(tokens[list[i]], tokens[list[j]])) union(i, j);
      } else { // gros vendeur : regroupement par signature (linéaire)
        const g = new Map();
        list.forEach((ix, k) => { const s = sigs[ix]; if (!s) return; if (g.has(s)) union(k, g.get(s)); else g.set(s, k); });
      }
      const sizes = new Map();
      for (let k = 0; k < m; k++) { const r = find(k); sizes.set(r, (sizes.get(r) || 0) + 1); }
      root = new Int32Array(m);
      for (let k = 0; k < m; k++) {
        const r = find(k); root[k] = r;
        const sz = sizes.get(r);
        clusterSize[list[k]] = sz;
        if (sz > best) { best = sz; bestRoot = r; }
      }
    } else clusterSize[list[0]] = 1;

    const members = root ? list.filter((_, k) => root[k] === bestRoot) : [list[0]];
    const photos = new Map();
    let dup = 0, likes = 0;
    for (const ix of list) {
      likes += items[ix].f;
      const pk = items[ix].pk;
      if (pk) { const c = (photos.get(pk) || 0) + 1; photos.set(pk, c); if (c === 2) dup++; }
    }
    const price0 = items[members[0]].p;
    const s = {
      o, n: m, sim: best, likes,
      samePrice: best >= 2 && members.every((ix) => items[ix].p === price0),
      price: price0,
      dupPhoto: dup > 0,
      recent: Number(o) > RECENT_OWNER_ID,
      biz: items[list[0]].biz,
      ex: items[members[0]].t,
      first: members[0],
      mem: best >= 2 ? members.map((ix) => items[ix].id) : [], // annonces du groupe suspect
    };
    s.score = scoreSeller(s);
    sellers.push(s);
  }
  sellers.sort((a, b) => b.score - a.score);
  refreshOwnerScore();

  // Produits présents chez plusieurs vendeurs (même titre normalisé)
  const prod = new Map();
  for (let i = 0; i < n; i++) {
    const sg = sigs[i];
    if (!sg) continue;
    let p = prod.get(sg);
    if (!p) prod.set(sg, (p = { sig: sg, title: items[i].t, sellers: new Set(), n: 0, pmin: Infinity, pmax: 0, likes: 0, first: i }));
    p.sellers.add(items[i].o); p.n++; p.likes += items[i].f;
    p.pmin = Math.min(p.pmin, items[i].p); p.pmax = Math.max(p.pmax, items[i].p);
  }
  products = [...prod.values()].filter((p) => p.sellers.size >= 2).map((p) => ({ ...p, sellers: p.sellers.size }))
    .sort((a, b) => b.sellers - a.sellers || b.n - a.n);
}

function refreshOwnerScore() {
  const map = new Map(sellers.map((s) => [s.o, s.score]));
  ownerScore = new Float32Array(items.length);
  for (let i = 0; i < items.length; i++) ownerScore[i] = map.get(items[i].o) || 0;
}

// ---------------------------------------------------------------- requêtes
function histogram(values, bins, cap) {
  const w = cap / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor(v / w))]++;
  return counts.map((value, i) => ({
    label: `${Math.round(i * w)}–${Math.round((i + 1) * w)}€${i === bins - 1 ? '+' : ''}`, value,
    lo: i * w, hi: i === bins - 1 ? null : (i + 1) * w - 0.01, // bornes pour filtrer au clic
  }));
}

const LIKE_BINS = [[0, 0, '0'], [1, 1, '1'], [2, 2, '2'], [3, 5, '3–5'], [6, 10, '6–10'], [11, 20, '11–20'], [21, 50, '21–50'], [51, 100, '51–100'], [101, Infinity, '100+']];
const AGE_BINS = [[0, 1e7, '< 10 M'], [1e7, 5e7, '10–50 M'], [5e7, 1e8, '50–100 M'], [1e8, 2e8, '100–200 M'], [2e8, 1e9, '200 M–1 Md'], [1e9, 3e9, '1–3 Md'], [3e9, Infinity, '≥ 3 Md (récents)']];

function topBy(map, k, valueOf) {
  return [...map.entries()].map(([label, v]) => ({ label, value: valueOf(v), extra: v })).sort((a, b) => b.value - a.value).slice(0, k);
}

function query(F, sort) {
  const q = (F.q || '').toLowerCase();
  const brand = (F.brand || '').toLowerCase();
  const state = (F.state || '').toLowerCase();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (F.pmin != null && it.p < F.pmin) continue;
    if (F.pmax != null && it.p > F.pmax) continue;
    if (F.lmin != null && it.f < F.lmin) continue;
    if (F.lmax != null && it.f > F.lmax) continue;
    if (F.demand && !it.d) continue;
    if (F.biz && !it.biz) continue;
    if (F.owner && it.o !== F.owner) continue;
    if (F.sig && sigs[i] !== F.sig) continue;
    if (F.minSim && clusterSize[i] < F.minSim) continue;
    if (brand && it.b.toLowerCase() !== brand) continue;
    if (state && it.st.toLowerCase() !== state) continue;
    if (q && it.t.toLowerCase().indexOf(q) === -1 && it.b.toLowerCase().indexOf(q) === -1) continue;
    out.push(i);
  }

  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = {
    f: (i) => items[i].f, p: (i) => items[i].p, tp: (i) => items[i].tp, o: (i) => Number(items[i].o),
    score: (i) => ownerScore[i], sim: (i) => clusterSize[i], sc: (i) => items[i].sc,
    t: (i) => items[i].t.toLowerCase(), b: (i) => items[i].b.toLowerCase(), st: (i) => items[i].st,
  }[sort.key];
  const idx = Uint32Array.from(out);
  if (key) idx.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a - b; });

  // agrégats sur la sélection
  const prices = [], likes = [], scatter = [];
  const brands = new Map(), states = new Map(), owners = new Map(), suspects = new Set();
  let demand = 0, value = 0, likeSum = 0;
  const ageCounts = AGE_BINS.map(() => 0), likeCounts = LIKE_BINS.map(() => 0);
  const step = Math.max(1, Math.floor(idx.length / 2500));
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], it = items[i];
    prices.push(it.p); likes.push(it.f); value += it.p; likeSum += it.f;
    if (it.d) demand++;
    if (k % step === 0) scatter.push([it.p, it.f]);
    const b = it.b || '—'; const bs = brands.get(b) || { n: 0, f: 0 }; bs.n++; bs.f += it.f; brands.set(b, bs);
    const st = it.st || '—'; states.set(st, (states.get(st) || 0) + 1);
    owners.set(it.o, (owners.get(it.o) || 0) + 1);
    if (clusterSize[i] >= 2) suspects.add(it.o);
    const idn = Number(it.o);
    for (let a = 0; a < AGE_BINS.length; a++) if (idn >= AGE_BINS[a][0] && idn < AGE_BINS[a][1]) { ageCounts[a]++; break; }
    for (let a = 0; a < LIKE_BINS.length; a++) if (it.f >= LIKE_BINS[a][0] && it.f <= LIKE_BINS[a][1]) { likeCounts[a]++; break; }
  }
  const sortedPrices = Float64Array.from(prices).sort();
  const cap = sortedPrices.length ? Math.max(10, Math.ceil(sortedPrices[Math.floor(sortedPrices.length * 0.98)] / 10) * 10) : 10;

  const agg = {
    priceHist: histogram(prices, 24, cap),
    likesHist: LIKE_BINS.map((b, i) => ({ label: b[2], value: likeCounts[i], lo: b[0], hi: b[1] === Infinity ? null : b[1] })),
    ageHist: AGE_BINS.map((b, i) => ({ label: b[2], value: ageCounts[i] })),
    scatter,
    brands: topBy(brands, 10, (v) => v.n).map((r) => ({ ...r, extra: Math.round(r.extra.f / r.extra.n) })),
    states: topBy(states, 8, (v) => v),
    topSellers: topBy(owners, 10, (v) => v),
  };
  const kpis = {
    n: idx.length, total: items.length, sellers: owners.size,
    median: median(prices), avgLikes: idx.length ? likeSum / idx.length : 0,
    demand, value, suspects: suspects.size,
  };
  // colonnes alignées sur idx : permet au thread principal d'afficher les lignes sans aller-retour
  const sim = new Uint16Array(idx.length), score = new Float32Array(idx.length);
  for (let k = 0; k < idx.length; k++) { sim[k] = clusterSize[idx[k]]; score[k] = ownerScore[idx[k]]; }
  return { idx, sim, score, agg, kpis };
}

function sellerList(o) {
  const q = (o.q || '').toLowerCase();
  const out = [];
  for (const s of sellers) {
    if (s.sim < (o.minSim || 1)) continue;
    if (o.recent && !s.recent) continue;
    if (o.biz && !s.biz) continue;
    const p = profiles.get(s.o);
    if (q && s.o.indexOf(q) === -1 && !(p && p.login.toLowerCase().indexOf(q) !== -1) && s.ex.toLowerCase().indexOf(q) === -1) continue;
    out.push({ ...s, profile: p || null });
    if (out.length >= 500) break;
  }
  return out;
}

// ---------------------------------------------------------------- messages
self.onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case 'load': items = m.items; compute(); self.postMessage({ t: 'loaded', n: items.length }); break;
    case 'append': items = items.concat(m.items); compute(); self.postMessage({ t: 'loaded', n: items.length }); break;
    case 'profile':
      profiles.set(m.profile.o, m.profile);
      for (const s of sellers) if (s.o === m.profile.o) s.score = scoreSeller(s);
      sellers.sort((a, b) => b.score - a.score);
      refreshOwnerScore();
      self.postMessage({ t: 'profile-ok' });
      break;
    case 'query': {
      const r = query(m.filters, m.sort);
      self.postMessage({ t: 'result', id: m.id, idx: r.idx, sim: r.sim, score: r.score, agg: r.agg, kpis: r.kpis },
        [r.idx.buffer, r.sim.buffer, r.score.buffer]);
      break;
    }
    case 'seller': {
      const s = sellers.find((x) => x.o === m.o);
      self.postMessage({ t: 'seller', seller: s ? { ...s, profile: profiles.get(s.o) || null } : null });
      break;
    }
    case 'sellers': self.postMessage({ t: 'sellers', id: m.id, list: sellerList(m.opts) }); break;
    case 'products': self.postMessage({ t: 'products', id: m.id, list: products.slice(0, 150) }); break;
  }
};
