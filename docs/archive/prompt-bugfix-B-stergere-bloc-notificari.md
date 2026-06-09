# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): fișierele de semnare STS. Acest prompt nu le atinge.

---

## Obiectiv — Bug 2: ștergere notificări în bloc, pe categoria curentă

API-ul are delete per-id + read-all, dar nu are bulk-delete. Pagina de notificări are deja categoriile
(toate/necitite/urgente/de-semnat/de-revizuit/finalizate/refuzate/formulare) calculate client în `filtered()`.
Adăugăm: un buton „Șterge afișate" care șterge exact notificările din filtrul curent. **Refolosim
`filtered()` din client** (trimitem ID-urile) → nu dublăm logica de categorii pe server.

---

## Patch 1 — `server/routes/notifications.mjs`: endpoint bulk-delete

Adaugă după ruta `DELETE /api/notifications/:id` (~linia 112).

**old_str**
```
router.delete('/api/notifications/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    await pool.query('DELETE FROM notifications WHERE id=$1 AND user_email=$2',
      [parseInt(req.params.id), actor.email.toLowerCase()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});
```
**new_str**
```
router.delete('/api/notifications/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    await pool.query('DELETE FROM notifications WHERE id=$1 AND user_email=$2',
      [parseInt(req.params.id), actor.email.toLowerCase()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// Bug-2: ștergere în bloc — clientul trimite ID-urile din filtrul/categoria curentă.
// Șterge doar notificările proprii (user_email), oricâte categorii ar acoperi lista.
router.post('/api/notifications/delete-bulk', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(n => parseInt(n)).filter(Number.isInteger)
      : [];
    if (!ids.length) return res.json({ ok: true, deleted: 0 });
    const { rowCount } = await pool.query(
      'DELETE FROM notifications WHERE id = ANY($1::int[]) AND user_email=$2',
      [ids, actor.email.toLowerCase()]
    );
    // Reîmprospătează badge-ul de necitite
    try {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM notifications WHERE user_email=$1 AND read=FALSE',
        [actor.email.toLowerCase()]
      );
      _wsPush?.(actor.email, { event: 'unread_count', count: rows[0]?.c || 0 });
    } catch {}
    res.json({ ok: true, deleted: rowCount });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});
```

> Notă: rutele existente de notificări nu declară `csrfMiddleware` (vezi DELETE/:id, read-all) — păstrăm
> același pattern pentru consistență. Auth-ul e prin `requireAuth` (cookie). Dacă există un guard CSRF
> global care le acoperă, se aplică automat și acesta.

---

## Patch 2 — `public/notifications.html`: buton „Șterge afișate"

Adaugă butonul imediat după `#btnReadAll`.

**old_str**
```
        <button class="df-action-btn" id="btnReadAll" style="display:none;">
          <svg class="df-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Marchează toate citite
        </button>
```
**new_str**
```
        <button class="df-action-btn" id="btnReadAll" style="display:none;">
          <svg class="df-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Marchează toate citite
        </button>
        <button class="df-action-btn danger" id="btnDeleteCat" style="display:none;">
          <svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-trash"/></svg>
          <span id="btnDeleteCatLabel">Șterge afișate</span>
        </button>
```

> Dacă `ico-trash` nu există în `icons.svg`, folosește `#ico-x`. Verifică: `grep -c 'id="ico-trash"' public/icons.svg`.

---

## Patch 3 — `public/js/notifications/notifications.js`: vizibilitate + handler bulk-delete

### 3a — în `renderList`, după `const list = filtered();`, gestionează butonul

**old_str**
```
function renderList() {
  const list = filtered();
  const area = $('listArea');
  updateTabCounts();
```
**new_str**
```
function renderList() {
  const list = filtered();
  const area = $('listArea');
  updateTabCounts();
  // Bug-2: buton ștergere în bloc — vizibil doar când există ceva de șters în filtrul curent
  const _bd = $('btnDeleteCat');
  if (_bd) {
    _bd.style.display = list.length ? 'inline-flex' : 'none';
    const _lbl = $('btnDeleteCatLabel');
    if (_lbl) _lbl.textContent = `Șterge afișate (${list.length})`;
  }
```

