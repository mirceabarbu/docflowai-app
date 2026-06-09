# PROMPT Claude Code — Registratură: modale acțiuni + aliniere filtre

> ⚠️ BRANCH: `develop` EXCLUSIV.
> NU propune merge / push / checkout pe `main`.
> Activează skill-ul `docflowai-ui` (auto, prin trigger-ul UI). Aplică
> convențiile din `.claude/skills/docflowai-ui/SKILL.md`:
> `.df-modal-bg` + `.df-modal`, `.df-frow`, `.df-action-btn`, CSRF prin
> `window.df.getCsrf()`, fără hardcodare de culori, fără emoji-uri în
> butoane semantice.

## Context

Trei probleme observate pe staging pe modulul Registratură:

1. **Butoanele `Reîncarcă` / `Export CSV` (Ieșiri) și `Reîncarcă` /
   `+ Înregistrare intrare` (Intrări) nu sunt aliniate vizual cu
   câmpurile de filtru** — câmpurile au `<label>` deasupra, butoanele nu,
   deci sar din baseline cu ~23 px (înălțimea labelului). `align-items:
   flex-end` din container nu compensează diferența de înălțime.
2. **Acțiunea „Repartizează" folosește `window.prompt()` text liber** —
   fără validare, fără structură. Utilizatorul trebuie să tasteze
   manual compartiment + persoană.
3. **Acțiunea „Clasează" folosește `window.confirm()` fără motiv** —
   nicio justificare salvată, nicio trasabilitate.

Plus: după repartizare, valoarea `repartizatLa` se salvează în DB dar nu
e vizibilă în tabel. Adăugăm și asta.

## Obiectiv (un singur commit pe `develop`)

- Migrare nouă: coloane `motiv_clasare`, `rezolutie` pe `registru_intrari`.
- Endpoint nou GET `/api/registratura/asignatari` — listă compartimente
  + utilizatori per org (non-admin, pentru orice user autentificat al
  org-ului).
- Endpoint modificat POST `/api/registratura/intrari/:id/status` — acceptă
  și salvează `motivClasare` (când `next='clasat'`) și `rezolutie` (când
  `next='repartizat'` sau `'solutionat'`).
- Endpoint GET `/api/registratura/intrari` — include în payload
  `motivClasare`, `rezolutie`.
- HTML: aliniere butoane în ambele subview-uri (Ieșiri + Intrări).
- Component nou: `public/js/components/registratura-action-modal.js`
  după pattern-ul din `public/js/components/opme-import-modal.js`.
- `public/js/registratura/main.js`: înlocuiește `prompt`/`confirm` cu
  apeluri la modal nou; afișează `repartizatLa` sub badge-ul de status
  în rândurile tabelului Intrări.
- Bump versiune + `CACHE_VERSION`.

## ⛔ ZONE NO-TOUCH (absolute)

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
server/db/migrate.mjs
orice migrare existentă (000…077)
orice fișier din public/js/registratura/ ÎN AFARĂ DE main.js
```

## Modificări detaliate

### 1. Migrare nouă (inline) — `server/db/index.mjs`

Adaugă imediat DUPĂ blocul `077_registratura_serie_comuna` (înainte de
`];` care închide `MIGRATIONS`):

```javascript
  ,
  {
    id: '078_registratura_motiv_rezolutie',
    sql: `
      -- BLOC Registratură UX: justificări pentru clasare + rezoluție pe repartizare/soluționare.
      ALTER TABLE registru_intrari
        ADD COLUMN IF NOT EXISTS motiv_clasare TEXT,
        ADD COLUMN IF NOT EXISTS rezolutie     TEXT;
    `
  }
