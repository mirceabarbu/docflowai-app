---
task: "#222 — Fluxul orfan: niciun flux pe un document generat nu mai poate porni fără să declare ce document revendică"
model_suggested: "Opus 5, efort high"
branch: develop
target_version: 3.9.876
migrations: none
touches_public: yes (js/admin/audit.js — ÎN PRECACHE_ASSETS ⇒ CACHE_VERSION obligatoriu; js/semdoc-initiator/main.js)
preexisting_tests_touched: 1, declarat (sql-fragmente-fara-backtick.test.mjs — MODULES + INVOCATIONS)
---

# ⛔ AVERTISMENT DE RAMURĂ

**Lucrezi EXCLUSIV pe `develop`.** `main` = PRODUCȚIE, gestionat MANUAL de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push origin main`.
Pasul final obligatoriu: `git push origin develop`.

# ⛔ ZONA NO-TOUCH (CLAUDE.md:71-79)

`server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`,
`server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`,
`server/signing/java-pades-client.mjs`. Dacă o modificare ar putea atinge fluxul STS
sau PAdES: **OPREȘTE și raportează**. Acest lot NU are ce căuta acolo.

===============================================================================

## 1. INCIDENTUL, MĂSURAT PE PRODUCȚIE (18.09.2026)

ORD 45301 apărea „✅ Completat" în listă deși fluxul lui era finalizat, cu 5/5
semnături și PDF semnat. Dosarul ALOP `16d86bd7-…` a stat blocat în `ordonantare`
din 21.08 până azi, deși ORD-ul fusese semnat pe 24.08 la 08:26.

**Cauza (măsurată, nu presupusă):** fluxul `PZ_2F1386A6E6`, `docName =
OrdonantarePlata_45301_20260821`, `completed = true`, dar `data.meta = {}`.

`public/js/semdoc-initiator/main.js:2416` construiește `meta` din
`prefill_doc_id` / `prefill_doc_type`, citite din query string **sau** din
`sessionStorage`. Când contextul se pierde (tab nou, alt calculator, refresh fără
parametri, drumul prin „Renunță", încărcare manuală a PDF-ului deja descărcat),
funcția întoarce `undefined`, iar `crud.mjs:489` stochează `meta: body.meta || {}`.

**Un flux cu `meta` gol e invizibil pentru TOATE gărzile existente**, fiindcă
fiecare dintre ele citește `meta`:

| Gardă | Linia | De ce nu vede |
|---|---|---|
| Poarta de lansare #170 | `crud.mjs:179` | `const docId = body.meta?.[metaKey]; if (!docId) continue;` |
| PASUL 3 (pointerul) | `crud.mjs:538/563` | `if (body.meta?.dfId && pool)` |
| PASUL 4 (legătura ALOP) | `crud.mjs:601/631` | idem |
| Garda de reinițiere #114/#171 | `flow-doc-claim.mjs` | `documenteRevendicate(data)` → `[]` |
| Auditul #120, toate cele 6 clase | `flow-link-audit.mjs` | `JOIN … f.data->'meta'->>'ordId' = d.id::text` |
| `finalizeDf…`, self-heal #1/#2, tranzițiile leneșe | — | `WHERE flow_id = $1`, iar pointerul nu există |

De aceea cardul „Consistență document↔flux" arăta **✅ 0** pe un document stricat.
Nu e o scăpare a auditului — e o clasă **structural în afara modelului lui**:
auditul compară două legături, iar aici a doua legătură nu s-a născut niciodată.

**Amploare măsurată (Q8, producție):** 2 fluxuri cu `meta` gol și `docName` pe
tiparul documentelor generate — `PZ_2F1386A6E6` (ORD 45301, finalizat, reparat
separat prin SQL) și `PZ_E38CA3BD3F` (`DocumentFundamentare_6744_20260707`,
**anulat**, 1/5 semnături, inofensiv). Nu e un accident unic: două apariții în
2,5 luni, pe ambele tipuri de document.

**Reparația de date NU face parte din acest lot** — se face separat, cu SQL și
backup (`SQL-222b`). Aici construim doar gărzile.

===============================================================================

## 2. CE CONSTRUIM

**(A) Adopția `meta` pe server, înainte de poarta #170.** Serverul recunoaște
tiparul de nume pe care tot el îl generează (`routes/formulare.mjs:1048`). Dacă
un `POST /flows` vine fără `dfId`/`ordId` dar cu un `docName` pe acel tipar,
serverul caută documentul după număr în organizația actorului:
- **exact o potrivire** ⇒ scrie `meta` el însuși și continuă;
- **zero sau ≥2** ⇒ **409**, fail-closed.

Efectul intenționat: **nu adăugăm o a doua poartă paralelă**, ci facem ca
cererea să treacă prin porțile care există deja. După adopție, poarta #170
verifică normal dacă documentul are deja un flux viu (inclusiv unul finalizat)
și refuză dacă da; PASUL 3 scrie pointerul; PASUL 4 leagă dosarul ALOP.

⚠️ Adopția se face la **LANSARE**, înainte de orice semnătură — NU re-leagă
niciodată un document deja semnat. Regula „un document semnat nu se re-leagă
tăcut" rămâne intactă.

**(B) Clasa G în auditul #120** — `flux_fara_document`: flux viu, pe tiparul
documentelor generate, fără `dfId` și fără `ordId`. Pur detecție, zero scrieri.
Închide permanent punctul orb, inclusiv pentru istoric.

**(C) Mesaj explicit în interfață** pentru 409-ul nou, pe modelul celui de la
#170 — altfel utilizatorul primește un cod brut și nu știe ce are de făcut.

===============================================================================

## 3. RECON — ÎNAINTE DE A SCRIE O LINIE

Rulează și **raportează** rezultatele. Dacă vreuna contrazice promptul,
**OPREȘTE-TE și raportează**; nu improviza.

```bash
# R1 — generatorul de nume (sursa tiparului)
sed -n '1044,1052p' server/routes/formulare.mjs
# Așteptat: `OrdonantarePlata_${...NrOrdonantPl...}_${ts}.pdf` și
#           `DocumentFundamentare_${...NrUnicInreg...}_${ts}.pdf`, ts = YYYYMMDD

