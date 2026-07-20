---
fix+feat: (A) nume+funcție·compartiment la CONFIRMAT în „Evenimente"; (B) notificare expeditor la confirmare; (C) „Deschide documentul" activ doar după confirmare
target_branch: develop
model_suggested: Sonnet 5 (3 modificări mici, precise, pe ancore clare)
risk: SCĂZUT (adăugiri punctuale; gate-ul e UI-only, decizie de produs a owner-ului)
version: 3.9.617 → 3.9.618
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Context (decizii luate cu owner-ul)
1. Linia „✅ CONFIRMAT DE DESTINATAR" din secțiunea „Evenimente" arată emailul brut — trebuie
   nume + funcție · compartiment, în formatul deja folosit pentru semnatari
   („Test — Inspector · Serviciul Buget").
2. Expeditorul NU află de confirmare decât dacă intră manual pe flux — trebuie notificare.
3. DECIZIE OWNER: confirmarea = confirmare de PRIMIRE; „Deschide documentul" din tabul Primite
   devine activ DOAR după confirmare. Gate UI-only (backend-ul rămâne permisiv — deep-link-urile
   din notificări și accesul expeditorului la timeline nu trebuie să dea 403).

# 🚫 NO-TOUCH
Semnare, financiar ALOP, `flow-access.mjs`, funcțiile existente din `flow-transmit.mjs`.
`isFlowAccessAllowed` — NU adăuga condiție de acknowledged (gate-ul e exclusiv UI, vezi §Context).

# Etapa 0 — caracterizare
```bash
sed -n '/router.post(.\/flows\/:flowId\/acknowledge/,/^});/p' server/routes/flows/transmit.mjs
grep -n "byName" server/routes/flows/transmit.mjs public/js/flow/flow.js
sed -n '440,470p' public/js/flow/flow.js     # nameMap "Nume — Functie · Compartiment" + who
grep -n "received-open-btn\|received-ack-btn\|const isAck" public/js/notifications/notifications.js
grep -n "async function notify(" server/index.mjs && grep -n "_injectDeps\|_notify" server/routes/flows/transmit.mjs | head -5
```
Confirmă: cum distinge ruta `acknowledge` un ack NOU de unul repetat (idempotent) — notificarea
și evenimentul se emit DOAR la ack nou; dacă funcția `acknowledgeReceipt` nu expune distincția,
folosește `RETURNING` din INSERT (rând întors = nou; niciun rând = era deja confirmat).

# Implementare

## A. Nume + funcție · compartiment la confirmare (backend + Evenimente)

### A1. `server/routes/flows/transmit.mjs` — `POST /flows/:flowId/acknowledge`
La ack NOU, înainte de push-ul evenimentului, un SELECT mic:
```js
const { rows: uRows } = await pool.query(
  'SELECT nume, functie, compartiment FROM users WHERE id=$1', [actor.userId || actor.id]);
const u = uRows[0] || {};
```
Extinde evenimentul (păstrează `byName` din v3.9.615, adaugă restul):
```js
data.events.push({ at: acknowledged_at, type: 'FLOW_ACKNOWLEDGED', by: actor.email,
  byName: u.nume || actor.nume || actor.email,
  byFunctie: u.functie || null, byCompartiment: u.compartiment || null,
  recipientKey });
```

### A2. `public/js/flow/flow.js` — `renderEvents()` (secțiunea „Evenimente")
La construcția `who` (linia ~459-460, `const byRaw = e.who || e.actor || e.by; const who = nameMap[byRaw] ...`),
adaugă preferința pentru câmpurile din eveniment, ÎNAINTE de fallback-ul pe nameMap:
```js
let who;
if (e.byName) {
  const extra = [e.byFunctie, e.byCompartiment].filter(Boolean).join(' · ');
  who = esc(e.byName) + (extra ? ` — ${esc(extra)}` : '');
} else {
  who = nameMap[byRaw] ? esc(nameMap[byRaw]) : esc(byRaw);
}
```
(Format identic cu semnatarii: „Nume — Funcție · Compartiment". Evenimentele vechi, fără
byName, cad pe comportamentul actual — nicio regresie.)

### A3. Coerență cu „Progres flux" (`renderTimeline`, sub-rândurile ✅)
Dacă vrei același format bogat și acolo (acum arată doar numele, din fix-ul 36), extinde
label-ul similar: `Confirmat de ${byName}${extra ? ' — '+extra : ''}`. Aplică-l — owner-ul a
cerut explicit îmbogățirea unde e afișat confirmatorul.

## B. Notificare către expeditor la confirmare

În aceeași rută `acknowledge`, DUPĂ push-ul evenimentului și saveFlow, DOAR la ack NOU:
```js
// Cine a transmis? manual → transmitted_by; auto (transmitted_by NULL) → inițiatorul fluxului
const { rows: trRows } = await pool.query(
  `SELECT DISTINCT fr.transmitted_by FROM flow_recipients fr WHERE fr.flow_id=$1
     AND (fr.recipient_user_id=$2 OR ($3 <> '' AND TRIM(fr.recipient_compartiment)=$3))`,
  [flowId, actor.userId || actor.id, compActorului]);
let targetEmail = null;
const tbId = trRows.find(r => r.transmitted_by)?.transmitted_by;
if (tbId) {
  const { rows: tRows } = await pool.query('SELECT email FROM users WHERE id=$1', [tbId]);
  targetEmail = tRows[0]?.email || null;
}
if (!targetEmail) targetEmail = data.initEmail || null;   // auto-transmit → inițiator
if (targetEmail && targetEmail.toLowerCase() !== actor.email.toLowerCase()) {
  await _notify({ userEmail: targetEmail, flowId, type: 'REPARTIZAT_CONFIRMAT',
    title: '✅ Confirmare primire',
    message: `${u.nume || actor.email} a confirmat primirea documentului „${data.docName || 'document'}".` });
}
```
(`_notify` e deja injectat în transmit.mjs din promptul 27. `compActorului` = valoarea
`loadActorComp` deja calculată în rută — refolosește-o.) Click-routing: NU adăuga ramură nouă în
notifications.js/notif-widget — fallback-ul generic duce la `flow.html?flow=...`, unde expeditorul
vede confirmarea în timeline. Exact comportamentul dorit.

## C. Gate „Deschide documentul" până la confirmare (UI-only)

`public/js/notifications/notifications.js`, cardul Primite (linia ~215):
```js
<button type="button" class="df-action-btn received-open-btn" ${isAck ? '' : 'disabled title="Confirmați mai întâi primirea documentului"'} ${isAck ? '' : 'style="opacity:.5;cursor:not-allowed"'}>Deschide documentul</button>
```
Iar în handler-ul de succes al ack-ului (linia ~233, unde se setează `r.acknowledged_at`),
re-render-ul existent (`renderList()`) va reactiva automat butonul — verifică doar că după
confirmare butonul devine imediat activ FĂRĂ reload de pagină. Handler-ul de click pe
`received-open-btn` trebuie să ignore click-urile când butonul e disabled (nativ pentru
`<button disabled>` — confirmă doar că nu e `<a>`).

# Verificare manuală
- Confirmare nouă → „Evenimente" arată „✅ CONFIRMAT DE DESTINATAR · Barbu Mircea — Funcție · Compartiment".
- Expeditorul (sau inițiatorul, la auto) primește notificarea „✅ Confirmare primire"; click → flux.
- Destinatar nou: „Deschide documentul" gri/inactiv + tooltip; după „Confirm luare la cunoștință",
  devine activ instant; documentul se deschide.
- Confirmare repetată (dublu-click rapid) → O SINGURĂ notificare către expeditor, UN SINGUR eveniment.
- Cine confirmă NU primește notificare despre propria confirmare (guard-ul de email diferit).

`npm test verde, fără regresii`. `npm run check` OK. Extinde `flow-received-ack.test.mjs`:
ack nou → notificare `REPARTIZAT_CONFIRMAT` pentru transmitted_by; ack repetat → zero notificări noi.

# Guardrails diff
EXCLUSIV: `server/routes/flows/transmit.mjs`, `public/js/flow/flow.js`,
`public/js/notifications/notifications.js`, `server/tests/db/flow-received-ack.test.mjs`,
`public/*.html` (bump ?v=), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|alop\.mjs|flow-access\.mjs" && echo "⛔ STOP" || echo "✅ NO-TOUCH ok"
```

# Cache busting + versiune
3.9.617 → 3.9.618; `CACHE_VERSION` sw.js; `?v=3.9.618` pe flow/flow.js + notifications/notifications.js.

# La final
```bash
git add -A -- server/routes/flows/transmit.mjs public/js/flow/flow.js public/js/notifications/notifications.js server/tests/db/flow-received-ack.test.mjs public/*.html public/sw.js package.json
git commit -m "fix+feat: nume+funcție la confirmare în Evenimente, notificare expeditor, gate Deschide până la confirmare (v3.9.618)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) formatul complet în ambele secțiuni;
(2) notificarea la expeditor, o singură dată, cu guard pe self-notify; (3) gate-ul UI activ/
dezactivat corect fără reload; (4) CI verde, v3.9.618.
