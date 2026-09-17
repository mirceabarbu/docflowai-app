---
prompt: 220
titlu: "Previzualizarea PDF-ului semnat al DF-ului: din formularul ORD (revizia pe care s-a emis) și din antetul dosarului ALOP (revizia în vigoare)"
model_suggested: "Opus 5"
efort: medium
branch: develop
versiune_curenta: "cea din package.json (v3.9.872 după #219)"
versiune_tinta: "următorul patch după versiunea curentă din package.json"
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA — `formular.html`, `js/formular/doc.js`, `js/formular/list.js`, `js/formular/alop.js` ⇒ `?v=` ȚINTIT pe fiecare JS atins; `CACHE_VERSION` doar dacă vreunul e în PRECACHE
zona_no_touch_atinsa: NU
tip: funcționalitate mică de afișare + o rută nouă de citire (decizie de acces a lui Mircea) + teste
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

Cererea lui Mircea (17.09.2026): în formularul Ordonanțării de Plată să se poată **previzualiza
DF-ul aprobat în baza căruia s-a emis ordonanțarea**, în același modal și cu același chip ca
atașamentele ORD-ului. Și, pe cardul dosarului ALOP, previzualizarea **DF-ului în vigoare**.

## Ce există deja (verificat pe cod)

- **Modalul de preview e global:** `window.openAttPreview(url, filename, mimeType)`
  (`public/js/shared/att-preview.js`) — face `fetch(url, { credentials: 'include' })`, randează PDF-ul,
  pune URL-ul pe butonul de descărcare din modal.
- **Chip-ul** e `window.renderFileItem({...})` (`public/js/shared/file-item.js`), folosit de
  atașamentele DF/ORD în `doc.js` (`renderAttachments`).
