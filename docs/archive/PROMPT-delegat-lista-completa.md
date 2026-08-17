---
prompt: "#delegat-lista-completa"
titlu: "Lista de delegați (Concediu și delegare) → toți utilizatorii din org (scoate excluderea u.leave.delegate)"
model_suggested: "Sonnet 4.6 (fix frontend de o linie + cache-bust)"
target_version: "v3.9.737"
branch: "develop"
migratii: "nu"
cache_bump: "DA — ?v= pe df-user-modals.js în 10 fișiere HTML (NU e în PRECACHE_ASSETS)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.

---

## Context (de ce) — diagnostic

În modalul „Concediu și delegare", dropdown-ul „Delegat (cine semnează în lipsa ta)" nu afișează
colegii din **același compartiment**. Cauza NU e un filtru de compartiment (nu există niciunul —
verificat: `GET /users` întoarce toți userii org-scopați minus șters/`role='admin'`, iar
`df-user-modals.js` nu referă deloc `compartiment`). Cauza reală: filtrul de candidați exclude
**orice user care are un delegat configurat**:

```js
if (u.leave?.delegate) return false;
```

`u.leave.delegate` e adevărat pentru oricine și-a setat vreodată o delegare (chiar cu concediu
trecut/viitor, nu neapărat activ acum). Colegii de compartiment care și-au setat delegare dispar;
ceilalți (fără delegare) rămân — de aici iluzia „lipsește compartimentul meu".

Decizie (Mircea): scoatem limitarea — delegatul se alege din **toți** utilizatorii organizației
(mai puțin tu însuți). `GET /users` deja exclude contul de platformă și șterșii, deci rămâne exact
personalul primăriei.

---

## PAS 1 — Preflight
```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.736",
```

---

## PAS 2 — `public/js/df-user-modals.js` — scoate excluderea

- old_str:
```
      const candidates = _lvAllUsers.filter(u => {
        if (u.id === _lvMeUserId) return false;
        if (u.org_id !== me?.org_id) return false;
        if (u.leave?.delegate) return false;
        return true;
      });
```
- new_str:
```
      const candidates = _lvAllUsers.filter(u => {
        if (u.id === _lvMeUserId) return false;
        if (u.org_id !== me?.org_id) return false;
        return true;   // #delegat: toți utilizatorii org (mai puțin tu); fără excludere pe delegare
      });
```

```bash
node --check public/js/df-user-modals.js
grep -n "u.leave?.delegate" public/js/df-user-modals.js
# Așteptat: NICIUN rezultat (excluderea a fost scoasă).
```

---

## PAS 3 — Cache-bust `df-user-modals.js` în cele 10 HTML (?v= 3.9.693 → 3.9.737)

`df-user-modals.js` NU e în `PRECACHE_ASSETS` ⇒ doar `?v=`, fără `CACHE_VERSION`. Substring-ul e
identic în toate (indiferent de `defer`), deci un singur replace uniform:

```bash
sed -i 's|df-user-modals.js?v=3.9.693|df-user-modals.js?v=3.9.737|g' \
  public/chat.html public/flow.html public/formular.html public/notafd-invest-form.html \
  public/notifications.html public/refnec-form.html public/registratura.html \
  public/semdoc-initiator.html public/setari.html public/templates.html

grep -rc "df-user-modals.js?v=3.9.693" public/*.html | grep -v ':0' || echo "OK — nicio referință veche rămasă"
grep -rl "df-user-modals.js?v=3.9.737" public/*.html | wc -l   # Așteptat: 10
```

---

## PAS 4 — Bump + suită + commit + push

- package.json old_str: `  "version": "3.9.736",`
- package.json new_str: `  "version": "3.9.737",`

```bash
npm test
# Așteptat: verde (schimbare pur frontend, nicio logică testată atinsă).
```

```bash
git add public/js/df-user-modals.js public/*.html package.json
git status --short          # df-user-modals.js + 10 HTML + package.json = 12 intrări
git commit -m "#delegat: lista de delegați = toți utilizatorii org (scoate excluderea u.leave.delegate) (v3.9.737)"
git push origin develop
```

---

## PAS 5 — Verificare pe STAGING (după deploy)

1. Deschide „Concediu și delegare" ca un user cu colegi în același compartiment care au delegare setată.
2. Dropdown-ul „Delegat" trebuie să conțină acum ȘI colegii din compartimentul tău.
3. Tu însuți nu apari; contul de platformă (admin) nu apare (corect).

---

## RAPORT FINAL (completează)

- df-user-modals.js: excluderea `u.leave?.delegate` scoasă (grep gol): da/nu
- ?v= df-user-modals.js 3.9.693 → 3.9.737 în cele 10 HTML: da/nu (câte fișiere)
- node --check df-user-modals.js: OK
- npm test: PASSED (nr. fișiere/teste)
- Bump 3.9.736 → 3.9.737: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `df-user-modals.js` (1 linie scoasă), cele 10 HTML (?v=), `package.json`.
- ⛔ NU atinge backend-ul `/users` (deja corect — org-scopat, fără filtru compartiment).
- ⛔ NU atinge `CACHE_VERSION` din sw.js (df-user-modals.js nu e precache).
- ⛔ Fără migrații. Zona NO-TOUCH `server/signing/*` neatinsă.
- ⛔ Orice `old_str` care nu se potrivește (whitespace): NU forța, raportează linia reală.