```

**Reguli respectate**: `ADD COLUMN IF NOT EXISTS`, fără `NOT NULL`, fără
`DEFAULT`, fără `DROP` — conform lecției incident 2026-04-19.

Verifică după:
```bash
grep -A 6 "078_registratura_motiv_rezolutie" server/db/index.mjs
# Așteptat: blocul corect, sintaxa template literal validă.
```

### 2. Endpoint nou — `server/routes/registratura.mjs`

Adaugă DUPĂ ultimul `router.get`/`router.post` existent în fișier
(probabil cel pentru `/intrari/:id/leaga-raspuns` sau aproape de el),
ÎNAINTE de `export default router`:

```javascript
// ─── GET /api/registratura/asignatari ──────────────────────────────────────
// Compartimente (din profil org) + utilizatori activi din aceeași org.
// Accesibil oricărui utilizator autentificat al org-ului — necesar pentru
// modal-ul de Repartizează/Clasează în Registratură.
router.get('/api/registratura/asignatari', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const orgId = actor.orgId || null;
    if (!orgId) return res.json({ ok: true, compartimente: [], users: [] });

    const [orgR, usersR] = await Promise.allSettled([
      pool.query(
        `SELECT compartimente FROM organizations WHERE id=$1 LIMIT 1`,
        [orgId]
      ),
      pool.query(
        `SELECT id, nume, compartiment
           FROM users
          WHERE org_id=$1
            AND (status IS NULL OR status <> 'inactiv')
          ORDER BY nume ASC`,
        [orgId]
      ),
    ]);

    const compOfic = orgR.status === 'fulfilled'
      ? (orgR.value.rows[0]?.compartimente || [])
      : [];
    const users = usersR.status === 'fulfilled' ? usersR.value.rows : [];

    // Compartimente: union compartimente_oficiale + cele găsite pe users.
    const fromUsers = [...new Set(users
      .map(u => (u.compartiment || '').trim())
      .filter(Boolean))];
    const compartimente = [...new Set([...compOfic, ...fromUsers])]
      .sort((a, b) => a.localeCompare(b, 'ro'));

    res.json({ ok: true, compartimente, users });
  } catch (e) {
    logger.error({ err: e }, 'registratura: asignatari listare eșuată');
    res.status(500).json({ error: 'internal' });
  }
});
```

> Notă: dacă tabela `users` nu are coloana `status`, scoate clauza
> `AND (status IS NULL OR status <> 'inactiv')`. Verifică întâi:
> ```bash
> grep -n "status TEXT\|status VARCHAR" server/db/index.mjs server/db/migrations/*.sql | grep -i "users" | head -3
> ```
> Dacă nu există → simplifică la `WHERE org_id=$1`.

### 3. Modifică endpoint status — `server/routes/registratura.mjs`

Verifică starea actuală:
```bash
grep -n "repartizatLa.*||" server/routes/registratura.mjs
# Așteptat: linia 266 (sau aproape) cu vals.push pentru repartizat_la.
```

Înlocuiește blocul:

**old_str:**
```javascript
    const sets = ['status = $1'];
    const vals = [next];
    if (next === 'repartizat') {
      vals.push(String((req.body || {}).repartizatLa || '').trim() || null);
      sets.push(`repartizat_la = $${vals.length}`, `repartizat_at = NOW()`);
    }
    if (next === 'solutionat') sets.push(`solutionat_at = NOW()`);
    if (next === 'clasat')     sets.push(`clasat_at = NOW()`);
```

**new_str:**
```javascript
    const sets = ['status = $1'];
    const vals = [next];
    const body = req.body || {};
    if (next === 'repartizat') {
      vals.push(String(body.repartizatLa || '').trim() || null);
      sets.push(`repartizat_la = $${vals.length}`, `repartizat_at = NOW()`);
      // BLOC Registratură UX: rezoluție opțională la repartizare
      const rez = String(body.rezolutie || '').trim();
      if (rez) {
        vals.push(rez);
        sets.push(`rezolutie = $${vals.length}`);
      }
    }
    if (next === 'solutionat') {
      sets.push(`solutionat_at = NOW()`);
      const rez = String(body.rezolutie || '').trim();
      if (rez) {
        vals.push(rez);
        sets.push(`rezolutie = $${vals.length}`);
      }
    }
    if (next === 'clasat') {
      sets.push(`clasat_at = NOW()`);
      // BLOC Registratură UX: motiv obligatoriu la clasare
      const mot = String(body.motivClasare || '').trim();
      if (!mot) return res.status(400).json({ error: 'motiv_obligatoriu' });
      vals.push(mot);
      sets.push(`motiv_clasare = $${vals.length}`);
    }
```

### 4. Include noile câmpuri în GET — `server/routes/registratura.mjs`

Verifică linia curentă:
```bash
grep -n "repartizatLa: r.repartizat_la, raspunsFlowId" server/routes/registratura.mjs
# Așteptat: linia 130 (sau aproape).
```

**old_str:**
```javascript
        repartizatLa: r.repartizat_la, raspunsFlowId: r.raspuns_flow_id,
```

**new_str:**
```javascript
        repartizatLa: r.repartizat_la, raspunsFlowId: r.raspuns_flow_id,
        motivClasare: r.motiv_clasare, rezolutie: r.rezolutie,
```

Și în query-ul SELECT corespunzător (~linia 109), adaugă coloanele:

```bash
grep -n "r.termen_at, r.mod_primire, r.repartizat_la, r.status" server/routes/registratura.mjs
```

**old_str:**
```javascript
             r.termen_at, r.mod_primire, r.repartizat_la, r.status AS status_raw,
```

**new_str:**
```javascript
             r.termen_at, r.mod_primire, r.repartizat_la, r.motiv_clasare, r.rezolutie, r.status AS status_raw,
```

### 5. Aliniere butoane filtru — `public/registratura.html`

**Subtab Ieșiri** (~linia 142-145). Verifică:
```bash
sed -n '142,146p' public/registratura.html
# Așteptat: <div style="display:flex;gap:8px;"> cu reg-refresh + reg-export
```

**old_str:**
```html
              <div style="display:flex;gap:8px;">
                <button class="df-action-btn" id="reg-refresh" type="button">Reîncarcă</button>
                <button class="df-action-btn primary" id="reg-export" type="button">Export CSV</button>
              </div>
```

**new_str:**
```html
              <div class="df-frow" style="display:flex;flex-direction:column;justify-content:flex-end;margin-bottom:0;">
                <span aria-hidden="true" style="display:block;font-size:.75rem;margin-bottom:5px;visibility:hidden;">&nbsp;</span>
                <div style="display:flex;gap:8px;">
                  <button class="df-action-btn" id="reg-refresh" type="button">Reîncarcă</button>
                  <button class="df-action-btn primary" id="reg-export" type="button">Export CSV</button>
                </div>
              </div>
```

**Subtab Intrări** (~linia 211-214):

**old_str:**
```html
              <div style="display:flex;gap:8px;">
                <button class="df-action-btn" id="regin-refresh" type="button">Reîncarcă</button>
                <button class="df-action-btn primary" id="regin-new" type="button">+ Înregistrare intrare</button>
              </div>
```

**new_str:**
```html
              <div class="df-frow" style="display:flex;flex-direction:column;justify-content:flex-end;margin-bottom:0;">
                <span aria-hidden="true" style="display:block;font-size:.75rem;margin-bottom:5px;visibility:hidden;">&nbsp;</span>
                <div style="display:flex;gap:8px;">
                  <button class="df-action-btn" id="regin-refresh" type="button">Reîncarcă</button>
                  <button class="df-action-btn primary" id="regin-new" type="button">+ Înregistrare intrare</button>
                </div>
              </div>
```

> Tehnica: `<span>` cu `visibility:hidden` ocupă același vertical space
> ca un `<label>` (font-size .75rem + margin-bottom 5px), deci baseline-ul
> butoanelor coincide cu baseline-ul inputurilor. Auto-adaptat dacă se
> schimbă vreodată dimensiunile labelului în `components.css`.

### 6. Component nou — `public/js/components/registratura-action-modal.js`

Creează fișier nou, urmărind pattern-ul exact din
`public/js/components/opme-import-modal.js` (IIFE + `window.DFXxxModal`):

**API expus:**
```javascript
window.DFRegistraturaActionModal.open({
  intrareId: <number>,
  action: 'repartizat' | 'clasat' | 'solutionat',
  onSuccess: () => void,    // apelat după 200 OK de la /status
});
```

**Conținut modal după acțiune:**

- `repartizat`:
  - Titlu: „Repartizare intrare"
  - `<select>` Compartiment (din `compartimente` returnate de
    `/api/registratura/asignatari`)
  - `<select>` Persoană (filtrată dinamic pe compartimentul ales — din
    `users[]`; afișează `nume`)
  - `<textarea>` Rezoluție (opțional, max 500 caractere)
  - Footer: butoane „Anulează" (`.df-action-btn`) + „Repartizează"
    (`.df-action-btn primary`)
  - Submit: POST `/api/registratura/intrari/:id/status` cu body
    `{ status:'repartizat', repartizatLa: '<compartiment> / <nume>', rezolutie: '...' }`
    (sau doar `'<compartiment>'` dacă nu s-a ales persoană)

- `clasat`:
  - Titlu: „Clasare intrare"
  - `<textarea>` Motiv clasare (**OBLIGATORIU**, min 3 caractere, max
    500). Buton submit dezactivat dacă e gol.
  - Footer: „Anulează" + „Clasează" (`.df-action-btn warning`)
  - Submit: `{ status:'clasat', motivClasare: '...' }`
  - Tratează 400 `motiv_obligatoriu` de la server cu mesaj inline sub
    textarea.

- `solutionat`:
  - Titlu: „Soluționare intrare"
  - Mesaj scurt: „Marchezi această intrare ca soluționată."
  - `<textarea>` Rezoluție (opțional, max 500 caractere)
  - Footer: „Anulează" + „Soluționează" (`.df-action-btn success`)
  - Submit: `{ status:'solutionat', rezolutie: '...' }`

**Convenții obligatorii** (din skill `docflowai-ui`):

- Folosește clasele standard: `.df-modal-bg` (backdrop), `.df-modal`
  (container), `.df-frow` (rânduri câmpuri), `.df-modal-acts` (footer
  butoane), `.df-action-btn` cu variante (`primary` / `warning` /
  `success`).
- ZERO culori hardcodate (`#xxxxxx`) — doar `var(--df-*)` din tokens.
- CSRF la POST: `headers: Object.assign({ 'Content-Type':'application/json' }, { 'x-csrf-token': window.df.getCsrf() })`
  ȘI `credentials:'include'`.
- `aria-modal="true"`, `aria-labelledby`, `Esc` închide, click pe
  backdrop închide, focus trap pe primul input.
- Cache de `asignatari`: prima dată face fetch, apoi reține într-o
  variabilă internă; reload-ul se forțează prin `open()` cu cache
  invalidate dacă trec >5 min de la ultimul fetch.
- Folosește `window.df.esc()` pentru orice valoare injectată în HTML.

**Structură fișier (schelet, completează detaliile):**

```javascript
/* registratura-action-modal.js — modal acțiuni Registratură Intrări.
 *
 * API:
 *   window.DFRegistraturaActionModal.open({ intrareId, action, onSuccess })
 *
 * action ∈ { 'repartizat', 'clasat', 'solutionat' }
 *
 * Dependențe: window.df.esc, window.df.getCsrf (din df-utils.js).
 */
