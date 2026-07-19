---
prompt: 75
titlu: "fix(auth): logout nu funcționează pe Safari/Firefox/mobil — logout() așteaptă POST-ul înainte de redirect (fire-and-forget → race)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: ⚠️ PRODUCȚIE · frontend logout (fără backend/auth)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`. `main` = producție, manual.

---

## Bug (owner, PRODUCȚIE)
Pe Safari/Firefox/mobil: după login, „Ieșire" redirecționează la /login dar **utilizatorul rămâne logat** (sesiunea persistă). Pe Chrome merge.

## Root cause (confirmat)
`logout()` face fetch **fire-and-forget** apoi redirect imediat:
```js
fetch('/auth/logout', {method:'POST', credentials:'include'}).catch(()=>{});  // NU e await
localStorage.removeItem('docflow_user'); ...
location.href='/login';   // navighează IMEDIAT
```
`location.href` **anulează fetch-ul în zbor** înainte ca browserul să aplice `Set-Cookie`-ul de ștergere. Chrome tolerează; Safari/Firefox/mobil anulează → cookie-ul de auth nu se șterge → rămâi logat. (Atributele set/clear se potrivesc — `lax`/`lax` — deci ștergerea merge DOAR dacă POST-ul se termină.)

Variantele inline cu `.finally(()=>location.href=...)` (formular.js, semdoc-signer) sunt deja corecte. Doar funcția `logout()` din `admin.js` și `df-shell.js` e ruptă (fire-and-forget).

## Fix (pur frontend, minimal) — așteaptă POST-ul înainte de redirect
Cu timeout defensiv (dacă serverul atârnă, tot te deloghează după 3s):

### `public/js/admin/admin.js` (~linia 38) — `logout()`
```js
async function logout(){
  // SEC-01: invalidăm cookie-ul pe server ÎNAINTE de redirect (Safari/mobil anulează fetch-ul în zbor)
  try {
    await Promise.race([
      fetch('/auth/logout', { method: 'POST', credentials: 'include' }),
      new Promise(res => setTimeout(res, 3000)),
    ]);
  } catch (_) {}
  localStorage.removeItem('docflow_user');
  localStorage.removeItem('docflow_force_pwd');
  location.href = '/login';
}
```

### `public/js/df-shell.js` (~linia 31) — `window.logout`
Aceeași structură `async` + `Promise.race([fetch, timeout(3000)])` + `await`, apoi curăță localStorage și `location.href='/login'`.

## Ce NU atingem
- ⛔ Backend/auth (`auth.mjs`, `totp.mjs`, `clearAuthCookie`, `setAuthCookie`) — atributele set/clear se potrivesc deja; 2FA nefolosit → în afara scopului.
- ⛔ Variantele `.finally` (formular.js, semdoc-signer, admin.js:123) — deja corecte, nu le atinge.
- ⛔ `sw.js` ca logică (doar bump CACHE_VERSION pentru busting).

## Cache busting + versiune
- Bump `?v=` la `admin.js` și `df-shell.js` în paginile care le referă.
- `sw.js` `CACHE_VERSION` ++. `package.json` următorul patch.

## Guardrails diff
EXCLUSIV: `public/js/admin/admin.js`, `public/js/df-shell.js`, HTML-uri cu `?v=`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "\.mjs$|auth|totp|signing|pades" && echo "⛔ STOP: backend/auth atins!" || echo "✅ doar frontend logout"
```

## Verificare (owner, staging + apoi producție)
- **Safari desktop + iPhone/Android:** login → „Ieșire" → ajungi la /login și **rămâi delogat** (reîncarci /flow.html → te duce la login).
- Chrome: neschimbat (merge în continuare).
- `npm test verde`.

## Final
```bash
git add public/js/admin/admin.js public/js/df-shell.js public/*.html public/sw.js package.json
git commit -m "fix(auth): logout asteapta POST-ul inainte de redirect (fix Safari/Firefox/mobil)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Notă
Fix-ul e relevant pentru PRODUCȚIE — după validare pe staging, owner-ul îl promovează manual pe `main` (cu backup dacă e disponibil).
