---
prompt: 84
titlu: "PDF DF/ORD — coloana Cod SSI pe un singur rând + capturi la lățime completă"
branch: develop
model_suggested: "Sonnet 4.6 (Default) — modificări chirurgicale de layout într-un singur fișier"
fisiere_atinse:
  - server/routes/formulare.mjs
  - server/tests/integration/formulare-pdf-wrap.test.mjs
  - package.json
versiune: 3.9.663 → 3.9.664
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

> `main` = **PRODUCȚIE** și este gestionat **manual, doar de Mircea**.
> NU face `checkout main`, NU face `merge` în `main`, NU face `push origin main`.
> Toate commit-urile merg pe `develop` (auto-deploy pe staging).

=====================================================================
## CONTEXT
=====================================================================

PDF-ul generat pentru **DF (NOTAFD)** și **ORD (ORDNT)** înainte de trimiterea pe flux
este produs integral server-side în `server/routes/formulare.mjs`, funcția
`generatePdfSimple(formType, data)` (pdf-lib + NotoSans TTF).

Două probleme de layout raportate din producție (PDF real: `PZ_D21DF3DAE6_signed.pdf`):

**BUG 1 — coloana „Cod SSI" e prea îngustă.**
Codul SSI real are 15 caractere (ex. `02A740501200130`). Măsurat în NotoSans-Regular:

| Font | Lățime „02A740501200130" |
|------|--------------------------|
| 7pt  | **60,5pt**               |
| 6,5pt| 56,2pt                   |
| 6pt  | 51,9pt                   |

Lățimile utile actuale ale coloanei Cod SSI (`col.width - 4` = padding intern):

| Tabel | width | pad util | 60,5pt încape? |
|-------|-------|----------|----------------|
| DF pct.4 „Element de fundamentare" | 70 | 66 | ✅ (la limită) |
| DF pct.5 „Angajamente legale — plăți" | 63 (`wPl`) | 59 | ❌ **wrap** |
| DF Secțiunea B | 49 (`wCt`) | 45 | ❌ **wrap** (vizibil în PDF: `02A74050120` / `0130`) |
| ORD tabel detalii plată | 60 | 56 | ❌ **wrap** |