- **PDF-ul semnat al unui flux** e servit de `GET /flows/:flowId/signed-pdf` (`flows/crud.mjs:~670`),
  cu autorizarea `isFlowAccessAllowed` (inclusiv prin dreptul de a vedea documentul DF/ORD al fluxului,
  #153). PDF-ul stă în `flows_pdfs` (cheia `signedPdfB64`), citit prin `getFlowData`, sau în Drive.
- **ORD-ul știe pe ce DF s-a emis:** `formulare_ord.df_id` — revizia înghețată la emitere (#134b).

## Măsurat pe producție (SQL-221)

- 126 de ORD-uri cu DF; **toate 126 au DF aprobat și PDF semnat** în `flows_pdfs`.
- **0** inițiatori de ORD dintr-un compartiment diferit de cel al DF-ului (fără CAB) ⇒ decizia de acces de
  mai jos nu lărgește azi accesul nimănui.

## Deciziile lui Mircea

1. **Accesul la DF din ORD se derivă din ORD:** cine poate vedea ordonanțarea poate vedea DF-ul pe baza
   căruia s-a emis (același dosar).
2. **Revizia afișată în ORD** = `formulare_ord.df_id` (cea pe care s-a emis), nu ultima aprobată.
3. **Chip-ul reflectă starea SALVATĂ:** pe un ORD în lucru, dacă se schimbă DF-ul din listă, chip-ul
   dispare până la redeschiderea documentului salvat. Nicio previzualizare pe o selecție nesalvată.
4. **Pe cardul ALOP: DOAR antetul** (4a) — link „Previzualizează" pe rândul „DF în vigoare", pe revizia
   în vigoare a dosarului, prin ruta existentă a fluxului. **Fără** link în cicluri (4b respins).

---

# ETAPA 0 — ancore (READ-ONLY, raportează valorile OBȚINUTE)

```bash
git branch --show-current
grep '"version"' package.json

grep -n "router.get('/flows/:flowId/signed-pdf'" -A30 server/routes/flows/crud.mjs
grep -n "router.get('/api/formulare-ord/:id'" server/routes/formulare/ord.mjs
grep -n "export async function getFlowData" -A12 server/db/index.mjs
grep -n "export async function canViewFormular" -A5 server/services/authz-formular.mjs
grep -n "export const docAprobatSql" server/services/df-aprobat-sql.mjs
grep -n "revizieInVigoare\|sqlRevizieInVigoare" server/services/alop-dosar-sql.mjs
grep -n "sqlRevizieInVigoareNr" server/routes/alop.mjs server/tests/unit/sql-fragmente-fara-backtick.test.mjs
grep -n "o-df-sel\|o-df-id" public/formular.html
grep -n "function selectDfAprobat" -A8 public/js/formular/list.js
grep -n "lockDfSelectIfLinked(); // ORD legat de DF" public/js/formular/doc.js
grep -n "window.openAttPreview\|window.renderFileItem" public/js/shared/*.js
grep -n "js/formular/doc.js?v=\|js/formular/list.js?v=\|js/formular/alop.js?v=" public/formular.html
grep -n "js/formular" public/sw.js

# Rute ORD care ar putea fi prinse înaintea celei noi (ordinea de montare contează în Express)
grep -n "router.get('/api/formulare-ord/" server/routes/formulare/ord.mjs
```

⭐ Confirmă că nicio rută existentă nu prinde `/api/formulare-ord/:id/df-aprobat.pdf` înaintea celei noi
(ex. un `/:id/:altceva` generic). Raportează.

⭐ Confirmă din `getFlowData` că `signedPdfB64` vine din `flows_pdfs` și că `data.storage` /
`data.driveFileIdFinal` sunt câmpurile Drive folosite de ruta existentă.

---

# ⭐ ETAPA T — testele ÎNTÂI, pe codul NEREPARAT

## T.1 — DB: `server/tests/db/ord-df-aprobat-pdf.test.mjs` (nou)

Seed: organizație; dosar ALOP A; DF cu `source_alop_id = A`, `nr_unic_inreg`, `revizie_nr = 0`, cu flux
**semnat** (`completed`) și un PDF semnat în `flows_pdfs` (cheia `signedPdfB64`, conținut base64 al unui
PDF minimal — ex. `%PDF-1.4…` generat în test); ORD cu `df_id` = DF, `source_alop_id = A`.
Modelează seed-urile de flux după `flow-link-audit.test.mjs` / `seedFlowApproved` din `db-real.mjs`.
Dacă helper-ul nu scrie în `flows_pdfs`, inserează direct și raportează.

1. ⭐ Cine vede ORD-ul (inițiatorul ORD) ⇒ `GET /api/formulare-ord/:id/df-aprobat.pdf` **200**,
   `Content-Type: application/pdf`, corpul = PDF-ul din `flows_pdfs` (bytes identici).
2. ⭐ Decizia 1: un utilizator care vede ORD-ul, dar **nu** ar vedea DF-ul prin regulile DF (inițiator ORD
   din alt compartiment decât DF-ul, neCAB) ⇒ **200**. (Confirmă în test că
   `GET /flows/:dfFlowId/signed-pdf` îi dă 403 — dovada că ruta nouă e cea care decide.)
3. Utilizator care nu vede ORD-ul ⇒ **403**; utilizator din altă organizație ⇒ **404** (sau 403 — exact
   ce întoarce GET-ul de detaliu ORD pentru același actor; aliniază-te la el și raportează).
4. ORD fără `df_id` ⇒ **404 `fara_df`**.
5. ⭐ DF **neaprobat** (flux refuzat / fără flux) ⇒ **409 `df_neaprobat`**, fără corp PDF.
6. ⭐ DF din alt dosar decât ORD-ul (ambele cu `source_alop_id`, diferite) ⇒ **409 `df_alt_dosar`**.
7. DF aprobat fără PDF semnat și fără Drive ⇒ **404 `signed_pdf_missing`** (același cod ca ruta existentă).
8. ⭐ Revizia înghețată: DF R0 aprobat (pe ORD) + R1 aprobat ulterior pe același dosar ⇒ ruta servește
   **PDF-ul lui R0**.
9. ⭐ Neregresie ruta existentă: `GET /flows/:flowId/signed-pdf` pentru inițiatorul DF ⇒ 200, aceleași
   antete ca înainte (`Content-Disposition` cu `DocFlowAI_<flowId>_signed.pdf`).

**Detaliul ORD (`GET /api/formulare-ord/:id`):**
10. ⭐ Răspunsul conține `df_revizie_nr` și `df_aprobat_semnat` (`true` pentru DF aprobat, `false` pentru
    neaprobat, `false`/absent pentru ORD fără DF).

**Detaliul ALOP (`GET /api/alop/:id`):**
11. ⭐ Răspunsul conține `df_revizie_vigoare_flow_id` = fluxul reviziei în vigoare (R1 în scenariul 8,
    nu R0). NULL pentru un dosar fără revizie aprobată.

## T.2 — unit happy-dom: `server/tests/unit/ord-df-aprobat-chip.test.mjs` (nou)

Convenția din `ord-list-valoare-plata-frontend.test.mjs` (`new Function(src).call(globalThis)`) pentru
`doc.js`/`list.js`, cu stub-uri pentru dependențele lipsă (raportează ce ai stubat).

12. ⭐ `renderOrdDfAprobatChip()` cu un ORD salvat (`df_aprobat_semnat: true`) randează în
    `#o-df-aprobat-chip` un chip cu textul `DF <nr> R<rev>`, buton „Previzualizează", link „Descarcă"
    spre `/api/formulare-ord/<id>/df-aprobat.pdf`, **fără** „Șterge".
13. ⭐ Click pe „Previzualizează" ⇒ `window.openAttPreview` apelat cu URL-ul rutei noi și tipul
    `application/pdf`.
14. ⭐ Decizia 3: după schimbarea `o-df-sel` pe alt DF (`selectDfAprobat`), chip-ul e gol.
15. `df_aprobat_semnat: false` ⇒ chip gol.
16. Static: `alop.js` conține linkul de previzualizare în antet condiționat de `df_revizie_vigoare_flow_id`,
    iar `previewDfVigoare` e expusă pe `window` (garda #212 o verifică și ea).

**Rulare pe codul nereparat:** raportează roșiile **ÎNAINTE** de patch. Așteptat: 1, 2, 4, 5, 6, 7, 8,
10, 11, 12–16 roșii (ruta, câmpurile și funcțiile nu există). Verzi: 3 (probabil 404 pe rută inexistentă
— raportează), 9.

---

# ETAPA A — server: livrarea PDF-ului semnat într-o singură funcție

## A.1 — `server/services/flow-signed-pdf.mjs` (nou)

```js
/**
 * #220 — Livrează PDF-ul SEMNAT al unui flux. Sursă unică pentru:
 *   GET /flows/:flowId/signed-pdf              (flows/crud.mjs)
 *   GET /api/formulare-ord/:id/df-aprobat.pdf  (formulare/ord.mjs)
 * NU face autorizare — apelantul a decis deja accesul. `data` = rezultatul `getFlowData(flowId)`.
 *
 * @param {import('express').Response} res
 * @param {object} data
 * @param {string} flowId
 * @param {{ filename?: string }} [opts]
 */
export async function sendFlowSignedPdf(res, data, flowId, { filename } = {}) {
  const name = String(filename || `DocFlowAI_${flowId}_signed.pdf`).replace(/["\r\n]/g, '');
  const b64 = data?.signedPdfB64;
  if (!b64 || typeof b64 !== 'string') {
    if (data?.storage === 'drive' && data?.driveFileIdFinal) {
      try {
        const { streamFromDrive } = await import('../drive.mjs');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        await streamFromDrive(data.driveFileIdFinal, res);
        return;
      } catch (driveErr) {
        return res.status(502).json({ error: 'drive_unavailable' });
      }
    }
    return res.status(404).json({ error: 'signed_pdf_missing' });
  }
  const raw = b64.includes('base64,') ? b64.split('base64,')[1] : b64;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return res.status(200).send(Buffer.from(raw, 'base64'));
}
```

⚠️ Verifică calea importului Drive: în `crud.mjs` e `'../../drive.mjs'` (din `server/routes/flows/`); din
`server/services/` devine `'../drive.mjs'`. Confirmă că `server/drive.mjs` există și raportează.

## A.2 — ruta existentă folosește funcția

`server/routes/flows/crud.mjs`. `old_str`:
```js
    const b64 = data.signedPdfB64;
    if (!b64 || typeof b64 !== 'string') {
      if (data.storage === 'drive' && data.driveFileIdFinal) {
        try {
          const { streamFromDrive } = await import('../../drive.mjs');
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="DocFlowAI_${req.params.flowId}_signed.pdf"`);
          await streamFromDrive(data.driveFileIdFinal, res); return;
        } catch(driveErr) { return res.status(502).json({ error: 'drive_unavailable' }); }
      }
      return res.status(404).json({ error: 'signed_pdf_missing' });
    }
    const raw = b64.includes('base64,') ? b64.split('base64,')[1] : b64;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="DocFlowAI_${req.params.flowId}_signed.pdf"`);
    return res.status(200).send(Buffer.from(raw, 'base64'));
```
`new_str`:
```js
    // #220 — livrarea (bază / Drive) e în services/flow-signed-pdf.mjs, partajată cu ruta DF din ORD.
    return await sendFlowSignedPdf(res, data, req.params.flowId);
```

