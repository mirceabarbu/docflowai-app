---
prompt: 100.2
titlu: "sec(ord): coloanele de identitate se DERIVĂ pe server din DF-ul legat — clientul nu mai e crezut"
model_suggested: Opus 4.8
branch: develop
zona: server/services/formular-shared.mjs, server/routes/formulare/ord.mjs, teste
versiune_tinta: v3.9.686
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.682)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`. NU atinge zona NO-TOUCH (semnare STS/PAdES).

---

## CONTEXT — ce a rămas descoperit după #100.1

**Regula de business:** *ORD-ul își ia codurile din DF-ul aprobat. Punct.*

La #100.1 am blocat cele patru coloane în UI (`readOnly` + „+" dezactivat). Ăsta e un fix pentru
**accident** — tab-through, typo, suprascriere din greșeală — și e valid.

**Nu e un control.** Un `readOnly` în DOM se șterge din devtools în trei secunde. Serverul
(`server/routes/formulare/ord.mjs:307`) acceptă în continuare orice valoare pe:

```
cod_angajament · indicator_angajament · program · cod_SSI
```

dintr-un PUT construit de mână. `codSsiValidate: false` pentru ORD (`formular-shared.mjs:144`), deci
nici măcar validarea Clasa 8 nu prinde nimic. Un `cod_SSI` fabricat ajunge în PDF-ul semnat și în
XML-ul către MF: bani publici ordonanțați la plată pe altă linie bugetară.

## Fix-ul — derivare, NU validare

⛔ **NU adăuga validare Clasa 8 pe ORD.** A fost respinsă explicit de owner și ar fi redundantă:
sursa (DF-ul) e deja validată la #98.

În schimb: **când ORD-ul are `df_id`, serverul ignoră ce trimite clientul pe cele 4 câmpuri și pune
ce scrie în `rows_ctrl`-ul DF-ului.** Nu validează. Nu refuză. Nu poate bloca un document. Doar
**nu mai crede clientul** pe câmpuri care, prin definiție, nu-i aparțin.

E același tipar ca `createFlow`, unde `initName`/`initEmail` se derivă server-side din actorul
autentificat în loc să fie acceptate din body.

---

## PAS 0 — RECON (read-only). Răspunde ÎNAINTE să scrii cod.

```bash
sed -n '160,190p' public/js/formular/list.js            # onDfSelect — prefill index-based, rând cu rând
sed -n '279,362p' server/routes/formulare/ord.mjs       # PUT — punctul de hook
sed -n '227,278p' server/routes/formulare/ord.mjs       # POST create — acceptă și `rows`, și `df_id`
grep -n "normalizeAngajamentRows" server/routes/formulare/ord.mjs
sed -n '28,50p'  server/services/angajament-normalize.mjs
grep -rn "rows_ctrl" server/routes/formulare/df.mjs | head
```

**Întrebarea care decide designul — răspunde explicit în raport:**

> `onDfSelect` (`list.js:176-184`) prepopulează **poziționale**: rândul *i* din ORD ia codurile din
> `rows_ctrl[i]`. Nu există cheie de corelare. Butonul „✕" (`.bdel`) a rămas **activ** și după #100.1.
>
> **Deci: poate un ORD legat să aibă mai puține rânduri decât `rows_ctrl`-ul DF-ului?**
> Verifică în producție/staging:
> ```sql
> SELECT o.id, jsonb_array_length(o.rows) AS ord_rows,
>        jsonb_array_length(d.rows_ctrl) AS df_rows
>   FROM formulare_ord o JOIN formulare_df d ON d.id = o.df_id
>  WHERE o.deleted_at IS NULL AND o.df_id IS NOT NULL
>    AND jsonb_array_length(o.rows) <> jsonb_array_length(d.rows_ctrl);
> ```
> **Dacă query-ul întoarce 0 rânduri** ⇒ corelarea pozițională e sigură ⇒ implementează Varianta A.
> **Dacă întoarce ≥1** ⇒ corelarea pozițională ar rescrie codurile pe rândul GREȘIT ⇒ **OPREȘTE-TE
> și raportează**. Nu improviza o corelare pe `cod_angajament` — aia e exact valoarea în care nu
> avem încredere. Owner-ul decide.

---

## PAS 1 — Varianta A: derivare pozițională, în `formular-shared.mjs`

```js
// SEC-100.2: cele 4 coloane de identitate ale ORD-ului sunt DERIVATE din DF, nu introduse.
// #100.1 le-a blocat în UI (readOnly) — dar un readOnly în DOM nu e un control de securitate.
// Aici serverul nu mai crede clientul: dacă ORD-ul are df_id, valorile vin din rows_ctrl.
// NU e validare: nu refuzăm nimic, nu ne uităm în clasa8_buget. Doar suprascriem.
export const ORD_IDENT_COLS = ['cod_angajament', 'indicator_angajament', 'program', 'cod_SSI'];

