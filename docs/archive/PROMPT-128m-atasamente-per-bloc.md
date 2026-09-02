# PROMPT #128m — atașamente per furnizor (migrație + rute + frontend)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus · **Target versiune:** `v3.9.773` (de la 3.9.772 — **citește
`package.json`**) · **Migrații:** UNA, inline, fără mutare de date

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**. ⛔ Fără here-string.

---

## 1. Ce face și ce NU face

Formularul ORD suportă mai mulți furnizori (blocuri) din #128h, cu validări (#128i), comportamente
vii (#128j), paritate (#128k) și fără pierdere de rânduri (#128l). Ce lipsește: blocurile 2+ **nu au
zonă de atașamente și nici captură**. Mircea a confirmat cerința: **atașamente per furnizor**.

**Împărțire deliberată:**

- **acest lot (#128m)** — migrația (care acoperă AMBELE tabele de binare, ca să nu facem un al
  doilea deploy cu schemă) + **atașamentele** cap-coadă;
- **#128n** — **capturile** per bloc (cablarea lor atinge harta globală `imgs[]`, cheiată pe id, plus
  randarea în PDF; e o problemă distinctă și merită lot propriu).

⛔ Nu cabla capturile în acest lot. Coloana lor va exista, dar nimic nu o scrie — la fel cum
`blocuri` a existat fără consumatori între #128b și #128c.

---

## 2. Etapa A — migrația

Ultima migrare inline e `105_formulare_ord_blocuri` (`server/db/index.mjs:2468`). Verifică:

```bash
grep -n "id: '10[0-9]_" server/db/index.mjs | tail -3
```

Dacă ultima nu e `105_…`, **oprește-te și raportează**. ⛔ Nu crea fișiere în
`server/db/migrations/` (numerotarea ca fișiere `.sql` se oprește la `015`).

Adaugă, în același stil, după obiectul `105`:

```js
  {
    // #128m — atașamente (și, la #128n, capturi) per BLOC de furnizor pe ORD.
    // `bloc_idx` e ORTOGONAL pe `slot`: `slot` distinge seturile de atașamente ale unui formular
    // (DF: n-fdad vs n-adata), `bloc_idx` distinge FURNIZORUL. Un ORD poate avea acum N blocuri.
    // ⚠️ FĂRĂ DEFAULT și FĂRĂ backfill, deliberat — același tipar ca `blocuri` la #128b:
    // NULL se citește ca „blocul 0" (`COALESCE(bloc_idx, 0)`), deci rândurile existente rămân
    // exact cum sunt și migrația e reversibilă instantaneu, fără dependență de pg_dump.
    // Coloana pe `formulare_capturi` se adaugă ACUM ca să nu fie nevoie de un al doilea deploy
    // cu schemă la #128n; până atunci rămâne nescrisă.
    id: '106_formulare_binare_bloc_idx',
    sql: `
      ALTER TABLE formulare_atasamente ADD COLUMN IF NOT EXISTS bloc_idx SMALLINT;
      ALTER TABLE formulare_capturi    ADD COLUMN IF NOT EXISTS bloc_idx SMALLINT;

      DROP INDEX IF EXISTS idx_formulare_atasamente_form;
      CREATE INDEX IF NOT EXISTS idx_formulare_atasamente_form
        ON formulare_atasamente(form_type, form_id, slot, bloc_idx) WHERE deleted_at IS NULL;
    `
  },
```

⛔ Fără `NOT NULL`, fără `DEFAULT`, fără `UPDATE`. Indexul se recreează pe același tipar folosit de
migrarea `slot` (v3.9.501) — verifică pe cod numele exact înainte de `DROP`.

---

## 3. Etapa B — serverul

Toate în `server/routes/formulare/shared.mjs`.

### B.1 Rezolvarea parametrului

Un helper local, folosit de toate cele patru rute de atașamente:
`bloc = Number.isInteger(parseInt(req.query.bloc, 10)) && parseInt(req.query.bloc,10) >= 0 ? parseInt(...) : 0`.
Absent ⇒ **0** (retrocompatibil: clienții vechi și DF-ul nu-l trimit).

### B.2 `POST /api/formulare-atasamente/:type/:id`

- `bloc_idx` intră în `INSERT` cu valoarea rezolvată;
- ⭐ **cheia de dedup #124i trebuie EXTINSĂ cu `bloc_idx`.** Azi e
  `(form_type, form_id, slot, filename, size_bytes)`; fără `COALESCE(bloc_idx,0) = $6`, **același
  fișier nu ar putea fi atașat la doi furnizori** — dedup-ul l-ar întoarce pe cel al blocului 0 și
  al doilea bloc ar rămâne fără atașament. Asta e capcana principală a lotului.
  ⛔ Nu slăbi dedup-ul, doar adaugă dimensiunea de bloc.

