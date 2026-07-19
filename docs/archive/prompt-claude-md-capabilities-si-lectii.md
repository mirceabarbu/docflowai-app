# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> Doar documentație (`CLAUDE.md`) + version bump. Zero cod, zero fișiere de semnare.

---

## Obiectiv

Blochează câștigurile arcului de refactor în `CLAUDE.md`: (1) documentează arhitectura **capabilities**
(ca o sesiune viitoare/Claude Code să NU reintroducă decizii status×rol în frontend), (2) adaugă cele
două lecții de disciplină — „test:db skipped ≠ passed" și „`?v=` driftează, bump țintit pe asset".

---

## Patch 1 — note în secțiunea Testing: skipped ≠ passed

**old_str**
```
- Fără `TEST_DATABASE_URL` se auto-skip (exit 0) — de aceea `npm test` rămâne verde și fără DB.
- CI rulează ambele (serviciu `postgres:16` în GitHub Actions).
```
**new_str**
```
- Fără `TEST_DATABASE_URL` se auto-skip (exit 0) — de aceea `npm test` rămâne verde și fără DB.
- ⚠️ **Skipped ≠ passed.** Un raport local „test:db verde" cu teste *sărite* (fără Docker) NU e dovadă —
  doar testele *passed* contează. Lecție din practică (mai 2026): un test scris greșit a trecut „verde"
  prin skip două commit-uri la rând, apoi a picat la primul push în CI. Confirmă DB-tests prin CI
  (push pe `develop`) sau local cu Docker — niciodată prin skip.
- CI rulează ambele (serviciu `postgres:16` în GitHub Actions) și pe `push: develop`.
```

## Patch 2 — baseline: nu hardcoda numărul

**old_str**
```
**Baseline teste = 758.** Orice modificare care atinge testarea trebuie să confirme numărul exact
prin `npm test` (NU prin `grep it(` — numărătoarea statică ratează al doilea pattern din
`vitest.config.mjs` și testele generate în buclă). După Etapa 1, plus `npm run test:db` verde.
```
**new_str**
```
**Baseline teste — crește în timp** (≈800 la mai/2026; era 758 la Etapa 1). Confirmă prin `npm test`
că e **verde, fără regresii** — NU hardcoda un număr în prompturi (suita crește) și NU folosi `grep it(`
(ratează al doilea pattern din `vitest.config.mjs` + testele generate în buclă). Plus `npm run test:db`
verde (în CI sau cu Docker).
```

## Patch 3 — secțiune nouă: Capabilities (inserată înainte de „Cache busting")

**old_str**
```
---

## Cache busting — când modifici JS/CSS
```
**new_str**
```
---

## Capabilities — sursă unică pentru deciziile de UI (din v3.9.522)

Logica „ce acțiuni/butoane sunt disponibile pe un document" se calculează **server-side**, ca să nu
existe divergență server↔frontend. Frontend-ul DOAR randează din `capabilities`.

- `server/services/formular-capabilities.mjs` → `computeDocCapabilities(doc, actor, ft)` (DF/ORD).
  Atașat pe `document.capabilities` la GET detaliu ȘI pe toate răspunsurile de mutație
  (create/PUT/submit/complete/returneaza) din `server/routes/formulare-db.mjs`.
- `server/services/alop-capabilities.mjs` → `computeAlopCapabilities(alop, actor)` (ALOP):
  `df_action`/`phase_action` (enum), `can_revise_df`/`can_delete`/`can_refresh`/`can_start_noua_ordonantare`.
  Atașat pe GET detaliu `/api/alop/:id` + `can_delete` pe lista `/api/alop`.

Frontend: `doc.js` → `renderActions`, `alop.js` → `renderAlopDetail`, `list.js` → `can_delete`.
Caps decid CE butoane apar; `status`×`rol` aleg DOAR eticheta (prezentare: „Trimite"/„Retrimite",
„Câmpuri"/„Resetează"). Singura decizie client legitimă rămasă e `hasPdf` la DF completed&p1
(Generează PDF vs Lansează flux) — stare locală, nu există pe server.

**Regula:** NU reintroduce decizii status×rol în frontend. Pentru un buton nou condiționat, adaugă un
flag în funcția de capabilities (server) + un test, apoi randează din el. Funcțiile sunt PURE și
acoperite de teste unit + caracterizare DB (`server/tests/db/*capabilities*`,
`server/tests/unit/alop-capabilities.test.mjs`). „Hint de afișare, NU autorizare" — mutațiile rămân
păzite independent pe rutele server (ex. ștergerea fluxurilor e `admin`-only pe backend, indiferent de UI).

**Prospețime caps:** DF/ORD fac update optimist local în `doc.js` → caps trebuie reîmprospătate din
`j.document.capabilities` după FIECARE mutație (de aceea caps e atașat și pe răspunsurile de mutație, nu
doar pe GET). ALOP re-fetch-uiește via `openAlop()` după orice acțiune → caps mereu proaspăt din GET detaliu.

---

## Cache busting — când modifici JS/CSS
```

## Patch 4 — cache-busting: nota despre drift + sed țintit

**old_str**
```
1. **Browser cache** → rezolvat prin `?v=VERSION` pe toate link-urile CSS/JS din HTML. Bump-ează `version` în `package.json` și rulează `sed` pe `?v=` în `public/*.html`.
```
**new_str**
```
1. **Browser cache** → `?v=VERSION` pe link-urile CSS/JS din HTML. Bump-ează `version` în `package.json`
   ȘI bump-ează `?v=` DOAR pe asset-urile schimbate.
   ⚠️ **`?v=` driftează** față de `package.json`: la commit-uri backend-only NU rulezi `sed`, deci `?v=`
   rămâne în urmă (văzut: `df-shell.js` la `518` în 11 fișiere și `524` în unul, cu `package.json` la `528`).
   NU presupune `OLD` din `package.json` — bump **țintit pe numele asset-ului**, independent de valoarea curentă:
   `sed -i -E "s#(nume-asset\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html` (uniformizează și drift-ul existent).
   Citește `?v=` curent din HTML (`grep`), nu-l deduce din versiune.
```

## Patch 5 — `package.json`: version bump

**old_str**
```
  "version": "3.9.531",
```
**new_str**
```
  "version": "3.9.532",
```

---

## Verificări

```bash
grep -n "Skipped ≠ passed\|Capabilities — sursă unică\|driftează" CLAUDE.md   # 3 hit-uri
npm test   # neschimbat (doc-only) → verde
git diff --name-only   # → doar CLAUDE.md + package.json
```

## RAPORT FINAL
- [ ] Versiune → 3.9.532
- [ ] Testing: notă „skipped ≠ passed" + baseline non-hardcodat
- [ ] Secțiune nouă „Capabilities — sursă unică"
- [ ] Cache-busting: notă drift + sed țintit
- [ ] `npm test` verde; diff doar CLAUDE.md + package.json
- [ ] commit + push **develop**

Commit sugerat:
```
docs(claude): arhitectura capabilities + lecții disciplină (skipped≠passed, drift ?v=)

- secțiune nouă: capabilities ca sursă unică pentru deciziile UI (DF/ORD + ALOP); regula anti-magnet
- testing: skipped ≠ passed (doar passed contează); baseline non-hardcodat (crește în timp)
- cache-busting: ?v= driftează vs package.json → bump țintit pe numele asset-ului
- v3.9.532
```