/**
 * @param {Array}  clientRows  rândurile din body (deja trecute prin normalizeAngajamentRows)
 * @param {Array}  ctrlRows    rows_ctrl al DF-ului legat
 * @returns {Array}            rândurile cu cele 4 coloane suprascrise din DF
 *
 * Corelare POZIȚIONALĂ — identică cu prefill-ul din onDfSelect (list.js:176).
 * Rândurile din ORD peste lungimea rows_ctrl (dacă apar) rămân NEATINSE: nu inventăm coduri.
 */
export function deriveOrdIdentityCols(clientRows, ctrlRows) {
  if (!Array.isArray(clientRows)) return clientRows;
  if (!Array.isArray(ctrlRows) || !ctrlRows.length) return clientRows;   // fără sursă ⇒ nu atingem
  return clientRows.map((row, i) => {
    const src = ctrlRows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    if (!src || typeof src !== 'object') return row;
    const out = { ...row };
    for (const k of ORD_IDENT_COLS) out[k] = src[k] ?? null;
    return out;
  });
}
```

⚠️ **`src[k] ?? null`, nu `src[k] || row[k]`.** Dacă DF-ul are câmpul gol, ORD-ul îl are gol. Un
fallback pe valoarea clientului ar redeschide exact gaura pe care o închidem.

⚠️ Ordinea contează: **întâi** `normalizeAngajamentRows` (#99, majuscule canonice), **apoi**
`deriveOrdIdentityCols`. Sursa (`rows_ctrl`) e deja normalizată la scrierea DF-ului — dar dacă
inversezi ordinea, normalizarea ar rula pe valorile clientului și le-ar „legitima" cosmetic.

---

## PAS 2 — Cablare: DOUĂ căi de scriere, nu una

**Ambele** intră pe `rows`. Dacă acoperi doar PUT-ul, POST-ul rămâne gaura.

**2a. PUT** (`ord.mjs:307`, imediat după `normalizeAngajamentRows`):

- `old_str`: `    if ('rows' in data) data.rows = normalizeAngajamentRows(data.rows);   // coduri canonice (OPME)`
- `new_str`:
```js
    if ('rows' in data) data.rows = normalizeAngajamentRows(data.rows);   // coduri canonice (OPME)
    // SEC-100.2: df_id-ul EFECTIV după acest PUT (body-ul îl poate schimba sau șterge).
    const _effDfId = ('df_id' in (req.body || {})) ? (req.body.df_id || null) : doc.df_id;
    if ('rows' in data && _effDfId) {
      const { rows: dfRows } = await pool.query(
        'SELECT rows_ctrl FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
        [_effDfId, actor.orgId]
      );
      if (dfRows.length) {
        const ctrl = Array.isArray(dfRows[0].rows_ctrl)
          ? dfRows[0].rows_ctrl
          : JSON.parse(dfRows[0].rows_ctrl || '[]');
        data.rows = deriveOrdIdentityCols(data.rows, ctrl);
      }
      // DF inexistent / alt org / șters ⇒ NU derivăm și NU blocăm. `df_id` e oricum
      // scris de FK-ul de mai jos; un ORD legat de un DF invalid e altă problemă, nu asta.
    }
```

⚠️ Query-ul are `org_id=$2` — derivarea **nu** trebuie să devină un canal de citire cross-tenant.

**2b. POST create** (`ord.mjs:~236`) — același tratament: dacă `body.df_id` e prezent **și** vine
și `rows`, derivă înainte de INSERT. Găsește linia `if ('rows' in data) data.rows = normalizeAngajamentRows(data.rows);`
din handlerul de creare (**nu** cea din PUT) și aplică același bloc, cu `body.df_id` în loc de `_effDfId`.

⚠️ **Nu factoriza cele două în încă un helper acum.** Sunt 12 linii, contextele diferă (`doc.df_id`
vs `body.df_id`), iar un helper prost tăiat aici e mai scump decât duplicarea.

---

## PAS 3 — Ce NU faci

- ⛔ **Nicio validare Clasa 8 pe ORD.** `codSsiValidate` rămâne `false`. Nu-l atinge.
- ⛔ **Niciun 400/422 nou.** Derivarea nu poate refuza un document. Dacă ești tentat să întorci o
  eroare pe undeva, te-ai abătut de la sarcină.