### B.3 `GET /api/formulare-atasamente/:type/:id` (listă)

Filtrează pe `COALESCE(bloc_idx, 0) = $N` cu blocul cerut, și întoarce `bloc_idx` în DTO.
⚠️ **Retrocompatibilitate:** o cerere FĂRĂ `?bloc` primește blocul 0 — exact ce vede clientul de
azi. ⛔ Nu schimba forma răspunsului în afara câmpului adăugat.

### B.4 `DELETE /api/formulare-atasamente/:type/:id/:attId`

Ștergerea e pe `attId`, deci nu are nevoie de bloc — dar verifică pe cod că nu există niciun
`WHERE` implicit pe slot care ar trebui extins. Raportează ce ai găsit.

### B.5 `copyFormularAttachmentsToFlow` (`server/services/formular-flow-attachments.mjs`)

Copiază atașamentele TUTUROR blocurilor în pachetul de semnare — fluxul e unul singur.
⚠️ `DISTINCT ON (fa.filename, fa.size_bytes)` din #128i rămâne **neschimbat**: dacă același fișier
e atașat la doi furnizori, în pachetul semnat intră o singură dată. E corect (pachetul e un
document, nu o arhivă per furnizor) — dar **scrie-o explicit în comentariu**, altcineva o va crede
un bug.

---

## 4. Etapa C — frontendul

### C.1 Șablonul de bloc

