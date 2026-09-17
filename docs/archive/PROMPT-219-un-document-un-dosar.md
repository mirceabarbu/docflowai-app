---
prompt: 219
titlu: "ALOP — „un document, un dosar" întărit pe căile care încă aleg un dosar arbitrar (flux, semnare, tranziții leneșe, buget) + detecție în auditul de legături"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: "cea din package.json (v3.9.871 după #218)"
versiune_tinta: "următorul patch după versiunea curentă din package.json"
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA — `js/admin/audit.js` (E ÎN PRECACHE ⇒ `CACHE_VERSION` OBLIGATORIU) + `?v=` în `admin.html`
zona_no_touch_atinsa: NU — `cloud-signing.mjs` și `bulk-signing.mjs` NU se ating; `signing.mjs` NU e în listă
tip: întărire (apărare în adâncime) după incidentul #215 + teste care forțează starea coruptă
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

La 16.09.2026, ORD 47842 (RATBV) a ajuns legat de două dosare ALOP (RATBV, corect, și CONSUM
CARBURANT, greșit). Datele au fost reparate (SQL-215 R1), iar #215 a închis **singura cale de scriere**:
`link-ord`/`link-df` refuză acum legarea unui document de alt dosar decât cel din care provine.

Rămân **consumatorii** care, dacă starea coruptă reapare (altă cale de scriere viitoare, un SQL de mână,
o regresie a gărzii), aleg un dosar **arbitrar** sau le tratează pe toate. Au fost raportați ca
colaterale de agentul #215 și verificați pe cod:

| # | Loc | Ce face azi cu două dosare pe același document |
|---|---|---|
| A | `flows/crud.mjs` ~600 și ~627 | `UPDATE alop_instances SET df_flow_id/ord_flow_id … WHERE df_id/ord_id = $2` ⇒ fluxul ajunge pe **toate** dosarele |
| B | `flows/signing.mjs` ~491-510 | `SELECT … WHERE df_flow_id/ord_flow_id = $1` fără `ORDER BY`, apoi `rows[0]` ⇒ **un singur dosar, arbitrar**, trece în lichidare/plată |
| C | `alop.mjs` GET detaliu ~895 și ~1087 | tranziția leneșă (calea STS cloud) se bazează pe `df_aprobat`/`ord_aprobat` ale documentului legat ⇒ dosarul greșit **trece în lichidare/plată** și își resincronizează `ord_flow_id` |
| D | `formular-shared.mjs` `resolveAlopIdForBudget` | `WHERE a.ord_id = $1 … LIMIT 1` ⇒ plafonul bugetar al ORD-ului se poate calcula pe **alt dosar** |

⭐ Calea STS cloud (majoritatea semnărilor din producție) **nu** tranziționează dosarul din
`cloud-signing.mjs` (NO-TOUCH); tranziția se face leneș, la deschiderea dosarului (C). De aceea C și A
sunt cele mai importante.

## Regula

**Proveniența decide.** `formulare_ord.source_alop_id` / `formulare_df.source_alop_id` sunt scrise la
creare și nu se mută; în producție toate ORD-urile din iulie–septembrie le au (SQL-215 Q4).

- Document **cu** proveniență ⇒ doar dosarul din proveniență e afectat.
- Document **fără** proveniență (vechi) ⇒ comportamentul de azi, neschimbat (nu avem criteriu).
- Ambiguitate reală (mai multe dosare, niciunul nu e cel din proveniență, sau fără proveniență pe
  calea B) ⇒ **nicio tranziție** + `logger.error` — mai bine un dosar blocat, vizibil în audit, decât o
  plată pe dosarul greșit.

Plus **detecție**: o clasă nouă în auditul de legături document↔flux (`flow-link-audit.mjs`), ca starea
coruptă să apară în dashboard-ul admin în loc să fie descoperită de utilizatori.

## Ce NU face lotul (decizii)

- ⛔ **Nu** adaugă index unic pe `alop_instances(ord_id)` — migrație separată, cu risc propriu.
- ⛔ **Nu** schimbă curățarea contextului din browser la trecerea între tab-urile DF/ORD
  (`list.js:~677`). Contextul e folosit legitim la „dosar → Completează ORD"; #215 neutralizează deja
  contextul rămas (server 409 + uitare în browser). O schimbare acolo riscă fluxul corect.
- ⛔ `signing.mjs` ~219 (refuzul fluxului ORD, `LIMIT 1`): după A, un flux nu mai ajunge pe două
  dosare. Rămâne neatins; raportează-l la colaterale.

---

# ETAPA 0 — ancore (READ-ONLY, raportează valorile OBȚINUTE)

```bash
git branch --show-current
grep '"version"' package.json

grep -n "SET df_flow_id = \$1, updated_at = NOW()" -A2 server/routes/flows/crud.mjs
grep -n "SET ord_flow_id = \$1, updated_at = NOW()" -A2 server/routes/flows/crud.mjs
grep -n "alopDf.rows\[0\]\|alopOrd.rows\[0\]" server/routes/flows/signing.mjs
grep -n "import { selfHealAlopDfLink }" server/routes/flows/signing.mjs
grep -n "AS ord_authoritative_flow_id\|AS df_authoritative_flow_id" server/routes/alop.mjs
grep -n "if (alop.ord_aprobat && alop.status === 'ordonantare')\|if (alop.df_aprobat && \['draft', 'angajare'\]" server/routes/alop.mjs
grep -n "export async function resolveAlopIdForBudget" -A20 server/services/formular-shared.mjs
grep -n "CLASS_KEYS\|pointer_alt_flux" server/services/flow-link-audit.mjs public/js/admin/audit.js
grep -n "js/admin/audit.js" public/sw.js public/admin.html
grep -n "CACHE_VERSION =" public/sw.js

# NO-TOUCH: confirmă că niciunul nu conține tranziții ALOP care ar trebui atinse aici
grep -n "alop_instances" server/routes/flows/cloud-signing.mjs server/routes/flows/bulk-signing.mjs
```

⭐ Dacă `cloud-signing.mjs` sau `bulk-signing.mjs` scriu în `alop_instances`, **OPREȘTE-TE și
raportează** — lotul presupune că nu.

⭐ Testele care ancorează pe textul SQL al acestor interogări:
```bash
grep -rn "df_flow_id = \$1\|ord_flow_id = \$1\|WHERE a.ord_id = \$1\|ord_authoritative_flow_id\|alopOrd.rows\|alopDf.rows" server/tests --include=*.mjs
```
Raportează. Fragmentele ancorate rămân caracter cu caracter; condițiile noi vin pe linii noi.

---

# ⭐ ETAPA T — testele ÎNTÂI, pe codul NEREPARAT

`server/tests/db/alop-un-document-un-dosar.test.mjs` (nou). Seed-urile după
`alop-link-alt-dosar.test.mjs` (#215), `flow-link-audit.test.mjs`, `ord-buget-cicluri-corelare.test.mjs`.

**Starea coruptă se forțează direct în bază** (`UPDATE alop_instances SET ord_id=…`), ocolind
`link-ord` — exact ce testăm e comportamentul consumatorilor când garda de scriere a fost ocolită.
Dosarul **greșit (B) se creează ÎNAINTEA celui corect (A)**, ca un `LIMIT 1` fără ordine să aibă șanse
reale să-l aleagă pe B.

**A — legarea fluxului la creare**
1. ⭐ ORD cu `source_alop_id = A`; A (`ordonantare`) și B (`lichidare`) au amândouă `ord_id = ORD`.
   `POST /flows` cu `meta.ordId = ORD` ⇒ `A.ord_flow_id` = fluxul, **`B.ord_flow_id` rămâne NULL**.
2. Același scenariu, ORD **fără** proveniență ⇒ ambele primesc fluxul (comportament neschimbat, documentat).
3. ⭐ DF cu `source_alop_id = A`; A (`angajare`) și B (`draft`) cu `df_id = DF`. `POST /flows` cu
   `meta.dfId` ⇒ doar A primește `df_flow_id`.

**B — alegerea dosarului la finalizarea semnării (helper nou, testat direct)**
4. ⭐ `pickAlopForFlow(pool, rows, { flowId, formType })`:
   - `[]` ⇒ `undefined`;
   - un singur rând ⇒ acel rând (comportamentul de azi, fără filtrare);
   - `[B, A]` și documentul cu `flow_id = flowId` are `source_alop_id = A` ⇒ **A**;
   - `[B, A]` și documentul fără proveniență ⇒ **`null`** + `logger.error` (spion pe logger);
   - `[B, A]` cu proveniență spre un al treilea dosar ⇒ **`null`**.
   Pentru `df` și `ord`.
5. ⭐ Static: `signing.mjs` cheamă `pickAlopForFlow` pentru ambele tipuri și nu mai conține
   `alopDf.rows[0]` / `alopOrd.rows[0] ||`.

**C — tranzițiile leneșe din GET detaliu**
6. ⭐ ORD aprobat (flux completed) cu `source_alop_id = A`; A și B în `ordonantare`, amândouă cu
   `ord_id = ORD`. `GET /api/alop/B` ⇒ B **rămâne `ordonantare`**, `ord_flow_id` neschimbat.
   `GET /api/alop/A` ⇒ A trece în `plata` (neregresie).
7. ⭐ Echivalentul DF: DF aprobat cu `source_alop_id = A`; B în `angajare` cu `df_id = DF` ⇒ B rămâne
   `angajare`; A trece în `lichidare`.
8. Neregresie documente vechi: ORD aprobat **fără** proveniență, un singur dosar ⇒ trece în `plata`.

**D — plafonul bugetar**
9. ⭐ Două dosare pe același ORD (B creat primul), proveniența = A ⇒ `resolveAlopIdForBudget` întoarce
   **A**. Același lucru când ORD-ul e doar în ciclurile arhivate ale ambelor.
   (Dacă e verde pe codul vechi din cauza ordinii fizice a rândurilor, raportează — testul rămâne ca gardă.)

**E — detecția**
10. ⭐ `findFlowLinkDivergences`: scenariul 1 (proveniență A, B greșit) ⇒ `byClass.document_alt_dosar = 1`,
    rândul are `alop_id = B`. Scenariul fără proveniență (A și B) ⇒ 2. Bază curată ⇒ 0. DF: la fel.
11. `byClass` conține cheia nouă chiar și când e 0.

**Rulare pe codul nereparat:**
```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/alop-un-document-un-dosar.test.mjs
```
⭐ Raportează roșiile **ÎNAINTE** de patch. Așteptat roșii: 1, 3, 4, 5, 6, 7, 9 (posibil), 10, 11.
Verzi: 2, 8.

---

# ETAPA A — `flows/crud.mjs`: fluxul ajunge doar pe dosarul din proveniență

**A.1 — DF.** `old_str`:
```js
         SET df_flow_id = $1, updated_at = NOW()
         WHERE df_id = $2 AND df_flow_id IS NULL AND cancelled_at IS NULL`,
```
`new_str`:
```js
         SET df_flow_id = $1, updated_at = NOW()
         WHERE df_id = $2 AND df_flow_id IS NULL AND cancelled_at IS NULL
           AND id = COALESCE((SELECT source_alop_id FROM formulare_df WHERE id = $2), id)`,
```

**A.2 — ORD.** `old_str`:
```js
         SET ord_flow_id = $1, updated_at = NOW()
         WHERE ord_id = $2 AND ord_flow_id IS NULL AND cancelled_at IS NULL`,
```
`new_str`:
```js
         SET ord_flow_id = $1, updated_at = NOW()
         WHERE ord_id = $2 AND ord_flow_id IS NULL AND cancelled_at IS NULL
           AND id = COALESCE((SELECT source_alop_id FROM formulare_ord WHERE id = $2), id)`,
```

Deasupra fiecărui `pool.query` (în JS, nu în SQL), un comentariu scurt: #219 — dacă documentul are
proveniență, fluxul se leagă doar de dosarul din care provine; fără proveniență, ca înainte
(`COALESCE(…, id)` ⇒ condiție mereu adevărată).

⚠️ `$2` e același parametru; nu se adaugă parametri. Numărul de interogări pe calea `POST /flows` nu se
schimbă (subinterogările sunt în aceeași instrucțiune) ⇒ testele mock cu `mockResolvedValueOnce` nu se
decalează. Confirmă cu `npm test`.

---

# ETAPA B — `flows/signing.mjs`: alegere deterministă la finalizare

## B.1 — helperul, în `server/services/alop-link.mjs`, la finalul fișierului

```js

/**
 * #219 — Alege dosarul ALOP de tranziționat la finalizarea unui flux, dintre rândurile găsite pe
 * `df_flow_id`/`ord_flow_id`. Un flux ar trebui să fie pe UN SINGUR dosar; dacă sunt mai multe
 * (stare coruptă — incidentul ORD 47842), decide proveniența documentului semnat.
 *
 *   0 rânduri                 ⇒ undefined (apelantul își poate continua fallback-ul)
 *   1 rând                    ⇒ acel rând (comportamentul dinainte, fără filtrare)
 *   >1, proveniența potrivită ⇒ rândul din proveniență
 *   >1, altfel                ⇒ null + logger.error (NICIO tranziție: mai bine blocat decât greșit)
 *
 * @param {{ query: Function }} pool
 * @param {Array<{id:string,status:string}>} rows
 * @param {{ flowId: string, formType: 'df'|'ord' }} ctx
 */
export async function pickAlopForFlow(pool, rows, { flowId, formType }) {
  if (!rows || rows.length === 0) return undefined;
  if (rows.length === 1) return rows[0];
  const table = formType === 'ord' ? 'formulare_ord' : 'formulare_df';
  let src = null;
  try {
    const { rows: d } = await pool.query(
      `SELECT source_alop_id FROM ${table} WHERE flow_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [flowId]
    );
    src = d?.[0]?.source_alop_id || null;
  } catch (e) {
    logger.error({ err: e, flowId, formType }, '[ALOP] pickAlopForFlow: proveniența nu a putut fi citită');
  }
  const hit = src ? rows.find(r => String(r.id) === String(src)) : null;
  if (hit) {
    logger.error({ flowId, formType, alopIds: rows.map(r => r.id), ales: hit.id },
      '[ALOP] fluxul e pe MAI MULTE dosare — ales dosarul din proveniență (#219)');
    return hit;
  }
  logger.error({ flowId, formType, alopIds: rows.map(r => r.id), sourceAlopId: src },
    '[ALOP] fluxul e pe MAI MULTE dosare și proveniența nu decide — NICIO tranziție (#219)');
  return null;
}
```

⚠️ `table` vine dintr-o listă închisă (două valori), nu din input.

⭐ **Gardă existentă care va pica — și e intenționat să pice:** `server/tests/unit/sql-fragmente-fara-backtick.test.mjs`
parcurge toate exporturile din `alop-link.mjs` și cere ca fiecare funcție nouă să fie ori invocată, ori
**exclusă explicit, cu motiv**. Asta e mecanismul proiectat (decizie conștientă), nu o regresie. Adaugă
în `EXCLUSIONS`, lângă celelalte patru intrări `alop-link.mjs`:

```js
  { module: 'alop-link.mjs', export: 'pickAlopForFlow', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },
```

și actualizează comentariul de deasupra („toate patru" → „toate cinci"). E **singura** modificare
permisă într-un test preexistent în acest lot; raportează-o.

## B.2 — importul în `signing.mjs`

`old_str`:
```js
import { selfHealAlopDfLink } from '../../services/alop-link.mjs';
```
`new_str`:
```js
import { selfHealAlopDfLink, pickAlopForFlow } from '../../services/alop-link.mjs';
```

## B.3 — DF

`old_str`:
```js
            if (alopDf.rows[0]) {
              const al = alopDf.rows[0];
```
`new_str`:
```js
            // #219 — un flux pe mai multe dosare nu mai tranziționează un dosar arbitrar.
            const al = await pickAlopForFlow(pool, alopDf.rows, { flowId, formType: 'df' });
            if (al) {
```

## B.4 — ORD

`old_str`:
```js
            const alopOrdRow = alopOrd.rows[0] || (await pool.query(
```
`new_str`:
```js
            // #219 — `undefined` (niciun dosar pe ord_flow_id) păstrează fallback-ul pe ciclurile
            // arhivate; `null` (ambiguitate nerezolvată) înseamnă NICIO tranziție.
            const _ordPick = await pickAlopForFlow(pool, alopOrd.rows, { flowId, formType: 'ord' });
            const alopOrdRow = _ordPick !== undefined ? _ordPick : (await pool.query(
```

⚠️ Verifică acoladele după B.3 (blocul `if (al) { … }` trebuie să se închidă exact unde se închidea
`if (alopDf.rows[0]) { … }`) cu `node --check` și raportează.

---

# ETAPA C — `alop.mjs`: tranzițiile leneșe respectă proveniența

**C.1 — proiecția.** `old_str`:
```js
        df.flow_id                   AS df_authoritative_flow_id,
```
`new_str`:
```js
        df.flow_id                   AS df_authoritative_flow_id,
        df.source_alop_id            AS df_source_alop_id,
```

`old_str`:
```js
        fo.flow_id                   AS ord_authoritative_flow_id,
```
`new_str`:
```js
        fo.flow_id                   AS ord_authoritative_flow_id,
        fo.source_alop_id            AS ord_source_alop_id,
```

⚠️ Confirmă că aliasurile `df` și `fo` din acea interogare sunt `formulare_df` / `formulare_ord` ale
pointerilor curenți ai dosarului, și că `df_source_alop_id` / `ord_source_alop_id` nu există deja ca
nume de coloană în rezultat.

**C.2 — DF.** `old_str`:
```js
    if (alop.df_aprobat && ['draft', 'angajare'].includes(alop.status)) {
```
`new_str`:
```js
    // #219 — un DF aprobat care provine din ALT dosar nu mută acest dosar în lichidare.
    const _dfDinDosar = alop.df_source_alop_id == null || String(alop.df_source_alop_id) === String(alop.id);
    if (!_dfDinDosar && alop.df_aprobat) {
      logger.error({ alopId: alop.id, dfSourceAlopId: alop.df_source_alop_id },
        '[ALOP] DF aprobat din ALT dosar pe acest dosar — tranziție leneșă oprită (#219)');
    }
    if (_dfDinDosar && alop.df_aprobat && ['draft', 'angajare'].includes(alop.status)) {
```

**C.3 — ORD.** `old_str`:
```js
    if (alop.ord_aprobat && alop.status === 'ordonantare') {
```
`new_str`:
```js
    // #219 — un ORD aprobat care provine din ALT dosar nu mută acest dosar în plată și nu îi
    // resincronizează ord_flow_id (incidentul ORD 47842: dosarul greșit ar fi trecut în plată).
    const _ordDinDosar = alop.ord_source_alop_id == null || String(alop.ord_source_alop_id) === String(alop.id);
    if (!_ordDinDosar && alop.ord_aprobat) {
      logger.error({ alopId: alop.id, ordSourceAlopId: alop.ord_source_alop_id },
        '[ALOP] ORD aprobat din ALT dosar pe acest dosar — tranziție leneșă oprită (#219)');
    }
    if (_ordDinDosar && alop.ord_aprobat && alop.status === 'ordonantare') {
```

⚠️ Verifică dacă `alop.id` e disponibil în acel punct (sau folosește `req.params.id`, ca în UPDATE-ul
existent) și raportează ce ai folosit.

---

# ETAPA D — `formular-shared.mjs`: plafonul pe dosarul din proveniență

**D.1** — `old_str`:
```js
      `SELECT a.id FROM alop_instances a
        WHERE a.ord_id = $1 AND a.org_id = $2 AND a.cancelled_at IS NULL
        LIMIT 1`, [ordId, orgId]);
```
`new_str`:
```js
      `SELECT a.id FROM alop_instances a
        WHERE a.ord_id = $1 AND a.org_id = $2 AND a.cancelled_at IS NULL
        ORDER BY (a.id = (SELECT fo.source_alop_id FROM formulare_ord fo WHERE fo.id = $1)) DESC NULLS LAST,
                 a.created_at
        LIMIT 1`, [ordId, orgId]);
```

**D.2** — `old_str`:
```js
      `SELECT a.id FROM alop_ord_cicluri c
         JOIN alop_instances a ON a.id = c.alop_id
        WHERE c.ord_id = $1 AND a.org_id = $2 AND a.cancelled_at IS NULL
        LIMIT 1`, [ordId, orgId]);
```
`new_str`:
```js
      `SELECT a.id FROM alop_ord_cicluri c
         JOIN alop_instances a ON a.id = c.alop_id
        WHERE c.ord_id = $1 AND a.org_id = $2 AND a.cancelled_at IS NULL
        ORDER BY (a.id = (SELECT fo.source_alop_id FROM formulare_ord fo WHERE fo.id = $1)) DESC NULLS LAST,
                 c.ciclu_nr DESC
        LIMIT 1`, [ordId, orgId]);
```

Actualizează docblock-ul funcției cu o frază: #219 — la mai multe dosare pe același ORD, câștigă cel din
proveniență. ⛔ Pasul 2 (proveniența DF) și fallback-urile rămân neatinse.

---

# ETAPA E — detecția: clasa `document_alt_dosar`

**E.1 — `server/services/flow-link-audit.mjs`, cheia.** `old_str`:
```js
const CLASS_KEYS = ['doc_fara_flux', 'alop_fara_flux', 'alop_fara_document', 'fluxuri_paralele', 'pointer_alt_flux'];
```
`new_str`:
```js
const CLASS_KEYS = ['doc_fara_flux', 'alop_fara_flux', 'alop_fara_document', 'fluxuri_paralele', 'pointer_alt_flux', 'document_alt_dosar'];
```

**E.2 — detectorii**, la sfârșitul listei. `old_str`:
```js
         AND ${validSignedFlowSql('fv')}${orgCond('d')}` },
  ];
```
`new_str`:
```js
         AND ${validSignedFlowSql('fv')}${orgCond('d')}` },
    // ── F — document_alt_dosar (#219) ────────────────────────────────────────
    // Documentul curent al unui dosar activ provine din ALT dosar, sau (fără proveniență) e pe
    // mai multe dosare active. Doar dosarele GREȘITE apar când proveniența decide.
    // Incidentul ORD 47842 (16.09.2026).
    { clasa: 'document_alt_dosar', sql: `
      SELECT 'document_alt_dosar'::text AS clasa, 'ord'::text AS tip, d.id::text AS doc_id,
             d.nr_ordonant_pl AS doc_nr, a.id::text AS alop_id, a.ord_flow_id AS flux,
             (CASE WHEN d.source_alop_id IS NOT NULL
                   THEN 'ORD legat de un dosar ALOP diferit de cel din care provine'
                   ELSE 'ORD fără proveniență legat de mai multe dosare ALOP active' END)::text AS detaliu
        FROM formulare_ord d
        JOIN alop_instances a ON a.ord_id = d.id AND a.cancelled_at IS NULL
       WHERE d.deleted_at IS NULL
         AND (   (d.source_alop_id IS NOT NULL AND d.source_alop_id <> a.id)
              OR (d.source_alop_id IS NULL AND EXISTS (
                    SELECT 1 FROM alop_instances a2
                     WHERE a2.ord_id = d.id AND a2.id <> a.id AND a2.cancelled_at IS NULL)))${orgCond('d')}` },
    { clasa: 'document_alt_dosar', sql: `
      SELECT 'document_alt_dosar'::text AS clasa, 'df'::text AS tip, d.id::text AS doc_id,
             d.nr_unic_inreg AS doc_nr, a.id::text AS alop_id, a.df_flow_id AS flux,
             (CASE WHEN d.source_alop_id IS NOT NULL
                   THEN 'DF legat de un dosar ALOP diferit de cel din care provine'
                   ELSE 'DF fără proveniență legat de mai multe dosare ALOP active' END)::text AS detaliu
        FROM formulare_df d
        JOIN alop_instances a ON a.df_id = d.id AND a.cancelled_at IS NULL
       WHERE d.deleted_at IS NULL
         AND (   (d.source_alop_id IS NOT NULL AND d.source_alop_id <> a.id)
              OR (d.source_alop_id IS NULL AND EXISTS (
                    SELECT 1 FROM alop_instances a2
                     WHERE a2.df_id = d.id AND a2.id <> a.id AND a2.cancelled_at IS NULL)))${orgCond('d')}` },
  ];
```

⚠️ Verifică tipul coloanelor `flux` în celelalte detectoare (text) și că `UNION`-ul implicit din
numărătoare/rânduri acceptă `a.ord_flow_id`/`a.df_flow_id` (TEXT). Actualizează docblock-ul modulului
cu o frază despre clasa F. ⭐ Detectorul rămâne **read-only**.

**E.3 — `public/js/admin/audit.js`**, două locuri.

`old_str`:
```js
                if (_bc.pointer_alt_flux)  _parts.push('pointer greșit: ' + _bc.pointer_alt_flux);
```
`new_str`:
```js
                if (_bc.pointer_alt_flux)  _parts.push('pointer greșit: ' + _bc.pointer_alt_flux);
                if (_bc.document_alt_dosar) _parts.push('document pe alt dosar: ' + _bc.document_alt_dosar);
```

`old_str`:
```js
        pointer_alt_flux:   'Document legat de alt flux decât cel semnat',
```
`new_str`:
```js
        pointer_alt_flux:   'Document legat de alt flux decât cel semnat',
        document_alt_dosar: 'Document legat de alt dosar ALOP decât cel din care provine',
```

⚠️ Dacă există un test pe cheile/etichetele auditului (ex. un test care compară `CLASS_KEYS` cu
`CLASS_LABEL`), actualizează-l **doar** prin adăugarea cheii noi și raportează.

---

# ETAPA F — suitele

```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/alop-un-document-un-dosar.test.mjs
npm test
npm run test:db
```

⚠️ **Secvențial, complet.** Verdictul din **output real**, cu numărul de fișiere confruntat cu discul.
⛔ O rulare `test:db` întreruptă nu e verdict — o reiei.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Candidați: testele
`flow-link-audit` (număr de clase), mock-urile pe `POST /flows`, testele GET detaliu ALOP care seedează
dosare cu documente fără proveniență.

⭐ Neregresie citată: `flow-link-audit.test.mjs`, `alop-link-alt-dosar.test.mjs` (#215),
`alop-progresie-stari.test.mjs`, `df-alop-link-resilienta.test.mjs`, `ord-buget-cicluri-corelare.test.mjs`,
`admin-cancel-flow.test.mjs`, `flow-link-audit` + `sql-fragmente-fara-backtick`.

---

# ETAPA G — versiune, cache, commit

```bash
npm version <TINTA> --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json   # ≤ 4 linii

grep -n "js/admin/audit.js?v=" public/admin.html
NEW=<TINTA>
sed -i -E "s#(js/admin/audit\.js\?v=)[0-9.]+#\1${NEW}#g" public/admin.html
grep -n "js/admin/audit.js?v=" public/admin.html     # linia <script> întreagă

grep -n "CACHE_VERSION =" public/sw.js
```

⭐ `js/admin/audit.js` e în `PRECACHE_ASSETS` ⇒ **`CACHE_VERSION` se incrementează** (ex.
`docflowai-v309` → `docflowai-v310`; folosește valoarea reală + 1). Fără bump, dashboard-ul admin
rămâne pe fișierul vechi din service worker.

`git add` explicit. Arhivează ca `docs/archive/PROMPT-219-un-document-un-dosar.md`.

```
fix(#219): ALOP — „un document, un dosar" intarit pe caile de flux, semnare, tranzitii lenese si buget — v<TINTA>

Dupa incidentul ORD 47842 (un ORD pe doua dosare), #215 a inchis calea de
scriere. Raman consumatorii care, daca starea corupta reapare, aleg un dosar
arbitrar sau le trateaza pe toate:
- crud.mjs: df_flow_id/ord_flow_id ajungeau pe toate dosarele cu acel document
- signing.mjs: rows[0] fara ORDER BY la finalizare
- alop.mjs GET: tranzitia lenesa (calea STS cloud) muta dosarul gresit in
  lichidare/plata si ii resincroniza ord_flow_id
- resolveAlopIdForBudget: LIMIT 1 fara ordine

Regula: provenienta documentului (source_alop_id) decide; documentele vechi,
fara provenienta, se comporta ca inainte; ambiguitatea nerezolvata opreste
tranzitia cu logger.error. Detectie noua in auditul de legaturi:
clasa document_alt_dosar, afisata in dashboard-ul admin.

Fara migratii. NO-TOUCH neatins. Teste scrise intai, pe stare corupta
fortata direct in baza, rulate rosii pe codul nereparat.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancore obținute, inclusiv confirmarea că `cloud-signing.mjs`/`bulk-signing.mjs` nu scriu în `alop_instances`.
2. ⭐ Roșiile pe codul nereparat (și dacă testul 9 a fost verde din cauza ordinii rândurilor).
3. `node --check` pe `signing.mjs` și `alop.mjs` după B și C; ce ai folosit pentru id-ul dosarului în C.
4. Rezultatul fiecărui test nou, în special 1, 3, 4, 6, 7, 10.
5. Teste preexistente atinse: așteptat DOAR intrarea `EXCLUSIONS` din `sql-fragmente-fara-backtick.test.mjs` (plus, eventual, un test pe cheile auditului — raportat).
6. Numere reale `npm test` și `npm run test:db`, **complete**, secvențial.
7. `?v=` pe `audit.js` și `CACHE_VERSION` vechi → nou, cu dovadă.
8. Divergențe prompt ↔ cod — raportate, nereparate tăcut.
9. Colaterale observate — nereparate (inclusiv `signing.mjs:~219`).

# ⛔ CONSTRÂNGERI ABSOLUTE
- `develop` ONLY, apoi stop. Zero migrații, zero scrieri de date.
- ⛔ `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `STSCloudProvider.mjs`, `java-pades-client.mjs` — neatinse.
- ⛔ `list.js` (contextul din browser), `link-ord`/`link-df`, `noua-lichidare` — neatinse.
- Documentele fără proveniență: comportament bit-identic cu azi.
- Ambiguitate nerezolvată ⇒ nicio tranziție + `logger.error`. Niciodată o alegere arbitrară.
- Detectorul de audit rămâne read-only.
- Fragmentele SQL ancorate de teste — caracter cu caracter; condiții noi pe linii noi.
- `CACHE_VERSION` incrementat (audit.js e în PRECACHE). `?v=` țintit. `git add` explicit.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
