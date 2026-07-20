---
feat: link dedicat „📥 Primite" în sidebar (Navigare app), cu bădge de documente neconfirmate
target_branch: develop
model_suggested: Sonnet 5 (pattern deja stabilit, de oglindit — Registratură/Setări)
risk: SCĂZUT (adăugire aditivă în componentă partajată, pattern deja folosit de 2 ori)
version: 3.9.615 → 3.9.616
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Scop
„Primite" (documente repartizate ție, cu confirmare de luare la cunoștință) merită vizibilitate
de prim rang, nu doar un tab ascuns în pagina de Notificări — sunt documente care necesită
acțiune, nu alerte efemere. Adaugă un link dedicat în sidebar, sub „Navigare app", lângă
„Fluxurile mele"/„Registratură", cu un bădge care arată câte sunt neconfirmate. NU construim o
pagină nouă — link-ul duce la interfața deja existentă (`/notifications.html?tab=primite`,
funcțională din promptul 28/36), doar cu prezență permanentă în navigare.

# 🚫 NO-TOUCH
`listReceivedFor`/`acknowledgeReceipt` din `flow-transmit.mjs` — doar consumate (o interogare
nouă de COUNT, aditivă). Restul injectărilor din `df-shell.js` (Setări, Registratură) —
neschimbate, doar oglindite ca pattern.

# Etapa 0 — caracterizare
```bash
sed -n '88,116p' public/js/df-shell.js
grep -n "router.get('/api/my-received'" server/routes/flows/transmit.mjs
grep -n "async function listReceivedFor" server/services/flow-transmit.mjs
grep -n "df-nav-label\|df-nav-group\|df-nav-item" public/*.html | head -5
```

# Implementare — BACKEND

## 1. `server/services/flow-transmit.mjs` — nouă funcție `countUnacknowledgedFor` (ADITIVĂ)
NU modifica `listReceivedFor` — adaugă o funcție separată, query mai ieftin (doar COUNT):
```js
export async function countUnacknowledgedFor(pool, userId, actorComp) {
  const comp = (actorComp || '').trim();
  const { rows } = await pool.query(
    `SELECT count(DISTINCT fr.flow_id) AS count
       FROM flow_recipients fr
       JOIN flows f ON f.id = fr.flow_id AND f.deleted_at IS NULL
       LEFT JOIN flow_recipient_acks ack ON ack.flow_id = fr.flow_id AND ack.user_id = $1
      WHERE (fr.recipient_user_id = $1 OR ($2 <> '' AND TRIM(fr.recipient_compartiment) = $2))
        AND ack.acknowledged_at IS NULL`,
    [userId, comp]
  );
  return Number(rows[0]?.count || 0);
}
```

## 2. `server/routes/flows/transmit.mjs` — endpoint nou `GET /api/my-received/count`
Oglindește authz-ul de la `GET /api/my-received` (aceeași `requireAuth` + `loadActorComp`),
dar folosește `countUnacknowledgedFor`:
```js
router.get('/api/my-received/count', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const comp = await loadActorComp(pool, actor.userId || actor.id);
    const count = await countUnacknowledgedFor(pool, actor.userId || actor.id, comp);
    res.json({ count });
  } catch (e) {
    logger.error({ err: e }, '/api/my-received/count error');
    res.status(500).json({ error: 'server_error' });
  }
});
```
(Import `countUnacknowledgedFor` alături de restul importurilor din `flow-transmit.mjs` deja
prezente în acest fișier.) Adaugă ruta ÎNAINTE sau DUPĂ `GET /api/my-received` existent, la
alegere — nu contează ordinea, doar să fie pe același router.

# Implementare — FRONTEND (`public/js/df-shell.js`)