Plus importul, lângă celelalte importuri din `crud.mjs`:
```js
import { sendFlowSignedPdf } from '../../services/flow-signed-pdf.mjs';
```

⚠️ `safeName` calculat deasupra rămâne nefolosit și înainte (nu era folosit nici în codul vechi). Nu-l
atinge; raportează-l la colaterale. ⛔ Autorizarea rutei existente rămâne neatinsă.

## A.3 — ruta nouă, în `server/routes/formulare/ord.mjs`

Imediat **înainte** de `router.get('/api/formulare-ord/:id', …)` (ca să nu fie umbrită de vreo rută
generică — verifică în Etapa 0):

```js
// #220 — PDF-ul SEMNAT al DF-ului pe baza căruia s-a emis ordonanțarea (revizia înghețată în
// formulare_ord.df_id). Decizie de acces (Mircea, 17.09.2026): dreptul vine din ORD — cine vede
// ordonanțarea vede și DF-ul ei, fiindcă sunt același dosar. Gărzi: DF-ul e cel legat de ORD, din
// aceeași organizație, din același dosar (când ambele au proveniență) și APROBAT.
router.get('/api/formulare-ord/:id/df-aprobat.pdf', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const isGlobalAdmin = actor.role === 'admin' && !actor.orgId;
    const orgCond = isGlobalAdmin ? '' : 'AND fo.org_id = $2';
    const params  = isGlobalAdmin ? [req.params.id] : [req.params.id, actor.orgId];
    const { rows: oRows } = await pool.query(
      `SELECT fo.* FROM formulare_ord fo WHERE fo.id = $1 ${orgCond} AND fo.deleted_at IS NULL`,
      params
    );
    if (!oRows.length) return res.status(404).json({ error: 'not_found' });
    const ord = oRows[0];

    const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
    const view = await canViewFormular(pool, actor, ord, actorComp, { cabComp });
    if (!view.allowed) return res.status(403).json({ error: view.reason });

    if (!ord.df_id) return res.status(404).json({ error: 'fara_df' });

    const { rows: dRows } = await pool.query(
      `SELECT fd.id, fd.org_id, fd.nr_unic_inreg, fd.revizie_nr, fd.flow_id, fd.source_alop_id,
              COALESCE(${docAprobatSql('fd', 'f')}, false) AS aprobat
         FROM formulare_df fd
         LEFT JOIN flows f ON f.id = fd.flow_id
        WHERE fd.id = $1 AND fd.deleted_at IS NULL`,
      [ord.df_id]
    );
    const df = dRows[0];
    if (!df || String(df.org_id) !== String(ord.org_id)) return res.status(404).json({ error: 'fara_df' });
    if (df.source_alop_id && ord.source_alop_id
        && String(df.source_alop_id) !== String(ord.source_alop_id)) {
      logger.warn({ ordId: ord.id, dfId: df.id }, '[ORD] df-aprobat.pdf: DF din alt dosar decât ORD-ul (#220)');
      return res.status(409).json({ error: 'df_alt_dosar' });
    }
    if (!df.aprobat || !df.flow_id) return res.status(409).json({ error: 'df_neaprobat' });

    const data = await getFlowData(df.flow_id);
    if (!data) return res.status(404).json({ error: 'signed_pdf_missing' });
    const nr = String(df.nr_unic_inreg || 'fara-nr').replace(/[^\w.-]+/g, '_');
    return await sendFlowSignedPdf(res, data, df.flow_id,
      { filename: `DF_${nr}_R${df.revizie_nr || 0}_semnat.pdf` });
  } catch (e) {
    logger.error({ err: e }, 'GET /api/formulare-ord/:id/df-aprobat.pdf error');
    return res.status(500).json({ error: 'server_error' });
  }
});
```