`_sablonBloc` (`core.js`, din #128h) primește o zonă de atașamente identică funcțional cu cea a
blocului 0, dar marcată prin `data-role` (`att-list`, `att-input`, `att-data`) — ⛔ **niciun `id`**,
regula din #128h.

Zona blocului 0 își păstrează id-urile (`o-alist`, `o-ainp`, `o-adata`) și primește **și**
`data-role`, exact ca la #128j pentru `benef-drop`/`cifb-spin`.

### C.2 Funcțiile de atașamente

`addAtt`, `remAttServer`, `uploadAttachments`, `lockCaptureAndAttachments` și randarea listei
operează azi pe id-uri. Generalizează-le să primească un **bloc-țintă**, cu default blocul 0
(apelanții existenți — inclusiv DF-ul — rămân neschimbați).

⚠️ Verifică pe cod harta `_pendingAtt` / structura care ține atașamentele neîncărcate înainte ca
documentul să existe: dacă e cheiată pe id de element sau pe slot, trebuie extinsă cu blocul.
Raportează ce ai găsit — e locul cel mai probabil de pierdere tăcută.

### C.3 Cele TREI trasee

Regula uitată de trei ori (`ctrl_idx` #128g, blocurile #128h, prefill #128k):
**creare · salvare · redeschidere.**

- creare: un bloc nou are zonă de atașamente funcțională imediat;
- salvare: `uploadAttachments` urcă atașamentele **fiecărui** bloc, cu `?bloc=N`;
- ⭐ redeschidere: `populateOrd` / `renderOrdBlocuri` încarcă lista atașamentelor **per bloc**
  (`GET …?bloc=N`). Confirmă explicit în raport, cu test.

### C.4 Delegare, nu cablare

Handlerele de atașamente ale blocurilor noi se leagă prin **delegare pe `#ord-blocuri`**, ca la
#128j — ⛔ nu la creare, ca să nu fie nevoie de cablare și la restaurarea din draft și la
redeschidere.

---

## 5. NO-TOUCH

⛔ `server/signing/**`, `flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ **Capturile** — `o-czone`, `o-czone2`, `o-captura2-wrap`, `imgs[]`, `uploadCaptura`,
   `/api/formulare-capturi/*`, randarea capturilor în PDF: toate sunt **#128n**
⛔ DF-ul (`n-fdad`, `n-adata`, ramurile `notafd`) — comportament byte-identic
⛔ Garda `rows_bloc_lipsa` din #128l, `blocuri`, `ctrl_idx` — nu se ating
⛔ Nu schimba limita de 10 MB, nu atinge `uploadGuard.mjs`

---

## 6. Criteriul de acceptanță

**Un ORD cu un singur bloc și un DF oarecare se comportă IDENTIC cu azi** — aceleași cereri,
aceleași răspunsuri, aceeași listă de atașamente. Dacă un test arată o diferență la un bloc,
patch-ul e greșit.

---

## 7. Teste

**7.1 DB real** (`server/tests/db/atasamente-bloc-idx.test.mjs`):

1. ⭐ **NON-REGRESIE:** upload fără `?bloc` → `bloc_idx = 0`; `GET` fără `?bloc` îl întoarce;
   comportament identic cu înainte;
2. ⭐ **capcana dedup:** același fișier (nume + dimensiune) urcat pe `?bloc=0` și apoi pe `?bloc=1`
   → **DOUĂ** rânduri, câte unul per bloc. Fără extinderea cheii, al doilea ar fi deduplicat și
   blocul 2 ar rămâne fără atașament;
3. același fișier urcat de două ori pe **același** bloc → dedup activ, un singur rând
   (#124i nepierdut);
4. `GET ?bloc=1` întoarce doar atașamentele blocului 1;
5. rânduri legacy cu `bloc_idx` NULL → citite ca bloc 0;
6. `slot` și `bloc_idx` sunt ortogonale: același fișier pe `(slot=1,bloc=0)` și `(slot=2,bloc=0)`
   la DF → două rânduri, neafectat de acest lot;
7. `copyFormularAttachmentsToFlow` pe un ORD cu atașamente în două blocuri → toate ajung în flux;
   același fișier în ambele blocuri → **un** rând în `flow_attachments` (comportament asumat);
8. schemă: `bloc_idx` există pe ambele tabele, e `smallint`, **nullable**, iar un `INSERT` minimal
   nu o populează (apără decizia „fără backfill").

**7.2 Frontend** (happy-dom, modelul din `pagin-component.test.mjs`; capcana:
`dirname(fileURLToPath(import.meta.url))`):

9. ⭐ bloc nou → are zonă de atașamente cu `data-role`, **zero id-uri**;
10. `uploadAttachments` trimite `?bloc=N` corect pentru fiecare bloc;
11. ⭐ la redeschidere (`renderOrdBlocuri`), fiecare bloc își cere lista cu `?bloc=N`;
12. atașamentele blocului 1 nu apar în lista blocului 0 și invers;
13. `lockCaptureAndAttachments(ft, true)` blochează zonele **tuturor** blocurilor;
14. ramura DF → cereri neschimbate.

---

## 8. Cache busting

Verifică pe cod (`grep -n "formular/core.js\|formular/doc.js" public/sw.js`); la #128h–#128l NU
erau în `PRECACHE_ASSETS` ⇒ probabil doar `?v=3.9.773` țintit. **Confirmă**, nu presupune.

---

## 9. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed" — `test:db` e obligatoriu, e singura suită care rulează migrația nouă.

Bump la `3.9.773`;
`git commit -m "feat(#128m): atasamente per furnizor (bloc_idx) + migratia 106"`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 10. Verificări de ieșire (verbatim în raport)

```bash
grep -n "106_formulare_binare_bloc_idx" server/db/index.mjs
# Așteptat: 1 linie

grep -n "bloc_idx SMALLINT" server/db/index.mjs
# Așteptat: 2 linii (atasamente + capturi), FĂRĂ DEFAULT, FĂRĂ NOT NULL

grep -n "COALESCE(bloc_idx" server/routes/formulare/shared.mjs
# Așteptat: dedup + listă

grep -rn "bloc_idx" server/routes/formulare/shared.mjs | grep -c "capturi"
# Așteptat: 0 — capturile sunt #128n, coloana rămâne nescrisă

ls server/db/migrations/ | tail -3
# Așteptat: se termină la 015_* — niciun fișier .sql nou

git status --short
```

---

## 11. RAPORT FINAL

- commit hash + push; versiunea din `package.json`; `git log -1 --pretty=%s` curat
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 6 verificări, verbatim
- ⭐ rezultatele cazurilor **1, 2, 8 și 11** menționate separat
- confirmarea explicită că migrația nu are `UPDATE`, `DEFAULT`, `NOT NULL`
- confirmarea că **capturile nu au fost cablate** (coloana există, nescrisă)
- **ce ai găsit la §4.C.2** despre structura de atașamente pending (cheiată pe ce?) și cum ai
  extins-o
- **al treilea traseu:** confirmarea că redeschiderea încarcă listele per bloc
- actualizarea listei albe din `ord-bloc-paritate.test.mjs` (intrările de atașamente ies din
  „AMÂNAT"; cele de capturi rămân, relabelate `#128n`)
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
