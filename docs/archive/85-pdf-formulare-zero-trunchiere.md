---
prompt: 85
titlu: "PDF DF/ORD — eliminarea completă a trunchierilor (zero „…", zero text pierdut)"
branch: develop
model_suggested: "Opus 4.8 — refactor de primitive de layout partajate, cu spargere pe pagini, în ambele formulare"
depinde_de: prompt 84 (trebuie rulat DUPĂ)
fisiere_atinse:
  - server/routes/formulare.mjs
  - server/tests/integration/formulare-pdf-wrap.test.mjs
  - package.json
versiune: 3.9.664 → 3.9.665
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

> `main` = **PRODUCȚIE** și este gestionat **manual, doar de Mircea**.
> NU face `checkout main`, NU face `merge` în `main`, NU face `push origin main`.
> Toate commit-urile merg pe `develop` (auto-deploy pe staging).

=====================================================================
## CONTEXT — inventarul complet al trunchierilor
=====================================================================

În PDF-ul real din producție (`PZ_D21DF3DAE6_signed.pdf`) sunt vizibile trunchieri:

- **Caseta de titlu a DF-ului** (`SubtitluDF`) se taie cu „…" — titlul are 2 rânduri,
  caseta desenează unul singur.
- **Secțiunea A, pct. 2** (`obiect_fd_reviz_scurt`) se taie cu „…".

Cauza este sistemică, nu punctuală. Am inventariat **toate** punctele de trunchiere din
`server/routes/formulare.mjs` (funcția `generatePdfSimple`):

### A. `clamp()` — taie pe un singur rând și adaugă „…"

| Linie | Câmp | Formular |
|-------|------|----------|
| 224 | valoarea din `fieldLine()` → **pct.1 compartiment** și **pct.2 obiect scurt** | DF |
| 457 / 524 | `DenInstPb` | DF + ORD |
| 467 / 534 | `Cif` | DF + ORD |
| **479** | **`SubtitluDF`** (caseta de titlu) | DF |
| 491 / 499 / 506 | `NrUnicInreg` / `Revizuirea` / `DataRevizuirii` | DF |
| 514 | eticheta „se referă la angajamente legale…" | DF |
| 549 / 555 | `NrOrdonantPl` / `DataOrdontPl` | ORD |
| 624 | eticheta „rămâne în suma de … lei" | DF |
| 773 | `df.nr_unic_inreg` | ORD |
| 804 | `df.beneficiar` | ORD |
| **815** | **`df.documente_justificative`** (frecvent lung) | ORD |
| 826 | `df.cif_beneficiar` | ORD |
| 838 | `df.iban_beneficiar` | ORD |
| **844** | **`df.banca_beneficiar`** (frecvent lung) | ORD |

### B. plafoane `maxLines` în `wrapText()` — aruncă rândurile în plus, **fără niciun semn vizibil**

| Linie | Câmp | Plafon | Formular |
|-------|------|--------|----------|
| **580** | `obiect_fd_reviz_lung` (pct. 3, descrierea pe larg) | **12 rânduri** | DF |
| 723 | eticheta „Nu s-au rezervat…" | 3 | DF |
| 733 | eticheta „întrucât creditele…" | 3 | DF |
| **750** | `sB.intrucat` (motivul, text liber al utilizatorului) | **2 rânduri** | DF |
| **854** | `df.inf_pv_plata` + `inf_pv_plata1` | **4 rânduri** | ORD |
| 231 | eticheta din `checkItem()` | 4 | DF |

Acesta este un **document financiar oficial** (OMF 1140/2025). Text pierdut = document
neconform. Obiectivul este **zero trunchiere**, garantată structural.

=====================================================================
## OBIECTIV
=====================================================================

1. Introdu 4 primitive noi de layout care **cresc dinamic** în înălțime și **sparg pe
   pagini noi** când e nevoie: `wrapText2`, `boxedText`, `boxedField`, `boxedFieldRow`.
2. Rescrie `fieldLine()` ca să facă **wrap** (etichetă bold + valoare pe N rânduri).
3. Migrează **toate** punctele din tabelele A și B de mai sus pe noile primitive.
4. **Șterge complet funcția `clamp()`** — după migrare devine mort. Ștergerea ei este
   garanția structurală că nu se mai poate reintroduce o trunchiere prin copy-paste.
5. Elimină toate plafoanele `maxLines` de pe conținut generat de utilizator.

⚠️ Regula de aur: **nicio informație introdusă de utilizator nu are voie să dispară din PDF.**

=====================================================================
## PAS 1 — Citește fișierul înainte de orice patch
=====================================================================

```bash
git checkout develop && git pull origin develop
grep -n "clamp(\|wrapText(" server/routes/formulare.mjs
sed -n '150,250p'  server/routes/formulare.mjs   # primitive + fieldLine + checkItem
sed -n '446,560p'  server/routes/formulare.mjs   # drawDocHeader (DF + ORD)
sed -n '562,600p'  server/routes/formulare.mjs   # buildNotafd — pct.1/2/3
sed -n '714,760p'  server/routes/formulare.mjs   # SecB — intrucat
sed -n '760,872p'  server/routes/formulare.mjs   # buildOrdnt integral
```