Importuri noi în `ord.mjs` (verifică dacă `getFlowData` e deja importat):
```js
import { sendFlowSignedPdf } from '../../services/flow-signed-pdf.mjs';
```
și `getFlowData` din `../../db/index.mjs`, lângă `pool`.

⚠️ Verifică tipul `flows.id` vs `formulare_df.flow_id` (în `ord.mjs` GET detaliu se folosește
`f.id = fo.flow_id`, fără cast). Aliniază-te la ce folosește fișierul și raportează.

⚠️ Verifică dacă celelalte rute GET din `ord.mjs` au un limitator de rată; dacă da, aplică-l identic
și aici. Raportează decizia.

## A.4 — detaliul ORD primește câmpurile pentru chip

`server/routes/formulare/ord.mjs`, GET detaliu.

`old_str`:
```js
        fd.nr_unic_inreg AS df_nr, fd.rows_ctrl AS df_rows_ctrl,
```
`new_str`:
```js
        fd.nr_unic_inreg AS df_nr, fd.rows_ctrl AS df_rows_ctrl,
        fd.revizie_nr AS df_revizie_nr,
        -- #220 — chip-ul „DF aprobat" din formular: aceeași regulă ca ruta df-aprobat.pdf.
        COALESCE(${docAprobatSql('fd', 'fdf')}, false) AS df_aprobat_semnat,
```

