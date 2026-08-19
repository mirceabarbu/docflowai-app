---
model_suggested: Opus 4.8   # atinge crearea fluxurilor + interogări de integritate pe documente semnate
target_branch: develop
version_bump: 3.9.748 → 3.9.749
cache_bump: DA (audit.js e în PRECACHE_ASSETS)
qv_bump: DA (pentru asset-urile frontend atinse)
---

═══════════════════════════════════════════════════════════════════
⚠️  AVERTISMENT BRANCH
═══════════════════════════════════════════════════════════════════
ȚINTĂ: branch `develop` EXCLUSIV.
NU face checkout/merge/push pe `main`. `main` = PRODUCȚIE, gestionat MANUAL de Mircea.
La final: commit pe `develop` + `git push origin develop`.
═══════════════════════════════════════════════════════════════════

# PROMPT #120 — Detecția divergențelor document↔flux + gardă la creare

## CONTEXT — trei incidente în producție în șase zile, aceeași familie

Toate trei au însemnat „un document semnat care nu știe că e semnat", fiecare cu
o rupere DIFERITĂ, iar niciunul n-a fost detectat de sistem — au fost găsite
manual, unul dintre ele la zece zile după producere:

| # | Caz | Ce era rupt | Acoperit de |
|---|---|---|---|
| 1 | DF 417 „Gaze Naturale" | `alop.df_id` NULL | #117 / #118 (self-heal) |
| 2 | ORD 42719 „DIGI" | `ord.flow_id` NULL **și** `alop.ord_flow_id` NULL | NIMIC |
| 3 | DF 3771 + DF 40243 | `formulare_df.flow_id` NULL, ALOP legat corect | NIMIC |

