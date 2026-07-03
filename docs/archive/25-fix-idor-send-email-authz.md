---
fix(sec): IDOR exfiltrare pe POST /flows/:id/send-email — restrânge la inițiator/semnatar/admin (canActorReadFlow)
target_branch: develop
model_suggested: Opus 4.8 (authz pe acțiune de exfiltrare externă — sensibil)
risk: SCĂZUT-MEDIU (o gardă adăugată; atenție să nu blochezi trimiterea legitimă de către inițiator/admin)
version: 3.9.604 → 3.9.605
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema (IDOR de exfiltrare)
`POST /flows/:flowId/send-email` (`server/routes/flows/email.mjs`) e protejat DOAR de `requireAuth`. Orice user autentificat poate trimite documentul semnat + atașamentele + raportul de conformitate al ORICĂRUI flux finalizat către adrese externe arbitrare, știind doar `flowId`. Ruta soră `GET /flows/:flowId/email-stats` (aceeași fișier) are deja garda corectă (`isAdmin || isInitiator || isSigner → 403`) — `send-email` a ratat-o.

# 🎯 Scop
Adaugă authz la nivel de obiect pe `send-email`: doar **inițiator, semnatar sau admin din aceeași org** pot trimite extern. Folosește helperul deja existent `canActorReadFlow` din `server/services/flow-access.mjs` (v3.9.603). **NU** include ramura „destinatar" — trimiterea externă e o acțiune de inițiator/semnatar/admin, nu a unui destinatar repartizat (aliniat cu `email-stats`).

# 🚫 NO-TOUCH
Semnare integral. Financiar ALOP. `flow-access.mjs` / `flow-transmit.mjs` — doar importate, neschimbate. NU atinge rutele de tracking `email-open` / `email-click` (pixeli publici, keyed pe trackingId opac — corect așa) și nici `email-stats` (deja corect).

# Etapa 0 — caracterizare
```bash
# Handlerul send-email: unde se încarcă data + de unde până unde e authz-ul actual (doar requireAuth):
sed -n '45,75p' server/routes/flows/email.mjs
# Confirmă exportul canActorReadFlow:
grep -n "export function canActorReadFlow" server/services/flow-access.mjs
# Importurile existente în email.mjs (ca să știi ce mai trebuie adăugat):
grep -n "^import" server/routes/flows/email.mjs
```

# Implementare — `server/routes/flows/email.mjs`
1. Importă helperul:
   `import { canActorReadFlow } from '../../services/flow-access.mjs';`
2. În handlerul `POST /flows/:flowId/send-email`, IMEDIAT după ce `data` e încărcat și validat că nu e null (și după/în jurul verificării `not_completed`), adaugă garda:
   ```js
   if (!canActorReadFlow(actor, data, null)) {
     return res.status(403).json({ error: 'forbidden', message: 'Nu ai drept să trimiți acest document.' });
   }
   ```
   `actor` e garantat de `requireAuth` la începutul handlerului. `signerToken = null` (ruta e cookie/auth-only, nu pe token). NU muta/șterge validările existente (destinatari, subiect, not_completed) — doar adaugi garda de authz.

# Teste — `server/tests/db/send-email-acl.test.mjs` (server/tests/db/**, auto-skip fără TEST_DATABASE_URL)
Pe un flux finalizat:
- inițiator → NU 403 (trece de authz; poți mocka/short-circuita trimiterea Resend sau verifica doar că nu primești 403 pe motiv de authz — respinge doar dacă e 403 forbidden).
- semnatar (după email) → NU 403.
- admin same-org → NU 403.
- **străin autentificat (alt user, altă org / fără legătură) → 403** (ăsta e miezul fix-ului).
- anonim → 401 (requireAuth).
Notă: dacă trimiterea reală prin Resend nu e disponibilă în CI, structurează testul să valideze DOAR poarta de authz (ex. verifică că răspunsul NU e 403 pentru personele legitime și ESTE 403 pentru străin), fără a depinde de succesul livrării email.

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`server/routes/flows/email.mjs`, `server/tests/db/send-email-acl.test.mjs` (nou), `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|flow-access\.mjs|flow-transmit\.mjs|alop\.mjs" && echo "⛔ STOP" || echo "✅ NO-TOUCH ok"
git diff server/routes/flows/email.mjs | grep -n "email-open\|email-click\|email-stats" && echo "⚠️ verifică: NU ai atins rutele de tracking/stats" || echo "✅ doar send-email atins"
```
Backend-only → fără `?v=`/`CACHE_VERSION`. Bump `package.json` 3.9.604 → 3.9.605.

# La final
```bash
git add server/routes/flows/email.mjs server/tests/db/send-email-acl.test.mjs package.json
git commit -m "fix(sec): închide IDOR exfiltrare pe send-email — restrânge la inițiator/semnatar/admin (v3.9.605)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Garda adăugată doar pe `send-email`; tracking/stats neatinse.
2. Străinul autentificat → 403; inițiator/semnatar/admin-same-org → nu 403.
3. NO-TOUCH respectat; status CI (`npm test` + `npm run check`).

# Ce urmează (Etapa 2b — prompt separat, imediat după)
Rută manuală `POST /flows/:id/transmit` (repartizare ad-hoc, cu authz `canActorReadFlow` de la început) + buton „📨 Transmite în aplicație" + modal în `flow.js`. Apoi Etapa 2c: tab „Primite / Repartizate mie" + `GET /api/my-received` + „Confirm luare la cunoștință" (`acknowledged_at`).