`old_str`:
```js
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      LEFT JOIN flows f ON f.id = fo.flow_id
      WHERE fo.id = $1 ${orgCond} AND fo.deleted_at IS NULL
```
`new_str`:
```js
      LEFT JOIN formulare_df fd ON fd.id = fo.df_id
      LEFT JOIN flows f ON f.id = fo.flow_id
      LEFT JOIN flows fdf ON fdf.id = fd.flow_id
      WHERE fo.id = $1 ${orgCond} AND fo.deleted_at IS NULL
```

⚠️ Confirmă că `formulare_ord` nu are coloane `df_revizie_nr` / `df_aprobat_semnat` (ar fi umbrite de
`fo.*`). Chip-ul nu verifică proveniența (ruta o face și răspunde 409) — acceptat.

## A.5 — detaliul ALOP: fluxul reviziei în vigoare

**A.5.1 — `server/services/alop-dosar-sql.mjs`.** `old_str`:
```js
export const sqlRevizieInVigoareNr = (a = 'a') =>
  revizieInVigoare('COALESCE(fdrv.revizie_nr, 0)', a);
```
`new_str`:
```js
export const sqlRevizieInVigoareNr = (a = 'a') =>
  revizieInVigoare('COALESCE(fdrv.revizie_nr, 0)', a);

/** #220 — Fluxul (flow_id) reviziei in vigoare a dosarului, sau NULL. Pentru previzualizarea PDF-ului semnat. */
export const sqlRevizieInVigoareFlowId = (a = 'a') => revizieInVigoare('fdrv.flow_id', a);
```

⭐ `sql-fragmente-fara-backtick.test.mjs` cere ca orice export nou din `alop-dosar-sql.mjs` să fie
**invocat** în lista de module (e un fragment SQL sincron, deci se invocă, nu se exclude). Adaugă, lângă
intrarea `sqlRevizieInVigoareNr`:
```js
  { module: 'alop-dosar-sql.mjs', export: 'sqlRevizieInVigoareFlowId', args: ['a'] },
```
E modificarea permisă a unui test existent; raportează-o.

**A.5.2 — `server/routes/alop.mjs`, importul.** `old_str`:
```js
  sqlRevizieInVigoareNr,
} from '../services/alop-dosar-sql.mjs';
```
`new_str`:
```js
  sqlRevizieInVigoareNr, sqlRevizieInVigoareFlowId,
} from '../services/alop-dosar-sql.mjs';
```

**A.5.3 — constanta.** `old_str`:
```js
const SQL_ALOP_REVIZIE_VIGOARE_NR = sqlRevizieInVigoareNr('a');
```
`new_str`:
```js
const SQL_ALOP_REVIZIE_VIGOARE_NR = sqlRevizieInVigoareNr('a');
const SQL_ALOP_REVIZIE_VIGOARE_FLOW = sqlRevizieInVigoareFlowId('a');   // #220 — doar detaliul
```