=====================================================================
## PAS 2 — Primitive noi (`wrapText2` + `boxedText` + `boxedField` + `boxedFieldRow`)
=====================================================================

Inserează-le **imediat după** funcția `wrapText` existentă (după linia care închide
`wrapText`, în jurul liniei 444 — verifică în fișier).

```js
  // ── Wrap cu prima linie mai îngustă (restul de text curge după o etichetă bold) ──
  // firstW = lățimea disponibilă pe primul rând (după etichetă)
  // restW  = lățimea disponibilă pe rândurile următoare (toată caseta)
  // FĂRĂ plafon de rânduri: niciun text nu se pierde.
  function wrapText2(text, font, size, firstW, restW) {
    const t = String(text ?? '');
    if (!t) return [''];
    const words = t.split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w0 of words) {
      const maxW = lines.length === 0 ? firstW : restW;
      // cuvânt mai lat decât rândul (ex. IBAN, URL) → spargere pe caractere
      if (tw(w0, font, size) > maxW) {
        if (cur) { lines.push(cur); cur = ''; }
        let chunk = '';
        for (const ch of w0) {
          const mw = lines.length === 0 ? firstW : restW;
          if (tw(chunk + ch, font, size) > mw && chunk) { lines.push(chunk); chunk = ch; }
          else { chunk += ch; }
        }
        cur = chunk;
        continue;
      }
      const trial = cur ? cur + ' ' + w0 : w0;
      if (tw(trial, font, size) <= maxW) { cur = trial; }
      else { if (cur) lines.push(cur); cur = w0; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  // ── Casetă de text multiline, FĂRĂ plafon de rânduri, cu spargere pe pagini ─────
  // Înlocuiește pattern-ul „wrapText(..., maxLines) + drawRectangle de înălțime fixă".
  function boxedText(text, { size = 8.5, lh = 11, minH = 28, pad = 4, x = ML, w = CW } = {}) {
    const all = wrapText(str(text), fR, size, w - 2 * pad);   // maxLines implicit = 999
    let idx = 0;
    let guard = 0;
    while (idx < all.length && guard++ < 200) {
      const avail = y - (MB + 5) - 4;                          // spațiu vertical rămas
      const fit   = Math.floor((avail - 8) / lh);
      if (fit < 1) { newPage(); continue; }                    // nu încape nici un rând
      const chunk = all.slice(idx, idx + fit);
      const boxH  = Math.max(minH, chunk.length * lh + 8);
      pg.drawRectangle({ x, y: y - boxH, width: w, height: boxH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      for (let i = 0; i < chunk.length; i++) {
        txt(chunk[i], x + pad, y - 8 - i * lh, { font: fR, size });
      }
      y -= boxH + 4;
      idx += chunk.length;
      if (idx < all.length) newPage();                         // continuăm pe pagina nouă
    }
  }

  // ── Rând încadrat: etichetă bold + valoare cu wrap (înălțime dinamică) ──────────
  // Înlocuiește pattern-ul „rowH = 16 + clamp(valoare)".
  function boxedField(label, value, { size = 8.5, vsize = 9, gapAfter = 2 } = {}) {
    const lbl   = str(label);
    const lblW  = tw(lbl, fB, size) + 8;
    const lines = wrapText2(str(value), fR, vsize, CW - lblW - 6, CW - 8);
    const LHv   = vsize + 2.5;
    const rowH  = Math.max(16, lines.length * LHv + 5);
    ensureY(rowH + gapAfter);
    pg.drawRectangle({ x: ML, y: y - rowH, width: CW, height: rowH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt(lbl, ML + 4, y - 11, { font: fB, size });
    for (let i = 0; i < lines.length; i++) {
      const lx = i === 0 ? ML + lblW : ML + 4;
      txt(lines[i], lx, y - 11 - i * LHv, { font: fR, size: vsize });
    }
    y -= rowH + gapAfter;
  }

  // ── Rând încadrat cu N sub-celule (etichetă + valoare fiecare), înălțime dinamică ─
  // cells: [{ label, value, w }]  — suma w-urilor trebuie să fie CW.
  function boxedFieldRow(cells, { size = 8.5, vsize = 9, gapAfter = 2 } = {}) {
    const LHv = vsize + 2.5;
    const prep = cells.map(c => {
      const lblW = tw(str(c.label), fB, size) + 8;
      return { ...c, lblW, lines: wrapText2(str(c.value), fR, vsize, c.w - lblW - 6, c.w - 8) };
    });
    const maxL = Math.max(1, ...prep.map(p => p.lines.length));
    const rowH = Math.max(16, maxL * LHv + 5);
    ensureY(rowH + gapAfter);
    pg.drawRectangle({ x: ML, y: y - rowH, width: CW, height: rowH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    let cx = ML;
    for (let i = 0; i < prep.length; i++) {
      const p = prep[i];
      txt(str(p.label), cx + 4, y - 11, { font: fB, size });
      for (let li = 0; li < p.lines.length; li++) {
        const lx = li === 0 ? cx + p.lblW : cx + 4;
        txt(p.lines[li], lx, y - 11 - li * LHv, { font: fR, size: vsize });
      }
      if (i < prep.length - 1)
        pg.drawLine({ start: { x: cx + p.w, y }, end: { x: cx + p.w, y: y - rowH },
          thickness: 0.4, color: rgb(0, 0, 0) });
      cx += p.w;
    }
    y -= rowH + gapAfter;
  }
```