- ⛔ Nu atinge `submitFormular` / `completeFormular` / `linkFlowFormular`. Ele validează **rândurile
  deja salvate** — care, după acest prompt, sunt deja derivate corect la scriere.
- ⛔ Nu atinge coloanele de sume (col. 2–5). Alea **sunt** conținutul ORD-ului.
- ⛔ Zero modificări în `public/`. #100.1 a acoperit UI-ul.

---

## PAS 4 — Teste (⛔ IMPORTĂ din producție — nu redeclara logica)

**Unit** — `server/tests/unit/ord-derive-ident.test.mjs`, importând `deriveOrdIdentityCols` din
`formular-shared.mjs`:

1. client trimite `cod_SSI: '99.99.99'`, DF are `'20.01.30'` ⇒ rezultat `'20.01.30'` ← *testul care contează*
2. toate 4 coloanele sunt suprascrise, nu doar `cod_SSI`
3. coloanele de sume (`receptii`, `plati_anterioare`, `suma_ordonantata_plata`) rămân **neatinse**
4. DF-ul are câmpul gol/absent ⇒ ORD-ul primește `null`, **nu** valoarea clientului
5. `ctrlRows` gol sau `null` ⇒ rândurile clientului se întorc **neschimbate** (fără sursă, nu inventăm)
6. clientul trimite mai multe rânduri decât are `rows_ctrl` ⇒ surplusul rămâne neatins, fără crash
7. input-ul NU e mutat (`deriveOrdIdentityCols` întoarce obiecte noi — la fel ca `normalizeAngajamentRows`)

**DB** — `server/tests/db/ord-derive-ident.test.mjs`, Postgres real:

8. seed DF cu `rows_ctrl` + ORD legat prin `df_id`; PUT cu `rows` care conțin coduri fabricate
   ⇒ re-`SELECT` din `formulare_ord` ⇒ codurile persistate sunt **cele din DF** ← *dovada end-to-end*
9. PUT pe un ORD **fără** `df_id` ⇒ codurile clientului se salvează ca atare (nu blocăm ORD-uri libere)
10. PUT cu `df_id` care aparține **altui org** ⇒ nu se derivă nimic, nu se scurge nimic din DF-ul străin

⛔ Fixture-urile trec prin helperii existenți (`seedOrgUser` etc.), nu prin valori literale.
⛔ Verifică numele coloanelor în `server/db/index.mjs` înainte să scrii SQL.

---

## PAS 5 — Versiune

`package.json` → **v3.9.686**. **Zero fișiere în `public/`** ⇒ fără `?v=`, fără `CACHE_VERSION`.

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
sec(ord): coloanele de identitate derivate server-side din DF-ul legat (v3.9.686)
```

---

## RAPORT FINAL

1. **Query-ul din PAS 0**: câte ORD-uri au un număr de rânduri diferit de `rows_ctrl`-ul DF-ului?
   Lipește rezultatul. **Dacă e ≥1, te-ai oprit acolo?**
2. Ai cablat **ambele** căi (PUT **și** POST create)? `grep -n "deriveOrdIdentityCols" server/routes/formulare/ord.mjs` — trebuie **2** potriviri.
3. Ordinea: `normalizeAngajamentRows` **înainte** de `deriveOrdIdentityCols`? Arată liniile.
4. Query-ul pe `formulare_df` are `org_id=$2`? (Testul #10 o dovedește.)
5. Testul #1 (client trimite cod fabricat ⇒ persistă codul DF-ului) și testul #8 (end-to-end pe DB) — ambele verzi? Lipește.
6. Ai adăugat vreo validare, vreun 400, vreun 422? (**Răspunsul corect e NU.**) `git diff` — caută `status(4`.
7. `codSsiValidate` pentru ORD e tot `false`? `grep -n "codSsiValidate" server/services/formular-shared.mjs`
8. `git diff --name-only` — lipește. **Nimic** din `public/`. Nimic din `signing`/`pades`.
9. `npm test` și `npm run test:db` — **separat**, ambele verzi. Ambele rezultate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Derivare, nu validare.** Serverul suprascrie tăcut. Nu refuză niciodată.
- ⛔ `src[k] ?? null` — **fără** fallback pe valoarea clientului.
- ⛔ `codSsiValidate: false` pentru ORD rămâne neatins.
- ⛔ Zero cod în `public/`.
- ⛔ Zona NO-TOUCH (`cloud-signing`, `bulk-signing`, `pades`, `java-pades-client`, `STSCloudProvider`) — neatinsă.