**A.5.4 — DOAR în GET detaliu** (NU în listă). `old_str`:
```js
        ${SQL_ALOP_REVIZIE_VIGOARE_NR} AS df_revizie_vigoare_nr,
        CASE WHEN COALESCE(fo.flow_id, a.ord_flow_id) IS NOT NULL AND (
```
`new_str`:
```js
        ${SQL_ALOP_REVIZIE_VIGOARE_NR} AS df_revizie_vigoare_nr,
        ${SQL_ALOP_REVIZIE_VIGOARE_FLOW} AS df_revizie_vigoare_flow_id,
        CASE WHEN COALESCE(fo.flow_id, a.ord_flow_id) IS NOT NULL AND (
```

⚠️ Același `${SQL_ALOP_REVIZIE_VIGOARE_NR} AS df_revizie_vigoare_nr,` apare și în lista ALOP (~510);
`old_str`-ul de mai sus e lărgit cu linia următoare ca să fie unic. ⛔ Lista ALOP nu se atinge (cost pe
fiecare rând, fără consumator).

---

# ETAPA B — frontend ORD: chip-ul „DF aprobat"

## B.1 — `public/formular.html`, gazda

`old_str`:
```html
      <input type="hidden" id="o-df-id"/>
    </div>
```
`new_str`:
```html
      <input type="hidden" id="o-df-id"/>
    </div>
    <!-- #220 — chip „DF aprobat": PDF-ul semnat al DF-ului pe care s-a emis ORD-ul (starea SALVATĂ) -->
    <div id="o-df-aprobat-chip" style="margin-top:6px"></div>
```

## B.2 — `public/js/formular/doc.js`, funcțiile

Lângă `previewAttFromChip`:

```js
// #220 — chip „DF aprobat" în formularul ORD. Reflectă DOAR starea salvată (decizia 3): dacă
// selecția din `o-df-sel` diferă de DF-ul salvat al ORD-ului deschis, chip-ul e gol.
let _ordDfSalvat = null;   // { ordId, dfId, nr, rev, semnat }
function setOrdDfSalvat(doc){
  _ordDfSalvat = (doc && doc.id) ? {
    ordId: doc.id, dfId: doc.df_id || null, nr: doc.df_nr || doc.nr_unic_inreg || '',
    rev: doc.df_revizie_nr || 0, semnat: doc.df_aprobat_semnat === true,
  } : null;
}
function renderOrdDfAprobatChip(){
  const host = document.getElementById('o-df-aprobat-chip');
  if (!host) return;
  const s = _ordDfSalvat;
  const curDf = document.getElementById('o-df-id')?.value || '';
  if (!s || !s.semnat || !s.dfId || s.ordId !== ST.docId?.ordnt || curDf !== String(s.dfId)) {
    host.innerHTML = '';
    return;
  }
  const url = `/api/formulare-ord/${encodeURIComponent(s.ordId)}/df-aprobat.pdf`;
  const name = `DF ${s.nr} R${s.rev} — semnat.pdf`;
  host.innerHTML = renderFileItem({
    filename: name, mimeType: 'application/pdf',
    canPreview: true, previewOnclick: 'previewOrdDfAprobat();return false;',
    downloadHref: url, downloadName: name,
    canDelete: false,
  });
}
function previewOrdDfAprobat(){
  const s = _ordDfSalvat; if (!s) return;
  const url = `/api/formulare-ord/${encodeURIComponent(s.ordId)}/df-aprobat.pdf`;
  window.openAttPreview?.(url, `DF ${s.nr} R${s.rev} — semnat.pdf`, 'application/pdf');
}
```

⚠️ Verifică denumirea reală a cheii ORD în `ST.docId` (în `doc.js` ORD e `'ordnt'`) și raportează.

