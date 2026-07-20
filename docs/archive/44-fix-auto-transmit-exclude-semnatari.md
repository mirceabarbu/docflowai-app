---
fix: Transmiterea internă (AUTO + MANUAL) nu mai repartizează/notifică inițiatorul și semnatarii fluxului — ei au deja acces prin canActorReadFlow. Simetric pe ambele căi, cu helper pur comun.
target_branch: develop
model_suggested: Sonnet 5 (fix chirurgical de domeniu pe transmitere; zero authz-nou/financiar/semnare)
risk: MIC (aditiv, filtrare de destinatari + un helper pur; nu schimbă accesul, doar cui i se trimite repartizarea)
version: 3.9.623 → 3.9.624
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. `main` = producție, gestionată manual de owner. La final: `git push origin develop` și **STOP**.
> Ordine de aplicare: după prompturile 42 și 43. Ambele 42 și 44 ating blocul auto-transmit din `notify()` — Etapa 0 re-caracterizează blocul curent înainte de editare.

# Simptom (owner, checklist grup D)
La transmiterea internă către un compartiment (sau user) care conține un **semnatar** al fluxului, semnatarul primește notificarea „📨 Document repartizat" — deși are deja acces la flux. Redundant. Owner-ul a cerut explicit ca semnatarii/inițiatorul să NU primească repartizarea, pe **ambele** căi (auto ȘI manual).

# Cauză (confirmată în cod)
`server/services/flow-transmit.mjs` — `resolveRecipientEmails` (~linia 116) expandează ținta (user → email; compartiment → TOȚI membrii) **fără** să excludă inițiatorul/semnatarii.
- Auto: blocul din `server/index.mjs` (`if (type === 'COMPLETED' && flowId)`, ~linia 1397) notifică toate emailurile rezultate.
- Manual: `server/routes/flows/transmit.mjs` (`POST /flows/:flowId/transmit`, ~linia 40-49) — la fel.

# Decizie de domeniu (fixată de owner)
Repartizarea = „luare la cunoștință" formală. Inițiatorul și semnatarii au deja acces (`canActorReadFlow`) și au luat cunoștință prin însuși actul semnării → excluși din repartizare pe AMBELE căi:
- **Țintă user** care e inițiator/semnatar → NU crea rândul `flow_recipients`, NU notifica.
- **Țintă compartiment** → păstrează rândul (ceilalți membri au nevoie de el), dar NU notifica membrii care sunt inițiator/semnatari.
- **Manual**, dacă TOȚI destinatarii aleși sunt excluși (ex. ai ales chiar un semnatar) → răspuns informativ, NU „succes" tăcut.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== blocul auto-transmit ==="; sed -n '/type === .COMPLETED. && flowId/,/auto-transmitere internă eșuată/p' server/index.mjs | head -60
echo "=== handler manual ==="; sed -n '/router.post(.\/flows\/:flowId\/transmit./,/return res.json({ ok: true, added/p' server/routes/flows/transmit.mjs
echo "=== forma signers + initEmail ==="; grep -n "data.signers\|data.initEmail\|fdata.signers\|fdata.initEmail" server/index.mjs server/routes/flows/transmit.mjs | head
```

# Modificări

## 1. Helper pur comun — `server/services/flow-transmit.mjs`
Adaugă o funcție pură exportată (fără dependențe de semnare) care întoarce setul de emailuri care AU DEJA acces la flux (inițiator + semnatari), lowercase:
```js
/**
 * Emailurile care au deja acces la flux prin canActorReadFlow (inițiator + semnatari) —
 * excluse din repartizare (n-are rost să le „transmiți" un document pe care îl pot deschide).
 * Pură: primește doar flow.data. @returns {Set<string>}
 */