# R2 — locul exact unde intră adopția (ÎNAINTE de bucla porții #170)
grep -n "for (const { metaKey, formType, eticheta } of DOC_KINDS)" server/routes/flows/crud.mjs
grep -n "const _fluxViuPeDoc = async" server/routes/flows/crud.mjs
# Așteptat: _fluxViuPeDoc ~153, bucla ~178. Adopția se inserează ÎNTRE ele.

# R3 — toate consumatoarele lui body.meta din POST /flows
grep -n "body.meta" server/routes/flows/crud.mjs
# Așteptat: validarea (~96-101), bucla porții (179), PASUL 3 (538, 563),
#           atașamente (592, 597), PASUL 4 (601, 631) și `meta: body.meta || {}` (489).
# ⇒ o SINGURĂ mutație a lui body.meta le alimentează pe toate. Asta e mecanismul.

# R4 — lista de module a porții anti-backtick
grep -n "const MODULES" -A 10 server/tests/unit/sql-fragmente-fara-backtick.test.mjs

# R5 — assets în PRECACHE + valorile ?v= CURENTE (nu le presupune din package.json)
grep -n "admin/audit.js" public/sw.js
grep -n "admin/audit.js?v=" public/admin.html
grep -n "semdoc-initiator/main.js?v=" public/semdoc-initiator.html
grep -n "CACHE_VERSION" public/sw.js | head -1
# Așteptat: audit.js E în PRECACHE_ASSETS; ?v= 3.9.872; semdoc 3.9.844; CACHE_VERSION v310
```

===============================================================================

## 4. PASUL 1 — modul pur nou: `server/services/flow-doc-name.mjs`

Sursă unică pentru „acest nume de fișier e al unui document generat de
platformă". Două forme ale ACELUIAȘI tipar (JS pentru rută, SQL pentru audit),
în același fișier, ca să nu poată deriva una de alta.

```js
/**
 * DocFlowAI — flow-doc-name.mjs  (#222)
 * ---------------------------------------------------------------------------
 * CE DOCUMENT GENERAT DE PLATFORMĂ E ÎN SPATELE UNUI `docName`.
 *
 * Tiparul e produs de `routes/formulare.mjs:1048`:
 *     OrdonantarePlata_<NrOrdonantPl>_<YYYYMMDD>.pdf
 *     DocumentFundamentare_<NrUnicInreg>_<YYYYMMDD>.pdf
 * Numărul e igienizat acolo cu /[^A-Za-z0-9_-]/g -> '_', deci poate conține '_';
 * de aceea grupul e LACOM și data (exact 8 cifre) se ancorează la final.
 *
 * ⛔ ZERO acces la baza de date, zero I/O — funcție pură. Interogările stau în rute.
 * ⛔ Fără backtick-uri în șirul SQL returnat: se interpolează în template literal-e
 *    la consumator (poarta tests/unit/sql-fragmente-fara-backtick.test.mjs).
 * ⚠️ Cele două forme (JS + SQL) trebuie să dea ACELAȘI verdict. Există un test DB
 *    care le confruntă pe aceleași fixture-uri — nu modifica una fără cealaltă.
 */

