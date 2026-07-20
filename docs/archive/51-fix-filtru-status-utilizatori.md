---
fix: Filtrul de status din „Utilizatori" (Activi / Doar dezactivați / Toți) (1) nu filtrează — „Doar dezactivați" afișează toți utilizatorii; și (2) dropdown-ul nativ apare alb, în afara temei întunecate. Ambele frontend. BUG PREZENT ÎN PRODUCȚIE (v3.9.629).
target_branch: develop
model_suggested: Sonnet 4.6 (Default) — fix frontend chirurgical (1 linie JS + CSS); admin-only, NU atinge ALOP/semnare
risk: MIC (frontend; backend-ul e deja corect — întoarce deleted_at + include_deleted)
version: 3.9.630 → 3.9.631
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. La final: `git push origin develop` și **STOP**.

# Simptome (owner, producție)
Pagina „Utilizatori", filtrul de status (coloana ACȚIUNI, select-ul „Activi / Doar dezactivați / Toți"):
1. **Nu filtrează** — la „Doar dezactivați" apar toți utilizatorii, nu doar cei dezactivați.
2. **În afara temei** — popup-ul de opțiuni al select-ului e alb, nu se potrivește cu UI-ul întunecat.

# Cauze (confirmate în cod)
1. `public/js/admin/users.js`, `loadUsers()` se termină cu **`renderUsers(users)`** (~linia 350) — randează TOT ce vine din backend. La „Doar dezactivați"/„Toți" backend-ul întoarce activi+dezactivați (`?include_deleted=1`), dar sub-filtrul de status din `filterUsers()` (`fS==='deactivated' ? !!u.deleted_at : ...`) NU e chemat pe calea de reload. Deci nu se aplică. („Activi" pare corect doar pentru că backend-ul întoarce deja doar activi.)
   - Backend-ul e OK: `server/routes/admin/users.mjs:122-125` onorează `include_deleted=1` și include `deleted_at` în coloane. NU atinge backend-ul.
2. Select-ul e nativ; pe temă întunecată popup-ul de opțiuni e randat alb de browser fiindcă lipsește `color-scheme: dark` pe `.th-filter`.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== finalul loadUsers (renderUsers vs filterUsers) ==="; grep -n "renderUsers(users)\|filterUsers()\|window._allUsers = users" public/js/admin/users.js
echo "=== .th-filter (cutie deja pe tema; lipseste color-scheme) ==="; grep -rn "\.th-filter{" public/css/df/components.css public/css/admin/admin.css
echo "=== admin.html: ?v pe users.js + css ==="; grep -n "admin/users.js\|df/components.css\|admin/admin.css" public/admin.html
```

# Modificare 1 (funcțional) — `public/js/admin/users.js`
În `loadUsers()`, înlocuiește apelul final:
```js
renderUsers(users);
```
cu:
```js
filterUsers();   // aplică sub-filtrul de status + eventualele filtre pe coloane, nu doar randează tot
```
`filterUsers()` citește `window._allUsers` (tocmai setat) și `window._userStatusFilter` (setat în `onUserStatusChange`), deci aplică corect „Activi/Doar dezactivați/Toți". Fără race cu `setTimeout`-ul de restaurare (filterUsers folosește variabila, nu DOM-ul).
> NU schimba `onUserStatusChange`, `filterUsers`, logica `include_deleted`, sau ordinea de fetch. O singură linie.

# Modificare 2 (temă) — `.th-filter` în CSS
În AMBELE definiții (`public/css/df/components.css:~52` și `public/css/admin/admin.css:~42`), adaugă pe regula `.th-filter{…}`:
```css
color-scheme: dark;
```
Opțional, ca plasă pentru browsere care ignoră color-scheme, adaugă și:
```css
.th-filter option{ background:#141d33; color:#eaf0ff; }
```
Astfel popup-ul nativ (și pentru fRol, și pentru fStatus) se randează în tonul întunecat al platformei. NU schimba lățimile/pozițiile coloanelor.

# Verificare manuală (owner)
1. „Utilizatori" → „Doar dezactivați" → apar DOAR utilizatorii dezactivați (cei cu deleted_at); „Activi" → doar activi; „Toți" → toți. Contorul „(N)" reflectă lista randată.
2. Filtrele pe coloane (nume/email/compartiment/rol) continuă să funcționeze combinat cu statusul.
3. Deschizi dropdown-ul de status (și cel de rol) → popup pe fundal întunecat, în tonul platformei, nu alb.
4. Butoanele de acțiuni (reactivare/email/G+/dezactivare) apar corect pe rândurile dezactivate.

# Guardrails diff
EXCLUSIV: `public/js/admin/users.js`, `public/css/df/components.css`, `public/css/admin/admin.css`, `public/admin.html` (bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "server/|\.mjs$|alop|signing|pades|flow" && echo "⛔ STOP: backend/ALOP/semnare atinse — trebuie DOAR admin users frontend!" || echo "✅ pur frontend admin, backend neatins"
git diff public/js/admin/users.js | grep -E "^\+" | grep -E "filterUsers\(\)" && echo "✅ fix funcțional aplicat"
```

# Cache busting + versiune
`package.json` 3.9.630 → 3.9.631. `CACHE_VERSION` în `public/sw.js`. `?v=3.9.631` pe `admin/users.js` + pe `df/components.css` și `admin/admin.css` în `public/admin.html`.

# La final
```bash
git add -A -- public/js/admin/users.js public/css/df/components.css public/css/admin/admin.css public/admin.html public/sw.js package.json
git commit -m "fix(admin): filtrul de status utilizatori chiar filtrează (loadUsers→filterUsers) + dropdown pe tema întunecată (color-scheme) (v3.9.631)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) `renderUsers(users)`→`filterUsers()` în loadUsers, cele 3 stări verificate (activi/dezactivați/toți); (2) `color-scheme:dark` pe `.th-filter` în ambele CSS, popup întunecat; (3) backend neatins; (4) `npm test verde, fără regresii`, `npm run check` OK, v3.9.631.