**BUG 2 — capturile de ecran sunt prea mici.**
`embedCapture()` folosește `const maxW = CW, maxH = 200;`. O captură tipică 1366×768
este scalată întâi la lățime 515pt (⇒ h=289pt), apoi **plafonată la h=200pt**, ceea ce
o re-scalează înapoi la doar ~356pt lățime (≈69% din pagină). Utilizatorul vrea captura
**pe toată lățimea conținutului** („cât ține pagina").

=====================================================================
## OBIECTIV
=====================================================================

1. Lățește coloana **Cod SSI** în **toate cele 4 tabele** (3 la DF + 1 la ORD) astfel încât
   un cod de 15–16 caractere să încapă pe **un singur rând**, redistribuind lățimea din
   coloanele care au surplus. Suma lățimilor trebuie să rămână **exact `CW` (515pt)**.
2. Adaugă un flag `shrink: true` pe coloanele de tip cod (Cod SSI, Cod angajament,
   Program) — micșorează fontul 7 → 5,5pt ca să păstreze valoarea pe **un singur rând**;
   abia dacă nici așa nu încape, cade pe wrap (**niciodată trunchiere**).
3. Scalează capturile la **lățimea completă a conținutului**, limitate doar de înălțimea
   utilă a paginii.

⚠️ **NU atinge** logica de business, rutele, validările (`validateNotafd` / `validateOrdnt`),
sau vreun alt fișier în afara celor 3 listate în frontmatter.

=====================================================================
## PAS 1 — Citește fișierul înainte de orice patch
=====================================================================

```bash
git checkout develop && git pull origin develop
sed -n '250,410p' server/routes/formulare.mjs   # drawTable
sed -n '596,720p' server/routes/formulare.mjs   # tabelele DF (pct.4, pct.5, SecB)
sed -n '776,800p' server/routes/formulare.mjs   # tabelul ORD
sed -n '872,896p' server/routes/formulare.mjs   # embedCapture
```

=====================================================================
## PAS 2 — `drawTable`: suport `shrink` pe coloane de tip cod
=====================================================================

**Fișier:** `server/routes/formulare.mjs`

`old_str`:
```js
      for (const col of cols) {
        const rawVal = row[col.key] ?? '';
        const cellPad = col.width - 4;
        let fs = ROW_FS;
        let lines;
        if (col.numeric) {
          const numStr = str(fmtNum(rawVal));
          if (tw(numStr, fR, fs) > cellPad) {
            for (fs = 6.5; fs >= 6; fs -= 0.5) {
              if (tw(numStr, fR, fs) <= cellPad) break;
            }
          }
          lines = tw(numStr, fR, fs) <= cellPad
            ? [numStr]
            : wrapText(numStr, fR, fs, cellPad);
        } else {
          lines = wrapText(str(rawVal), fR, fs, cellPad);
        }
```

`new_str`:
```js
      for (const col of cols) {
        const rawVal = row[col.key] ?? '';
        const cellPad = col.width - 4;
        let fs = ROW_FS;
        let lines;
        if (col.numeric) {
          const numStr = str(fmtNum(rawVal));
          if (tw(numStr, fR, fs) > cellPad) {
            for (fs = 6.5; fs >= 6; fs -= 0.5) {
              if (tw(numStr, fR, fs) <= cellPad) break;
            }
          }
          lines = tw(numStr, fR, fs) <= cellPad
            ? [numStr]
            : wrapText(numStr, fR, fs, cellPad);
        } else if (col.shrink) {
          // Coloane de cod (Cod SSI, Cod angajament, Program): valoarea trebuie să
          // rămână pe UN SINGUR RÂND. Micșorăm fontul 7 → 5,5pt înainte de a accepta
          // wrap-ul. Niciodată trunchiere (fără „…").
          const codeStr = str(rawVal);
          if (tw(codeStr, fR, fs) > cellPad) {
            for (fs = 6.5; fs >= 5.5; fs -= 0.5) {
              if (tw(codeStr, fR, fs) <= cellPad) break;
            }
          }
          lines = tw(codeStr, fR, fs) <= cellPad
            ? [codeStr]
            : wrapText(codeStr, fR, fs, cellPad);
        } else {
          lines = wrapText(str(rawVal), fR, fs, cellPad);
        }
```

=====================================================================
## PAS 3 — DF, tabelul de la pct. 4 (`Element de fundamentare`)
=====================================================================

Lățimi noi: `92 + 52 + 74 + 72 + 65 + 55 + 105 = 515` ✅

`old_str`:
```js
    drawTable([
      { header: 'Element de fundamentare',                  key: 'element_fd',    width: 95,
        numLabel: '1', totalText: 'TOTAL' },
      { header: 'Program',                                  key: 'program',       width: 55,
        numLabel: '2', totalText: 'X' },
      { header: 'Cod SSI',                                  key: 'codSSI',        width: 70,
        numLabel: '3', totalText: 'X' },
      { header: 'Parametrii de fundamentare',               key: 'param_fd',      width: 75,
        numLabel: '4', totalText: 'X' },
      { header: 'Valoare totală revizie precedentă (lei)',  key: 'valt_rev_prec', width: 65,
        numLabel: '5', numeric: true },
      { header: 'Influențe +/- (lei)',                      key: 'influente',     width: 55,
        numLabel: '6', numeric: true },
      { header: 'Valoarea totală actualizată (lei)',        key: 'valt_actualiz', width: CW - 95 - 55 - 70 - 75 - 65 - 55,
        numLabel: '7=5+6', numeric: true },
    ], Array.isArray(angV.rowT_ang_pl_val) ? angV.rowT_ang_pl_val : [], { totals: true });
```

`new_str`:
```js
    drawTable([
      { header: 'Element de fundamentare',                  key: 'element_fd',    width: 92,
        numLabel: '1', totalText: 'TOTAL' },
      { header: 'Program',                                  key: 'program',       width: 52,
        numLabel: '2', totalText: 'X', shrink: true },
      { header: 'Cod SSI',                                  key: 'codSSI',        width: 74,
        numLabel: '3', totalText: 'X', shrink: true },
      { header: 'Parametrii de fundamentare',               key: 'param_fd',      width: 72,
        numLabel: '4', totalText: 'X' },
      { header: 'Valoare totală revizie precedentă (lei)',  key: 'valt_rev_prec', width: 65,
        numLabel: '5', numeric: true },
      { header: 'Influențe +/- (lei)',                      key: 'influente',     width: 55,
        numLabel: '6', numeric: true },
      { header: 'Valoarea totală actualizată (lei)',        key: 'valt_actualiz', width: CW - 92 - 52 - 74 - 72 - 65 - 55,
        numLabel: '7=5+6', numeric: true },
    ], Array.isArray(angV.rowT_ang_pl_val) ? angV.rowT_ang_pl_val : [], { totals: true });
```

=====================================================================
## PAS 4 — DF, tabelul de la pct. 5 (plăți)
=====================================================================

Lățimi noi: `Program 60 + Cod SSI 72 + 5×63 + 68 = 515` ✅

`old_str`:
```js
    const wPl = Math.floor((CW - 70) / 7);
    drawTable([
      { header: 'Program',                              key: 'program',                width: 70,
        numLabel: '1', totalText: 'TOTAL' },
      { header: 'Cod SSI',                              key: 'codSSI',                 width: wPl,
        numLabel: '2', totalText: 'X' },
```

`new_str`:
```js
    const wPlProg = 60;                                        // Program
    const wPlSSI  = 72;                                        // Cod SSI — lățit (cod pe 1 rând)
    const wPl = Math.floor((CW - wPlProg - wPlSSI) / 6);       // 6 coloane numerice
    drawTable([
      { header: 'Program',                              key: 'program',                width: wPlProg,
        numLabel: '1', totalText: 'TOTAL', shrink: true },
      { header: 'Cod SSI',                              key: 'codSSI',                 width: wPlSSI,
        numLabel: '2', totalText: 'X', shrink: true },
```

Apoi, **ultima coloană** a aceluiași tabel:

`old_str`:
```js
      { header: 'Plăți estimate ani ulteriori (lei)',   key: 'plati_estim_ani_ulter',  width: CW - 70 - wPl * 6,
        numLabel: '8', numeric: true },
```

`new_str`:
```js
      { header: 'Plăți estimate ani ulteriori (lei)',   key: 'plati_estim_ani_ulter',  width: CW - wPlProg - wPlSSI - wPl * 5,
        numLabel: '8', numeric: true },
```

=====================================================================
## PAS 5 — DF, tabelul din Secțiunea B (10 coloane)
=====================================================================

Lățimi noi: `54 + 46 + 46 + 72 + 5×49 + 52 = 515` ✅

`old_str`:
```js
    const wCt = Math.floor((CW - 70 - 50) / 8);
    drawTable([
      { header: 'Cod angajament',                                                                              key: 'cod_angajament',               width: 70,
        numLabel: '1', totalText: 'TOTAL' },
      { header: 'Indicator angajament',                                                                        key: 'indicator_angajament',         width: 50,
        numLabel: '2', totalText: 'X' },
      { header: 'Program',                                                                                     key: 'program',                      width: wCt,
        numLabel: '3', totalText: 'X' },
      { header: 'Cod SSI',                                                                                     key: 'cod_SSI',                      width: wCt,
        numLabel: '4', totalText: 'X' },
```

`new_str`:
```js
    const wCtAng  = 54;   // Cod angajament
    const wCtInd  = 46;   // Indicator angajament
    const wCtProg = 46;   // Program
    const wCtSSI  = 72;   // Cod SSI — lățit (cod pe 1 rând)
    const wCt = Math.floor((CW - wCtAng - wCtInd - wCtProg - wCtSSI) / 6);  // 6 coloane numerice
    drawTable([
      { header: 'Cod angajament',                                                                              key: 'cod_angajament',               width: wCtAng,
        numLabel: '1', totalText: 'TOTAL', shrink: true },
      { header: 'Indicator angajament',                                                                        key: 'indicator_angajament',         width: wCtInd,
        numLabel: '2', totalText: 'X', shrink: true },
      { header: 'Program',                                                                                     key: 'program',                      width: wCtProg,
        numLabel: '3', totalText: 'X', shrink: true },
      { header: 'Cod SSI',                                                                                     key: 'cod_SSI',                      width: wCtSSI,
        numLabel: '4', totalText: 'X', shrink: true },
```

Apoi, **ultima coloană** (col. 10):

`old_str`:
```js
      { header: 'Suma rezervată din credite bugetare pentru anul curent actualizată (lei)',                    key: 'sum_rezv_crdt_bug_act',        width: CW - 70 - 50 - wCt * 7,
        numLabel: '10=8+9', numeric: true },
```

`new_str`:
```js
      { header: 'Suma rezervată din credite bugetare pentru anul curent actualizată (lei)',                    key: 'sum_rezv_crdt_bug_act',        width: CW - wCtAng - wCtInd - wCtProg - wCtSSI - wCt * 5,
        numLabel: '10=8+9', numeric: true },
```

=====================================================================
## PAS 6 — ORD, tabelul de detalii plată (8 coloane)
=====================================================================

Lățimi noi: `66 + 46 + 48 + 74 + 56 + 58 + 64 + 103 = 515` ✅

`old_str`:
```js
      { header: 'Cod angajament',                  key: 'cod_angajament',         width: 78,
        numLabel: '1.1', totalText: 'TOTAL' },
      { header: 'Indicator angajament',            key: 'indicator_angajament',   width: 60,
        numLabel: '1.2', totalText: 'X' },
      { header: 'Program',                         key: 'program',                width: 55,
        numLabel: '1.3', totalText: 'X' },
      { header: 'Cod SSI',                         key: 'cod_SSI',                width: 60,
        numLabel: '1.4', totalText: 'X' },
      { header: 'Recepții (lei)',                  key: 'receptii',               width: 55,
        numLabel: '2', numeric: true },
      { header: 'Plăți anterioare (lei)',          key: 'plati_anterioare',       width: 60,
        numLabel: '3', numeric: true },
      { header: 'Suma ordonanțată la plată (lei)', key: 'suma_ordonantata_plata', width: 70,
        numLabel: '4', numeric: true },
      { header: 'Recepții neplătite (lei)',        key: 'receptii_neplatite',     width: CW - 78 - 60 - 55 - 60 - 55 - 60 - 70,
        numLabel: '5 = (col.2)-(col.3)-(col.4)', numeric: true },
```

`new_str`:
```js
      { header: 'Cod angajament',                  key: 'cod_angajament',         width: 66,
        numLabel: '1.1', totalText: 'TOTAL', shrink: true },
      { header: 'Indicator angajament',            key: 'indicator_angajament',   width: 46,
        numLabel: '1.2', totalText: 'X', shrink: true },
      { header: 'Program',                         key: 'program',                width: 48,
        numLabel: '1.3', totalText: 'X', shrink: true },
      { header: 'Cod SSI',                         key: 'cod_SSI',                width: 74,
        numLabel: '1.4', totalText: 'X', shrink: true },
      { header: 'Recepții (lei)',                  key: 'receptii',               width: 56,
        numLabel: '2', numeric: true },
      { header: 'Plăți anterioare (lei)',          key: 'plati_anterioare',       width: 58,
        numLabel: '3', numeric: true },
      { header: 'Suma ordonanțată la plată (lei)', key: 'suma_ordonantata_plata', width: 64,
        numLabel: '4', numeric: true },
      { header: 'Recepții neplătite (lei)',        key: 'receptii_neplatite',     width: CW - 66 - 46 - 48 - 74 - 56 - 58 - 64,
        numLabel: '5 = (col.2)-(col.3)-(col.4)', numeric: true },
```

=====================================================================
## PAS 7 — `embedCapture`: captură pe toată lățimea paginii
=====================================================================

`old_str`:
```js
    const maxW = CW, maxH = 200;
    let iw = imgEmbed.width, ih = imgEmbed.height;
    if (iw > maxW) { ih = Math.round(ih * maxW / iw); iw = maxW; }
    if (ih > maxH) { iw = Math.round(iw * maxH / ih); ih = maxH; }
    ensureY(ih + 32);
    y -= 10;
    pg.drawText(str(title), { x: ML, y, font: fB, size: 7.5, color: rgb(0.2, 0.2, 0.2) });
    y -= 4;
    pg.drawLine({ start: { x: ML, y }, end: { x: ML + CW, y },
      thickness: 0.3, color: rgb(0.7, 0.7, 0.7) });
    y -= 2 + ih;
    pg.drawImage(imgEmbed, { x: ML, y, width: iw, height: ih });
    y -= 8;
```

`new_str`:
```js
    // Zoom „cât ține pagina": captura se scalează la lățimea completă a conținutului
    // (CW = 515pt), limitată doar de înălțimea utilă a unei pagini A4. O captură mai
    // mică decât CW este mărită (upscale) — comportament cerut explicit.
    const CAP_HDR = 32;                                  // titlu + linie separatoare + spațiere
    const maxW = CW;
    const maxH = (H - MT - MB) - CAP_HDR - 24;           // ≈ 691pt înălțime utilă
    const sc   = Math.min(maxW / imgEmbed.width, maxH / imgEmbed.height);
    const iw   = Math.round(imgEmbed.width  * sc);
    const ih   = Math.round(imgEmbed.height * sc);

    ensureY(ih + CAP_HDR);
    y -= 10;
    pg.drawText(str(title), { x: ML, y, font: fB, size: 7.5, color: rgb(0.2, 0.2, 0.2) });
    y -= 4;
    pg.drawLine({ start: { x: ML, y }, end: { x: ML + CW, y },
      thickness: 0.3, color: rgb(0.7, 0.7, 0.7) });
    y -= 6 + ih;
    const ix = ML + Math.round((CW - iw) / 2);           // centrat orizontal
    pg.drawImage(imgEmbed, { x: ix, y, width: iw, height: ih });
    pg.drawRectangle({ x: ix, y, width: iw, height: ih,
      borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.4 });
    y -= 8;
```

> `embedCapture` este **singura** cale de embed de imagine în PDF-ul DF/ORD
> (verificat: `grep -rn "embedPng\|embedJpg" server/` → doar `formulare.mjs`,
> `sign-trust-report.mjs` (QR code) și `convertToPdf.mjs` (conversie upload) —
> ambele în afara scopului). Este apelată pentru **DF** (`captureImageBase64`) și
> pentru **ORD** (`captureImageBase64` + `captureImageBase64_2`), deci fix-ul acoperă
> automat **toate capturile din ambele formulare**.

=====================================================================
## PAS 8 — Test: Cod SSI pe UN SINGUR RÂND
=====================================================================

**Fișier:** `server/tests/integration/formulare-pdf-wrap.test.mjs`

Adaugă un helper care extrage **item-urile** de text (nu textul concatenat), ca să putem
demonstra că SSI-ul e desenat printr-un **singur** `drawText`:

Adaugă imediat sub `extractPdfText`:

```js
// ── Helper: extrage item-urile individuale de text (1 item = 1 drawText) ──────

async function extractPdfItems(base64) {
  const data = new Uint8Array(Buffer.from(base64, 'base64'));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const items = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (it.str && it.str.trim()) items.push(it.str.trim());
    }
  }
  doc.destroy();
  return items;
}
```

Apoi adaugă, în `describe('PDF cell wrap (no truncation)')`:

```js
  it('DF — Cod SSI de 15 caractere este desenat pe UN SINGUR rând (pct.4, pct.5 si SecB)', async () => {
    const SSI = '02A740501200130';   // 15 chars — cod SSI real din producție
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Serviciul Tehnic',
        obiect_fd_reviz_scurt: 'Obiect',
        ang_legale_val: {
          ckbx_stab_tin_cont: true,
          rowT_ang_pl_val: [
            { element_fd: 'igienizare', program: '0000000000', codSSI: SSI, param_fd: 'oferta',
              valt_rev_prec: 0, influente: 181500, valt_actualiz: 181500 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: true,
          ckbx_cu_plati_ang_in_mmani: true,
          rowT_ang_pl_plati: [
            { program: '0000000000', codSSI: SSI, plati_ani_precedenti: 0, plati_estim_ancrt: 181500,
              plati_estim_an_np1: 0, plati_estim_an_np2: 0, plati_estim_an_np3: 0, plati_estim_ani_ulter: 0 },
          ],
        },
      },
      sectiuneaB: {
        ckbx_secta_inreg_ctrl_ang: true,
        rowT_ang_ctrl_ang: [
          { cod_angajament: 'AAB542827M6', indicator_angajament: 'AAB', program: '0000000000',
            cod_SSI: SSI, sum_rezv_crdt_ang_af_rvz_prc: 0, influente_c6: 181500,
            sum_rezv_crdt_ang_act: 181500, sum_rezv_crdt_bug_af_rvz_prc: 0,
            influente_c9: 181500, sum_rezv_crdt_bug_act: 181500 },
        ],
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);

    const items = await extractPdfItems(res.body.pdfBase64);

    // SSI-ul trebuie să apară ca item ÎNTREG de 3 ori (pct.4, pct.5, SecB) — nu spart.
    const whole = items.filter(s => s === SSI);
    expect(whole.length).toBe(3);

    // și NU trebuie să existe niciun fragment parțial de SSI (dovada de wrap)
    const fragments = items.filter(s => s !== SSI && SSI.startsWith(s) && s.length >= 8);
    expect(fragments).toHaveLength(0);

    expect(items.join(' ')).not.toContain('…');
  });

  it('ORD — Cod SSI de 15 caractere este desenat pe UN SINGUR rând', async () => {
    const SSI = '02A740501200130';
    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({
        formType: 'ordnt',
        data: {
          Cif: '4646897',
          DenInstPb: 'Primaria Zarnesti',
          NrOrdonantPl: '39917',
          DataOrdontPl: '07.07.2026',
          docFd: {
            nr_unic_inreg: '39917',
            beneficiar: 'SC Test SRL',
            iban_beneficiar: 'RO49AAAA1B31007593840000',
            cif_beneficiar: '1234567',
            rowTfd: [
              { cod_angajament: 'AAB542827M6', indicator_angajament: 'AAB', program: '0000000000',
                cod_SSI: SSI, receptii: 181500, plati_anterioare: 0,
                suma_ordonantata_plata: 181500, receptii_neplatite: 0 },
            ],
          },
        },
      });

    expect(res.status).toBe(200);

    const items = await extractPdfItems(res.body.pdfBase64);
    expect(items.filter(s => s === SSI).length).toBe(1);
    expect(items.filter(s => s !== SSI && SSI.startsWith(s) && s.length >= 8)).toHaveLength(0);
    expect(items.join(' ')).not.toContain('…');
  });
```

=====================================================================
## PAS 9 — Verificare
=====================================================================

```bash
# 1. Suma lățimilor = 515 în toate cele 4 tabele (verificare manuală a aritmeticii)
node -e "
const CW=515;
console.log('pct4 :', 92+52+74+72+65+55 + (CW-92-52-74-72-65-55));
const wPlProg=60, wPlSSI=72, wPl=Math.floor((CW-wPlProg-wPlSSI)/6);
console.log('pct5 :', wPlProg+wPlSSI+wPl*5 + (CW-wPlProg-wPlSSI-wPl*5), '(wPl='+wPl+')');
const a=54,i=46,p=46,s=72, wCt=Math.floor((CW-a-i-p-s)/6);
console.log('SecB :', a+i+p+s+wCt*5 + (CW-a-i-p-s-wCt*5), '(wCt='+wCt+')');
console.log('ORD  :', 66+46+48+74+56+58+64 + (CW-66-46-48-74-56-58-64));
"
# Așteptat: 4 linii, toate cu valoarea 515

# 2. Flag-ul shrink e prezent pe toate coloanele de cod
grep -c "shrink: true" server/routes/formulare.mjs
# Așteptat: 12

# 3. Vechea limită maxH=200 a dispărut
grep -n "maxH = 200" server/routes/formulare.mjs
# Așteptat: (niciun rezultat)

# 4. Teste
npm test
# Așteptat: verde, fără regresii (inclusiv cele 2 teste noi de Cod SSI)
```

=====================================================================
## PAS 10 — Version bump + commit
=====================================================================

Modificare **exclusiv server-side** (generare PDF) — **NU** e nevoie de bump
`sw.js CACHE_VERSION` și **NU** de bulk-replace `?v=` în HTML (niciun asset frontend atins).

```bash
# package.json: 3.9.663 → 3.9.664
git add server/routes/formulare.mjs server/tests/integration/formulare-pdf-wrap.test.mjs package.json
git commit -m "fix(pdf): coloana Cod SSI pe un singur rand (DF pct.4/pct.5/SecB + ORD) + capturi la latime completa (v3.9.664)"
git push origin develop
```

=====================================================================
## RAPORT FINAL
=====================================================================

Raportează, în această ordine:

1. **Diff-ul** aplicat, pe pași (2–7).
2. Output-ul complet al **PAS 9** (toate cele 4 verificări).
3. Numărul de teste rulate și rezultatul (`npm test`).
4. Versiunea nouă din `package.json` și hash-ul commit-ului.
5. **Orice abatere** de la snippet-urile din prompt, cu justificare (dacă `old_str` nu
   s-a potrivit exact — fișierul este sursa de adevăr, nu promptul).
6. Confirmarea explicită că **NU** ai atins `main` și **NU** ai atins niciun fișier
   din NO-TOUCH zone.

=====================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
=====================================================================

- ⛔ **BRANCH `develop` EXCLUSIV.** Fără `checkout`/`merge`/`push` pe `main`.
- ⛔ **NO-TOUCH ZONE** — nu modifica niciodată:
  `server/signing/cloud-signing.mjs`, `server/signing/bulk-signing.mjs`,
  `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`,
  `server/signing/providers/STSCloudProvider.mjs`.
- ⛔ **NU** atinge alte fișiere decât cele 3 din frontmatter.
- ⛔ **NU** modifica `validateNotafd` / `validateOrdnt` / rutele / logica de business.
- ⛔ **NU** șterge și **NU** rescrie teste existente — doar adaugă.
- ⛔ **CITEȘTE fișierul înainte de fiecare patch.** Nu presupune conținutul.
- ⛔ Fără migrări DB. Fără fișiere `.sql` noi.
