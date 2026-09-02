# PROMPT #152 — zero text tăiat în Raportul de încredere

> ⚠️ **BRANCH: `develop`.** Niciun `checkout`, `merge` sau `push` spre `main`.
> Dacă `git branch --show-current` nu arată `develop`, OPREȘTE-TE.

- **Model recomandat:** Sonnet 5 (efort mediu)
- **versiune_start:** 3.9.808
- **versiune_tinta:** 3.9.809
- **Migrații:** ZERO
- **CACHE_VERSION:** lot server-side — NU

---

## DE CE

Pe un Raport de încredere real, nota nivelului L6 se termină brusc:
„… · QcType-esign (semnatura de" — restul lipsește.

Cauza (`sign-trust-report.mjs:591-594`): nota lui L6 se construiește prin
concatenarea tuturor dovezilor QcStatements separate cu `·`, deci lungimea ei
**crește cu numărul de atribute din certificat**. Rândul are însă înălțime
FIXĂ (`y -= 13` pentru notă, apoi `y -= 18`), fără spațiu rezervat pentru o a
doua linie.

Fișierul are DEJA implementarea corectă: §7 Concluzie face word-wrap manual
(linia ~639), măsurând cu `fontR.widthOfTextAtSize`. Bucla nivelurilor nu o
folosește.

Aceeași clasă de defect a fost reparată anterior în auditul PDF al fluxurilor
(`estimateLines()` + înălțime dinamică de rând). Aici o reparăm o dată, cu un
helper partajat.

---

## PASUL 0 — ancore

```bash
git branch --show-current           # develop
git status --short
grep -n '"version"' package.json    # 3.9.808
grep -c "maxWidth" server/services/sign-trust-report.mjs     # aștept ~15
grep -n "CONCL_MAX_W" server/services/sign-trust-report.mjs  # wrap-ul existent din §7
```

---

## ETAPA A — MĂSOARĂ ÎNTÂI: taie sau se suprapune?

⭐⭐ Nu presupune comportamentul lui pdf-lib. Cele două posibilități cer fixuri
diferite:

- **(a)** `drawText` cu `maxWidth` **nu rupe** rândul ⇒ textul e tăiat la
  margine și restul se pierde.
- **(b)** `drawText` rupe rândul ⇒ liniile suplimentare se desenează SUB `y`,
  peste conținutul următor, fiindcă `y` scade cu o valoare fixă.

Determină care e cazul, empiric:

1. Generează un raport pe fixtura reală și raportează exact ce se vede la nota
   lui L6 — se termină brusc, sau apare o a doua linie suprapusă?
2. Repetă cu o notă **artificial foarte lungă** (300+ caractere) injectată în
   `levels.L6.note`, ca să vezi comportamentul amplificat.
3. Raportează versiunea pdf-lib din `package.json` și ce documentează pentru
   `maxWidth`.

Nu trece la Etapa B fără răspunsul (a) sau (b) și dovada.

---

## ETAPA B — un singur helper de încadrare

Extrage word-wrap-ul manual existent din §7 (linia ~639) într-un helper
reutilizabil, în același fișier, lângă celelalte utilitare de desenare:

```js
/**
 * Rupe `text` în linii care încap în `maxW` la `size`, măsurând cu fontul REAL.
 * Rupe pe spații; un cuvânt mai lung decât maxW se rupe pe caractere (hash-uri,
 * DN-uri fără spații) — altfel ar depăși tăcut marginea.
 */
function wrapLines(text, font, size, maxW) { … }
```

Cerințe:

- măsurare cu `font.widthOfTextAtSize`, **nu** estimare pe număr de caractere
  (fontul e proporțional; o estimare pe caractere greșește pe „lll" vs „WWW");
- ⭐ un cuvânt singur mai lat decât `maxW` se rupe pe caractere — altfel
  hash-urile și DN-urile trec tăcut peste margine;
- `text` gol sau doar spații ⇒ tablou gol, nu o linie goală;
- helperul primește textul **deja trecut prin `ro()`**, sau îl aplică el —
  alege una și fii consecvent; măsurarea trebuie făcută pe șirul FINAL desenat,
  altfel lățimile nu corespund.

⛔ §7 trebuie să folosească noul helper, nu să păstreze o a doua copie a
logicii. Randarea §7 nu are voie să se schimbe vizual.

---

## ETAPA C — bucla nivelurilor L1–L6

Înlocuiește desenarea notei cu una pe linii, cu **înălțime dinamică**:

- calculează liniile cu `wrapLines(...)` înainte de a desena;
- `ensureSpace()` primește înălțimea REALĂ a rândului (etichetă + toate liniile
  notei), nu constanta `20`;
- `y` scade cu înălțimea reală, nu cu `18` fix;
- eticheta nivelului (linia 590) primește același tratament — și ea poate
  depăși la etichete lungi.

⚠️ Verifică pe cod că `ensureSpace()` chiar face salt de pagină și că un rând
cu 3–4 linii nu se rupe peste marginea de jos.

---

## ETAPA D — restul rândurilor expuse

Aplică același tratament, în ordinea riscului:

1. **`drawKV` (352-357)** — `y -= 14` fix, valori variabile (DN-uri, emitenți,
   algoritmi). Cel mai folosit helper din fișier.
2. **Lista lanțului de certificare (548, 554)** — CN-uri lungi de CA.
3. **Audit Trail (621-623)** — trei coloane cu lățimi fixe (135/125/130);
   numele actorului poate depăși. ⚠️ Aici înălțimea rândului trebuie să fie
   maximul dintre cele trei coloane, nu al ultimei desenate.
4. **Hash-uri (437, 523)** — `size: 6` pe toată lățimea; măsoară dacă un
   SHA-256 chiar încape. Dacă da, lasă-le și spune-o în raport.

⛔ Nu schimba dimensiuni de font, margini sau culori ca să „faci loc". Dacă un
text nu încape, se rupe pe linii — nu se micșorează.

---

## ETAPA E — teste

`server/tests/unit/trust-report-wrap.test.mjs`:

1. ⭐⭐ `wrapLines` pe nota REALĂ de L6 din fixtură ⇒ **mai mult de o linie**,
   și concatenarea liniilor (fără separatorii de rând) reproduce textul
   integral, fără caractere pierdute. **Ancora lotului.**
2. ⭐⭐ fiecare linie returnată are lățimea măsurată `<= maxW`.
3. ⭐ un cuvânt de 200 de caractere fără spații ⇒ rupt pe caractere, nicio
   linie peste `maxW`.
4. ⭐ text gol / doar spații ⇒ tablou gol.
5. ⭐ text scurt ⇒ exact o linie, identică cu intrarea.
6. ⭐⭐ raport generat pe fixtură ⇒ se produce fără excepție și are cel puțin
   o pagină; nicio poziție `y` desenată nu iese sub marginea de jos.

⚠️ Dacă nu poți inspecta pozițiile din PDF-ul generat, spune-o și acoperă cât
se poate — ⛔ nu înlocui cazul 6 cu o verificare că „funcția nu aruncă".

```bash
npm test
npm run test:db
```

Înainte de `test:db`: omoară rulările anterioare și recreează baza.

---

## PASUL FINAL

```bash
# package.json: 3.9.808 → 3.9.809
git status --short          # NICIODATĂ `git add -A`
git add server/services/sign-trust-report.mjs \
        server/tests/unit/trust-report-wrap.test.mjs \
        package.json
git diff --cached --stat
git commit -m "fix(#152): text incadrat pe linii in Raportul de incredere, inaltime de rand dinamica (v3.9.809)"
git push origin develop
```

---

## RAPORT FINAL

1. Branch, versiune, ancorele din PASUL 0.
2. ⭐⭐ Etapa A: cazul (a) sau (b), cu dovada. Versiunea pdf-lib.
3. Etapa B: semnătura helperului; confirmarea că §7 îl folosește și că
   randarea §7 nu s-a schimbat vizual.
4. ⭐⭐ Etapa C: pe fixtură, câte linii ocupă nota lui L6 acum și cât e
   înălțimea reală a rândului.
5. Etapa D: ce ai tratat din cele patru și ce ai lăsat, cu măsurătoarea.
   Pentru hash-uri: încap sau nu, în cifre.
6. ⭐ Etapa E: cazurile 1, 2 și 6 — ce au dat.
7. ⭐ A crescut numărul de pagini al raportului? Cu cât, pe fixtură.
8. `npm test` / `npm run test:db` — cifre, PASSED REAL, zero skipped.
9. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri de date.
- O singură implementare de word-wrap în fișier — §7 se mută pe helper.
- Măsurare cu fontul real, niciodată estimare pe număr de caractere.
- Nu micșora fonturi și nu strânge marginile pentru a face loc.
- Nu schimba conținutul notelor — doar felul în care sunt așezate.
- Motoarele de verificare (`verify.mjs`, `certificate-verify.mjs`) nu se ating.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
