---
fix: Utilizatorii dezactivați (deleted_at NOT NULL) NU mai apar în dropdown-urile de selecție utilizator (semnatari la „Flux nou", transmitere manuală, delegări, șabloane, signer). Ruta GET /users nu filtra soft-delete. Fluxurile ÎN CURS rămân neatinse (stochează semnatarii în datele fluxului).
target_branch: develop
model_suggested: Sonnet 4.6 (Default) — filtru WHERE pe o rută; zero authz nou/financiar/semnare
risk: MIC (3 ramuri de query primesc AND deleted_at IS NULL; backend-ul e singura sursă a listelor de selecție)
version: 3.9.631 → 3.9.632
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. La final: `git push origin develop` și **STOP**.
> Ordine: după promptul 51 (filtru status utilizatori, 630→631). Dacă rulezi 52 înaintea lui 51, schimbă versiunile ca să rămână strict crescătoare.

# Simptom (owner)
La „Flux nou", în dropdown-ul de semnatari („Nume și prenume"), apar și utilizatori DEZACTIVAȚI (ex. „Igrisan Alexandru", marcat DEZACTIVAT în Administrare). Nu ar trebui să poată fi selectați.

# Cauză (confirmată în cod)
Dropdown-urile de selecție se populează din `window._dbUsers`, încărcat din `_apiFetch('/users')`. Ruta `server/routes/admin/users.mjs`, `GET /users` (~linia 41), are 3 ramuri de query:
- `WHERE institutie=$1 ORDER BY nume ASC` (~linia 52)
- `WHERE org_id=$1 ORDER BY nume ASC` (~linia 58)
- `FROM users ORDER BY nume ASC` (~linia 61)
**Niciuna** nu exclude `deleted_at IS NOT NULL` → întoarce și utilizatorii dezactivați.
Consumatori (toți trebuie să excludă dezactivații): `semdoc-initiator/main.js` (semnatari + transmite auto), `df-transmit-modal.js` (transmitere manuală), `df-user-modals.js` (delegări), `templates/templates.js` (șabloane), `semdoc-signer/post-dom-handlers.js`.

# Decizie (owner: „minim, sigur — doar la fluxuri noi")
Excludem dezactivații DOAR din sursa de selecție (`/users`). Fluxurile ÎN CURS stochează semnatarii în `flow.data.signers` (nume/email) și NU re-interoghează `/users` → rămân neatinse. La reinițiere, un fost semnatar dezactivat nu se va mai pre-selecta (comportament corect — nu reasignezi un user dezactivat).
> NU atinge `/admin/users` (managementul, care intenționat poate include dezactivați via `include_deleted=1`).

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== cele 3 ramuri /users ==="; sed -n '48,64p' server/routes/admin/users.mjs
echo "=== confirmare: /users hraneste selectiile, nu /admin/users ==="; grep -rn "_apiFetch('/users')\|fetch('/users'" public/js | grep -v node_modules | grep -v '/admin/users'
echo "=== deleted_at exista pe users? ==="; grep -rn "deleted_at" server/routes/admin/users.mjs | head -3
```

# Modificare — `server/routes/admin/users.mjs`, ruta `GET /users`
Adaugă `AND deleted_at IS NULL` (respectiv `WHERE deleted_at IS NULL` pe ramura fără filtru) la cele 3 query-uri, ÎNAINTE de `ORDER BY`:
```js
// ramura institutie:
query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE institutie=$1 AND deleted_at IS NULL ORDER BY nume ASC';
// ramura org_id:
query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE org_id=$1 AND deleted_at IS NULL ORDER BY nume ASC';
// ramura „toti":
query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE deleted_at IS NULL ORDER BY nume ASC';
```
> Atât. NU schimba `SELECT`-ul de coloane, îmbogățirea cu `leave`/`batchGetLeaveInfo`, sau restul rutei. NU atinge `/admin/users`. NU atinge frontend-ul (dropdown-urile se corectează automat, primind lista deja filtrată).

# Test
Extinde testele rutei `/users` (caută în `server/tests/` teste pentru `/users` sau `admin/users`). Adaugă: un user cu `deleted_at` setat NU apare în răspunsul `GET /users` (pe fiecare ramură relevantă: cu instituție); un user activ apare. Fără hardcodare de count.

# Verificare manuală (owner)
1. „Flux nou" → dropdown-ul de semnatari NU mai conține utilizatorul dezactivat (Igrisan Alexandru); userii activi apar normal.
2. Transmitere manuală / auto (dropdown destinatar utilizator) → dezactivații lipsesc.
3. Un flux ÎN CURS care are deja acel semnatar → neschimbat (numele rămâne afișat din datele fluxului; timeline intact).
4. Reactivezi userul în Administrare → reapare în dropdown-uri.

# Guardrails diff
EXCLUSIV: `server/routes/admin/users.mjs`, testul rutei `/users`, `package.json`. Fără frontend → fără `?v=`/`CACHE_VERSION`.
```bash
git diff --name-only | grep -vE "server/routes/admin/users\.mjs|server/tests/|package\.json" | grep . && echo "⛔ STOP: alt fișier atins!" || echo "✅ doar ruta /users + test"
git diff server/routes/admin/users.mjs | grep -nE "/admin/users|include_deleted|batchGetLeaveInfo" && echo "⚠️ verifică: NU ai atins /admin/users sau leave enrichment" || echo "✅ doar cele 3 query-uri /users modificate"
git diff server/routes/admin/users.mjs | grep -c "deleted_at IS NULL"   # trebuie 3
```

# Versiune
`package.json` 3.9.631 → 3.9.632. (Backend-only → fără `?v=`/`sw.js`.)

# La final
```bash
git add -A -- server/routes/admin/users.mjs server/tests package.json
git commit -m "fix(users): exclude utilizatorii dezactivați (deleted_at) din /users → nu mai apar la semnatari/transmitere/delegări; fluxurile în curs neatinse (v3.9.632)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) `AND deleted_at IS NULL` pe cele 3 ramuri `/users`; (2) `/admin/users` + leave enrichment neatinse; (3) testul confirmă excluderea dezactivaților; (4) fluxurile în curs neafectate; (5) `npm test verde, fără regresii`, `npm run check` OK, v3.9.632.