⭐ **A doua gardă existentă care va pica — intenționat:** `server/tests/unit/ord-bloc-paritate.test.mjs`
(#128k) ține un inventar ÎNCHIS al ancorelor `getElementById('o-…')` din `doc.js`. `renderOrdDfAprobatChip`
adaugă o citire a lui `o-df-id` și ancora nouă `o-df-aprobat-chip`. Actualizează `ANCORE_PERMISE['doc.js']`:

```js
    'o-df-id': [6, 'GLOBAL PRIN DESIGN — id-ul DF-ului legat, unic pe document. 5→6 la #220: ' +
      'renderOrdDfAprobatChip CITEȘTE hidden-ul ca să ascundă chip-ul când selecția diferă de DF-ul salvat'],
    'o-df-aprobat-chip': [1, 'GLOBAL PRIN DESIGN — #220: gazda chip-ului „DF aprobat", unică pe document ' +
      '(un singur DF per ORD), randată doar de renderOrdDfAprobatChip'],
```

Numerele sunt cele de pe arhiva verificată; dacă `develop` diferă, folosește valorile reale și raportează.

## B.3 — apelul la încărcarea ORD-ului

`old_str`:
```js
  lockDfSelectIfLinked(); // ORD legat de DF → referința DF needitabilă (ciclu ALOP)
```
`new_str`:
```js
  lockDfSelectIfLinked(); // ORD legat de DF → referința DF needitabilă (ciclu ALOP)
  setOrdDfSalvat(doc); renderOrdDfAprobatChip();   // #220
```

⚠️ Verifică în ce funcție e linia (încărcarea ORD-ului) și că `doc` e documentul ORD complet de la
`GET /api/formulare-ord/:id`. Verifică și calea „ORD nou" / „închide documentul": chip-ul trebuie să
dispară (condiția `s.ordId !== ST.docId.ordnt` o acoperă — confirmă și raportează).

## B.4 — expunerea

`old_str`:
```js
  window.previewAttFromChip         = previewAttFromChip;
```
`new_str`:
```js
  window.previewAttFromChip         = previewAttFromChip;
  window.renderOrdDfAprobatChip     = renderOrdDfAprobatChip;   // #220
  window.previewOrdDfAprobat        = previewOrdDfAprobat;      // #220
```

## B.5 — `public/js/formular/list.js`: schimbarea DF-ului golește chip-ul

`old_str`:
```js
  if(hiddenId)hiddenId.value=id;
```
`new_str`:
```js
  if(hiddenId)hiddenId.value=id;
  if(typeof window.renderOrdDfAprobatChip==='function')window.renderOrdDfAprobatChip();   // #220 — decizia 3
```

---

# ETAPA C — frontend ALOP: linkul din antet (4a)

`public/js/formular/alop.js`.

**C.1 — linkul.** `old_str`:
```js
${a.df_nr?`<span style="color:var(--df-text-2);font-weight:600">· Nr. ${a.df_nr}</span>`:''}
```
`new_str`:
```js
${a.df_nr?`<span style="color:var(--df-text-2);font-weight:600">· Nr. ${a.df_nr}</span>`:''}${(_revStare.vigoare!=null&&a.df_revizie_vigoare_flow_id)?`<a href="#" style="color:var(--df-accent,#818cf8);font-weight:600;text-decoration:none" title="Previzualizează PDF-ul semnat al reviziei în vigoare" onclick="previewDfVigoare('${esc(a.df_revizie_vigoare_flow_id)}','${esc(String(a.df_nr||''))}',${Number(_revStare.vigoare)||0});return false;">· 🔍 Previzualizează</a>`:''}
```

⚠️ `esc` e în scope (`const esc = window.df.esc`, începutul IIFE-ului). Verifică. Id-urile de flux sunt
de forma `PZ_…`; `esc` le face sigure în atribut.

**C.2 — funcția**, lângă celelalte funcții de antet ale fișierului:
```js
// #220 — PDF-ul semnat al reviziei ÎN VIGOARE a dosarului, prin ruta existentă a fluxului
// (autorizarea #153: dreptul de a vedea DF-ul). Deschide modalul global de preview.
function previewDfVigoare(flowId, nr, rev){
  if (!flowId) return;
  window.openAttPreview?.(`/flows/${encodeURIComponent(flowId)}/signed-pdf`,
    `DF ${nr} R${rev} — semnat.pdf`, 'application/pdf');
}
```
și expunerea în blocul `window.*` al fișierului:
```js
  window.previewDfVigoare = previewDfVigoare;   // #220
```
⚠️ Garda #212 (`onclick-handlers-expuse`) verifică handler-ele inline din template-urile JS; rulează-o.

---

# ETAPA D — suitele

```bash
npx vitest run --config vitest.config.db.mjs server/tests/db/ord-df-aprobat-pdf.test.mjs
npx vitest run server/tests/unit/ord-df-aprobat-chip.test.mjs
npm test
npm run test:db
```

⚠️ **Secvențial, complet.** Verdict din output real, cu numărul de fișiere confruntat cu discul.
⛔ Test preexistent care pică ⇒ raportează ÎNAINTE de a-l atinge (excepții permise: intrarea din
`sql-fragmente-fara-backtick` și lista albă din `ord-bloc-paritate`). Neregresie citată: testele rutei `signed-pdf` (grep `signed-pdf` în
`server/tests`), `alop-dosar-sql.test.mjs`, testele GET detaliu ORD și ALOP, garda #212.

---

# ETAPA E — versiune, cache, commit

```bash
npm version <TINTA> --no-git-tag-version
npm install --package-lock-only
NEW=<TINTA>
for f in doc list alop; do
  sed -i -E "s#(js/formular/${f}\.js\?v=)[0-9.]+#\1${NEW}#g" public/formular.html
done
grep -n "js/formular/doc.js?v=\|js/formular/list.js?v=\|js/formular/alop.js?v=" public/formular.html
grep -n "js/formular\|formular.html" public/sw.js
```
⭐ Linia `<script>` întreagă pentru fiecare, după sed. `CACHE_VERSION` doar dacă vreun fișier atins e în
`PRECACHE_ASSETS` — dovada prin grep.

`git add` explicit. Arhivează ca `docs/archive/PROMPT-220-df-aprobat-preview.md`; dacă
`docs/archive/sql/SQL-221-df-aprobat-in-ord.sql` există netrackat, adaugă-l.

```
feat(#220): previzualizarea PDF-ului semnat al DF-ului din ORD si din antetul dosarului ALOP — v<TINTA>

Formularul ORD primeste sub campul „Nr. unic inregistrare DF" un chip identic
cu cel al atasamentelor: PDF-ul semnat al DF-ului pe care s-a emis ordonantarea
(revizia inghetata in formulare_ord.df_id), cu Previzualizeaza si Descarca.
Ruta noua GET /api/formulare-ord/:id/df-aprobat.pdf: accesul se deriva din ORD
(decizie de produs), cu garzi de organizatie, dosar si aprobare. Chip-ul
reflecta doar starea salvata.

Antetul dosarului ALOP primeste „Previzualizeaza" pe randul „DF in vigoare",
pe revizia in vigoare, prin ruta existenta a fluxului.

Livrarea PDF-ului semnat (baza / Drive) mutata in services/flow-signed-pdf.mjs,
folosita de ambele rute. Masurat pe productie: 126/126 ORD cu DF aprobat si PDF
semnat. Teste scrise intai.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL
1. Ancore obținute: rutele ORD existente și ordinea, sursa `signedPdfB64`, calea `drive.mjs`, cheia ORD din `ST.docId`, limitatorul de rată.
2. ⭐ Roșiile pe codul nereparat.
3. Rezultatul fiecărui test nou, în special 1, 2, 5, 6, 8, 9, 11, 13, 14.
4. Teste preexistente atinse: așteptat DOAR intrarea din `sql-fragmente-fara-backtick` și lista albă din `ord-bloc-paritate` (#128k).
5. Numere reale `npm test` și `npm run test:db`, complete, secvențial.
6. `?v=` pe cele trei JS-uri și `CACHE_VERSION`, cu dovadă.
7. Divergențe prompt ↔ cod — raportate, nereparate tăcut.
8. Colaterale (ex. `safeName` nefolosit în `crud.mjs`) — nereparate.

# ⛔ CONSTRÂNGERI ABSOLUTE
- `develop` ONLY, apoi stop. Zero migrații, zero scrieri de date.
- Autorizarea rutei `/flows/:flowId/signed-pdf` — neatinsă; doar livrarea se mută în funcția comună, bit-identic.
- Ruta nouă: acces DOAR prin `canViewFormular` pe ORD + gărzile de organizație, dosar, aprobare.
- Lista ALOP și ciclurile — neatinse (doar antetul detaliului).
- ⛔ Zona NO-TOUCH (STS/PAdES) — neatinsă.
- `?v=` țintit, `git add` explicit, `old_str` unic sau STOP.
