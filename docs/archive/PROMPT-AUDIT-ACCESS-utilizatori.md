---
id: AUDIT-ACCESS
titlu: Audit PDF flux — vizibil utilizatorilor cu acces la flux (nu doar admin)
model_suggested: Opus 4.8   # schimbă AUTZ pe o rută cu date sensibile (audit: hash-uri, IP-uri, semnatari)
branch: develop
bump: 3.9.710   # backend (autz rută) + frontend (2 gate-uri) → ?v= pe assetele atinse; CACHE_VERSION doar dacă atingi PRECACHE
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU merge/push/checkout pe `main` (= PRODUCȚIE, manual, Mircea).

===============================================================================
CONTEXT (cerință + diagnostic pe cod v3.9.704 — nu re-investiga)
===============================================================================

Butonul „Audit PDF" pe fluxuri e vizibil DOAR la admin/org_admin. Mircea îl vrea și la
UTILIZATORI — în pagina flux (flow.html) ȘI în kebab-ul „Fluxurile mele" — dar DOAR pentru
fluxurile la care userul are deja acces (NU orice flux).

⚠️ SECURITATE — regula centrală a acestui fix: NU „scoate gate-ul admin". Auditul de flux
conține hash-uri SHA-256, IP-uri, semnatari, jurnal complet. Dacă doar ștergem verificarea
de rol, orice user autentificat ar descărca auditul ORICĂRUI flux ghicind `flowId` = IDOR
pe date de conformitate. Corect: înlocuiește gate-ul de rol cu poarta la nivel de OBIECT
`isFlowAccessAllowed`, deja folosită pe GET /flows/:id + signed-pdf/pdf/attachments.

Cele TREI straturi (verificate):
 • Backend: `GET /admin/flows/:flowId/audit` (server/routes/admin/flows.mjs:524) →
   `if (!isAdminOrOrgAdmin(actor)) return 403`. ← ASTA e poarta reală.
 • Frontend flow.js:830 → `btnAudit.style.display = isAdmin ? "" : "none"`.
 • Frontend semdoc-initiator/main.js:1293 → `auditAction = isAdminRole ? '<button…>' : ''`.

Poarta corectă (există): `isFlowAccessAllowed(pool, actor, data, signerToken, flowId)` din
`server/services/flow-access.mjs` — permite init | semnatar | admin/org_admin same-org |
destinatar repartizat. `getFlowData(flowId)` întoarce `orgId`, deci poarta are ce-i trebuie.

===============================================================================
PAS 1 — Backend: înlocuiește gate-ul de rol cu isFlowAccessAllowed pe ruta de audit
===============================================================================

Fișier: `server/routes/admin/flows.mjs`, ruta `GET /admin/flows/:flowId/audit` (~524).

Verifică întâi importurile și forma reală:
    grep -n "isFlowAccessAllowed\|flow-access\|getFlowData\|isAdminOrOrgAdmin(actor)) return res.status(403)" server/routes/admin/flows.mjs | head

Dacă `isFlowAccessAllowed` NU e deja importat, adaugă importul (mirror alte rute care-l
folosesc, ex. în crud.mjs/flow content routes):
    import { isFlowAccessAllowed } from '../../services/flow-access.mjs';

Apoi modifică DOAR gate-ul acestei rute. `getFlowData` se apelează oricum la linia ~530 —
mută-l ÎNAINTEA gate-ului (ca poarta să primească `data`), și înlocuiește verificarea de rol:

old_str:
  router.get('/admin/flows/:flowId/audit', async (req, res) => {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
    try {
      const { flowId } = req.params;
      const data = await getFlowData(flowId);
      if (!data) return res.status(404).json({ error: 'not_found' });

new_str:
  router.get('/admin/flows/:flowId/audit', async (req, res) => {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    try {
      const { flowId } = req.params;
      const data = await getFlowData(flowId);
      if (!data) return res.status(404).json({ error: 'not_found' });
      // AUTZ la nivel de OBIECT: init | semnatar | admin same-org | destinatar repartizat.
      // (Înlocuiește vechiul gate admin-only; NU deschide IDOR pe auditul altui flux.)
      const allowed = await isFlowAccessAllowed(pool, actor, data, null, flowId);
      if (!allowed) return res.status(403).json({ error: 'forbidden' });

⚠️ Verifică că `pool` e disponibil în scope-ul rutei (probabil importat sus). Dacă
`getFlowData` era DEJA înaintea gate-ului în forma reală, adaptează old_str — scopul e:
`requireAuth` → `getFlowData` → 404 dacă lipsește → `isFlowAccessAllowed` → 403 dacă nu.
NU lăsa AMBELE gate-uri (nici `isAdminOrOrgAdmin`, nici return 403 vechi să rămână).

⚠️ NU atinge ruta bulk `/admin/flows/audit-export` (linia ~998, `actor.role !== 'admin'`) —
aia rămâne strict admin (export în masă, alt risc). Doar ruta per-flux se deschide.

Verificare:
    grep -n "isAdminOrOrgAdmin(actor)) return res.status(403)" server/routes/admin/flows.mjs
    # ruta :flowId/audit NU mai trebuie să apară aici; audit-export (role!=='admin') RĂMÂNE
    node --check server/routes/admin/flows.mjs

===============================================================================
PAS 2 — Frontend: arată butonul tuturor (poarta reală e serverul acum)
===============================================================================

(a) `public/js/flow/flow.js` (~830):
old_str:
        btnAudit.style.display = isAdmin ? "" : "none";
new_str:
        btnAudit.style.display = "";   // AUTZ pe server (isFlowAccessAllowed); vizibil oricui are pagina flux

(b) `public/js/semdoc-initiator/main.js` (~1293): scoate garda `isAdminRole ?`:
old_str:
          const auditAction = isAdminRole
            ? `<button type="button" class="df-action-btn df-kebab-item" data-audit-action="preview" data-audit-url="/admin/flows/${encodeURIComponent(f.flowId)}/audit?format=pdf" data-audit-name="Audit_${f.flowId}.pdf"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-file-text"/></svg>Audit PDF</button>`
new_str:
          const auditAction = `<button type="button" class="df-action-btn df-kebab-item" data-audit-action="preview" data-audit-url="/admin/flows/${encodeURIComponent(f.flowId)}/audit?format=pdf" data-audit-name="Audit_${f.flowId}.pdf"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-file-text"/></svg>Audit PDF</button>`

⚠️ Verifică forma exactă a ambelor (liniile pot diferi ușor); dacă `auditAction` are un
`: ''` la final pe altă linie, include-l în old_str ca înlocuirea să fie curată.
NU schimba `data-audit-url` (ruta serverului rămâne aceeași `/admin/flows/.../audit`).
⚠️ Dacă `isAdminRole` devine nefolosit după asta, verifică — probabil e folosit și în altă
parte (nu-l șterge dacă mai are referințe; linterul îți spune).

Verificare:
    grep -n "btnAudit.style.display" public/js/flow/flow.js         # Așteptat: = ""
    grep -n "auditAction" public/js/semdoc-initiator/main.js         # fără `isAdminRole ?`

===============================================================================
PAS 3 — Test DB real (autz-ul e invariantul critic) + suită
===============================================================================

Adaugă un test (mirror pattern-ul testelor de flow-access existente) care lovește
`GET /admin/flows/:flowId/audit?format=json` cu actori diferiți pe ACELAȘI flux:
 1. inițiatorul fluxului → 200 (poate)
 2. un semnatar al fluxului → 200
 3. un destinatar repartizat → 200
 4. un user din ACELAȘI org dar FĂRĂ legătură cu fluxul (nu init/semnatar/repartizat) → 403
 5. un user din ALT org → 403 (nu 404 leak, dar 404 e și el acceptabil dacă getFlowData scope-uiește; asertează NON-200)
 6. admin same-org → 200 (regresie: adminul păstrează accesul)

(Folosește `format=json` ca să nu generezi PDF în test; ruta suportă `format` — verifică.)

Verificare:
    npx vitest run --config vitest.config.db.mjs server/tests/db/flow-audit-access.test.mjs
    npm test     # verde, fără regresii

===============================================================================
PAS 4 — Cache + bump
===============================================================================
`package.json`: 3.9.709 → 3.9.710.
`?v=` țintit pe assetele atinse: flow.js (flow.html), semdoc-initiator/main.js (pagina care
o încarcă). Verifică dacă vreunul e în PRECACHE_ASSETS:
    grep -n "flow.js\|semdoc-initiator\|main.js\|PRECACHE" public/sw.js | head
    # Dacă flow.js/main.js NU sunt în PRECACHE → FĂRĂ CACHE_VERSION bump (doar ?v=).
    # Dacă vreunul E în PRECACHE → bump CACHE_VERSION obligatoriu.

===============================================================================
RAPORT FINAL
===============================================================================
1. Diff-ul gate-ului rutei (rol → isFlowAccessAllowed) + confirmarea că ruta bulk
   audit-export a rămas admin-only.
2. Diff-urile celor două gate-uri frontend (flow.js + semdoc-initiator/main.js).
3. Testul DB: cazurile 1–6, toate verzi (mai ales 4 și 5 = 403 pentru user fără acces / alt org).
4. CACHE_VERSION bump DA/NU + motiv; ?v= țintite.
5. `npm test` passed/0 fail. `git diff --name-only`.
6. Commit+push develop (`feat(audit): Audit PDF flux vizibil utilizatorilor cu acces (isFlowAccessAllowed în loc de admin-only) (v3.9.710)`) + hash.

ACCEPTANCE (manual, Mircea, staging după deploy):
 • Ca user NON-admin care e inițiator/semnatar pe un flux → butonul „Audit PDF" apare în
   pagina flux ȘI în kebab-ul „Fluxurile mele", și descarcă auditul.
 • Ca user care NU are legătură cu un flux → chiar dacă ar forța URL-ul
   /admin/flows/<alt_flow>/audit, primește 403 (nu descarcă).

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================
⛔ NU „scoate pur și simplu" gate-ul rutei — ÎNLOCUIEȘTE-l cu isFlowAccessAllowed (altfel IDOR).
⛔ NU atinge ruta bulk `/admin/flows/audit-export` (rămâne admin-only).
⛔ NU atinge `server/signing/*`. NU schimba `data-audit-url` / ruta serverului.
⛔ `?v=` țintit pe assetele atinse, NU bulk-sed. CACHE_VERSION doar dacă atingi PRECACHE.
⛔ Testul DB e OBLIGATORIU — cazurile 4 și 5 (403 pentru user fără acces / alt org) sunt dovada
   că NU am introdus IDOR. Fără ele, fix-ul nu e complet.
⛔ Totul pe `develop`. NU merge/push pe `main`. Contrazicere grep vs prompt ⇒ oprește-te și raportează.