=====================================================================
## PAS 3 — `fieldLine()` face wrap (rezolvă pct.1 și pct.2 din Secțiunea A)
=====================================================================

Numele funcției **rămâne** `fieldLine` — cele 2 call-site-uri (pct.1, pct.2) rămân neatinse.

`old_str`:
```js
  function fieldLine(label, value, { size = 8, indent = 0 } = {}) {
    const lbl = str(label) + ': ';
    const lw  = tw(lbl, fB, size);
    const valX = ML + indent + lw;
    const valW = CW - indent - lw;
    const val  = str(value);
    ensureY(LH);
    txt(lbl, ML + indent, y, { font: fB, size });
    txt(clamp(val, fR, size, valW), valX, y, { font: fR, size });
    y -= LH;
  }
```

`new_str`:
```js
  // Etichetă bold + valoare care se pliază pe oricâte rânduri (fără trunchiere).
  function fieldLine(label, value, { size = 8, indent = 0 } = {}) {
    const lbl   = str(label) + ': ';
    const lw    = tw(lbl, fB, size);
    const lineH = size + 3.5;
    const lines = wrapText2(str(value), fR, size, CW - indent - lw, CW - indent);
    const totalH = Math.max(LH, lines.length * lineH);
    ensureY(totalH);
    txt(lbl, ML + indent, y, { font: fB, size });
    for (let i = 0; i < lines.length; i++) {
      const lx = i === 0 ? ML + indent + lw : ML + indent;
      txt(lines[i], lx, y - i * lineH, { font: fR, size });
    }
    y -= totalH;
  }
```

=====================================================================
## PAS 4 — `checkItem()`: scoate plafonul de 4 rânduri
=====================================================================

`old_str`:
```js
    const lines = wrapText(str(label), fR, size, lblW, 4);
```

`new_str`:
```js
    const lines = wrapText(str(label), fR, size, lblW);   // fără plafon de rânduri
```

=====================================================================
## PAS 5 — Antetul DF: rânduri încadrate + caseta de titlu cu wrap
=====================================================================

