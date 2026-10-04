import * as DB from '../lib/db.js';

const bc = new BroadcastChannel('vtl');
const DASH = chrome.runtime.getURL('dashboard/dashboard.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openDashboard(sid) {
  const url = DASH + (sid ? `?sid=${encodeURIComponent(sid)}` : '');
  const [tab] = await chrome.tabs.query({ url: DASH + '*' });
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(async () => {
  const [last] = await DB.listSessions();
  openDashboard(last && last.sid);
});

// --- Profils vendeurs (lus depuis la page /member/ID) ------------------------
let profileJob = false;
async function fetchProfile(owner) {
  const res = await fetch(`https://www.vinted.fr/member/${owner}`, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const t = await res.text();
  const i = t.indexOf(`\\"id\\":${owner},\\"anon_id`);
  if (i < 0) throw new Error('profil introuvable');
  const seg = t.slice(i, i + 6000);
  const num = (k) => { const m = seg.match(new RegExp(`\\\\"${k}\\\\":(\\d+)`)); return m ? +m[1] : null; };
  return {
    o: String(owner),
    login: (seg.match(/\\"login\\":\\"([^\\]*)\\"/) || [])[1] || '',
    feedback: num('feedback_count'),
    items: num('item_count'),
    total: num('total_items_count'),
    followers: num('followers_count'),
    business: /\\"business\\":true/.test(seg),
    locale: (seg.match(/\\"iso_locale_code\\":\\"([^\\]*)\\"/) || [])[1] || '',
    at: Date.now(),
  };
}

async function fetchProfiles(owners) {
  if (profileJob) return;
  profileJob = true;
  try {
    const cached = new Map((await DB.getProfiles()).map((p) => [p.o, p]));
    let done = 0;
    for (const o of owners) {
      const c = cached.get(String(o));
      if (c && Date.now() - c.at < 86400000) { bc.postMessage({ type: 'profile', profile: c }); continue; }
      try {
        const p = await fetchProfile(o);
        await DB.putProfile(p);
        bc.postMessage({ type: 'profile', profile: p });
      } catch (e) { /* un profil en échec n'arrête pas le lot */ }
      bc.postMessage({ type: 'profile-progress', done: ++done, total: owners.length });
      await sleep(700);
    }
  } finally { profileJob = false; bc.postMessage({ type: 'profile-progress', done: 0, total: 0 }); }
}

// --- Messages du crawler et du dashboard -------------------------------------
const SID = /^[a-z0-9]{1,16}$/;
const ID = /^\d{1,20}$/;

async function handle(msg) {
  // Entrées validées : un message mal formé ne doit ni toucher la base ni construire d'URL.
  if (msg.sid !== undefined && !SID.test(String(msg.sid))) throw new Error('sid invalide');
  if (msg.type === 'vtl:items' && !Array.isArray(msg.items)) throw new Error('items invalides');
  if (msg.type === 'vtl:profiles') msg.owners = (Array.isArray(msg.owners) ? msg.owners : []).map(String).filter((o) => ID.test(o)).slice(0, 100);
  switch (msg.type) {
    case 'vtl:start':
      await DB.createSession({ sid: msg.sid, ...msg.meta, startedAt: Date.now(), status: 'running', count: 0 });
      if (!msg.meta.noOpen) await openDashboard(msg.sid);
      return { ok: true };
    case 'vtl:items':
      await DB.putItems(msg.sid, msg.items);
      bc.postMessage({ type: 'items', sid: msg.sid, items: msg.items });
      return { ok: true };
    case 'vtl:done': {
      const count = await DB.countItems(msg.sid);
      await DB.updateSession(msg.sid, { status: msg.status || 'done', endedAt: Date.now(), count, stats: msg.stats });
      bc.postMessage({ type: 'done', sid: msg.sid, count });
      return { ok: true, count };
    }
    case 'vtl:count':
      return { count: await DB.countItems(msg.sid) };
    case 'vtl:open':
      await openDashboard(msg.sid);
      return { ok: true };
    case 'vtl:profiles':
      fetchProfiles(msg.owners);
      return { ok: true };
    case 'vtl:sleep': // les timers d'un onglet en arrière-plan sont bridés : on délègue l'attente ici
      await sleep(Math.min(60000, Math.max(0, Number(msg.ms) || 0)));
      return { ok: true };
    default:
      return { error: 'message inconnu' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (sender.id !== chrome.runtime.id) return false; // uniquement les scripts de cette extension
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vtl:')) return false;
  handle(msg).then(send, (e) => send({ error: String(e) }));
  return true;
});
