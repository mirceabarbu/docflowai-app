---
prompt: 80
titlu: "fix(PDF cartuș): spațiere verticală minimă între rândurile de semnatari (gap vertical = gap orizontal ≈ 1pt)"
model_suggested: Opus 4.8
branch: develop
zona: ⚠️ geometrie PDF pe traseul de semnare · Node-only (Java neatins)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ Geometrie pe traseul de semnare — ZERO logică de semnare/STS/CMS. Doar dimensiuni rect.

## Diagnostic (confirmat în cod, Node + Java)
Cartușul de semnatari (documente cu >3 semnatari → 2 rânduri) are gap vertical mare între rânduri față de gap-ul orizontal (`colGap=1pt`). Împărțirea:
- **Java `PadesPrepareService.drawCustomCartus`** desenează chenarul de la `borderTop = h − 0.8` până la `borderBottom = y7 − 2.5 = h − 55.5` → **înălțime chenar ≈ 54.7pt, CONSTANTĂ (independentă de `h`)**. Cutia vizibilă e mereu ~55pt. Java NU se atinge.
- **Node** calculează `cellH = max(56, min(78, (max(120, height*0.30) − (rows−1)*rowGap)/rows))` → pentru 2 rânduri pe A4 = **78**; strideul rândurilor = `cellH + rowGap = 79`; dar `rect h = 65`.
- Rezultat: `9.5pt` gol sub chenar în fiecare celulă (rect 65 − chenar ~55) **+** `14pt` între rect-uri (stride 79 − rect 65) = **~24pt gap vizibil între rânduri**, vs `colGap=1pt` orizontal.

## Fix (Node-only): `cellH` și `rect h` = înălțimea reală a chenarului Java (~55pt)
Setând `cellH = rect h = 57` (chenarul Java ~55pt + 1.5pt margine jos) și păstrând `rowGap=1`:
- fără gol sub chenar (rect ≈ chenar),
- stride vertical = `57 + 1 = 58` → gap între rânduri = `rowGap = 1pt` = `colGap`. ✅

> `57` e aproape de podeaua impusă de Java (chenarul are nevoie de `h ≥ 55.5`, altfel `borderBottom` iese sub rect). Dacă vrei absolut minim, `56` merge (margine 0.5pt); am pus `57` pentru siguranță la descenderul liniei de delegare (rară). NU coborî sub 56.

### 1. `server/index.mjs` — `stampFooterOnPdf`
După `const rowGap = 1;` (~1002), adaugă constanta:
```js
      const CARTUS_CELL_H = 57; // = înălțimea chenarului desenat de Java (~55pt, y7-based) + margine.
                                // stride vertical = CARTUS_CELL_H + rowGap ⇒ gap între rânduri = rowGap (1pt), ca la coloane.
```
Înlocuiește cele DOUĂ calcule `cellH` cu constanta:
- ~1019 `const cellHCheck = Math.max(56, Math.min(78, (Math.max(120, hLast * 0.30) - ((rows - 1) * rowGap)) / rows));`
  → `const cellHCheck = CARTUS_CELL_H;`
- ~1108 `const cellH      = Math.max(56, Math.min(78, (Math.max(120, height * 0.30) - ((rows - 1) * rowGap)) / rows));`
  → `const cellH      = CARTUS_CELL_H;`
Și rect-ul (~1136):
- `signerRects.push({ page: cartusPageNum, x, y, w: cellW, h: 65 });`
  → `signerRects.push({ page: cartusPageNum, x, y, w: cellW, h: CARTUS_CELL_H });`

### 2. `server/utils/pdf-signed-placement.mjs` — `computeSignerRectsReadOnly` (trebuie să coincidă cu #1)
După `const rowGap = 1;` (~82), adaugă `const CARTUS_CELL_H = 57;` (aceeași valoare!).
- ~95 `const cellH = Math.max(56, Math.min(78, (Math.max(120, height * 0.30) - ((rows - 1) * rowGap)) / rows));`
  → `const cellH = CARTUS_CELL_H;`
- ~152 `signerRects.push({ page: lastPageNum, x, y, w: cellW, h: 65 });`
  → `signerRects.push({ page: lastPageNum, x, y, w: cellW, h: CARTUS_CELL_H });`

> Ambele fișiere TREBUIE să folosească aceeași valoare — `index.mjs` desenează, `computeSignerRectsReadOnly` înregistrează rect-urile la creare; dacă diferă, ancora nu coincide cu cutia.

## Ce NU atingem
- ⛔ Serviciul Java (chenarul e deja strâns ~55pt). ⛔ `pades.mjs` (alt traseu — cartuș „SEMNAT SI APROBAT", cellH=64, NU documentul cu >3 semnatari STS). ⛔ Logica de plasare (fits-at-bottom / gap / pagină nouă) rămâne — doar `cellH` scade (cartușul încape mai ușor, fără regresie). ⛔ Orice cod de semnare/CMS/STS/ByteRange.

## „De acum încolo"
Rect-urile se calculează la creare/stampare → afectează DOAR fluxurile noi. Documentele deja semnate rămân neschimbate.

## Test
`server/tests/**` — verifică geometria din `computeSignerRectsReadOnly` (sau un helper pur):
- 5 semnatari (2 rânduri) → fiecare rect `h === 57`; diferența verticală între rândul 0 și rândul 1 (`rects[0].y − rects[3].y`) `=== 58` (cellH+rowGap); coloanele cu `colGap=1`.
- 1 semnatar → `h===57`. 6 semnatari (2×3) idem.
`npm test verde, fără regresii`.

## Cache busting + versiune
- Doar server (fără asset public) ⇒ FĂRĂ `?v=`/`sw.js`. Bump `package.json` (următorul patch).

## Guardrails diff
EXCLUSIV: `server/index.mjs`, `server/utils/pdf-signed-placement.mjs`, `server/tests/**`, `package.json`.
```bash
git diff --name-only | grep -iE "pades|signing|STS|cms|\.java$|cloud-signing" && echo "⛔ STOP: în afara scopului!" || echo "✅ doar geometrie Node"
git diff server/ | grep -iE "signExternal|ByteRange|CMS|randomBytes|provider|widgetRect" && echo "⚠️ verifică: doar cellH/h atins" || echo "✅ doar cellH/h"
```

## Verificare (owner, staging)
- Creează un flux cu **5 semnatari** (2 rânduri), generează + semnează toți (STS Cloud QES).
- În PDF: distanța verticală între rândul 1 și rândul 2 de cutii ≈ distanța orizontală dintre coloane (minimă). Fără gol mare între rânduri.
- Un flux cu ≤3 semnatari (1 rând) — cutiile arată normal, chenar strâns.

## Final
```bash
git add server/index.mjs server/utils/pdf-signed-placement.mjs server/tests package.json
git commit -m "fix(pdf-cartus): spatiere verticala minima intre randurile de semnatari (cellH=h=57, stride=rowGap)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