(function () {
  'use strict';
  // ... implementare după pattern opme-import-modal.js
  window.DFRegistraturaActionModal = { open, close };
})();
```

Lungime țintă: 250-350 linii (similar opme-import-modal.js).

### 7. Include modal-ul în pagina Registratură — `public/registratura.html`

Verifică ce script-uri sunt deja încărcate:
```bash
grep -n "df-utils.js\|<script" public/registratura.html | head -10
```

Adaugă tag-ul `<script>` ÎNAINTE de scriptul `public/js/registratura/main.js`:

```html
<script src="/js/components/registratura-action-modal.js?v=3.9.486"></script>
```

(Înlocuiește `3.9.486` cu versiunea finală — vezi pasul 9 jos.)

### 8. Înlocuiește prompt/confirm în main.js — `public/js/registratura/main.js`

Verifică:
```bash
grep -n "prompt\|confirm" public/js/registratura/main.js
# Așteptat: liniile 255, 259, 260, 278.
```

Modifică funcția `doStatus` (~linia 252-275). Folosește modal-ul nou
pentru `repartizat`, `clasat`, `solutionat`. Lasă `doLink` neatins
(linia 277 — prompt pentru ID flux răspuns; e altă acțiune și e
suficient acolo).

**old_str:**
```javascript
  async function doStatus(id, next) {
    let extra = {};
    if (next === 'repartizat') {
      const r = prompt('Repartizat la (compartiment/persoană)?', '');
      if (r === null) return;
      extra.repartizatLa = r.trim();
    }
    if (next === 'clasat' && !confirm('Confirmi clasarea acestei intrări?')) return;
    if (next === 'solutionat' && !confirm('Confirmi soluționarea acestei intrări?')) return;
    try {
      const r = await fetch(`/api/registratura/intrari/${id}/status`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHdr()),
        credentials: 'include',
        body: JSON.stringify(Object.assign({ status: next }, extra)),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert('Eroare: ' + (j.error || r.status));
        return;
      }
      loadIn();
    } catch (e) { alert('Eroare rețea.'); }
  }
