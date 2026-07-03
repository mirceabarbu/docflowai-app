---
target_branch: develop
model_suggested: Sonnet 4.6 (schimbare minimă, 2 apeluri)
risk: LOW — nu schimbă logica, doar conexiunea pe care rulează authz-ul.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️
> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: §4 — authz pe `client` (nu pe `pool`) sub tranzacția deschisă din noua-lichidare

## Context (verificat)
`server/routes/alop.mjs`, ruta `POST /api/alop/:id/noua-lichidare` (~:1211):
- `BEGIN` la ~:1224, apoi `SELECT ... FOR UPDATE` pe rândul alop la ~:1225.
- DAR authz-ul rulează pe `pool`, nu pe `client`:
  - `loadActorComp(pool, actor.userId)` (~:1231)
  - `canEditAlop(pool, actor, alop, actorComp)` (~:1232)
- Asta consumă o A DOUA conexiune din pool cât timp prima ține deja lock-ul `FOR UPDATE`.
  Sub presiune (pool max + lock-uri lungi) e o componentă de contenție. `confirma-plata`
  e deja curat (pre-check pe pool ÎNAINTE de BEGIN).

## Modificare cerută
Schimbă `pool` → `client` în cele două apeluri de authz din `noua-lichidare`
(`loadActorComp` și `canEditAlop`), astfel încât authz-ul să ruleze pe conexiunea
deja deschisă, fără a consuma o a doua. Rândul `alop` e deja citit sub lock, deci nu e
nevoie de re-citire. NIMIC ALTCEVA nu se schimbă.

## Verifică
- `loadActorComp` și `canEditAlop` folosesc primul argument ca executor `.query(...)`
  (drop-in pentru `client`). Dacă vreuna face altceva cu `pool` (ex. `pool.connect`),
  OPREȘTE-TE și raportează — atunci fix-ul diferă.

## Zone interzise
- NU atinge tranzițiile de status, garda de idempotență, fișierele NO-TOUCH, `migrate.mjs`.
- NU muta logica de business; doar executorul authz-ului.

## Definition of done
- `npm test verde, fără regresii` + (CI) `npm run test:db verde` — testele existente pe
  noua-lichidare (404 / 403 / success / concurență) trebuie să rămână identice.
- `npm run check` verde.
- Bump `package.json` patch +1 (citește versiunea curentă). Fără frontend ⇒ fără CACHE_VERSION.
- Commit + push DOAR pe `develop`. STOP înainte de `main`.
