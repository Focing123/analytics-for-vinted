/**
 * Parseur des pages Vinted.
 *
 * Chaque page de résultats embarque toutes les annonces dans des blocs JSON
 * `self.__next_f.push([1,"..."])`. On les lit directement (aucun DOM à construire) :
 * c'est 10 à 50 fois plus rapide que de parser le HTML de la grille, et ça donne
 * des champs que les cartes n'affichent pas (vendeur, prix total, badges…).
 */
(() => {
  const SEP = '\\"productItem\\":{\\"id\\":';
  // Un même JSON peut être coupé entre deux blocs push : on recolle avant de lire.
  const BOUNDARY = /"\]\)<\/script><script>self\.__next_f\.push\(\[1,"/g;

  const RE = {
    head: /^(\d+),\\"title\\":\\"(.*?)\\",\\"url\\":\\"([^\\]*)\\"/,
    fav: /\\"favouriteCount\\":(\d+)/,
    price: /\\"price\\":\{\\"amount\\":\\"([\d.]+)\\"/,
    total: /\\"totalItemPrice\\":\{\\"amount\\":\\"([\d.]+)\\"/,
    promoted: /\\"isPromoted\\":(true|false)/,
    thumb: /\\"thumbnailUrl\\":\\"(https:[^\\]*)\\"/,
    user: /\\"user\\":\{\\"id\\":(\d+),.{0,600}?\\"isBusiness\\":(true|false)/,
    box: /\\"firstLine\\":\\"(.*?)\\",\\"secondLine\\":\\"(.*?)\\",\\"exposure/,
    label: /\\"accessibilityLabel\\":\\"(.*?)\\",\\"badge\\":(.*?),\\"actions\\"/,
    exposures: /\\"exposures\\":(.*?),\\"ffExposures\\"/,
    owner: /\\"ownerId\\":(\d+)/,
    score: /\\"searchScore\\":([\d.eE-]+)/,
    photoKey: /\/t\/([^/]+)\//,
    brand: /Marque: ([^,]+)/,
    state: /État: ([^,]+)/,
    size: /Taille: ([^,]+)/,
  };

  const BS = String.fromCharCode(92);
  const decode = (s) =>
    s
      .split(BS + BS + BS + '"').join('"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .split(BS + BS + BS + BS).join(BS);
  const first = (re, s) => { const m = re.exec(s); return m ? m[1] : ''; };
  // Défense en profondeur : ces valeurs finissent dans des href / src du dashboard.
  // On n'accepte que des chemins d'annonce et des images hébergées par Vinted
  // (évite par ex. "@evil.com" collé derrière le domaine pour détourner un lien).
  const safePath = (u, id) => (/^\/items\/\d+[\w%.~-]*$/.test(u) ? u : '/items/' + id);
  const safeImg = (u) => (/^https:\/\/[a-z0-9.-]+\.vinted\.(net|com|fr)\//i.test(u) ? u : '');
  const clean = (v) => (v && v.indexOf('$undefined') === -1 && v !== 'null' && v !== '[]' ? decode(v.replace(/^\\"|\\"$/g, '')) : '');

  /** @returns {Array<object>} annonces au format compact */
  function parsePage(html) {
    const parts = html.replace(BOUNDARY, '').split(SEP);
    const out = [];
    for (let i = 1; i < parts.length; i++) {
      let c = parts[i];
      const end = c.indexOf('\\"searchSignals\\"');
      c = end > 0 ? c.slice(0, end + 40) : c.slice(0, 9000);

      const head = RE.head.exec(c);
      if (!head) continue;
      const owner = first(RE.owner, c);
      const user = RE.user.exec(c);
      const box = RE.box.exec(c);
      const label = RE.label.exec(c);
      const lab = label ? decode(label[1]) : '';
      const thumb = safeImg(first(RE.thumb, c));
      const boxStart = c.indexOf('\\"itemBox\\"');
      const boxText = boxStart >= 0 ? c.slice(boxStart) : '';
      const badge = label ? clean(label[2]) : '';
      const expo = clean(first(RE.exposures, c));

      out.push({
        id: head[1],
        t: decode(head[2]),
        u: safePath(head[3], head[1]),
        f: +first(RE.fav, c) || 0,
        p: +first(RE.price, c) || 0,
        tp: +first(RE.total, c) || 0,
        o: owner || (user ? user[1] : ''),
        biz: user ? user[2] === 'true' : false,
        pr: first(RE.promoted, c) === 'true',
        th: thumb,
        pk: first(RE.photoKey, thumb),
        b: first(RE.brand, lab) || (box ? decode(box[1]) : ''),
        st: first(RE.state, lab) || (box ? decode(box[2]) : ''),
        sz: first(RE.size, lab),
        d: /en\s+demande/i.test(boxText),
        bd: badge,
        ex: expo,
        sc: +first(RE.score, c) || 0,
      });
    }
    return out;
  }

  globalThis.VTL = Object.assign(globalThis.VTL || {}, { parsePage });
})();