### 3b — handler (lângă `$('btnReadAll').onclick`, la final)

**old_str**
```
$('btnReadAll').onclick = async () => {
  allNotifs.forEach(n => n.read = true);
  updateTabCounts();
  renderList(); updateReadAllBtn();
  await _apiFetch('/api/notifications/read-all', { method:'POST' }).catch(()=>{});
};
```
**new_str**
```
$('btnReadAll').onclick = async () => {
  allNotifs.forEach(n => n.read = true);
  updateTabCounts();
  renderList(); updateReadAllBtn();
  await _apiFetch('/api/notifications/read-all', { method:'POST' }).catch(()=>{});
};

const _btnDeleteCat = $('btnDeleteCat');
if (_btnDeleteCat) _btnDeleteCat.onclick = async () => {
  const ids = filtered().map(n => n.id);
  if (!ids.length) return;
  const eticheta = currentFilter === 'all' ? 'toate notificările' : 'notificările din această categorie';
  if (!confirm(`Ștergeți ${eticheta} (${ids.length})? Operațiunea nu poate fi inversată.`)) return;
  const idSet = new Set(ids);
  allNotifs = allNotifs.filter(n => !idSet.has(n.id));
  renderList(); updateReadAllBtn(); updateTabCounts();
  await _apiFetch('/api/notifications/delete-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(()=>{});
};
```

> `_apiFetch` adaugă auth/CSRF automat (ca la celelalte apeluri din pagină). Optimist: ștergem local
> apoi sincronizăm cu serverul, ca la `deleteNotif`.

---

## Patch 4 — version bump + cache-busting țintit

`notifications.js` se schimbă; e referit cu `?v=` în `notifications.html`. Bump țintit (independent de drift):

```bash
NEW=3.9.530
node -e "const p=require('./package.json');p.version='$NEW';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
sed -i -E "s#(notifications/notifications\.js\?v=)[0-9.]+#\1$NEW#g" public/notifications.html
grep -n "notifications/notifications\.js?v=$NEW" public/notifications.html   # confirmă
```

> `notifications.js` NU e în `PRECACHE_ASSETS` → fără bump `CACHE_VERSION`.

---

## Verificări

```bash
node --check server/routes/notifications.mjs
node --check public/js/notifications/notifications.js

grep -n "delete-bulk" server/routes/notifications.mjs public/js/notifications/notifications.js   # 1 + 1
grep -n "btnDeleteCat" public/notifications.html public/js/notifications/notifications.js

npm test   # backend additive → verde (800)
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

## Verificare manuală staging
Pe pagina Notificări: pe fiecare categorie (ex. Finalizate, Refuzate, Necitite), butonul „Șterge afișate (N)"
apare cu numărul corect → click → confirm → dispar doar cele din categoria curentă; pe „Toate" șterge tot.

---

## RAPORT FINAL
- [ ] Versiune → 3.9.530 (package.json + `?v=` notifications.js)
- [ ] Endpoint `POST /api/notifications/delete-bulk` (șterge după id+user, update badge)
- [ ] Buton „Șterge afișate (N)" + handler (refolosește `filtered()`)
- [ ] `npm test` verde (800)
- [ ] diff fără fișiere de semnare
- [ ] commit + push **doar pe develop** → CI verde
- [ ] (staging) ștergere pe categorie + pe „Toate"

Commit sugerat:
```
feat(notif): ștergere în bloc pe categoria curentă (Bug 2)

- POST /api/notifications/delete-bulk {ids} → șterge după id+user, reîmprospătează badge necitite
- buton „Șterge afișate (N)" în pagina Notificări; refolosește filtered() din client (fără dublare logică)
- v3.9.530
```