```

**new_str:**
```javascript
  async function doStatus(id, next) {
    // BLOC Registratură UX: pentru tranziții cu input → modal dedicat.
    if (next === 'repartizat' || next === 'clasat' || next === 'solutionat') {
      if (!window.DFRegistraturaActionModal) {
        alert('Componentă modal indisponibilă. Reîncarcă pagina.');
        return;
      }
      window.DFRegistraturaActionModal.open({
        intrareId: id,
        action: next,
        onSuccess: () => loadIn(),
      });
      return;
    }
    // Restul tranzițiilor (ex. in_lucru) — fără confirmare modală.
    try {
      const r = await fetch(`/api/registratura/intrari/${id}/status`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHdr()),
        credentials: 'include',
        body: JSON.stringify({ status: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert('Eroare: ' + (j.error || r.status));
        return;
      }
      loadIn();
    } catch (e) { alert('Eroare rețea.'); }
  }
```

### 9. Afișează repartizatLa + rezoluție în rând — `public/js/registratura/main.js`

Modifică `renderIn(items)` (~linia 217). Adaugă sub badge-ul de status
o linie mică cu repartizatul și/sau rezoluția (truncate la 60 chars).

Verifică prima:
```bash
grep -n "statusBadge(it.status)" public/js/registratura/main.js
```

**old_str:**
```javascript
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${statusBadge(it.status)}</td>
```

**new_str:**
```javascript
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">
          ${statusBadge(it.status)}
          ${it.repartizatLa ? `<div style="font-size:.72rem;color:var(--df-text-3);margin-top:4px;">→ ${esc(String(it.repartizatLa).slice(0, 60))}</div>` : ''}
          ${it.motivClasare ? `<div title="${esc(it.motivClasare)}" style="font-size:.72rem;color:var(--df-text-3);margin-top:4px;font-style:italic;">motiv: ${esc(String(it.motivClasare).slice(0, 40))}${it.motivClasare.length > 40 ? '…' : ''}</div>` : ''}
        </td>
```

(`esc` e deja importat în main.js; folosește același helper.)

### 10. Bump versiune — `package.json`

```bash
grep '"version"' package.json
# Așteptat: "3.9.485" (după hang-fix) — incrementăm la 3.9.486.
# DACĂ vezi altă versiune (ex. 3.9.484, hang-fix-ul n-a fost încă commis):
# folosește versiunea curentă + 1 patch. Adaptează toate referințele
# (?v=X) la noua versiune.
```

**old_str:**
```json
  "version": "3.9.485",
```

**new_str:**
```json
  "version": "3.9.486",
```

### 11. Bump CACHE_VERSION — `public/sw.js`

Frontend a fost atins (HTML + JS nou + JS modificat) → cache bust
obligatoriu.

```bash
grep "CACHE_VERSION" public/sw.js
# Așteptat: const CACHE_VERSION = 'docflowai-v200';
```

**old_str:**
```javascript
const CACHE_VERSION = 'docflowai-v200';
```

**new_str:**
```javascript
const CACHE_VERSION = 'docflowai-v201';
```

## Verificări obligatorii înainte de commit

```bash
# 1. Niciun NO-TOUCH atins
git status
git diff --name-only
# Așteptat exact (în orice ordine):
#   server/db/index.mjs
#   server/routes/registratura.mjs
#   public/registratura.html
#   public/js/registratura/main.js
#   public/js/components/registratura-action-modal.js  (NOU)
#   package.json
#   public/sw.js
# DACĂ apare oricare din signing files / migrate.mjs → STOP.

# 2. Sintaxa OK
npm run check

# 3. Migrarea există
grep "078_registratura_motiv_rezolutie" server/db/index.mjs
# Așteptat: 1 hit.

# 4. Endpoint nou
grep "/api/registratura/asignatari" server/routes/registratura.mjs
# Așteptat: 1 hit.

# 5. Modal-ul există și expune API global
grep "window.DFRegistraturaActionModal" public/js/components/registratura-action-modal.js
# Așteptat: 1 hit.
ls -la public/js/components/registratura-action-modal.js
# Așteptat: fișier ~6-12 KB.

# 6. Script-ul e inclus în pagină
grep "registratura-action-modal.js" public/registratura.html
# Așteptat: 1 hit cu ?v=3.9.486.

# 7. prompt/confirm pentru status au dispărut
grep -n "prompt\|confirm" public/js/registratura/main.js
# Așteptat: doar linia ~278 (doLink prompt pentru flowId) — NU pentru status.

# 8. Versiunile sincronizate
grep '"version"' package.json
grep CACHE_VERSION public/sw.js
# Așteptat: 3.9.486 și docflowai-v201.

# 9. Teste
npm test
# npm test verde, fără regresii. Niciun test șters/dezactivat.
```

Dacă oricare verificare pică → STOP, raportează simptomul, nu commit-a.

## Commit + push pe develop

```bash
git add server/db/index.mjs \
        server/routes/registratura.mjs \
        public/registratura.html \
        public/js/registratura/main.js \
        public/js/components/registratura-action-modal.js \
        package.json \
        public/sw.js

git commit -m "feat(registratura): modale acțiuni + aliniere filtre (v3.9.486)

UX hardening pe Registratură Intrări:

- Repartizează / Clasează / Soluționează folosesc modal dedicat în loc
  de window.prompt() / confirm():
  - Repartizează: dropdown compartiment → dropdown persoană (filtrată)
    + rezoluție opțională
  - Clasează: motiv OBLIGATORIU (min 3 chars, max 500)
  - Soluționează: rezoluție opțională
- Endpoint nou GET /api/registratura/asignatari — listă compartimente
  + users per org, non-admin (orice user autentificat al org-ului)
- Endpoint /status acceptă motivClasare + rezolutie; returnează
  400 motiv_obligatoriu dacă lipsește la clasare
- Migrare 078_registratura_motiv_rezolutie: coloane motiv_clasare,
  rezolutie pe registru_intrari (ADD COLUMN IF NOT EXISTS, fără NOT NULL)
- HTML: butoane Reîncarcă/Export CSV (Ieșiri) și Reîncarcă/+ Înregistrare
  (Intrări) aliniate pe același baseline cu inputurile (spacer span)
- Tabelul Intrări: sub badge-ul de status, afișează repartizatLa și
  motiv_clasare (trunchiat 40-60 chars)

Componenta nouă: public/js/components/registratura-action-modal.js
(API window.DFRegistraturaActionModal.open) — urmează pattern-ul
opme-import-modal.js (.df-modal-bg, .df-modal, .df-frow, .df-action-btn).

Bump CACHE_VERSION docflowai-v200 → v201 (cache bust frontend)."

git push origin develop
```

## RAPORT FINAL (formatul așteptat)

```
COMMIT: <SHA scurt> pe develop
Fișiere: 7 (6 modificate + 1 nou)
  - server/db/index.mjs                                            (+8 -0)
  - server/routes/registratura.mjs                                 (+~40 -~6)
  - public/registratura.html                                       (+~16 -~6)
  - public/js/registratura/main.js                                 (+~14 -~8)
  - public/js/components/registratura-action-modal.js              (NOU, ~300 linii)
  - package.json                                                   (+1 -1)
  - public/sw.js                                                   (+1 -1)
Verificări:
  - git diff --name-only: doar cele 7 fișiere ✅
  - npm run check: pass ✅
  - npm test: pass (X/X) ✅
  - migrarea 078 prezentă ✅
  - endpoint asignatari prezent ✅
  - window.DFRegistraturaActionModal exportat ✅
  - prompt/confirm pentru status: 0 hits ✅ (doLink intact)
  - versiuni: 3.9.486 + docflowai-v201 ✅
NO-TOUCH respectat: ✅ (signing-ul + migrările vechi + migrate.mjs neatinse)
Push: develop @ <SHA scurt>
Staging: redeploy automat declanșat
```

## Pași MANUALI după push (Mircea — NU Claude Code)

1. **Smoke test pe staging după redeploy (~2-3 min):**
   - `https://docflowai-app-staging.up.railway.app/registratura.html`
   - Hard-refresh (`Ctrl+Shift+R`) ca să iei `sw.js` nou.
   - Tab Ieșiri: butoanele aliniate cu inputurile.
   - Tab Intrări: butoanele aliniate. Click pe „Repartizează" → modal,
     nu prompt browser. Alege compartiment + persoană + (opțional)
     rezoluție → confirmă → rândul se reîncarcă cu indicatorul vizual
     sub badge.
   - Click pe „Clasează" → modal. Fără motiv = buton dezactivat sau 400.
     Cu motiv → confirmă → rândul afișează „motiv: ..." sub badge.
2. **Verifică log Railway** că migrarea `078_registratura_motiv_rezolutie`
   s-a aplicat fără eroare la pornire.
3. Dacă staging stabil + funcțional → activează skill-ul
   `docflowai-deploy` mâine sau când vrei pentru merge → main.
