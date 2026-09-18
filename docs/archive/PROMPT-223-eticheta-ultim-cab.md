---
task: "#223 — coloana „Responsabil CAB": afișăm doar numele, data și ora (fără eticheta „ultim: ")"
model_suggested: "Sonnet 5, efort low"
branch: develop
target_version: 3.9.875
migrations: none
touches_public: yes (public/js/formular/list.js, public/formular.html)
cache_version_bump: NU
---

# ⛔ AVERTISMENT DE RAMURĂ — CITEȘTE ÎNAINTE DE ORICE COMANDĂ

**Lucrezi EXCLUSIV pe `develop`.** `main` = PRODUCȚIE și e gestionat MANUAL de Mircea.
Nu propune, nu executa `checkout main`, `merge main`, `push origin main`. Niciodată.
Pasul final obligatoriu al acestui lot este `git push origin develop`.

===============================================================================

## CONTEXT

#217 a adăugat, sub compartimentul din coloana „Responsabil CAB" (listele DF și ORD),
ultimul utilizator din compartimentul CAB care a lucrat pe document. Linia arată azi:

```
👥 Serviciul Buget
ultim: Mircea Diana · 17.09.2026, 14:38
```

Decizia lui Mircea: eticheta `ultim: ` iese. Sensul liniei e deja explicat de
atributul `title` la hover, iar spațiul din coloană e prețios.

```
👥 Serviciul Buget
Mircea Diana · 17.09.2026, 14:38
```

**Se schimbă DOAR textul din ghilimele.** Restul liniei — condiția de afișare,
stilul, separatorul ` · `, formatarea datei, atributul `title` — rămâne bit-identic.

===============================================================================

## PASUL 1 — Verifică punctul de atac (o singură ocurență în tot arborele)

```bash
grep -rn "ultim: " public/js/ | wc -l
# Așteptat: 1

grep -n "ultim: " public/js/formular/list.js
# Așteptat: o singură linie (în jur de 965), în interiorul lui _renderLstTable
```

`_renderLstTable` e **partajat de lista DF și lista ORD** — o singură modificare
acoperă ambele taburi. Nu căuta un al doilea loc.

```bash
grep -n "p2_ultim_cab" public/js/formular/list.js
# Așteptat: 4 linii — 964, 965 (randare) și 2 în exportLista (Excel).
# ⚠️ Exportul folosește VALOAREA BRUTĂ (`row.p2_ultim_cab||''`), fără prefix.
#    NU îl atinge: Excel-ul e deja curat.
```

===============================================================================

## PASUL 2 — Patch chirurgical

Fișier: `public/js/formular/list.js`

`old_str`:
```
>ultim: ${esc(row.p2_ultim_cab)}$
```

`new_str`:
```
>${esc(row.p2_ultim_cab)}$
```

⚠️ Fragmentul e ales ca să fie unic (începe cu `>` de închidere a tag-ului `div`
și se termină cu `$` de deschidere a interpolării următoare). Dacă `str_replace`
refuză din cauza a zero sau mai multe potriviri, **lărgește `old_str`** cu
`document">` în față — nu împărți patch-ul în două.

===============================================================================

## PASUL 3 — Verifică rezultatul (aserțiuni derivate din textul patch-ului)

```bash
grep -c "ultim: " public/js/formular/list.js
# Așteptat: 0

grep -n 'title="Ultimul utilizator din compartimentul CAB care a lucrat pe document"' public/js/formular/list.js | wc -l
# Așteptat: 1   (title-ul NU s-a atins — el rămâne singura explicație a liniei)

grep -c "p2_ultim_cab" public/js/formular/list.js
# Așteptat: 4   (nimic pierdut din randare sau din export)

node --check public/js/formular/list.js
# Așteptat: fără ieșire (fișierul e sintactic valid)
```

===============================================================================

## PASUL 4 — Versionare

```bash
npm version patch --no-git-tag-version
node -e "console.log(require('./package.json').version)"
# Așteptat: 3.9.875
```

Cache busting **țintit** pe singurul asset schimbat:

```bash
grep -n "formular/list.js?v=" public/*.html
# Așteptat: o singură linie, în formular.html, cu valoarea CURENTĂ (3.9.873)

NEW=$(node -e "console.log(require('./package.json').version)")
sed -i -E "s#(js/formular/list\.js\?v=)[0-9.]+#\1$NEW#g" public/formular.html

grep -n "formular/list.js?v=" public/*.html
# Așteptat: aceeași linie, acum cu 3.9.875, tag <script> INTACT
```

⛔ **NU face sed în masă pe toate `?v=`** din HTML — driftul față de `package.json`
e intenționat (commit-urile doar-backend sar peste sed).
⛔ **NU atinge `CACHE_VERSION` din `public/sw.js`**: `js/formular/list.js` nu e în
`PRECACHE_ASSETS` (verifică singur cu `grep -n "formular/" public/sw.js` → 0 linii).
⛔ În `sed`, grupul de captură se referă cu `\1`, NU cu `\g<1>`.

===============================================================================

## PASUL 5 — Teste

```bash
npm test
# Așteptat: verde, fără regresii. Niciun test nu ancorează pe șirul „ultim: ";
# dacă totuși pică ceva, OPREȘTE-TE și raportează — nu modifica testul.
```

`npm run test:db` nu e necesar: lotul nu atinge nimic din server.

===============================================================================

## PASUL 6 — Commit + push

```bash
git add -A
git status --short
# Așteptat: exact 3 intrări — public/js/formular/list.js, public/formular.html, package.json
# (+ package-lock.json dacă npm version l-a atins → atunci 4)

git commit -m "fix(#223): coloana Responsabil CAB afișează doar numele, data și ora (fără eticheta «ultim: »)"
git push origin develop
```

===============================================================================

## RAPORT FINAL (obligatoriu)

1. Linia din `list.js` ÎNAINTE și DUPĂ (copiate din fișier, nu rescrise din memorie).
2. Rezultatul fiecărei comenzi de verificare din PAȘII 1, 3 și 4, cu cifra obținută
   lângă `# Așteptat:`.
3. Versiunea din `package.json` și valoarea `?v=` din `formular.html`.
4. Rezultatul `npm test`.
5. Hash-ul commit-ului și confirmarea `git push origin develop`.
6. Orice abatere de la prompt, cu motivul. Dacă ai găsit ceva ce contrazice
   promptul (de ex. o a doua ocurență), **raportează, nu improviza**.

===============================================================================

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Zero modificări pe server. Acest lot e 100% frontend.
- ⛔ Nu atinge `exportLista` — Excel-ul primește deja valoarea curată.
- ⛔ Nu atinge atributul `title`, stilul inline, separatorul ` · ` sau `_fmtDate`.
- ⛔ Nu atinge `CACHE_VERSION`.
- ⛔ Nu modifica niciun test existent.
- ⛔ Nu atinge zona NO-TOUCH (`STSCloudProvider.mjs`, `routes/flows/cloud-signing.mjs`,
  `routes/flows/bulk-signing.mjs`, `signing/pades.mjs`, `signing/java-pades-client.mjs`).
- ⛔ `main` nu se atinge. Push DOAR pe `origin develop`.