`old_str` (**tot blocul DF din `drawDocHeader`**, de la „Rând 1" până la checkbox inclusiv):
```js
      // ── Antet DF conform ghid OMF (Capitolul III) ──────────────────────
      // Rând 1: "Instituția publică:" + valoare (full-width, înrămat)
      const rowH1 = 16;
      pg.drawRectangle({ x: ML, y: y - rowH1, width: CW, height: rowH1,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Instituția publică:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW1 = tw('Instituția publică:', fB, 8.5) + 8;
      txt(clamp(str(data.DenInstPb || ''), fR, 9, CW - lblW1 - 6),
          ML + lblW1, y - 11, { font: fR, size: 9 });
      y -= rowH1 + 2;

      // Rând 2: "Cod de identificare fiscală:" + valoare
      const rowH2 = 16;
      pg.drawRectangle({ x: ML, y: y - rowH2, width: CW, height: rowH2,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Cod de identificare fiscală:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW2 = tw('Cod de identificare fiscală:', fB, 8.5) + 8;
      txt(clamp(str(data.Cif || ''), fR, 9, CW - lblW2 - 6),
          ML + lblW2, y - 11, { font: fR, size: 9 });
      y -= rowH2 + 18;

      // Titlu centrat
      centered('DOCUMENT DE FUNDAMENTARE', y, { font: fB, size: 14 });
      y -= 20;

      // Casetă subtitlu (Obiectul DF) — full-width, încadrat
      const subH = 28;
      pg.drawRectangle({ x: ML, y: y - subH, width: CW, height: subH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      const subStr = clamp(str(data.SubtitluDF || ''), fR, 10, CW - 8);
      const subW = tw(subStr, fR, 10);
      txt(subStr, ML + (CW - subW) / 2, y - subH / 2 - 3, { font: fR, size: 10 });
      y -= subH + 8;

      // Rând: "Numar unic de inregistrare" / "revizuirea" / "data" în 3 sub-celule
      const rowH3 = 16;
      pg.drawRectangle({ x: ML, y: y - rowH3, width: CW, height: rowH3,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      const cell1W = CW * 0.5;
      txt('Numar unic de inregistrare:', ML + 4, y - 11, { font: fB, size: 8 });
      const lblNr = tw('Numar unic de inregistrare:', fB, 8) + 8;
      txt(clamp(str(data.NrUnicInreg || ''), fR, 8.5, cell1W - lblNr - 6),
          ML + lblNr, y - 11, { font: fR, size: 8.5 });
      pg.drawLine({ start: { x: ML + cell1W, y }, end: { x: ML + cell1W, y: y - rowH3 },
        thickness: 0.4, color: rgb(0, 0, 0) });
      const cell2X = ML + cell1W;
      const cell2W = CW * 0.25;
      txt('revizuirea:', cell2X + 4, y - 11, { font: fB, size: 8 });
      const lblRev = tw('revizuirea:', fB, 8) + 8;
      txt(clamp(str(data.Revizuirea || ''), fR, 8.5, cell2W - lblRev - 6),
          cell2X + lblRev, y - 11, { font: fR, size: 8.5 });
      pg.drawLine({ start: { x: cell2X + cell2W, y }, end: { x: cell2X + cell2W, y: y - rowH3 },
        thickness: 0.4, color: rgb(0, 0, 0) });
      const cell3X = cell2X + cell2W;
      txt('/ data:', cell3X + 4, y - 11, { font: fB, size: 8 });
      const lblData = tw('/ data:', fB, 8) + 8;
      txt(clamp(str(data.DataRevizuirii || ''), fR, 8.5, ML + CW - cell3X - lblData - 6),
          cell3X + lblData, y - 11, { font: fR, size: 8.5 });
      y -= rowH3 + 14;

      // Checkbox "obligație legală terț"
      const cbY = y;
      drawCheckbox(ML, cbY, data.ckbx_oblig_tert);
      const lblObligTxt = 'se referă la angajamente legale care se emit ca urmare a unei obligații legale sau de către un terț';
      txt(clamp(str(lblObligTxt), fR, 8, CW - 16), ML + 14, cbY, { font: fR, size: 8 });
      y -= 14;
```

`new_str`:
```js
      // ── Antet DF conform ghid OMF (Capitolul III) ──────────────────────
      // Rând 1 + 2: instituția publică și CIF — casete cu înălțime dinamică (fără trunchiere)
      boxedField('Instituția publică:', data.DenInstPb || '');
      boxedField('Cod de identificare fiscală:', data.Cif || '');
      y -= 16;

      // Titlu centrat
      centered('DOCUMENT DE FUNDAMENTARE', y, { font: fB, size: 14 });
      y -= 20;

      // Casetă subtitlu (Obiectul DF) — TEXT INTEGRAL: wrap + auto-shrink font, înălțime dinamică
      const subRaw = str(data.SubtitluDF || '');
      let subFS = 10;
      let subLines = wrapText(subRaw, fR, subFS, CW - 8);
      if (subLines.length > 3) { subFS = 9;   subLines = wrapText(subRaw, fR, subFS, CW - 8); }
      if (subLines.length > 5) { subFS = 8.5; subLines = wrapText(subRaw, fR, subFS, CW - 8); }
      const subLH = subFS + 2.5;
      const subH  = Math.max(28, subLines.length * subLH + 10);
      ensureY(subH + 8);
      pg.drawRectangle({ x: ML, y: y - subH, width: CW, height: subH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      const subTop = y - (subH - subLines.length * subLH) / 2 - subLH + 3;
      for (let i = 0; i < subLines.length; i++) {
        const slw = tw(subLines[i], fR, subFS);
        txt(subLines[i], ML + (CW - slw) / 2, subTop - i * subLH, { font: fR, size: subFS });
      }
      y -= subH + 8;

      // Rând: "Numar unic de inregistrare" / "revizuirea" / "data" în 3 sub-celule
      boxedFieldRow([
        { label: 'Numar unic de inregistrare:', value: data.NrUnicInreg || '',    w: CW * 0.5  },
        { label: 'revizuirea:',                 value: data.Revizuirea || '',     w: CW * 0.25 },
        { label: '/ data:',                     value: data.DataRevizuirii || '', w: CW * 0.25 },
      ], { size: 8, vsize: 8.5 });
      y -= 12;

      // Checkbox "obligație legală terț" — eticheta se pliază, nu se taie
      checkItem(data.ckbx_oblig_tert,
        'se referă la angajamente legale care se emit ca urmare a unei obligații legale sau de către un terț');
```

=====================================================================
## PAS 6 — Antetul ORD: rânduri încadrate
=====================================================================

`old_str` (**tot blocul ORD din `drawDocHeader`**):
```js
      // ── Antet ORD conform ghid OMF (Capitolul IV) ───────────────────────
      // Rând 1: "Instituția publică:" + valoare (full-width, încadrat)
      const rowH1o = 16;
      pg.drawRectangle({ x: ML, y: y - rowH1o, width: CW, height: rowH1o,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Instituția publică:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW1o = tw('Instituția publică:', fB, 8.5) + 8;
      txt(clamp(str(data.DenInstPb || ''), fR, 9, CW - lblW1o - 6),
          ML + lblW1o, y - 11, { font: fR, size: 9 });
      y -= rowH1o + 2;

      // Rând 2: "Cod de identificare fiscală:" + valoare
      const rowH2o = 16;
      pg.drawRectangle({ x: ML, y: y - rowH2o, width: CW, height: rowH2o,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      txt('Cod de identificare fiscală:', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblW2o = tw('Cod de identificare fiscală:', fB, 8.5) + 8;
      txt(clamp(str(data.Cif || ''), fR, 9, CW - lblW2o - 6),
          ML + lblW2o, y - 11, { font: fR, size: 9 });
      y -= rowH2o + 18;

      // Titlu centrat
      centered('ORDONANȚARE DE PLATĂ', y, { font: fB, size: 14 });
      y -= 20;

      // Rând "nr." + valoare | "/ data" + valoare (2 sub-celule)
      const rowH3o = 16;
      pg.drawRectangle({ x: ML, y: y - rowH3o, width: CW, height: rowH3o,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      const cellNrW = CW * 0.5;
      txt('nr.', ML + 4, y - 11, { font: fB, size: 8.5 });
      const lblNrO = tw('nr.', fB, 8.5) + 8;
      txt(clamp(str(data.NrOrdonantPl || ''), fR, 9, cellNrW - lblNrO - 6),
          ML + lblNrO, y - 11, { font: fR, size: 9 });
      pg.drawLine({ start: { x: ML + cellNrW, y }, end: { x: ML + cellNrW, y: y - rowH3o },
        thickness: 0.4, color: rgb(0, 0, 0) });
      txt('/ data', ML + cellNrW + 4, y - 11, { font: fB, size: 8.5 });
      const lblDataO = tw('/ data', fB, 8.5) + 8;
      txt(clamp(str(data.DataOrdontPl || ''), fR, 9, CW - cellNrW - lblDataO - 6),
          ML + cellNrW + lblDataO, y - 11, { font: fR, size: 9 });
      y -= rowH3o + 6;
```

`new_str`:
```js
      // ── Antet ORD conform ghid OMF (Capitolul IV) ───────────────────────
      // Rând 1 + 2: instituția publică și CIF — casete cu înălțime dinamică (fără trunchiere)
      boxedField('Instituția publică:', data.DenInstPb || '');
      boxedField('Cod de identificare fiscală:', data.Cif || '');
      y -= 16;

      // Titlu centrat
      centered('ORDONANȚARE DE PLATĂ', y, { font: fB, size: 14 });
      y -= 20;

      // Rând "nr." + valoare | "/ data" + valoare (2 sub-celule)
      boxedFieldRow([
        { label: 'nr.',    value: data.NrOrdonantPl || '', w: CW * 0.5 },
        { label: '/ data', value: data.DataOrdontPl || '', w: CW * 0.5 },
      ]);
      y -= 4;
```

=====================================================================
## PAS 7 — DF, pct. 3 „Descrierea pe larg" (plafon de 12 rânduri → nelimitat)
=====================================================================

`old_str`:
```js
    if (sA.obiect_fd_reviz_lung) {
      ensureY(LH);
      txt('3. Descrierea pe larg a stării de fapt și de drept:', ML, y, { font: fB, size: 8.5 });
      y -= LH;
      const longTxt = str(sA.obiect_fd_reviz_lung);
      const lines = wrapText(longTxt, fR, 8.5, CW - 8, 12);
      const boxH = Math.max(40, lines.length * 11 + 8);
      ensureY(boxH + 4);
      pg.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      for (let i = 0; i < lines.length; i++) {
        txt(lines[i], ML + 4, y - 8 - i * 11, { font: fR, size: 8.5 });
      }
      y -= boxH + 6;
    }
```

`new_str`:
```js
    if (sA.obiect_fd_reviz_lung) {
      ensureY(LH);
      txt('3. Descrierea pe larg a stării de fapt și de drept:', ML, y, { font: fB, size: 8.5 });
      y -= LH;
      // Casetă cu înălțime dinamică, fără plafon de rânduri, cu spargere pe pagini noi.
      boxedText(sA.obiect_fd_reviz_lung, { size: 8.5, lh: 11, minH: 40 });
      y -= 2;
    }
```

=====================================================================
## PAS 8 — DF, Secțiunea B: etichete + `intrucat` fără plafoane
=====================================================================

`old_str`:
```js
      const wrappedFara = wrapText(str(lblFara), fR, 8, CW - 16, 3);
```
`new_str`:
```js
      const wrappedFara = wrapText(str(lblFara), fR, 8, CW - 16);
```

`old_str`:
```js
        const wrappedIns = wrapText(str(lblIns), fR, 8, CW - 30, 3);
```
`new_str`:
```js
        const wrappedIns = wrapText(str(lblIns), fR, 8, CW - 30);
```

`old_str` (caseta „întrucât:" — text liber al utilizatorului, plafonat la 2 rânduri):
```js
        if (sB.intrucat) {
          const motivH = 24;
          ensureY(motivH + 2);
          pg.drawRectangle({ x: ML + 14, y: y - motivH, width: CW - 14, height: motivH,
            borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
          const motivLines = wrapText(str(sB.intrucat), fR, 8, CW - 22, 2);
          for (let i = 0; i < motivLines.length; i++) {
            txt(motivLines[i], ML + 18, y - 8 - i * 10, { font: fR, size: 8 });
          }
          y -= motivH + 4;
        }
```

`new_str`:
```js
        if (sB.intrucat) {
          // Motivul (text liber) — integral, fără plafon de rânduri.
          const motivLines = wrapText(str(sB.intrucat), fR, 8, CW - 22);
          const motivH = Math.max(24, motivLines.length * 10 + 8);
          ensureY(motivH + 2);
          pg.drawRectangle({ x: ML + 14, y: y - motivH, width: CW - 14, height: motivH,
            borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
          for (let i = 0; i < motivLines.length; i++) {
            txt(motivLines[i], ML + 18, y - 8 - i * 10, { font: fR, size: 8 });
          }
          y -= motivH + 4;
        }
```

Și eticheta „rămâne în suma de …" (pct. 4), care folosea `clamp`:

`old_str`:
```js
      const lbl = `rămâne în suma de ${sumStr} lei conform fundamentării aprobate într-o revizuire anterioară a prezentului document de fundamentare`;
      txt(clamp(str(lbl), fR, 8, CW - 16), ML + 14, y, { font: fR, size: 8 });
      y -= LH;
```

`new_str`:
```js
      const lbl = `rămâne în suma de ${sumStr} lei conform fundamentării aprobate într-o revizuire anterioară a prezentului document de fundamentare`;
      const lblLines = wrapText(str(lbl), fR, 8, CW - 16);
      for (let i = 0; i < lblLines.length; i++) {
        txt(lblLines[i], ML + 14, y - i * 10, { font: fR, size: 8 });
      }
      y -= Math.max(LH, lblLines.length * 10);
```

=====================================================================
## PAS 9 — ORD, corpul documentului: toate rândurile pe `boxedField`/`boxedFieldRow`/`boxedText`
=====================================================================

### 9a. Nr. unic de înregistrare al DF-ului

`old_str`:
```js
    const rowDfH = 16;
    ensureY(rowDfH + 4);
    pg.drawRectangle({ x: ML, y: y - rowDfH, width: CW, height: rowDfH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Numar unic de inregistrare al documentului de fundamentare:',
        ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblNrDf = tw('Numar unic de inregistrare al documentului de fundamentare:', fB, 8.5) + 8;
    txt(clamp(str(df.nr_unic_inreg || ''), fR, 9, CW - lblNrDf - 6),
        ML + lblNrDf, y - 11, { font: fR, size: 9 });
    y -= rowDfH + 6;
```

`new_str`:
```js
    boxedField('Numar unic de inregistrare al documentului de fundamentare:',
               df.nr_unic_inreg || '', { gapAfter: 6 });
```

### 9b. Beneficiar

`old_str`:
```js
    const rowBfH = 16;
    ensureY(rowBfH + 2);
    pg.drawRectangle({ x: ML, y: y - rowBfH, width: CW, height: rowBfH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Beneficiar:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblBfW = tw('Beneficiar:', fB, 8.5) + 8;
    txt(clamp(str(df.beneficiar || ''), fR, 9, CW - lblBfW - 6),
        ML + lblBfW, y - 11, { font: fR, size: 9 });
    y -= rowBfH + 2;
```

`new_str`:
```js
    boxedField('Beneficiar:', df.beneficiar || '');
```

### 9c. Documente justificative

`old_str`:
```js
    const rowDjH = 16;
    ensureY(rowDjH + 2);
    pg.drawRectangle({ x: ML, y: y - rowDjH, width: CW, height: rowDjH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Documente justificative:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblDjW = tw('Documente justificative:', fB, 8.5) + 8;
    txt(clamp(str(df.documente_justificative || ''), fR, 9, CW - lblDjW - 6),
        ML + lblDjW, y - 11, { font: fR, size: 9 });
    y -= rowDjH + 2;
```

`new_str`:
```js
    boxedField('Documente justificative:', df.documente_justificative || '');
```

### 9d. CIF beneficiar

`old_str`:
```js
    const rowCifH = 16;
    ensureY(rowCifH + 2);
    pg.drawRectangle({ x: ML, y: y - rowCifH, width: CW, height: rowCifH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    txt('Cod de identificare fiscală beneficiar:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblCifW = tw('Cod de identificare fiscală beneficiar:', fB, 8.5) + 8;
    txt(clamp(str(df.cif_beneficiar || ''), fR, 9, CW - lblCifW - 6),
        ML + lblCifW, y - 11, { font: fR, size: 9 });
    y -= rowCifH + 2;
```

`new_str`:
```js
    boxedField('Cod de identificare fiscală beneficiar:', df.cif_beneficiar || '');
```

### 9e. IBAN + Cont deschis la (2 sub-celule)

`old_str`:
```js
    const rowIbnH = 16;
    ensureY(rowIbnH + 2);
    pg.drawRectangle({ x: ML, y: y - rowIbnH, width: CW, height: rowIbnH,
      borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
    const cellIbW = CW * 0.6;
    txt('Cod IBAN beneficiar:', ML + 4, y - 11, { font: fB, size: 8.5 });
    const lblIbW = tw('Cod IBAN beneficiar:', fB, 8.5) + 8;
    txt(clamp(str(df.iban_beneficiar || ''), fR, 9, cellIbW - lblIbW - 6),
        ML + lblIbW, y - 11, { font: fR, size: 9 });
    pg.drawLine({ start: { x: ML + cellIbW, y }, end: { x: ML + cellIbW, y: y - rowIbnH },
      thickness: 0.4, color: rgb(0, 0, 0) });
    txt('Cont deschis la:', ML + cellIbW + 4, y - 11, { font: fB, size: 8.5 });
    const lblCdW = tw('Cont deschis la:', fB, 8.5) + 8;
    txt(clamp(str(df.banca_beneficiar || ''), fR, 9, CW - cellIbW - lblCdW - 6),
        ML + cellIbW + lblCdW, y - 11, { font: fR, size: 9 });
    y -= rowIbnH + 10;
```

`new_str`:
```js
    boxedFieldRow([
      { label: 'Cod IBAN beneficiar:', value: df.iban_beneficiar  || '', w: CW * 0.6 },
      { label: 'Cont deschis la:',     value: df.banca_beneficiar || '', w: CW * 0.4 },
    ], { gapAfter: 10 });
```

### 9f. Informații privind plata (plafon de 4 rânduri → nelimitat)

`old_str`:
```js
    const infTxt = [df.inf_pv_plata, df.inf_pv_plata1].filter(Boolean).join(' ');
    ensureY(LH);
    txt('Informații privind plata:', ML, y, { font: fB, size: 8.5 });
    y -= LH;
    if (infTxt) {
      const lines = wrapText(str(infTxt), fR, 8.5, CW - 8, 4);
      const boxH = Math.max(28, lines.length * 11 + 8);
      ensureY(boxH + 4);
      pg.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      for (let i = 0; i < lines.length; i++) {
        txt(lines[i], ML + 4, y - 8 - i * 11, { font: fR, size: 8.5 });
      }
      y -= boxH + 4;
    } else {
      const boxH = 28;
      ensureY(boxH + 4);
      pg.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH,
        borderColor: rgb(0, 0, 0), borderWidth: 0.4, color: rgb(1, 1, 1) });
      y -= boxH + 4;
    }
  }
```

`new_str`:
```js
    const infTxt = [df.inf_pv_plata, df.inf_pv_plata1].filter(Boolean).join(' ');
    ensureY(LH);
    txt('Informații privind plata:', ML, y, { font: fB, size: 8.5 });
    y -= LH;
    // Casetă cu înălțime dinamică, fără plafon de rânduri, cu spargere pe pagini noi.
    // Text gol → casetă goală de înălțime minimă (comportament păstrat).
    boxedText(infTxt, { size: 8.5, lh: 11, minH: 28 });
  }
```

=====================================================================
## PAS 10 — ȘTERGE funcția `clamp()`
=====================================================================

După pașii 3–9, `clamp` nu mai are niciun apelant. **Șterge-o complet** — este garanția
structurală că nu se mai poate reintroduce o trunchiere.

`old_str`:
```js
  function clamp(s, font, size, maxW) {
    let t = String(s ?? '');
    if (tw(t, font, size) <= maxW) return t;
    while (t.length && tw(t + '…', font, size) > maxW) t = t.slice(0, -1);
    return t.length ? t + '…' : '';
  }

```

`new_str`:
```js
```
*(șterge inclusiv linia goală de după)*

> Dacă `grep -n "clamp(" server/routes/formulare.mjs` mai întoarce apelanți **înainte**
> de acest pas, **NU șterge funcția** — raportează apelanții rămași și migrează-i mai
> întâi pe `boxedField`/`boxedFieldRow`/`fieldLine`/`wrapText`.

=====================================================================
## PAS 11 — Teste noi anti-trunchiere
=====================================================================

**Fișier:** `server/tests/integration/formulare-pdf-wrap.test.mjs`

Adaugă un helper de normalizare (imediat sub `extractPdfText`):

```js
// Normalizează spațierea: PDF-ul sparge textul pe rânduri, extragerea le lipește cu spații.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
```

Apoi adaugă în `describe('PDF cell wrap (no truncation)')`:

```js
  it('DF — titlul lung (SubtitluDF) apare INTEGRAL în caseta de titlu', async () => {
    const TITLU = 'Lucrari de igienizare si ecologizare zona Deal, Saticel si zona situata pe malul stang al raului Barsa la iesirea din Cartierul Saticel, in apropierea statie Peco Octano';
    const data = makeNotafdData({ SubtitluDF: TITLU });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    expect(norm(text)).toContain(norm(TITLU));
    expect(text).not.toContain('…');
  });

  it('DF — Secțiunea A pct.2 (obiect scurt, 250 chars) apare INTEGRAL', async () => {
    const OBIECT = 'Lucrari de igienizare si ecologizare zona Deal, Saticel si zona situata pe malul stang al raului Barsa la iesirea din Cartierul Saticel, in apropierea statiei Peco Octano, conform ofertei nr. 1234 din data de 07.07.2026, cu termen de executie 30 de zile';
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Serviciul Tehnic',
        obiect_fd_reviz_scurt: OBIECT,
        ang_legale_val: { ckbx_stab_tin_cont: true, rowT_ang_pl_val: [{ element_fd: 'E', codSSI: '01A', valt_actualiz: 1 }] },
        ang_legale_plati: {},
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    expect(norm(text)).toContain(norm(OBIECT));
    expect(text).not.toContain('…');
  });

  it('DF — pct.3 „descriere pe larg" de 4000 chars apare INTEGRAL (spargere pe pagini)', async () => {
    const LUNG = Array.from({ length: 160 }, (_, i) => `paragraf${i} despre starea de fapt si de drept`).join(' ');
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Serviciul Tehnic',
        obiect_fd_reviz_scurt: 'Obiect',
        obiect_fd_reviz_lung: LUNG,
        ang_legale_val: { ckbx_stab_tin_cont: true, rowT_ang_pl_val: [{ element_fd: 'E', codSSI: '01A', valt_actualiz: 1 }] },
        ang_legale_plati: {},
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    const n = norm(text);
    expect(n).toContain('paragraf0 despre');     // începutul
    expect(n).toContain('paragraf159 despre');   // FINALUL — dovada că nu s-a plafonat la 12 rânduri
    expect(text).not.toContain('…');
  });

  it('ORD — beneficiar / documente justificative / banca / info plata apar INTEGRAL', async () => {
    const BENEF  = 'SOCIETATEA COMERCIALA DE SALUBRIZARE SI ECOLOGIZARE ZONA MONTANA BRASOV SUD-EST SRL';
    const DOCJ   = 'Factura fiscala seria ZRN nr. 0001234 din 05.07.2026, proces-verbal de receptie nr. 77 din 06.07.2026, situatie de lucrari anexata si oferta tehnico-financiara acceptata';
    const BANCA  = 'Trezoreria Municipiului Zarnesti, Judetul Brasov, Sucursala Operativa Centrala';
    const INFO   = Array.from({ length: 60 }, (_, i) => `detaliu${i} privind plata efectuata`).join(' ');

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({
        formType: 'ordnt',
        data: {
          Cif: '4646897',
          DenInstPb: 'Primaria Orasului Zarnesti, Judetul Brasov',
          NrOrdonantPl: '39917',
          DataOrdontPl: '07.07.2026',
          docFd: {
            nr_unic_inreg: '39917',
            beneficiar: BENEF,
            documente_justificative: DOCJ,
            banca_beneficiar: BANCA,
            iban_beneficiar: 'RO49AAAA1B31007593840000',
            cif_beneficiar: '1234567',
            inf_pv_plata: INFO,
            rowTfd: [
              { cod_angajament: 'AAB542827M6', cod_SSI: '02A740501200130',
                receptii: 181500, suma_ordonantata_plata: 181500 },
            ],
          },
        },
      });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    const n = norm(text);
    expect(n).toContain(norm(BENEF));
    expect(n).toContain(norm(DOCJ));
    expect(n).toContain(norm(BANCA));
    expect(n).toContain('detaliu0 privind');
    expect(n).toContain('detaliu59 privind');   // finalul — dovada că nu s-a plafonat la 4 rânduri
    expect(text).not.toContain('…');
  });
```

=====================================================================
## PAS 12 — Verificare
=====================================================================

```bash
# 1. clamp() a dispărut complet (funcție + toți apelanții)
grep -c "clamp" server/routes/formulare.mjs
# Așteptat: 0

# 2. Niciun plafon maxLines pe conținut generat de utilizator.
#    Singurul wrapText cu al 5-lea argument rămas trebuie să fie cel din drawTable (MAX_HDR_LINES).
grep -n "wrapText(.*,.*,.*,.*,.*)" server/routes/formulare.mjs
# Așteptat: EXACT 1 rezultat — cel cu MAX_HDR_LINES (header de tabel)

# 3. Noile primitive există
grep -c "function wrapText2\|function boxedText\|function boxedField\b\|function boxedFieldRow" server/routes/formulare.mjs
# Așteptat: 4

# 4. Teste
npm test
# Așteptat: verde, fără regresii (inclusiv cele 4 teste noi anti-trunchiere)
```

=====================================================================
## PAS 13 — Version bump + commit
=====================================================================

Modificare **exclusiv server-side** — fără bump `sw.js` și fără bulk-replace `?v=`.

```bash
# package.json: 3.9.664 → 3.9.665
git add server/routes/formulare.mjs server/tests/integration/formulare-pdf-wrap.test.mjs package.json
git commit -m "fix(pdf): eliminare completa a trunchierilor in DF/ORD — casete cu inaltime dinamica, spargere pe pagini, clamp() sters (v3.9.665)"
git push origin develop
```

=====================================================================
## RAPORT FINAL
=====================================================================

1. **Diff-ul** aplicat, pe pași (2–10).
2. Output-ul complet al **PAS 12** (toate cele 4 verificări).
3. **Tabelul de acoperire**: pentru fiecare linie din inventarul A și B de la începutul
   promptului — confirmă că a fost migrată, sau explică de ce nu.
4. `npm test`: număr de teste + rezultat.
5. Versiunea nouă + hash-ul commit-ului.
6. **Orice abatere** de la snippet-uri, cu justificare (fișierul este sursa de adevăr).
7. Confirmarea că **NU** ai atins `main` și niciun fișier din NO-TOUCH zone.

=====================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
=====================================================================

- ⛔ **BRANCH `develop` EXCLUSIV.** Fără `checkout`/`merge`/`push` pe `main`.
- ⛔ **NO-TOUCH ZONE** — nu modifica niciodată:
  `server/signing/cloud-signing.mjs`, `server/signing/bulk-signing.mjs`,
  `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`,
  `server/signing/providers/STSCloudProvider.mjs`.
- ⛔ **NU** atinge alte fișiere decât cele 3 din frontmatter.
- ⛔ **NU** modifica `validateNotafd` / `validateOrdnt` / rutele / logica de business /
  numele câmpurilor din `data` (sunt 1:1 cu schemele XSD ale MF — orice redenumire
  strică serializatoarele XML `notafd-serializer.mjs` / `ordnt-serializer.mjs`).
- ⛔ **NU** șterge și **NU** rescrie teste existente — doar adaugă.
- ⛔ **NU** șterge `clamp()` dacă mai are apelanți — raportează-i întâi.
- ⛔ **CITEȘTE fișierul înainte de fiecare patch.** Nu presupune conținutul.
- ⛔ Fără migrări DB. Fără fișiere `.sql` noi.