export function alreadyHasAccessEmails(flowData) {
  const out = new Set();
  const push = (e) => { const v = String(e || '').trim().toLowerCase(); if (v) out.add(v); };
  push(flowData?.initEmail);
  for (const s of (Array.isArray(flowData?.signers) ? flowData.signers : [])) push(s?.email);
  return out;
}
```
> NU modifica `resolveRecipientEmails`, `transmitFlowTo`, `isFlowRecipient` etc. — doar ADAUGI helper-ul.

## 2. Calea AUTO — `server/index.mjs`, blocul auto-transmit
Importă helper-ul lângă importul existent din `flow-transmit.mjs`:
```js
import { transmitFlowTo, resolveRecipientEmails, alreadyHasAccessEmails } from './services/flow-transmit.mjs';
```
În blocul `if (type === 'COMPLETED' && flowId)`, după ce ai `fdata` și `cfg`:
```js
const excludeEmails = alreadyHasAccessEmails(fdata);

// pre-filtrează țintele de tip USER care sunt inițiator/semnatar (compartimentele rămân)
let cfgFiltered = cfg;
if (excludeEmails.size && cfg.some(c => c?.type === 'user')) {
  const userIds = cfg.filter(c => c?.type === 'user').map(c => Number(c.value)).filter(Boolean);
  const emailById = new Map();
  if (userIds.length) {
    const { rows } = await pool.query('SELECT id, lower(email) AS email FROM users WHERE id = ANY($1::int[])', [userIds]);
    for (const r of rows) emailById.set(r.id, r.email);
  }
  cfgFiltered = cfg.filter(c => c?.type !== 'user' || !excludeEmails.has(emailById.get(Number(c.value))));
}
```
Folosește `cfgFiltered` la `transmitFlowTo` (nu `cfg`). Dacă `cfgFiltered` e gol → sari peste transmitere.
În bucla de notificare, sari peste emailurile excluse:
```js
for (const t of targets) {
  if (!t.email || excludeEmails.has(String(t.email).toLowerCase())) continue;
  await notify({ userEmail: t.email, flowId, type: 'REPARTIZAT', title: '📨 Document repartizat',
    message: `Documentul „${fdata.docName || 'document'}" v-a fost transmis spre luare la cunoștință.` });
}
```

## 3. Calea MANUALĂ — `server/routes/flows/transmit.mjs`, `POST /flows/:flowId/transmit`
Importă `alreadyHasAccessEmails` din `flow-transmit.mjs` (lângă importurile existente).
După `const recipients = normalizeRecipients(...)` și validarea `no_recipients`:
```js
const excludeEmails = alreadyHasAccessEmails(data);

// pre-filtrează destinatarii USER care au deja acces (inițiator/semnatar)
let recipientsEff = recipients;
if (excludeEmails.size && recipients.some(r => r.type === 'user')) {
  const uids = recipients.filter(r => r.type === 'user').map(r => Number(r.value)).filter(Boolean);
  const emailById = new Map();
  if (uids.length) {
    const { rows } = await pool.query('SELECT id, lower(email) AS email FROM users WHERE id = ANY($1::int[])', [uids]);
    for (const r of rows) emailById.set(r.id, r.email);
  }
  recipientsEff = recipients.filter(r => r.type !== 'user' || !excludeEmails.has(emailById.get(Number(r.value))));
}
const skippedHasAccess = recipients.length - recipientsEff.length;