export const GENERATED_DOC_NAME_RE =
  /^(OrdonantarePlata|DocumentFundamentare)_(.+)_(\d{8})(\.pdf)?$/;

/**
 * @param {unknown} docName
 * @returns {{ formType: 'ord'|'df', nr: string }|null}
 */
export function parseGeneratedDocName(docName) {
  if (typeof docName !== 'string') return null;
  const m = GENERATED_DOC_NAME_RE.exec(docName.trim());
  if (!m) return null;
  const nr = String(m[2]).trim();
  if (!nr) return null;
  return { formType: m[1] === 'OrdonantarePlata' ? 'ord' : 'df', nr };
}

/** Fragment SQL: `docName`-ul fluxului e pe tiparul documentelor generate. */
export function generatedDocNameSql(alias = 'f') {
  return '(' + alias + ".data->>'docName') ~ " +
         "'^(OrdonantarePlata|DocumentFundamentare)_.+_[0-9]{8}(\\.pdf)?$'";
}
```

⚠️ `generatedDocNameSql` e construit prin CONCATENARE, nu cu template literal —
așa e imposibil să apară un backtick în rezultat. Nu-l rescrie cu backtick-uri.

===============================================================================

## 5. PASUL 2 — adopția în `server/routes/flows/crud.mjs`

Import, lângă celelalte importuri de servicii:
```js
import { parseGeneratedDocName } from '../../services/flow-doc-name.mjs';
```

Inserează blocul de mai jos **exact între** sfârșitul lui `_fluxViuPeDoc` și
comentariul `// #171 — lista de tipuri vine din services/flow-doc-claim.mjs`.
`old_str` = ultimele două linii ale lui `_fluxViuPeDoc` plus linia de comentariu
`// #171 —` (lărgește până devine unic — `return rows[0] || null;` singur NU e unic).

