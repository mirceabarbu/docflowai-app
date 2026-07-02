---
fix: C — Trasabilitatea afișează numărul DF în loc de numărul propriu al ORD
target_branch: develop
model_suggested: Sonnet 4.6 (display + un câmp în SELECT-uri; localizat, risc mic)
risk: SCĂZUT — doar afișare/citire; fără migrare, fără semnare
---

# ⚠️ BRANCH `develop` EXCLUSIV
NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol pe ele (oricum nu le atinge).

## Cauză (confirmată în sursă)
Modalul „Trasabilitate document" afișează pentru fiecare ORD numărul **DF-ului** (`nr_unic_inreg`), nu numărul propriu al ORD-ului (`nr_ordonant_pl`). De-aia toate ciclurile arată același „ORD: 123" — toate referă același DF, dar numerele lor proprii diferă.

Lanțul:
- Backend `server/services/trasabilitate.mjs`:
  - Q3 (ORD curent, două variante — liniile ~122 și ~150): selectează `foc.nr_unic_inreg AS ord_curent_nr_unic_inreg`. NU selectează `foc.nr_ordonant_pl`.
  - Q4 (cicluri arhivate, linia ~181): `fo.nr_unic_inreg AS ord_nr_unic_inreg`. NU selectează `fo.nr_ordonant_pl`.
  - Mapare răspuns: `ord_curent.nr_unic_inreg` (linia ~244) și ciclurile cu `ord_nr_unic_inreg` (linia ~202).
- Frontend `public/js/formular/trasabilitate.js`:
  - Linia 249 (ORD curent): `const nr = ord.nr_unic_inreg || '(fără număr)';`
  - Linia 282 (ciclu arhivat): `const nr = ciclu.ord_nr_unic_inreg || '(fără număr)';`

Numărul DF e oricum deja vizibil în cardul DF din capul trasabilității — deci pe cardul ORD vrem numărul ORD-ului.

## Fix
### Backend — `server/services/trasabilitate.mjs`
1. Q3 (ambele variante ale SELECT-ului pentru ORD curent): adaugă
   `foc.nr_ordonant_pl AS ord_curent_nr_ordonant_pl,`
2. Q4 (ciclurile arhivate): adaugă
   `fo.nr_ordonant_pl AS ord_nr_ordonant_pl,`
3. Mapare răspuns:
   - în obiectul `ord_curent` (~linia 244): adaugă `nr_ordonant_pl: a.ord_curent_nr_ordonant_pl,`
   - în maparea ciclurilor (~linia 202): adaugă `ord_nr_ordonant_pl: c.ord_nr_ordonant_pl,`
   (păstrează și `nr_unic_inreg`/`ord_nr_unic_inreg` — pot rămâne ca referință DF, nu le șterge.)

### Frontend — `public/js/formular/trasabilitate.js`
1. Linia 249 (ORD curent):
   `const nr = ord.nr_ordonant_pl || '(fără număr)';`
2. Linia 282 (ciclu arhivat):
   `const nr = ciclu.ord_nr_ordonant_pl || '(fără număr)';`
   - NU face fallback la `nr_unic_inreg` (ăla e numărul DF — exact bug-ul). Dacă `nr_ordonant_pl` lipsește, „(fără număr)" e corect. (`nr_ordonant_pl` e câmp obligatoriu pe ORD, deci în practică e mereu setat.)
   - Opțional (decizie ușoară, NU obligatoriu): poți afișa și referința DF ca secundar, ex. `ORD nr. ${nr} · DF ${esc(ord.nr_unic_inreg||'—')}`. Dar fiindcă DF-ul apare deja în cardul de sus, varianta simplă (doar numărul ORD) e suficientă. Lasă pe owner dacă vrea și DF-ul.

## Teste
- Dacă există `server/tests/integration/trasabilitate.test.mjs` și asertează pe numărul ORD, actualizează-l să verifice `nr_ordonant_pl`. Adaugă/extinde un caz: ORD cu `nr_ordonant_pl` ≠ `nr_unic_inreg` → trasabilitatea întoarce și afișează `nr_ordonant_pl`, NU `nr_unic_inreg`.
- `node --check` pe fișierele atinse; `npm test` verde, fără regresii (confirmă în CI pentru testele DB).

## Acceptare
- `npm test` verde, fără regresii.
- `git diff` NO-TOUCH gol.
- Trasabilitatea afișează numărul propriu al fiecărui ORD; cicluri diferite cu ORD-uri diferite arată numere diferite.
- Cache-bust țintit pe `trasabilitate.js` (`?v=`) + bump `package.json` patch.
- CLAUDE.md: o linie („trasabilitatea afișează `nr_ordonant_pl` (numărul ORD), nu `nr_unic_inreg` (numărul DF) — backend-ul trasabilitate întoarce ambele").

## Finalizare
```
git add <doar fișierele acestei sarcini: trasabilitate.mjs, trasabilitate.js, test, CLAUDE.md, package.json>
git commit -m "fix(trasabilitate): afișează numărul propriu al ORD (nr_ordonant_pl), nu numărul DF (nr_unic_inreg)"
git push origin develop
```