## 3. Injectare link „📥 Primite" — pattern IDENTIC cu Registratură
Adaugă un nou bloc `document.addEventListener('DOMContentLoaded', ...)`, imediat după cel al
Registraturii (sau consolidat în același, la alegerea ta — dar păstrează idempotența):
```js
document.addEventListener('DOMContentLoaded', function() {
  var labels = document.querySelectorAll('.df-nav-label');
  var navGroup = null;
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].textContent.trim() === 'Navigare app') {
      var sib = labels[i].nextElementSibling;
      if (sib && sib.classList.contains('df-nav-group')) { navGroup = sib; break; }
    }
  }
  if (!navGroup) return;
  if (navGroup.querySelector('a[href^="/notifications.html?tab=primite"]')) return; // idempotent

  var a = document.createElement('a');
  a.href = '/notifications.html?tab=primite';
  a.className = 'df-nav-item';
  var path = (location.pathname || '').replace(/\/$/, '');
  var qs = location.search || '';
  if (path === '/notifications' || path === '/notifications.html') {
    if (qs.includes('tab=primite')) a.classList.add('active');
  }
  a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><path d="M21 8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M2 8l10 6 10-6"/><path d="M22 8l-10-6L2 8"/></svg> <span>Primite</span> <span class="df-nav-badge" id="primiteBadgeCount" style="display:none;margin-left:auto;background:rgba(124,92,255,.35);color:#c4b5fd;border-radius:9px;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:800;padding:0 5px;"></span>';
  navGroup.appendChild(a);

  // Bădge cu numărul de documente neconfirmate — doar dacă există sesiune activă
  var hasSession = !!localStorage.getItem('docflow_user') || !!localStorage.getItem('docflow_token');
  if (hasSession) {
    fetch('/api/my-received/count', { credentials: 'include' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d || !d.count) return;
        var badge = document.getElementById('primiteBadgeCount');
        if (badge) { badge.textContent = String(d.count); badge.style.display = 'inline-flex'; }
      })
      .catch(function() {});
  }
});
```
IMPORTANT: span-ul cu `style="display:none"` inline urmat de `style="...display:inline-flex..."`
în același atribut e o eroare — ultima valoare din `style=""` câștigă. Scrie corect: badge-ul
pornește ASCUNS (`display:none` ca stil implicit în `innerHTML`), iar JS-ul de mai sus îi
schimbă `style.display = 'inline-flex'` DOAR când există count > 0. Nu pune ambele valori în
același atribut `style` string — folosește un singur `display:none;` inițial în markup, restul
proprietăților (background, color, etc.) rămân, iar JS-ul schimbă doar `.style.display` la runtime.

# Verificare manuală
- Link „📥 Primite" apare în sidebar, sub „Navigare app", pe orice pagină autentificată
  (`flow.html`, `semdoc-initiator.html`, `notifications.html`, etc.).
- Dacă ai ≥1 document neconfirmat → bădge vizibil cu numărul corect.
- Dacă ai 0 → bădge ascuns (fără „0" afișat inutil).
- Click pe link → deschide `/notifications.html?tab=primite`, tabul corect activ.
- Reîncarci pagina de mai multe ori → link-ul apare O SINGURĂ DATĂ (idempotent, nu duplicat).

`npm test verde, fără regresii`. `npm run check` OK.

# Teste — `server/tests/db/flow-received-count.test.mjs` (server/tests/db/**, auto-skip fără TEST_DATABASE_URL)
- User cu 2 repartizări neconfirmate → `count: 2`.
- Confirmă una → `count: 1`.
- User fără nicio repartizare → `count: 0`.
- Anonim → 401.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/services/flow-transmit.mjs`, `server/routes/flows/transmit.mjs`, `public/js/df-shell.js`, `server/tests/db/flow-received-count.test.mjs` (nou), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|alop\.mjs|flow-access\.mjs" && echo "⛔ STOP" || echo "✅ NO-TOUCH ok"
git diff server/services/flow-transmit.mjs | grep -nE "^-.*(listReceivedFor|acknowledgeReceipt|transmitFlowTo|isFlowRecipient|normalizeRecipients|resolveRecipientEmails)" && echo "⛔ ai modificat funcții existente!" || echo "✅ doar adăugiri"
```

# Cache busting + versiune
- bump `package.json` 3.9.615 → 3.9.616;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.616` pe `df-shell.js` în TOATE HTML-urile care-l includ (verifică lista din Etapa 0).

# La final
```bash
git add server/services/flow-transmit.mjs server/routes/flows/transmit.mjs public/js/df-shell.js server/tests/db/flow-received-count.test.mjs public/sw.js package.json public/*.html
git commit -m "feat(nav): link dedicat Primite în sidebar cu bădge de neconfirmate (v3.9.616)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Link injectat idempotent, pe pattern identic cu Registratură; bădge corect (ascuns la 0).
2. Endpoint nou `/api/my-received/count`; `listReceivedFor` etc. neatinse (guardrail verde).
3. Status CI (`npm test` + `npm run check`); versiune 3.9.616.
4. Confirmare vizuală pe staging: link vizibil pe minim 2-3 pagini diferite, bădge corect.