Self-heal-urile existente (`alop-link.mjs`, plus self-heal #1/#2 din `alop.mjs`)
se declanșează DOAR pe `df_id`/`ord_id` NULL. Cazurile 2 și 3 au `df_id`/`ord_id`
corecte — le lipsește legătura cu FLUXUL. Nicio vindecare automată nu le atinge.

**CAUZA COMUNĂ, verificată pe cod:** `server/routes/flows/crud.mjs` PRE-SETEAZĂ
`formulare_{df,ord}.flow_id` la CREAREA fluxului (din `meta.dfId/ordId`), prin
suprascriere ORBĂ. Garda 409 „documentul e deja pe flux" există DOAR în
`linkFlowFormular` (`services/formular-shared.mjs:~583`) și e ocolită complet de
pre-setare. La ORD 42719 s-au creat TREI fluxuri în PATRU SECUNDE (dublu/triplu
click): documentul a rămas agățat de ultimul creat, dar semnarea s-a făcut pe
altul. Zece zile mai târziu, curățarea fluxurilor-fantomă a golit corect un
pointer care era deja greșit — abia atunci s-a văzut.

⚠️ Al doilea fapt confirmat: un flux ANULAT poate rămâne cu `data->>'completed' =
'true'` (ex. `PZ_8C34C4E842`, 0/5 semnături, anulat, `completedAt` NULL). Orice
interogare care se încrede în steagul `completed` fără să excludă
`cancelled`/`refused` dă fals-pozitive.

**OBIECTIV, în ordinea importanței:** (1) DETECȚIA — sistemul află în ziua zero,
nu utilizatorul peste zece zile; (2) GARDA la creare — nu se mai produc fluxuri
paralele pe același document; (3) IGIENA stării anulate.

⛔ NU implementa reparare automată a pointerilor. Un document semnat nu se
re-leagă tăcut de un flux ales de o euristică — se semnalează, iar decizia e a
omului.

═══════════════════════════════════════════════════════════════════
PAS 0 — CITEȘTE ÎNTÂI (fără modificări)
═══════════════════════════════════════════════════════════════════
- `server/routes/flows/crud.mjs` — pre-setarea `formulare_{df,ord}.flow_id` la creare (caut-o după `meta.dfId` / `meta.ordId`), plus ștergerea de la ~742-750
- `server/services/formular-shared.mjs` ~575-600 — garda 409 din `linkFlowFormular` (pattern-ul de reutilizat)
- `server/routes/admin/flows.mjs` ~108-135 — cardul „Poartă ALOP" (`COUNT(*) FILTER (WHERE violation)`) = MODELUL de urmat pentru noul card
- `public/js/admin/audit.js` ~150-175 — randarea cardului porții ALOP
- `server/routes/flows/lifecycle.mjs` ~520-580 — anularea fluxului (unde `completed` rămâne true)

⛔ NU deschide și NU modifica: `server/signing/**`,
`server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`.

═══════════════════════════════════════════════════════════════════
PAS 1 — Serviciu nou de detecție (pur, read-only)
═══════════════════════════════════════════════════════════════════
Fișier NOU `server/services/flow-link-audit.mjs`. O funcție exportată
`findFlowLinkDivergences(pool, { orgId = null, limit = 200 } = {})` care întoarce
`{ total, byClass: {...}, rows: [...] }`, fiecare rând cu
`{ clasa, tip, doc_id, doc_nr, alop_id, flux, detaliu }`.

Predicatul „flux valid semnat" se folosește IDENTIC în toate clasele — definește-l
o singură dată ca fragment SQL reutilizat:

```sql
  f.deleted_at IS NULL
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
  AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
```
⚠️ `IS DISTINCT FROM` obligatoriu (NULL-safe). Excluderea `cancelled`/`refused` NU
e opțională — vezi `PZ_8C34C4E842` din context.

Cele patru clase:

- **A — `doc_fara_flux`**: `formulare_df`/`formulare_ord` cu `flow_id IS NULL`,
  `deleted_at IS NULL`, pentru care există un flux valid semnat care le revendică
  prin `f.data->'meta'->>'dfId'` / `->>'ordId'`. (Cazul 3, și ORD 42719 parțial.)
- **B — `alop_fara_flux`**: `alop_instances` cu `cancelled_at IS NULL` unde
  `df_id`/`ord_id` e setat, documentul are `flow_id` pe un flux valid semnat, dar
  `alop.df_flow_id` / `alop.ord_flow_id` e NULL. (Cazul 2.)
- **C — `alop_fara_document`**: `alop_instances` cu `cancelled_at IS NULL` și
  `df_id IS NULL` (resp. `ord_id IS NULL`) pentru care există un document
  nedeleted cu `source_alop_id` = ALOP-ul. (Cazul 1 — deja auto-vindecat, dar
  raportat ca să se vadă frecvența.)
- **D — `fluxuri_paralele`**: DOUĂ SAU MAI MULTE fluxuri NEȘTERSE, necancelate,
  care revendică ACELAȘI document prin `data->'meta'`. Semnalul TIMPURIU — apare
  înainte de orice semnătură, deci înainte ca paguba să existe.

Cerințe:
- `orgId` opțional: `null` ⇒ toate organizațiile (folosit de platform-admin);
  altfel `AND <alias>.org_id = $n`. Foloseşte helperii din
  `server/services/authz-scope.mjs` dacă se potrivesc; NU inventa alt contract.
- Read-only: ZERO `UPDATE`/`INSERT`/`DELETE` în acest fișier.
- `limit` aplicat pe rezultatul final, dar `total` numărat integral.

# Verificare PAS 1:
node --check server/services/flow-link-audit.mjs
grep -nE "UPDATE|INSERT|DELETE" server/services/flow-link-audit.mjs
# Așteptat: 0 rezultate (serviciu strict read-only)

═══════════════════════════════════════════════════════════════════
PAS 2 — Endpoint + card în dashboard
═══════════════════════════════════════════════════════════════════
(a) În `server/routes/admin/flows.mjs`, adaugă în răspunsul de statistici (lângă
`gate`) un obiect `linkAudit: { total, byClass }` — apel la
`findFlowLinkDivergences` cu `limit: 0` (doar numărătoare, fără rânduri).
Non-fatal: dacă interogarea eșuează, întoarce `{ total: null }` și loghează —
un dashboard nu trebuie să pice din cauza unei metrici.

(b) Rută nouă `GET /admin/flow-link-divergences` (același gard de autorizare ca
restul rutelor din `admin/flows.mjs`) care întoarce rândurile detaliate.

(c) În `public/js/admin/audit.js`, un card „Consistență document↔flux" alături de
„Poartă ALOP": verde la 0, roșu altfel, cu numărul pe clase și link către lista
detaliată. Urmează EXACT tiparul vizual existent al cardului porții.

⚠️ Spre deosebire de cardul porții ALOP (cumulativ pe tot logul), acesta reflectă
starea CURENTĂ — deci trebuie să ajungă la 0 și să RĂMÂNĂ la 0. Zero e starea
normală, nu un ideal.

# Verificare PAS 2:
node --check server/routes/admin/flows.mjs
grep -n "flow-link-divergences" server/routes/admin/flows.mjs public/js/admin/audit.js
# Așteptat: prezent în ambele

═══════════════════════════════════════════════════════════════════
PAS 3 — Garda la creare (cauza rădăcină)
═══════════════════════════════════════════════════════════════════
În `server/routes/flows/crud.mjs`, la pre-setarea `formulare_{df,ord}.flow_id`
din `meta.dfId`/`meta.ordId`: NU mai suprascrie orb. Adaugă condiția în UPDATE,
în loc de un SELECT separat (evită fereastra de race la dublu-click):

```sql
UPDATE formulare_<tip>
   SET flow_id = $1, updated_at = NOW()
 WHERE id = $2
   AND org_id = $3
   AND (
     flow_id IS NULL
     OR flow_id = $1
     OR NOT EXISTS (
       SELECT 1 FROM flows f
        WHERE f.id = formulare_<tip>.flow_id
          AND f.deleted_at IS NULL
          AND f.data->>'status' IS DISTINCT FROM 'cancelled'
          AND f.data->>'status' IS DISTINCT FROM 'refused'
     )
   )
RETURNING id
```

Adică: preia documentul doar dacă e liber, dacă e deja al fluxului curent
(idempotent), sau dacă fluxul vechi e mort. Când `rowCount === 0`, documentul e
pe un flux VIU:

```js
logger.warn({ flowId, formType, formId },
  '[flux] documentul e deja pe un flux activ — pre-setare flow_id refuzata (posibil dublu-click)');
```

DECIZIE DE PRODUS — implementează AȘA: fluxul se creează în continuare
(NU arunca, NU face rollback la crearea fluxului), dar documentul rămâne agățat
de fluxul VECHI. Motivul: un rollback aici ar atinge calea de creare a fluxurilor,
cea mai sensibilă din aplicație, iar clasa D din PAS 1 face vizibil imediat
fluxul paralel. Prevenim coruperea pointerului, nu creăm o cale nouă de eșec.

⚠️ NU atinge `linkFlowFormular` — garda lui de 409 rămâne exact cum e.
⚠️ Verifică dacă pre-setarea e `.catch(() => {})` fire-and-forget: dacă da,
păstreaz-o non-fatală, dar adaugă `rowCount` în log.

# Verificare PAS 3:
node --check server/routes/flows/crud.mjs
git diff --stat server/signing/ server/routes/flows/cloud-signing.mjs server/routes/flows/bulk-signing.mjs
# Așteptat: GOL

═══════════════════════════════════════════════════════════════════
PAS 4 — Igiena stării la anulare
═══════════════════════════════════════════════════════════════════
În `server/routes/flows/lifecycle.mjs`, pe calea de anulare a fluxului: când se
setează `data.status = 'cancelled'`, curăță și `data.completed` (setează `false`)
și `data.completedAt` (`null`) dacă fluxul NU avea toți semnatarii semnați.

⚠️ Dacă fluxul chiar era complet semnat înainte de anulare, NU șterge `completed`
— ar rescrie istoria unui document semnat. Condiția: curăță doar când numărul de
semnatari cu `status==='signed' && pdfUploaded===true` e mai mic decât totalul.

# Verificare PAS 4:
node --check server/routes/flows/lifecycle.mjs

═══════════════════════════════════════════════════════════════════
PAS 5 — Teste
═══════════════════════════════════════════════════════════════════
Fișier DB nou `server/tests/db/flow-link-audit.test.mjs`:

1. Clasa A: doc cu `flow_id` NULL + flux valid semnat care-l revendică ⇒ detectat.
2. Clasa A negativ: același doc, dar fluxul e ANULAT cu `completed=true`
   (reproduce `PZ_8C34C4E842`) ⇒ NU e detectat. **Testul-cheie al promptului.**
3. Clasa B: ORD cu `flow_id` setat pe flux semnat, `alop.ord_flow_id` NULL ⇒ detectat.
4. Clasa C: ALOP cu `df_id` NULL + DF cu `source_alop_id` ⇒ detectat.
5. Clasa D: două fluxuri vii pe același document ⇒ detectat; unul viu + unul
   șters ⇒ NU.
6. Bază curată ⇒ `total = 0` (rulează pe fixtures fără divergențe).
7. `orgId` respectat: divergențele org B nu apar la interogarea pe org A.
8. PAS 3: creare flux pe un document deja pe flux VIU ⇒ `flow_id` rămâne pe
   fluxul vechi, fluxul nou se creează, warn logat. Cu fluxul vechi ANULAT ⇒
   documentul e preluat de fluxul nou.
9. PAS 4: anulare cu 0/5 semnături ⇒ `completed=false`; anulare a unui flux
   complet semnat ⇒ `completed` rămâne `true`.

⛔ Testele IMPORTĂ din producție — nu redeclara logica.

# Verificare PAS 5:
npm test
npm run test:db
# Așteptat: ambele verzi; test:db PASSED (nu SKIPPED)

═══════════════════════════════════════════════════════════════════
PAS 6 — Versiune + cache
═══════════════════════════════════════════════════════════════════
`package.json`: 3.9.748 → 3.9.749.
`public/sw.js`: BUMP `CACHE_VERSION` (`audit.js` e în PRECACHE_ASSETS).
`?v=` bump pentru asset-urile frontend atinse.
⚠️ Testul `sw-no-auth-cache.test.mjs` asertează FORMATUL, nu valoarea — nu-l atinge.

═══════════════════════════════════════════════════════════════════
RAPORT FINAL (obligatoriu)
═══════════════════════════════════════════════════════════════════
- Fișiere/funcții atinse; confirmarea că zona NO-TOUCH e neatinsă (`git diff --stat`).
- Forma exactă a pre-setării găsite în `crud.mjs` (citată) + cum a fost gardată.
- Ieșirea `npm test` + `npm run test:db` (PASSED, nu SKIPPED).
- Cele 9 grupuri de cazuri + rezultate.
- `CACHE_VERSION` vechi → nou.
- Hash commit + confirmarea `git push origin develop`.
- ⚠️ Reamintire: interogarea de detecție trebuie rulată pe PRODUCȚIE după deploy;
  divergențele existente NU se repară automat (deliberat).

═══════════════════════════════════════════════════════════════════
⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════
⛔ NU atinge `server/signing/**`, `server/routes/flows/cloud-signing.mjs`,
   `server/routes/flows/bulk-signing.mjs` (NO-TOUCH, CLAUDE.md:71-77).
⛔ NU implementa reparare automată a pointerilor — doar detecție.
⛔ NU modifica `linkFlowFormular`, `selfHealAlopDfLink`, self-heal #1/#2 din `alop.mjs`.
⛔ NU adăuga filtre `completed_at IS NULL` pe query-urile de relink (CLAUDE.md:499).
⛔ NU adăuga migrații — detecția e o interogare, nu o coloană.
⛔ NU face checkout/merge/push pe `main`. Push DOAR pe `origin develop`.
⛔ Fără `.only`/`.skip` uitate, fără `console.log` de debug.

PAS FINAL: `git add -A && git commit -m "feat(integritate): detectie divergente document-flux + garda la creare + igiena stare anulata v3.9.749" && git push origin develop`
