---
fix: Numele ÎNTOCMIT devine autoritar din DB (nu din body-ul clientului) când JWT-ul nu cară numele. Închide spoof-ul de NUME rămas după 43 (email era deja sigur; numele cădea pe fallback client).
target_branch: develop
model_suggested: Sonnet 5 (schimbare de 2 linii, bine specificată + test; Opus 4.8 dacă vrei rigoare maximă pe identitate)
risk: MIC (aditiv; face numele la fel de autoritar ca emailul, reutilizând un query existent — fără round-trip nou)
version: 3.9.624 → 3.9.625
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. `main` = producție, gestionată manual de owner. La final: `git push origin develop` și **STOP**.
> Ordine recomandată: după 43 și 44. Dacă îl rulezi înaintea lui 44, ajustează versiunile ca să rămână strict crescătoare (vezi nota din raportul owner-ului).

# Context (continuare directă a lui 43)
După 43, `initEmail` e mereu actor-derived (sigur), iar detecția ÎNTOCMIT e robustă la diacritice. A rămas UN gol pe care l-a scos nota din testul lui 43: `initName`.

# Cauză (confirmată în cod)
`server/routes/flows/crud.mjs:114` — `initName = String(actor.nume || '').trim() || initName;`. Dacă JWT-ul NU cară numele cache-uit (`actor.nume` gol), `initName` cade pe valoarea **din body-ul clientului**. Apoi, la construirea semnatarilor (linia 149, `name: isIntocmitRole ? initName : ...`), numele afișat al ÎNTOCMIT-ului — cel tipărit pe cartuș, citit de om ca „cine a întocmit" — poate proveni de la client. Emailul rămâne corect, dar numele e spoof-abil.
Lookup-ul din DB de la linia 255 aduce `functie/compartiment/institutie`, dar NU `nume`, și oricum rulează DUPĂ linia 149.

# Soluție
Lookup-ul timpuriu de la linia 118 (`SELECT org_id FROM users WHERE email=$1`) rulează ÎNAINTE de linia 149. Extinde-l să aducă și `nume`, și suprascrie `initName` autoritar din DB — la fel cum emailul e deja autoritar. Zero query nou.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== lookup timpuriu (linia ~118) ==="; sed -n '113,124p' server/routes/flows/crud.mjs
echo "=== ordine: lookup(118) ÎNAINTE de normalizedSigners(149)? ==="; grep -n "SELECT org_id FROM users\|normalizedSigners = signers.map\|name: isIntocmitRole" server/routes/flows/crud.mjs
```

# Modificare — `server/routes/flows/crud.mjs`, lookup-ul timpuriu
Adaugă `nume` la SELECT-ul existent și suprascrie `initName` din DB (autoritar; păstrează fallback-ul pentru edge-case-ul „user inexistent în DB"):
```js
try {
  const ru = await pool.query('SELECT org_id, nume FROM users WHERE email=$1', [initEmail.trim().toLowerCase()]);
  orgId = ru.rows[0]?.org_id || null;
  const dbNume = String(ru.rows[0]?.nume || '').trim();
  if (dbNume) initName = dbNume;   // numele din DB e sursa autoritară, ca emailul (nu body-ul clientului)
} catch(e) {}
```
> NU muta lookup-ul. NU atinge linia 114 (fallback-ul rămâne pentru cazul „user negăsit în DB"). NU atinge `initEmail`, normalizarea ÎNTOCMIT (43) sau restul blocului semnatarilor.

# Test — `server/tests/**/flow-intocmit-lock.test.mjs` (extinde testul din 43)
Într-un mediu cu DB de test, un user cu `nume` cunoscut în `users`, JWT fără `nume`, body cu un `initName` inventat + rol ÎNTOCMIT → semnatarul ÎNTOCMIT rezultat are `name === numele din DB`, NU cel din body. (Complementar aserției pe email din 43.) Fără hardcodare de count.
> Notă: dacă `makeAuthCookie` nu poate seta un user real în DB pentru test, asigură-te că testul creează/seed-uiește userul cu `nume` înainte, altfel aserția pe nume rămâne inaplicabilă (ca în 43). Preferă un test care chiar validează suprascrierea din DB.

# Verificare manuală (owner)
1. Creezi flux ca user al cărui `nume` e completat în Administrare → ÎNTOCMIT afișează numele tău real.
2. (dacă ai unelte API) POST creare flux cu `initName` fals în body → fluxul salvat + cartușul au numele din DB, nu cel fals.
3. Fără regresie la funcție/compartiment/instituție (vin tot din lookup-ul de la linia 255).

# Guardrails diff
EXCLUSIV: `server/routes/flows/crud.mjs`, testul de identitate ÎNTOCMIT, `package.json`. (Fără frontend → fără `?v=`/`CACHE_VERSION`.)
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|alop\.mjs|flow-transmit\.mjs|transmit\.mjs|index\.mjs|\.html$|sw\.js" && echo "⛔ STOP: zonă interzisă/inutilă atinsă!" || echo "✅ doar crud.mjs + test"
git diff server/routes/flows/crud.mjs | grep -nE "SELECT org_id, nume|if \(dbNume\)|initEmail = String\(actor" && echo "verifică: doar nume adăugat la lookup + override initName; initEmail neschimbat"
```

# Versiune
`package.json` 3.9.624 → 3.9.625. (Fără frontend → fără bump `?v=`/`sw.js`.)

# La final
```bash
git add -A -- server/routes/flows/crud.mjs server/tests/**/*intocmit*.* package.json
git commit -m "fix(sec): numele ÎNTOCMIT autoritar din DB, nu din body-ul clientului (închide spoof-ul de nume rămas după 43) (v3.9.625)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) `nume` adăugat la lookup-ul timpuriu, `initName` suprascris din DB înainte de linia 149; (2) `initEmail` + fallback linia 114 neatinse; (3) testul validează numele din DB peste body; (4) `npm test verde, fără regresii`, `npm run check` OK, v3.9.625.