```js
    // ── #222 — ADOPȚIA META pentru documentele generate de platformă ──────────
    // Un flux creat din ecranul de semnare FĂRĂ contextul de prefill (tab nou, alt
    // calculator, refresh, drumul prin „Renunță") ajunge cu `meta = {}`. Un astfel de
    // flux e ORFAN: nu îl vede nici poarta de mai jos, nici PASUL 3/4, nici garda de
    // reinițiere, nici auditul #120 — toate citesc `meta`. Documentul rămâne semnat
    // fără să știe (ORD 45301, 21.08–18.09.2026), iar dosarul ALOP stă blocat.
    //
    // Soluția NU e o a doua poartă, ci punerea cererii pe drumul porților existente:
    // recunoaștem tiparul de nume pe care tot serverul îl generează, identificăm
    // documentul și scriem `body.meta` AICI, înaintea porții #170. De la linia
    // următoare încolo, cererea e indistinctibilă de una venită cu prefill corect.
    //
    // ⛔ Fail-CLOSED: zero sau mai multe potriviri ⇒ 409, niciodată „lansează oricum".
    //    `nr_unic_inreg` ARE duplicate în producție între dosare (#126) ⇒ ramura ≥2 e reală.
    // ⛔ Adopția se face la LANSARE, înainte de orice semnătură. NU re-leagă un
    //    document semnat — regula „un document semnat nu se re-leagă tăcut" e intactă.
    let _metaAdoptat = null;
    if (pool && !body.meta?.dfId && !body.meta?.ordId) {
      const _gen = parseGeneratedDocName(body.docName);
      if (_gen) {
        // Whitelist închisă, ca la `col` din _fluxViuPeDoc — nu interpolare liberă.
        const _tbl = _gen.formType === 'ord' ? 'formulare_ord'   : 'formulare_df';
        const _col = _gen.formType === 'ord' ? 'nr_ordonant_pl'  : 'nr_unic_inreg';
        let _cand;
        try {
          const { rows } = await pool.query(
            `SELECT id FROM ${_tbl}
              WHERE ${_col} = $1 AND org_id = $2 AND deleted_at IS NULL
              LIMIT 2`,
            [_gen.nr, orgId]
          );
          _cand = rows;
        } catch (e) {
          logger.error({ err: e, docName: body.docName }, '[flux] adoptia meta: interogare esuata — fail-closed');
          return res.status(503).json({
            error: 'poarta_flux_indisponibila',
            message: 'Nu am putut identifica documentul din fișierul încărcat. Încearcă din nou.',
          });
        }
        if (_cand.length !== 1) {
          logger.warn({ docName: body.docName, formType: _gen.formType, nr: _gen.nr, gasite: _cand.length },
            '[flux] adoptia meta: document neidentificat — lansare refuzata (409)');
          return res.status(409).json({
            error: 'document_generat_neidentificat',
            formType: _gen.formType,
            nr: _gen.nr,
            gasite: _cand.length,
            message: _cand.length === 0
              ? 'Fișierul pare a fi un document generat de platformă, dar numărul din denumirea lui nu corespunde niciunui document al instituției tale. Pornește semnarea din ecranul documentului.'
              : 'Numărul din denumirea fișierului corespunde mai multor documente. Pornește semnarea din ecranul documentului, ca legătura să fie fără dubiu.',
          });
        }
        const _docId = String(_cand[0].id);
        body.meta = {
          ...(body.meta || {}),
          docType: _gen.formType === 'ord' ? 'ordnt' : 'notafd',
          ...(_gen.formType === 'ord' ? { ordId: _docId } : { dfId: _docId }),
        };
        _metaAdoptat = { formType: _gen.formType, nr: _gen.nr, docId: _docId };
        logger.warn({ docName: body.docName, ..._metaAdoptat },
          '[flux] meta ADOPTATA din docName — contextul de prefill lipsea la client');
      }
    }
```

Apoi, în evenimentul de audit (`writeAuditEvent({ … eventType: 'FLOW_CREATED' … })`),
adaugă în `payload` cheia `metaAdoptat: _metaAdoptat || undefined`. Adopția nu
trebuie să fie tăcută: dacă mâine se dovedește greșită, trebuie să existe urma.
⛔ **Nu redenumi** `FLOW_CREATED` și nicio altă cheie tehnică de eveniment.

===============================================================================

## 6. PASUL 3 — clasa G în `server/services/flow-link-audit.mjs`

1. Import: adaugă `generatedDocNameSql` din `./flow-doc-name.mjs` lângă importul
   existent din `./flow-provenance.mjs`.
2. `CLASS_KEYS`: adaugă `'flux_fara_document'` la finalul listei.
3. Adaugă detectorul la **finalul** tabloului `detectors`, după clasa F:

```js
    // ── G — flux_fara_document (#222) ────────────────────────────────────────
    // Un flux VIU pe un document generat de platformă (docName pe tipar) care nu
    // declară nici `dfId`, nici `ordId`. Complementara tuturor celorlalte clase:
    // acelea compară două legături, aici a doua legătură nu s-a născut. Invizibil
    // altfel pentru orice detector, fiindcă toate fac JOIN pe `meta`.
    // `liveFlowSql` (nu `validSignedFlowSql`): un flux orfan ÎNCĂ ÎN SEMNARE e la
    // fel de rupt ca unul finalizat, iar excluderea anulat/refuzat ține cardul
    // capabil să ajungă la 0 (fluxurile anulate cu meta gol sunt inofensive).
    { clasa: 'flux_fara_document', sql: `
      SELECT 'flux_fara_document'::text AS clasa,
             (CASE WHEN f.data->>'docName' ILIKE 'Ordonantare%' THEN 'ord' ELSE 'df' END)::text AS tip,
             NULL::text AS doc_id,
             (f.data->>'docName')::text AS doc_nr,
             NULL::text AS alop_id,
             f.id AS flux,
             'Flux pe un document generat de platforma, dar care nu declara niciun DF/ORD (meta gol)'::text AS detaliu
        FROM flows f
       WHERE f.data->'meta'->>'dfId'  IS NULL
         AND f.data->'meta'->>'ordId' IS NULL
         AND ${generatedDocNameSql('f')}
         AND ${liveFlowSql('f')}${orgCond('f')}` },
```

⚠️ `orgCond('f')` — `flows` ARE coloană `org_id` (folosită deja de clasa D).
Verifică asta, nu o presupune.

===============================================================================

## 7. PASUL 4 — interfața (`public/js/admin/audit.js`)

1. În `CLASS_LABEL` (din `showFlowLinkDivergences`), adaugă:
   `flux_fara_document: 'Flux fără document declarat',`
2. În blocul KPI, lângă celelalte `_parts.push(...)`, adaugă:
   `if (_bc.flux_fara_document) _parts.push('flux fără document: ' + _bc.flux_fara_document);`

⛔ Nu schimba nimic din logica cardului (pragurile, culorile, `display`).

===============================================================================

## 8. PASUL 5 — mesajul de refuz (`public/js/semdoc-initiator/main.js`)

Imediat DUPĂ blocul existent `if (r.status === 409 && j?.error === "document_are_flux_viu")`
și ÎNAINTE de `if (!r.ok) throw new Error(...)`, adaugă ramura oglindă:

```js
          // #222 — fișierul e un document generat de platformă, dar nu l-am putut
          // identifica după numărul din denumire. Nu creăm un flux orfan.
          if (r.status === 409 && j?.error === "document_generat_neidentificat") {
            $("createResult").innerHTML =
              `<div style="margin-top:10px;padding:12px 14px;border:1px solid var(--df-warning-bd);background:var(--df-warning-bg);border-radius:var(--df-radius-md);color:var(--df-warning);line-height:1.5;font-size:13px;">`
              + `⚠️ <strong>Nu am putut identifica documentul.</strong> ${esc(String(j.message || ""))}`
              + `<br><strong>Ce ai de făcut:</strong> deschide documentul în tabul <strong>${j.formType === "ord" ? "ORD" : "DF"}</strong> și pornește semnarea de acolo — așa legătura document↔flux se face automat.`
              + `</div>`;
            return;
          }
```

