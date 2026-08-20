---
prompt: 122
titlu: P0-03 — validarea provenienței fluxului la link-df-flow/link-ord-flow + dovada semnării la df-completed/ord-completed
model_suggested: Opus 4.8
branch: develop
version_bump: 3.9.751 → 3.9.752
migratii: NU
cache_version_bump: NU (zero fișiere frontend atinse)
v_param_bump: NU
---

# ⚠️⚠️ BRANCH: `develop` — EXCLUSIV ⚠️⚠️
`main` = PRODUCȚIE, administrat MANUAL de Mircea. NU face niciodată checkout/merge/push pe `main`.
Pasul final OBLIGATORIU: `git push origin develop`.

Prima comandă pe orice stație:
```
git fetch origin && git status && git log --oneline --graph --all -6
```
Trebuie să fii pe `develop`, curat, aliniat cu `origin/develop` (v3.9.751).

---

# CONTEXT — constatarea P0-03 din auditul extern v3.9.746

`POST /api/alop/:id/link-df-flow` (`server/routes/alop.mjs:1076`) scrie `df_flow_id` primit de la client **fără nicio validare**: nu verifică existența fluxului, organizația, starea lui (anulat/refuzat/șters) sau proveniența (dacă fluxul chiar aparține DF-ului acestui ALOP). `link-ord-flow` (`:1377`) are aceeași gaură, simetric.

Apoi `POST /api/alop/:id/df-completed` (`:1176`) cere DOAR `df_flow_id IS NOT NULL AND status='angajare'`, iar `ord-completed` (`:1421`) DOAR `ord_flow_id IS NOT NULL AND status='ordonantare'`. Rezultat: un utilizator autorizat pe ALOP poate avansa dosarul angajare→lichidare→…→plata **fără niciun document semnat**. Nu e exploit neautentificat (SELECT-ul e org-scopat + `canEditAlop`), e **risc de integritate financiară / insider** — exact ce contează la Curtea de Conturi.

## Fapte de cod deja verificate (folosește-le, nu le re-descoperi)

