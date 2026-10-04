/**
 * Crawler : lit les pages de résultats Vinted et envoie les annonces au service worker.
 *
 * - Requêtes même origine (cookies de la session de l'utilisateur), parsées sans DOM.
 * - Pool de requêtes adaptatif : ralentit seul si Vinted répond 429/403, ré-accélère ensuite.
 * - Vinted plafonne chaque recherche à 10 pages (~960 annonces) : le mode MAX+ découpe
 *   la recherche en tranches de prix (dichotomie) puis en tris différents si une tranche
 *   reste saturée, et fusionne tout.
 */
(() => {
  if (window.__vtlLoaded) return;
  window.__vtlLoaded = true;
  const { parsePage } = globalThis.VTL;

  const MAX_PAGES = 10;
  const PAGE_SIZE = 96;
  const SATURATED = MAX_PAGES * PAGE_SIZE - 10;
  const MAX_PRICE = 10000;
  const MAX_CONCURRENCY = 5;
  const EXTRA_ORDERS = ['price_low_to_high', 'price_high_to_low', 'newest_first', 'relevance'];

  // ---------------------------------------------------------------- messagerie
  const send = (msg) =>
    new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); }); }
      catch (e) { resolve(null); }
    });
  // Les timers d'un onglet masqué sont bridés par Chrome : on délègue l'attente au service worker.
  const sleep = async (ms) => { const r = await send({ type: 'vtl:sleep', ms }); if (!r) await new Promise((x) => setTimeout(x, ms)); };

  // ------------------------------------------------------------------- widget
  const root = document.createElement('div');
  root.id = 'vtl-widget';
  root.innerHTML = `
    <div class="vtl-head"><b>Analytics for Vinted</b><button id="vtl-min" title="Réduire">–</button></div>
    <div class="vtl-body">
      <label>Volume
        <select id="vtl-mode">
          <option value="1">Page actuelle</option>
          <option value="5">5 pages (~480)</option>
          <option value="10">10 pages (~960, limite Vinted)</option>
          <option value="split" selected>MAX+ (découpe par prix)</option>
        </select>
      </label>
      <div class="vtl-row">
        <label>Prix min <input id="vtl-pmin" type="number" min="0" placeholder="€"></label>
        <label>Prix max <input id="vtl-pmax" type="number" min="0" placeholder="€"></label>
      </div>
      <div class="vtl-bar"><i id="vtl-fill"></i></div>
      <div id="vtl-stat">Prêt.</div>
      <div class="vtl-row">
        <button id="vtl-go" class="vtl-primary">Analyser</button>
        <button id="vtl-stop" hidden>Stop</button>
        <button id="vtl-open">Dashboard</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const $ = (id) => root.querySelector('#' + id);
  $('vtl-min').onclick = () => root.classList.toggle('vtl-collapsed');
  $('vtl-open').onclick = () => send({ type: 'vtl:open', sid: lastSid });

  // --------------------------------------------------------------------- état
  let lastSid = null;
  let stopped = false;
  let running = false;
  const stats = { items: 0, requests: 0, errors: 0, ranges: 0, pending: 0, t0: 0 };
  let pauseUntil = 0;
  let concurrency = 3;
  let okStreak = 0;

  function render() {
    const s = (Date.now() - stats.t0) / 1000 || 1;
    $('vtl-stat').textContent =
      `${stats.items.toLocaleString('fr-FR')} annonces · ${stats.requests} requêtes · ` +
      `${(stats.items / s).toFixed(0)}/s` + (stats.errors ? ` · ${stats.errors} erreurs` : '') +
      (stats.pending ? ` · ${stats.pending} tranches en attente` : '');
    $('vtl-fill').style.width = running ? '100%' : '0';
  }

  // ------------------------------------------------------------------- réseau
  function pageUrl(page, o) {
    const u = new URL(location.href);
    u.hash = '';
    u.searchParams.delete('search_id'); // lié à une session : peut limiter les résultats
    u.searchParams.set('page', page);
    if (o.from != null) u.searchParams.set('price_from', o.from);
    if (o.to != null) u.searchParams.set('price_to', o.to);
    if (o.order) u.searchParams.set('order', o.order);
    return u.toString();
  }

  async function getPage(page, o) {
    const url = pageUrl(page, o);
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = pauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        stats.requests++;
        const res = await fetch(url, { credentials: 'include' });
        if (res.status === 429 || res.status === 403) {
          pauseUntil = Date.now() + 8000 * (attempt + 1); // pause globale : tous les workers attendent
          concurrency = 1; okStreak = 0;
          throw new Error('HTTP ' + res.status);
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const items = parsePage(await res.text());
        if (!items.length && page === 1 && attempt < 2) throw new Error('page vide');
        if (++okStreak % 8 === 0 && concurrency < MAX_CONCURRENCY) concurrency++;
        return items;
      } catch (e) {
        stats.errors++;
        stats.lastError = e.message;
        $('vtl-stat').title = 'Dernière erreur : ' + e.message;
        if (attempt === 4) throw e;
        await sleep(2500 * (attempt + 1));
      }
    }
  }

  const seen = new Set();
  async function emit(sid, items) {
    const fresh = items.filter((it) => !seen.has(it.id));
    fresh.forEach((it) => seen.add(it.id));
    if (!fresh.length) return;
    stats.items = seen.size;
    await send({ type: 'vtl:items', sid, items: fresh });
    render();
  }

  /** Charge les pages 1..10 d'une tranche avec un pool de workers. @returns {received, failed} */
  async function loadRange(sid, o, maxPages = MAX_PAGES) {
    let received = 0, failed = false, next = 1, last = maxPages;
    async function worker(slot) {
      while (!stopped && next <= last) {
        if (slot >= concurrency) { await sleep(400); continue; }
        const p = next++;
        try {
          const items = await getPage(p, o);
          received += items.length;
          await emit(sid, items);
          if (items.length < PAGE_SIZE * 0.9) last = Math.min(last, p); // dernière page
        } catch (e) { failed = true; last = 0; }
        await sleep(150);
      }
    }
    await Promise.all(Array.from({ length: MAX_CONCURRENCY }, (_, i) => worker(i)));
    return { received, failed };
  }

  // ----------------------------------------------------------------- scénarios
  async function crawl(sid, mode, pmin, pmax) {
    if (mode !== 'split') {
      await loadRange(sid, { from: pmin, to: pmax }, parseInt(mode, 10));
      return;
    }
    const url = new URL(location.href);
    const from0 = pmin ?? (parseFloat(url.searchParams.get('price_from')) || 0);
    const to0 = pmax ?? (parseFloat(url.searchParams.get('price_to')) || MAX_PRICE);
    const queue = [{ from: from0, to: to0, order: null, tries: 0 }];
    while (queue.length && !stopped) {
      stats.pending = queue.length;
      const job = queue.shift();
      stats.ranges++;
      const { received, failed } = await loadRange(sid, job);
      if (failed) {
        if (job.tries < 3) { await sleep(10000); queue.push({ ...job, tries: job.tries + 1 }); }
      }
      if (received >= SATURATED && job.order === null) {
        if (job.to - job.from > 1) {
          const m = Math.floor((job.from + job.to) / 2); // chevauchement voulu : les doublons sont ignorés
          queue.push({ from: job.from, to: m, order: null, tries: 0 }, { from: m, to: job.to, order: null, tries: 0 });
        } else {
          for (const order of EXTRA_ORDERS) queue.push({ from: job.from, to: job.to, order, tries: 0 });
        }
      }
    }
    stats.pending = 0;
  }

  async function start(opts = {}) {
    if (running) return;
    running = true; stopped = false;
    seen.clear();
    Object.assign(stats, { items: 0, requests: 0, errors: 0, ranges: 0, pending: 0, t0: Date.now() });
    concurrency = 3; okStreak = 0; pauseUntil = 0;
    const mode = opts.mode || $('vtl-mode').value;
    const num = (id) => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
    const pmin = num('vtl-pmin'), pmax = num('vtl-pmax');
    const sid = Date.now().toString(36);
    lastSid = sid;
    const u = new URL(location.href);
    ['page', 'search_id'].forEach((k) => u.searchParams.delete(k));

    $('vtl-go').hidden = true; $('vtl-stop').hidden = false;
    const timer = setInterval(render, 400);
    await send({
      type: 'vtl:start', sid,
      meta: { url: u.toString(), label: document.title.replace(/\s*\|\s*Vinted.*/, ''), mode, pmin, pmax, noOpen: !!opts.noOpen },
    });
    try { await crawl(sid, mode, pmin, pmax); }
    catch (e) { console.warn('[Analytics for Vinted]', e); }
    const done = await send({ type: 'vtl:done', sid, status: stopped ? 'stopped' : 'done', stats: { ...stats, ms: Date.now() - stats.t0 } });
    clearInterval(timer);
    running = false;
    $('vtl-go').hidden = false; $('vtl-stop').hidden = true;
    render();
    $('vtl-stat').textContent += stopped ? ' · arrêté' : ' · terminé';
    return { sid, stored: done && done.count };
  }

  $('vtl-go').onclick = () => start();
  $('vtl-stop').onclick = () => { stopped = true; };

  // Aucune collecte ne démarre sans un clic de l'utilisateur sur « Analyser » :
  // ni paramètre d'URL ni script de la page ne peut la déclencher.
})();