⚠️ Verifică prin `grep` că funcția `esc` e deja disponibilă în acel scope (o
folosește ramura #170 de deasupra). Dacă nu e, **raportează** — nu importa nimic nou.

===============================================================================

## 9. PASUL 6 — teste

**Unit — `server/tests/unit/flow-doc-name.test.mjs` (nou):**
- pozitive: `OrdonantarePlata_45301_20260821` → `{ord, '45301'}`;
  același cu `.pdf`; `DocumentFundamentare_6744_20260707` → `{df,'6744'}`;
  număr cu underscore: `OrdonantarePlata_AB_12_20260821` → `nr = 'AB_12'` (grup lacom);
- negative: `null`, `''`, `123`, `raport.pdf`, `OrdonantarePlata_45301` (fără dată),
  `OrdonantarePlata_45301_2026082` (7 cifre), `OrdonantarePlata__20260821` (nr gol);
- `generatedDocNameSql('f')` întoarce string, **fără backtick**, fără `${` neevaluat.

**Unit — `sql-fragmente-fara-backtick.test.mjs` (TEST PREEXISTENT, atingere PERMISĂ
și declarată):** adaugă `'flow-doc-name.mjs'` în `MODULES` și
`{ module: 'flow-doc-name.mjs', export: 'generatedDocNameSql', args: ['f'] }` în
`INVOCATIONS`. `parseGeneratedDocName` NU e funcție SQL ⇒ intrare în `EXCLUSIONS`
cu motiv explicit. `GENERATED_DOC_NAME_RE` nu e funcție ⇒ meta-testul o ignoră
(verifică asta pe cod).
⛔ Nicio altă aserțiune din acest fișier nu se atinge.

**DB — `server/tests/db/flow-meta-adoptie.test.mjs` (nou):**
1. ORD existent, `POST /flows` cu `docName` pe tipar și **fără** `meta`
   ⇒ 201, `formulare_ord.flow_id` = fluxul nou, `flows.data->'meta'->>'ordId'` = id-ul ORD.
2. Același, dar ORD-ul are deja un flux VIU ⇒ 409 `document_are_flux_viu`
   (poarta #170, **nu** o poartă nouă — asta e dovada că adopția pune cererea pe
   drumul existent).
3. `docName` pe tipar cu număr inexistent ⇒ 409 `document_generat_neidentificat`, `gasite = 0`.
4. Două DF-uri cu același `nr_unic_inreg` în aceeași org (cazul #126) ⇒ 409, `gasite = 2`.
5. `docName` ÎN AFARA tiparului (`contract-servicii.pdf`), fără meta ⇒ 201, `meta = {}`
   — **comportamentul vechi rămâne neatins pentru documentele care nu sunt ale platformei**.
6. `meta.ordId` trimis explicit de client ⇒ adopția NU rulează (`_metaAdoptat` null),
   `meta` rămâne exact cea trimisă.

**DB — `server/tests/db/flow-link-audit-clasa-g.test.mjs` (nou):**
7. Flux viu, `docName` pe tipar, `meta = {}` ⇒ apare în clasa `flux_fara_document`;
   `byClass.flux_fara_document = 1`.
8. Același flux, dar `cancelled` ⇒ NU apare (cardul trebuie să poată ajunge la 0).
9. Flux cu `meta.ordId` pus ⇒ NU apare.
10. Flux cu `docName` în afara tiparului și `meta` gol ⇒ NU apare.
11. **Paritate JS↔SQL:** aceleași fixture-uri de nume ca în testul unit, inserate ca
    rânduri, verdictul SQL identic cu `parseGeneratedDocName(...) !== null`.

**Poarta de sensibilitate:** fiecare test nou trebuie să PICE pe codul dinainte.
Rulează-le pe `git stash` sau pe fișierele restaurate din `HEAD` și raportează
câte pică. Un test care trece și pe codul vechi nu demonstrează nimic.

```bash
npm test
npm run test:db
# Așteptat: ambele verzi. Singurul test preexistent atins e
# sql-fragmente-fara-backtick (MODULES/INVOCATIONS/EXCLUSIONS).
# Orice ALT test preexistent care pică ⇒ OPREȘTE-TE și raportează.
```

===============================================================================

## 10. PASUL 7 — versionare și cache

```bash
npm version patch --no-git-tag-version
NEW=$(node -e "console.log(require('./package.json').version)")
echo $NEW    # Așteptat: 3.9.876
```

`?v=` **țintit** pe cele două assets schimbate (citește valoarea veche din HTML,
NU o presupune din package.json):

```bash
sed -i -E "s#(js/admin/audit\.js\?v=)[0-9.]+#\1$NEW#g" public/admin.html
sed -i -E "s#(js/semdoc-initiator/main\.js\?v=)[0-9.]+#\1$NEW#g" public/semdoc-initiator.html
grep -n "admin/audit.js?v=" public/admin.html
grep -n "semdoc-initiator/main.js?v=" public/semdoc-initiator.html
# Așteptat: ambele 3.9.876, tag-urile <script> INTACTE
```

`CACHE_VERSION` — **DA de data asta**: `/js/admin/audit.js` E în `PRECACHE_ASSETS`.

```bash
sed -i -E "s#(const CACHE_VERSION = 'docflowai-v)[0-9]+#\1311#" public/sw.js
grep -n "CACHE_VERSION" public/sw.js | head -1
# Așteptat: docflowai-v311
```

⛔ `sed`: grupul de captură se referă cu `\1`, NU cu `\g<1>`.
⛔ NU face sed în masă pe toate `?v=` — driftul e intenționat.

===============================================================================

## 11. PASUL 8 — commit + push

```bash
git add -A
git status --short
# Așteptat: server/services/flow-doc-name.mjs (nou), server/routes/flows/crud.mjs,
# server/services/flow-link-audit.mjs, public/js/admin/audit.js,
# public/js/semdoc-initiator/main.js, public/admin.html,
# public/semdoc-initiator.html, public/sw.js, package.json(+lock),
# + 3 fișiere de test noi + sql-fragmente-fara-backtick.test.mjs
# ⚠️ `git diff --stat` NU vede fișierele netracked — folosește `git status --short`.
# ⚠️ Fișierul acestui prompt NU se comite.

git commit -m "fix(#222): niciun flux pe un document generat nu mai poate porni fără să declare documentul (adopție meta + clasa G în auditul document↔flux)"
git push origin develop
```

===============================================================================

## RAPORT FINAL (obligatoriu)

1. Rezultatele RECON-ului R1–R5, cu cifra obținută lângă fiecare `# Așteptat:`.
2. `flow-doc-name.mjs` complet, așa cum a rămas în fișier.
3. Blocul de adopție din `crud.mjs`, cu numerele de linie ÎNTRE care a fost inserat,
   și confirmarea că e **înaintea** buclei porții #170.
4. Detectorul clasei G, copiat din fișier.
5. Lista testelor noi + **câte pică pe codul vechi** (poarta de sensibilitate),
   cu comanda folosită pentru a demonstra.
6. `npm test` și `npm run test:db`: numărul de fișiere/teste și verdictul.
   Lista EXACTĂ a testelor preexistente atinse (așteptat: exact 1).
7. `package.json`, cele două `?v=`, `CACHE_VERSION`.
8. Hash-ul commit-ului + confirmarea push-ului pe `develop`.
9. **Orice ai găsit care contrazice promptul.** Dacă o poartă `# Așteptat:` din
   promptul ăsta e greșită, spune-o — promptul nu are prioritate față de realitate.

===============================================================================

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Zona NO-TOUCH din antet nu se atinge sub nicio formă.
- ⛔ Zero migrații. Zero fișiere noi în `migrations/`.
- ⛔ Nicio reparație de date. Acest lot NU scrie în `flows.data` și nu
  repopulează niciun `flow_id` existent — 45301 se repară separat, cu SQL și backup.
- ⛔ Adopția rulează DOAR când `body.meta` nu are nici `dfId`, nici `ordId`.
  Nu suprascrie niciodată o `meta` trimisă de client.
- ⛔ Fail-closed peste tot: eroare de interogare ⇒ 503; 0 sau ≥2 potriviri ⇒ 409.
  Nicio portiță „lansează oricum".
- ⛔ Nu redenumi chei tehnice de evenimente de audit (doar traducerile lor pot fi atinse).
- ⛔ Nu modifica niciun test preexistent în afara celui declarat în §9.
- ⛔ Nu sparge `crud.mjs` în module și nu „aranja" nimic din afara acestui lot.
- ⛔ `main` nu se atinge. Push DOAR pe `origin develop`.
