# HOTFIX: test DB stale după FIX B — `noua-lichidare` invariant pică pe CI (400 în loc de 200)

> ⚠️ **BRANCH DISCIPLINE** — EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.
> **ZONA NO-TOUCH:** `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs` — zero modificări.
> Doar fișiere de TEST se modifică aici. Codul de producție NU se atinge.

## Cauză (diagnostic confirmat)

CI (Run DB test suite, Postgres real) pică pe:
`server/tests/db/alop-df-relink-selfheal.test.mjs > ... > noua-lichidare după revizie cu valoare mărită`
`AssertionError: expected 400 to be 200`.

Testul seamănă DF-ul DOAR cu `rows_val: [{ valt_actualiz: '1500' }]` și așteaptă `ramas = 500`. Dar FIX B (v3.9.557) a schimbat baza de calcul a lui `ramas` din `noua-lichidare` de pe `SUM(rows_val.valt_actualiz)` pe `SUM(rows_plati.plati_estim_ancrt)`. Seed-ul NU pune `rows_plati` → `bugetAnCurent = 0` → `ramas = 0 − 1000 < 0` → endpoint-ul întoarce `400 limita_depasita`. Test stale, NU regresie de cod. (Local s-a auto-skip fără Docker, de-asta n-a fost prins la FIX B.)

## Fix (exclusiv în test)

În `server/tests/db/alop-df-relink-selfheal.test.mjs`, testul „noua-lichidare după revizie cu valoare mărită":
- Seed-ul DF-ului și UPDATE-ul reviziei trebuie să populeze `rows_plati` cu `plati_estim_ancrt` consecvent cu noua semantică (bugetul anului curent), nu doar `rows_val`.
- Ajustează valorile ca să testeze EXACT invariantul vizat: revizia mărește bugetul anului curent → `noua-lichidare` permite ciclu nou cu `ramas > 0`. Ex.: revizie cu `rows_plati: [{ plati_estim_ancrt: '1500' }]`, `plataSumaEfectiva: 1000` → `ramas = 500`. Păstrează și `rows_val` coerent (angajament total ≥ buget an curent), ca documentul să rămână realist.
- Actualizează comentariul `// 1500 (revizie) - 1000` ca să reflecte că 1500 e acum bugetul anului curent (`plati_estim_ancrt`), nu `valt_actualiz`.

Verifică în ACELAȘI fișier și restul testelor care ating `noua-lichidare` sau `ramas` și care s-ar putea baza pe vechea semantică `valt_actualiz` — aplică același tratament (seed `rows_plati`). La fel, aruncă un ochi pe `server/tests/db/alop-noua-lichidare-ciclu.test.mjs` și `ord-buget-an-curent-plafon.test.mjs` (actualizate la FIX B) ca să confirmi că nu mai există alt seed bazat pe vechea bază de calcul.

## Verificare

- Rulează suita DB local DACĂ ai Docker (`npm run db:test:up` + `npm run test:db`); altfel, validarea autoritară e CI pe push develop — confirmă verde în GitHub Actions, nu te baza pe skip local.
- Restul suitei (mock) rămâne verde.
- Bump `package.json` patch + linie scurtă în CLAUDE.md NU sunt necesare pentru un hotfix de test, dar bump-ează versiunea dacă vrei trasabilitate în CI.

## Criterii de acceptare

- CI „Run DB test suite (Postgres real)" verde.
- Doar fișiere de test modificate (`git diff --stat` nu arată cod de producție).
- Commit mic, descriptiv, doar pe `develop`.