- Predicatele corecte EXISTĂ deja, scrise la #120 în `server/services/flow-link-audit.mjs` ca funcții PRIVATE: `validSignedFlowSql(alias)` și `liveFlowSql(alias)`. Ambele exclud `cancelled` ȘI `refused` cu `IS DISTINCT FROM` (NULL-safe) + `deleted_at IS NULL`. ⚠️ Excluderea NU e opțională: un flux ANULAT poate rămâne cu `data->>'completed'='true'` (incidentul PZ_8C34C4E842, 0/5 semnături). `completed` singur NU e dovadă de semnare.
- Legătura flux→document: `flows.data->'meta'->>'dfId'` / `->>'ordId'` (folosită în tot `flow-link-audit.mjs`).
- `flows` = `(id TEXT PK, data JSONB, org_id INTEGER, deleted_at TIMESTAMPTZ, …)`. `org_id` a fost adăugat prin migrație (linia 322) + FK (397); există ȘI `data->>'orgId'` (JSONB), citit de `flow-access.mjs:25`. Gate-ul de la #101 rulat pe producție a confirmat: **0 fluxuri fără orgId**.
- Calea AUTOMATĂ de legare (`server/routes/flows/crud.mjs:519`, „PASUL 4") e DEJA corectă prin construcție: `UPDATE alop_instances SET df_flow_id=$1 WHERE df_id = $2` cu `$2 = body.meta.dfId`. ⛔ NU o atinge în acest prompt.
- Calea manuală client-side e apelată din `public/js/semdoc-initiator/main.js:2310` (`_lnkFlow = _isDfFlow ? "link-df-flow" : "link-ord-flow"`), imediat după crearea fluxului — deci trimite EXACT fluxul cu `meta.dfId`/`meta.ordId` al documentului. Validarea nu rupe calea legitimă.
- Cazul „Fără DF" (incident 04.08, DF 417): `alop.df_id` poate fi NULL pe calea de semnare cloud, iar reataşarea se face prin `selfHealAlopDfLinkByAlop` (`alop-link.mjs:113`) la deschiderea ALOP-ului. Proveniența alternativă folosită acolo e `formulare_df.source_alop_id = alop.id`. ⇒ validarea TREBUIE să accepte și acest caz, altfel rupem recuperarea cloud.
- `df-completed` e un buton MANUAL (`alop.js:1013`, confirm „Marchezi DF-ul ca semnat complet?"). Calea automată legitimă e lazy auto-tranziția din `GET /api/alop/:id` (`alop.mjs` ~763), care derivă `df_aprobat` din flux. ⛔ NU atinge lazy auto-tranziția și NU atinge self-heal-urile — sunt căile de recuperare, derivă deja din flux.
- Debug rămas în producție: `console.log('🔗 LINK-DF-FLOW called:'…)` la `alop.mjs:1077` și `console.log('🔗 AUTO link-df-flow:'…)` la `crud.mjs:527`.

⛔ ZONĂ NO-TOUCH (neatinsă): `server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`.

===============================================================================
# ETAPA A — modul PUR + teste, ZERO cablare (poartă obligatorie)
===============================================================================

⛔ La finalul Etapei A, `git diff --stat` trebuie să arate DOAR fișiere NOI. Dacă a fost modificat vreun fișier existent, OPREȘTE-TE și raportează. Cablarea e Etapa B.

## Pas A1 — `server/services/flow-provenance.mjs` (NOU)

Modul pur (fără Express, fără `res`). Predicatele SQL se mută aici ca SURSĂ UNICĂ și se **re-exportă** — `flow-link-audit.mjs` le va importa la Pasul B4 în loc să le redeclare (⛔ fără copie-paste: două definiții ale aceluiași predicat = drift garantat).

Exporturi:

```js
export function liveFlowSql(alias = 'f')         // deleted_at IS NULL + NOT cancelled + NOT refused
export function validSignedFlowSql(alias = 'f')  // liveFlowSql + (status='completed' OR completed::boolean=true)
```
Ambele COPIATE BYTE-CU-BYTE din `flow-link-audit.mjs` (liniile ~21-38). ⛔ Nu „îmbunătăți" predicatul aici — orice schimbare de semantică ar afecta și auditul #120.

```js
/**
 * Poate fi legat fluxul `flowId` de ALOP-ul dat, ca flux de `kind`?
 * PUR ca decizie, dar interoghează DB (primește pool).
 * @returns {Promise<{ok:true} | {ok:false, status:number, body:object}>}
 */
export async function checkFlowLinkable(pool, { flowId, kind, alop, orgId })
```
`kind` = `'df'` | `'ord'`. `alop` = rândul deja încărcat în rută (are `id`, `df_id`, `ord_id`).

Regulile, în ordine, fiecare cu cod de eroare propriu (fail-CLOSED — orice ramură neacoperită întoarce refuz, niciodată `ok:true` implicit):

1. `flowId` gol / non-string → `400 flow_id_invalid`
2. fluxul nu există în `flows` → `404 flow_inexistent`
3. organizație diferită → `403 flow_alt_org`. Predicatul: `(f.org_id = $orgId OR f.data->>'orgId' = $orgId::text)`. Ambele NULL ⇒ REFUZ (fail-closed; producția are 0 astfel de fluxuri).
4. fluxul nu e „viu" (`liveFlowSql` fals: șters / anulat / refuzat) → `409 flux_anulat_sau_refuzat`
5. proveniență — fluxul trebuie să revendice documentul acestui ALOP. Pentru `kind='df'`, acceptă dacă ORICARE e adevărat:
   - `f.data->'meta'->>'dfId' = alop.df_id::text`
   - `alop.df_id IS NULL` ȘI `EXISTS (SELECT 1 FROM formulare_df fd WHERE fd.id::text = f.data->'meta'->>'dfId' AND fd.source_alop_id = alop.id AND fd.org_id = $orgId)` — cazul „Fără DF"/cloud, oglindind `selfHealAlopDfLinkByAlop`
   
   altfel → `403 flux_alt_document`.
   Pentru `kind='ord'`: identic, cu `meta.ordId`, `alop.ord_id`, `formulare_ord.source_alop_id`.
6. altfel `{ ok: true }`.

```js
/**
 * ALOP-ul are DOVADA semnării pentru faza `kind`? (poarta pentru df-completed/ord-completed)
 * @returns {Promise<{ok:true} | {ok:false, status:number, body:object}>}
 */
export async function checkFlowSigned(pool, { kind, alop, orgId })
```
- fluxul de pe ALOP (`alop.df_flow_id` / `alop.ord_flow_id`) lipsește → `400 flux_lipsa`
- fluxul nu satisface `validSignedFlowSql` → `409 document_nesemnat`, cu `message` în română: „Fluxul de semnare nu este finalizat. Dosarul nu poate avansa fără documentul semnat."
- fluxul nu satisface regula de proveniență (5) → `409 document_nesemnat` (același cod — nu divulgăm structura internă)
- altfel `{ ok: true }`

Fiecare `body` conține `{ error, message }`, mesajul în română, formulat pentru un funcționar (nu jargon).

## Pas A2 — `server/tests/unit/flow-provenance.test.mjs` (NOU)

Teste pe predicatele PURE (fragmentele SQL) — fără DB:
1. `liveFlowSql('x')` conține `deleted_at IS NULL`, `IS DISTINCT FROM 'cancelled'`, `IS DISTINCT FROM 'refused'` și folosește aliasul primit.
2. `validSignedFlowSql` include tot ce include `liveFlowSql` + ramura `completed`.
3. Echivalență cu #120: fragmentele întoarse sunt IDENTICE (după normalizarea spațiilor) cu cele din `flow-link-audit.mjs` — citește sursa cu `readFileSync` și compară. Testul ăsta e plasa care prinde driftul dacă cineva editează doar una din copii.
4. `checkFlowLinkable` cu `flowId` gol → `{ok:false, status:400}` FĂRĂ să atingă pool-ul (pasează un pool fals care aruncă la `query`).

## Poarta Etapei A
```
git diff --stat
# Așteptat: DOAR cele două fișiere NOI. Zero fișiere existente modificate.
npm test
# Așteptat: verde
```

===============================================================================
# ETAPA B — cablarea în alop.mjs
===============================================================================

## Pas B1 — `link-df-flow` (`server/routes/alop.mjs`, ~1076)

- Șterge linia de debug `console.log('🔗 LINK-DF-FLOW called:'…)`.
- Extinde SELECT-ul existent al ALOP-ului cu `id` (e nevoie de `alop.id` pentru regula de proveniență; azi selectează `created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari`).
- DUPĂ garda `canEditAlop` și ÎNAINTE de `UPDATE alop_instances SET df_flow_id=…`, inserează:
```js
const prov = await checkFlowLinkable(pool, {
  flowId: flow_id, kind: 'df', alop: alopRows[0], orgId: actor.orgId,
});
if (!prov.ok) {
  logger.warn({ alopId: req.params.id, flowId: flow_id, reason: prov.body.error },
    '[ALOP] link-df-flow REFUZAT (proveniență)');
  return res.status(prov.status).json(prov.body);
}
```
⛔ Restul rutei (copierea atașamentelor, flip-ul `formulare_df.status='transmis_flux'`, auto-lichidarea când fluxul e deja completat) rămâne NEATINS.

## Pas B2 — `link-ord-flow` (~1377)
Identic, cu `kind: 'ord'` și mesajul de log `link-ord-flow`.

## Pas B3 — `df-completed` (~1176) și `ord-completed` (~1421)

DUPĂ `canEditAlop`, ÎNAINTE de `UPDATE`, adaugă poarta de dovadă a semnării. Ruta are nevoie și de `df_flow_id`/`ord_flow_id` în SELECT-ul ALOP-ului (azi NU sunt selectate) — extinde SELECT-ul.
```js
const semnat = await checkFlowSigned(pool, { kind: 'df', alop: alopRows[0], orgId: actor.orgId });
if (!semnat.ok) {
  logger.warn({ alopId: req.params.id, reason: semnat.body.error },
    '[ALOP] df-completed REFUZAT (fără dovada semnării)');
  return res.status(semnat.status).json(semnat.body);
}
```
⛔ NU schimba `WHERE … AND status='angajare'` din UPDATE — rămâne poarta de stare (a doua apărare). ⛔ Pentru `ord-completed`, absorbția OPME de după UPDATE rămâne neatinsă.

## Pas B4 — dedup predicat în `flow-link-audit.mjs`
Șterge cele două funcții private `validSignedFlowSql`/`liveFlowSql` și importă-le din `flow-provenance.mjs`. ⛔ Zero schimbare de comportament — testul 3 din A2 o dovedește. Dacă importul creează ciclu de dependențe, OPREȘTE-TE și raportează (nu ar trebui: `flow-provenance` nu importă `flow-link-audit`).

## Pas B5 — curățenie debug
Șterge `console.log('🔗 AUTO link-df-flow:'…)` din `server/routes/flows/crud.mjs:527`. ⛔ DOAR linia de `console.log`; logica din jur rămâne.

===============================================================================
# ETAPA C — migrarea testelor care codifică permisivitatea
===============================================================================

⚠️ Testele PROPRII codifică azi comportamentul găurit — la fel ca lecția de la #105h. Ele TREBUIE migrate, nu ocolite. ⛔ Dacă un test devine roșu, întrebarea e „premisa testului era greșită?", nu „cum slăbesc garda?". Dacă un test roșu NU se explică prin premisă greșită, OPREȘTE-TE și raportează.

## Pas C1 — fixtura `seedFlow` (`server/tests/helpers/db-real.mjs:203`)
Azi inserează `data` fără `meta` și cu `org_id` opțional (default NULL) ⇒ după Etapa B, orice `link-*-flow` din teste ar fi refuzat cu `flow_alt_org`.
- Adaugă opțiunea `meta` (obiect, implicit `undefined`) care ajunge în `data.meta`.
- Păstrează semnătura și toate opțiunile existente (`id`, `completed`, `orgId`, `initEmail`, `docName`, `signers`) — retrocompatibil, apelanții care nu pasează `meta` primesc exact comportamentul de azi.
- Același tratament pentru `seedFlowApproved` (`:110`), care azi inserează FĂRĂ `org_id`: adaugă parametri opționali `{ orgId, meta }` păstrând apelul pozițional existent funcțional.

## Pas C2 — `server/tests/db/alop-progresie-stari.test.mjs`
Cazul de la liniile ~39-52 creează `seedFlow({ completed: false })` și așteaptă ca `df-completed` să întoarcă 200. Asta e EXACT permisivitatea reparată.
- Pasul 3 (link-df-flow) trebuie să pună `orgId: 1` și `meta: { dfId }` ca legarea să fie legitimă.
- Pasul 4 se ÎMPARTE în două:
  - flux `completed:false` ⇒ `df-completed` acum **409 `document_nesemnat`**, iar ALOP-ul rămâne `angajare` (verifică AMBELE);
  - apoi fluxul devine semnat (`UPDATE flows SET data = data || '{"status":"completed","completed":true}'` sau un al doilea flux legat corect) ⇒ `df-completed` → 200, `lichidare`, `df_completed_at` setat.
- Aceeași împărțire pentru `ord-completed` mai jos în același test.
- Restul progresiei (link-df, confirma-lichidare, idempotență) rămâne NEATINS.

## Pas C3 — teste NOI `server/tests/db/alop-flow-proveninta.test.mjs`
Importă din PRODUCȚIE (montează app-ul real), NU redeclara logica. Cazuri, fiecare pe `link-df-flow` ȘI pe `link-ord-flow`:
1. flux inexistent (`flow_id: 'nu-exista'`) → 404 `flow_inexistent`; `df_flow_id` rămâne NULL în DB.
2. flux dintr-o ALTĂ organizație → 403 `flow_alt_org` (pattern-ul cu două org-uri există deja: `alop-tranzitii-garzi.test.mjs:97` — `orgName: 'Org 2'` + email distinct; ⚠️ `seedOrgUser` are `orgName='Org Test'` implicit ⇒ două org-uri cu numele implicit calcă `organizations_name_key`).
3. flux ANULAT (`data.status='cancelled'`) dar cu `completed:true` → 409 `flux_anulat_sau_refuzat`. Cazul ăsta e miezul lecției din incidentul PZ_8C34C4E842.
4. flux care revendică ALT document (`meta.dfId` = alt DF) → 403 `flux_alt_document`.
5. POZITIV: flux corect (`org_id` potrivit + `meta.dfId = alop.df_id`) → 200 și `df_flow_id` setat.
6. POZITIV cazul cloud: `alop.df_id IS NULL` + flux cu `meta.dfId` care pointează la un DF cu `source_alop_id = alop.id` → 200 (recuperarea „Fără DF" nu se rupe).
7. `df-completed` cu flux legat legitim dar NEsemnat → 409 `document_nesemnat`, ALOP rămâne în `angajare`.
8. `df-completed` cu flux semnat valid → 200, `lichidare`.

## Pas C4 — restul suitei
Rulează TOATĂ suita DB și repară fixturile oricărui alt test care lega fluxuri fără `meta`/`org_id`. Enumeră în raport fiecare fișier atins și motivul.

===============================================================================
# ETAPA D — versionare, rulare, push
===============================================================================

## Pas D1 — `package.json`: `3.9.751` → `3.9.752`.
⛔ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=` — acest prompt nu atinge niciun fișier din `public/`.

## Pas D2 — rulare completă (poartă înainte de push)
```
npm test
# Așteptat: verde

# test:db REAL — rețeta PG 17 efemeră din CLAUDE.md (port propriu, parolă proprie, curățare la final):
npm run test:db
# Așteptat: PASSED REAL (NU „skipped"), inclusiv fișierul nou
```
⚠️ „Docker absent" NU e motiv de skip. Skipped ≠ passed. Căile astea sunt pur DB — un mock pe `pool.query` ar testa forma, nu comportamentul.

## Pas D3 — commit + push
```
git add -A
git commit -m "fix(#122): P0-03 — validare proveniență flux la link-df-flow/link-ord-flow + dovada semnării la df-completed/ord-completed — v3.9.752"
git push origin develop
```

===============================================================================
# RAPORT FINAL (completează după rulare)
===============================================================================
- Commit hash (develop): __________ · push: __________
- POARTA Etapei A — `git diff --stat` după A2 arăta DOAR fișiere noi? (da/nu): __________
- `npm test`: ____ fișiere / ____ teste (verde? da/nu)
- `npm run test:db`: ____ fișiere / ____ teste — PASSED REAL? (da/nu; „skipped" = NEACCEPTAT)
- Coduri de eroare implementate (flow_inexistent / flow_alt_org / flux_anulat_sau_refuzat / flux_alt_document / document_nesemnat): __________
- Cazul cloud „Fără DF" (`alop.df_id IS NULL` + `source_alop_id`) — testul 6 din C3 e VERDE? __________
- B4: predicatele sunt acum definite O SINGURĂ dată (flow-link-audit importă din flow-provenance)? __________
- Teste migrate la Etapa C — listă fișiere + ce premisă era greșită în fiecare: __________
- Cele două `console.log` de debug șterse (alop.mjs, crud.mjs)? __________
- Abateri de la prompt + motiv: __________

===============================================================================
# ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================
- ⛔ EXCLUSIV `develop`. Pasul final = `git push origin develop`.
- ⛔ Zona NO-TOUCH de semnare neatinsă.
- ⛔ FĂRĂ migrații. FĂRĂ atingerea vreunui fișier din `public/`.
- ⛔ NU atinge lazy auto-tranziția din `GET /api/alop/:id`, `selfHealAlopDfLink*`, sau PASUL 4 din `crud.mjs:519` — sunt căile de recuperare și derivă DEJA din flux.
- ⛔ NU slăbi garda ca să treacă un test. Un test roșu se explică prin premisă greșită sau se raportează.
- ⛔ Fail-CLOSED peste tot: orice ramură neacoperită = refuz, niciodată acceptare implicită. Nicio eroare înghițită tăcut (`catch` care lasă legarea să treacă).
- ⛔ `test:db` PASSED REAL, nu SKIPPED.
- ⛔ Citește fiecare fișier ÎNAINTE de patch; `old_str` unic (whitespace inclus).