// dacă TOȚI destinatarii aleși au deja acces → răspuns informativ, nu succes tăcut
if (!recipientsEff.length) {
  return res.json({ ok: true, added: 0, alreadyPresent: 0, skippedHasAccess,
    message: 'Destinatarii aleși au deja acces la document (inițiator/semnatari) — repartizarea nu e necesară.' });
}
```
Înlocuiește `recipients` cu `recipientsEff` la `transmitFlowTo` ȘI la construcția `rez`/evenimentelor de trasabilitate.
În bucla de notificare, sari peste excluși (acoperă semnatarii din compartimentul-țintă):
```js
for (const t of targets) {
  if (!t.email || excludeEmails.has(String(t.email).toLowerCase())) continue;
  await _notify({ userEmail: t.email, flowId, type: 'REPARTIZAT', title: '📨 Document repartizat',
    message: `Documentul „${data.docName || 'document'}" v-a fost transmis spre luare la cunoștință.` });
}
```
Adaugă `skippedHasAccess` în răspunsul final de succes: `return res.json({ ok: true, added: newly.length, alreadyPresent: recipientsEff.length - newly.length, skippedHasAccess });`

> NU atinge trasabilitatea (`FLOW_TRANSMITTED`) pentru rândurile chiar create — evenimentul rămâne. NU atinge authz-ul (`canActorReadFlow`), acknowledge, sau inbox-ul „Primite".

# Test
Extinde testele repartizării (integrare pentru auto + testul rutei manuale):
- **Auto:** flux cu 2 semnatari + `transmiteLaFinalizare` = compartimentul unui semnatar + un ne-semnatar → după `notify(COMPLETED)`: ne-semnatarul primește `REPARTIZAT`, semnatarul și inițiatorul NU.
- **Auto:** țintă user = semnatar → NU se creează rând `flow_recipients`; țintă user = ne-semnatar → rândul se creează.
- **Manual:** `POST /transmit` cu un singur destinatar = semnatar → `added: 0`, `skippedHasAccess: 1`, mesaj informativ, ZERO notificări.
- **Manual:** destinatar = compartiment ce conține un semnatar + un ne-semnatar → rândul se creează, doar ne-semnatarul e notificat.
Fără hardcodare de count.

# Verificare manuală (owner)
1. Auto către un compartiment ce conține un semnatar → semnatarul NU mai primește „Document repartizat"; un membru ne-semnatar da.
2. Manual, alegi chiar un semnatar ca destinatar → mesaj „au deja acces… nu e necesară", fără notificare.
3. Manual către un ne-semnatar → funcționează ca înainte (notificare + „Primite" + trasabilitate).
4. Trasabilitatea în „Progres flux"/„Evenimente" rămâne pentru repartizările reale.

# Guardrails diff
EXCLUSIV: `server/services/flow-transmit.mjs`, `server/index.mjs`, `server/routes/flows/transmit.mjs`, testele de repartizare, `package.json`. (Fără frontend → fără `?v=`/`CACHE_VERSION`.)
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|alop\.mjs|crud\.mjs|flow-access\.mjs|\.html$|sw\.js" && echo "⛔ STOP: zonă interzisă/inutilă atinsă!" || echo "✅ doar transmitere + notify + test"
git diff server/services/flow-transmit.mjs | grep -nE "resolveRecipientEmails|transmitFlowTo|isFlowRecipient" && echo "verifică: funcțiile existente NESCHIMBATE, doar alreadyHasAccessEmails adăugat"
git diff server/index.mjs | grep -n "async function notify" && echo "verifică: semnătura notify neschimbată"
```

# Versiune
`package.json` 3.9.623 → 3.9.624. (Fără frontend → fără bump `?v=`/`sw.js`.)

# La final
```bash
git add -A -- server/services/flow-transmit.mjs server/index.mjs server/routes/flows/transmit.mjs server/tests/integration/flow-transmite-interna.test.mjs server/tests/**/*transmit*.* package.json
git commit -m "fix(flows): transmiterea internă (auto+manual) exclude inițiatorul+semnatarii; helper pur alreadyHasAccessEmails + răspuns informativ manual (v3.9.624)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) helper pur comun folosit pe ambele căi (fără drift); (2) auto: semnatarii+inițiatorul excluși din notificare, țintă-user semnatar fără rând; (3) manual: idem + mesaj informativ când toți au deja acces; (4) authz, trasabilitatea și inbox-ul „Primite" neatinse; (5) `npm test verde, fără regresii`, `npm run check` OK, v3.9.624.
