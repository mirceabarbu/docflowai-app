---
fix(crit): adaugă pool.on('error') lipsă — o simplă resetare de conexiune Postgres dobora TOT procesul Node
target_branch: develop
model_suggested: Opus 4.8 (atinge gestiunea de erori la nivel de proces — precizie)
risk: FOARTE SCĂZUT (adaugă un handler lipsă, nu schimbă nimic din comportamentul existent pentru cazul „totul e OK")
version: 3.9.612 → 3.9.613
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema (CONFIRMATĂ din logs Railway, root cause al outage-ului de pe staging)
Logurile arată secvența exactă:
```
Postgres: database system was interrupted; last known up at 07:21:13 UTC
Postgres: database system was not properly shut down; automatic recovery in progress
docflowai-app: uncaughtException — exiting   err.message: Connection terminated unexpectedly
```
Postgres a fost întrerupt brusc (motiv încă investigat — posibil platformă Railway, vezi ticket
support separat). Când aplicația a pierdut o conexiune din pool ca urmare a asta, eroarea a
escaladat până la `process.on('uncaughtException')` — care, conform design-ului existent
(intenționat pentru erori cu adevărat necunoscute/periculoase), oprește tot procesul
(`process.exit(1)`).

**Root cause exact:** `pg.Pool` documentează explicit că erorile pe clienți inactivi din pool
(exact ce se întâmplă când serverul Postgres restartează sau o conexiune e resetată de rețea)
trebuie ascultate cu `pool.on('error', ...)`. FĂRĂ acel listener, un eveniment normal și
recuperabil (Postgres bâlbâie o clipă) devine excepție nedeuncaught și **doboară toată
aplicația**, nu doar acea conexiune — amplificând orice problemă minoră de rețea/DB într-un
outage complet, indiferent de cauza inițială.

# 🎯 Scop
Adaugă handler-ul lipsă. Acesta e fix-ul cu cel mai mare impact din toată investigația —
rămâne valabil PERMANENT ca plasă de siguranță, indiferent ce răspunde Railway support pe
partea de ce a cauzat întreruperea inițială a Postgres-ului.

# 🚫 NO-TOUCH
`process.on('uncaughtException')` / `process.on('unhandledRejection')` — rămân EXACT cum sunt
(fail-fast intenționat pentru erori genuin necunoscute). NU le slăbi, NU le elimina. Restul
config-ului pool-ului (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `statement_timeout`,
`ssl`, `keepAlive` — adăugat în v3.9.612) — neschimbate.

# Etapa 0 — caracterizare
```bash
sed -n '120,140p' server/db/index.mjs
sed -n '690,700p' server/index.mjs
grep -n "^import.*logger\|from.*logger" server/db/index.mjs | head -3
```
Confirmă că `logger` e deja importat/disponibil în `server/db/index.mjs` (probabil da — fișierul
face deja `logger.warn`/`logger.error` în alte locuri, verifică).

# Implementare — `server/db/index.mjs`
Imediat DUPĂ crearea `pool` (după `: null;` care închide expresia ternară), adaugă:
```js
// FIX CRITIC (incident 2026-07-02): fără acest handler, o eroare pe un client inactiv din
// pool (ex. Postgres restartează, conexiune resetată de rețea) escaladează la
// process.on('uncaughtException') și doboară TOT procesul — nu doar acea conexiune.
// pg documentează explicit necesitatea acestui listener pentru erori pe clienți idle.
// Non-fatal: pool-ul reface automat conexiunea la următoarea cerere.
if (pool) {
  pool.on('error', (err) => {
    logger.error({ err }, 'pool: eroare pe client inactiv (non-fatală — conexiunea se reface automat)');
  });
}
```
(Adaptează poziția exactă — trebuie să fie DUPĂ ce `pool` e definit, oriunde e natural în
fișier, fără să rupă restul exporturilor.)

# Verificare
Nu necesită test automat care simulează un crash real de Postgres (greu de reprodus determinist
în CI). Verifică manual:
```bash
node --check server/db/index.mjs
node --check server/index.mjs
```
`npm test verde, fără regresii` (sanity check pe suita completă — schimbarea nu atinge logică
de business). `npm run check` OK.

Pe staging, DUPĂ deploy: dacă Postgres mai are un hiccup (din orice cauză), aplicația NU
ar mai trebui să intre în `uncaughtException — exiting` — ar trebui să vezi în schimb
`pool: eroare pe client inactiv (non-fatală...)` și aplicația continuă să răspundă normal.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/db/index.mjs`, `package.json`.
```bash
git diff --name-only | grep -vE "^server/db/index\.mjs$|^package\.json$" && echo "⛔ STOP" || echo "✅ scope curat"
git diff server/index.mjs 2>/dev/null | grep -n "uncaughtException\|unhandledRejection" && echo "⛔ STOP: handlerele de proces nu trebuie atinse!" || echo "✅ neatinse"
```
Backend-only → fără `?v=`/`CACHE_VERSION`. Bump `package.json` 3.9.612 → 3.9.613.

# La final
```bash
git add server/db/index.mjs package.json
git commit -m "fix(crit): pool.on('error') lipsă — o eroare pe conexiune idle nu mai doboară tot procesul (v3.9.613)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Handler-ul adăugat, poziționat corect după definirea pool-ului.
2. `process.on('uncaughtException')`/`unhandledRejection` confirmate NESCHIMBATE.
3. Status CI (`npm test` + `npm run check`); versiune 3.9.613.
4. Recomandare: monitorizează Railway logs — dacă mai apare un hiccup de Postgres, ar trebui
   să vezi `pool: eroare pe client inactiv` în loc de `uncaughtException — exiting`, și
   aplicația să NU mai cadă complet.

---

# Notă separată — de ce a fost întrerupt Postgres inițial
Acest fix oprește AMPLIFICAREA (un hiccup normal → crash total), dar NU explică de ce Postgres
însuși a fost „interrupted"/„not properly shut down" la 07:21:13 UTC. Aceea rămâne investigație
de platformă — planul de acțiune pregătit anterior (verificare status.railway.app, restart
manual Postgres, mesaj către Railway support cu Project ID `293f3150-0e13-43e0-aa55-addbe7191b9d`
și timestamp-urile confirmate) rămâne valabil și necesar în paralel cu acest fix.
