---
fix+feat: (A) repară test flow-intocmit-lock cu input invalid; (B) trasabilitate transmitere/confirmare internă în „Progres flux" + „Evenimente" (paritate cu EMAIL_SENT)
target_branch: develop
model_suggested: Opus 4.8 (atinge notify()/transmit.mjs backend + renderTimeline/renderEvents într-un monolit de 2257 linii — precizie pe corelare)
risk: MEDIU (adăugiri, dar în funcții hardcodate din flow.js; backend read-modify-write pe data.events, pattern deja folosit de EMAIL_SENT)
version: 3.9.609 → 3.9.610
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# PARTEA A — fix test (CI roșu din push-ul anterior, v3.9.609)

## Problema
`server/tests/db/flow-intocmit-lock.test.mjs` linia ~112-114 trimite `{ initName: 'X', initEmail: 'not-an-email...' }` și așteaptă `400 initEmail_invalid`. Dar `initName:'X'` are 1 caracter (< 2), deci validarea existentă din `createFlow` (linia ~70: `if (!initName || initName.length < 2) return res.status(400).json({error:'initName_required'})`) rulează ÎNAINTEA verificării de email și întoarce `initName_required`. **NU e regresie de cod** — ordinea de validare exista deja dinaintea fix-ului 29; testul are un input de date greșit.

## Fix
```bash
grep -n "initName: 'X'" server/tests/db/flow-intocmit-lock.test.mjs
```
Schimbă `initName: 'X'` în ceva valid (≥2 caractere, ex. `initName: 'XX'` sau `'Test User'`), păstrând `initEmail: 'not-an-email...'` invalid — ca testul să verifice EXCLUSIV ramura `initEmail_invalid`. NU atinge codul din `crud.mjs` pentru asta.

# PARTEA B — trasabilitate transmitere internă

## 🎯 Problema
Repartizarea (auto la finalizare / manuală / confirmare) scrie DOAR o notificare către destinatar. Cel care a transmis documentul nu vede nicăieri, pe pagina fluxului, că s-a întâmplat — spre deosebire de „Trimite email extern", care apare atât în „Progres flux" (`renderTimeline`, cu iconița ✉️) cât și în „Evenimente" (`renderEvents`, „📧 EMAIL TRIMIS EXTERN"). Motivul: `EMAIL_SENT` scrie în `data.events[]` (sursa pentru `renderTimeline`) ȘI în `audit_events` via `writeAuditEvent` (sursa pentru `renderEvents`); transmiterea internă nu scrie în niciuna.

## 🎯 Scop
Adaugă două tipuri de eveniment — `FLOW_TRANSMITTED` (transmitere, auto sau manuală) și `FLOW_ACKNOWLEDGED` (confirmare) — în AMBELE surse, oglindind exact pattern-ul `EMAIL_SENT`/`EMAIL_OPENED`, cu **corelare exactă** transmitere↔confirmări (nu doar ordine cronologică — o transmitere către compartiment poate avea mai mulți confirmatori, iar mai multe transmiteri apropiate în timp nu trebuie amestecate).

# 🚫 NO-TOUCH
Semnare integral. Financiar ALOP. Restul tipurilor de eveniment din `EV_SHOW`/`EVENT_LABELS` — doar ADAUGĂ, nu modifica intrările existente. `flow-transmit.mjs`/`flow-access.mjs` — neschimbate (doar consumate).

# Etapa 0 — caracterizare (OBLIGATORIU)
```bash
grep -n "router.post('/flows/:flowId/transmit'\|router.post('/flows/:flowId/acknowledge'\|router.get('/api/my-received'" server/routes/flows/transmit.mjs
sed -n '1,90p' server/routes/flows/transmit.mjs
grep -n "transmitFlowTo(pool" server/index.mjs
sed -n '/if (type === .COMPLETED. && flowId)/,/^  }/p' server/index.mjs | head -40
grep -n "const EV_SHOW = new Set" public/js/flow/flow.js
grep -n "EMAIL_SENT.*EMAIL TRIMIS EXTERN\|const EVENT_LABELS" public/js/flow/flow.js
grep -n "PAȘI EMAIL EXTERN\|PAS FINAL: stare finală" public/js/flow/flow.js
# Guard-ul de traduceri admin (deja cunoscut din sesiunea trecută — FLOW_TRANSMITTED are deja eticheta din push-ul 27):
grep -rn "FLOW_TRANSMITTED" public/js/admin/ server/tests/ 2>/dev/null | grep -v node_modules
```
Raportează: liniile exacte confirmate pentru fiecare ancoră; dacă `FLOW_TRANSMITTED` are deja etichetă în `activity.js`/`audit.js` (probabil da, adăugată în push-ul 27 conform raportului anterior) — dacă da, o REFOLOSEȘTI, nu duplica.

# Implementare — BACKEND

## 1. `server/routes/flows/transmit.mjs` — `POST /flows/:flowId/transmit` (manual)
După ce `newly` (rândurile nou-inserate din `transmitFlowTo`) e calculat, PENTRU FIECARE rând din `newly`, construiește un `recipientKey` stabil și un `recipientLabel` afișabil, apoi push în `data.events[]` + păstrează `writeAuditEvent` existent (aliniază-l să folosească EXACT payload-ul de mai jos, nu-l duplica):
```js
if (!Array.isArray(data.events)) data.events = [];
const nowIso = new Date().toISOString();
for (const row of newly) {
  const recipientKey = row.recipient_user_id
    ? `user:${row.recipient_user_id}`
    : `comp:${String(row.recipient_compartiment||'').trim().toLowerCase()}`;
  let recipientLabel;
  if (row.recipient_user_id) {
    const { rows: uRows } = await pool.query('SELECT nume,email FROM users WHERE id=$1', [row.recipient_user_id]);
    recipientLabel = uRows[0]?.nume || uRows[0]?.email || `user #${row.recipient_user_id}`;
  } else {
    recipientLabel = `Compartimentul „${row.recipient_compartiment}"`;
  }
  const rez = normalizeRecipients(req.body?.recipients).find(r =>
    (r.type === 'user' && row.recipient_user_id && String(r.value) === String(row.recipient_user_id)) ||
    (r.type === 'comp' && row.recipient_compartiment && r.value === row.recipient_compartiment)
  )?.rezolutie || null;
  data.events.push({
    at: nowIso, type: 'FLOW_TRANSMITTED', by: actor.email,
    source: 'manual', recipientKey, recipientLabel, rezolutie: rez,
  });
}
if (newly.length) { data.updatedAt = nowIso; await saveFlow(flowId, data); }
```
(Adaptează la structura EXACTĂ găsită în Etapa 0 — numele câmpurilor din `newly` trebuie confirmate acolo, nu presupuse.) Păstrează/aliniază `writeAuditEvent({ ..., eventType: 'FLOW_TRANSMITTED', payload: { recipientKey, recipientLabel, rezolutie: rez, source: 'manual' } })` — un apel per rând nou, lângă push-ul de mai sus.

## 2. `server/routes/flows/transmit.mjs` — `POST /flows/:flowId/acknowledge`
Determină `recipientKey` care s-a potrivit (direct pe user SAU prin compartiment) — reutilizează verificarea deja făcută de `isFlowRecipient`, dar ai nevoie și de CARE ramură a picat, deci interoghează explicit:
```js
const { rows: directRows } = await pool.query(
  'SELECT 1 FROM flow_recipients WHERE flow_id=$1 AND recipient_user_id=$2', [flowId, actor.userId || actor.id]);
let recipientKey;
if (directRows.length) {
  recipientKey = `user:${actor.userId || actor.id}`;
} else {
  const comp = await loadActorComp(pool, actor.userId || actor.id);
  recipientKey = `comp:${(comp||'').trim().toLowerCase()}`;
}
```
După `acknowledgeReceipt(...)` reușit (idempotent — push doar dacă a fost efectiv nou, adică `acknowledged_at` întors era chiar cel din acest apel, nu unul preexistent — vezi cum distinge deja `acknowledgeReceipt` din Etapa 1/2c, sau simplu: push oricum, e idempotent vizual dacă userul reconfirmă, dar EVITĂ duplicate — verifică în Etapa 0 dacă funcția distinge insert-nou vs conflict), push:
```js
data.events = Array.isArray(data.events) ? data.events : [];
data.events.push({ at: acknowledged_at, type: 'FLOW_ACKNOWLEDGED', by: actor.email, recipientKey });
data.updatedAt = new Date().toISOString();
await saveFlow(flowId, data);
writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_ACKNOWLEDGED', actorEmail: actor.email, payload: { recipientKey } });
```
Va trebui `data = await getFlowData(flowId)` disponibil în acest handler (dacă nu e deja încărcat, adaugă-l).

## 3. `server/index.mjs` — auto-transmit în `notify()` (finalizare)
În blocul existent `if (type === 'COMPLETED' && flowId) { ... transmitFlowTo(...) ... }`, după obținerea `newly`, adaugă ACELAȘI push în `fdata.events[]` + `writeAuditEvent`, cu `by: null` și `source: 'auto'` (recipientLabel construit identic ca la §1 — poți extrage un helper comun dacă e simplu, sau duplica logic minim, la alegerea ta pe baza a ce găsești):
```js
if (newly.length) {
  if (!Array.isArray(fdata.events)) fdata.events = [];
  const nowIso2 = new Date().toISOString();
  for (const row of newly) {
    const recipientKey = row.recipient_user_id ? `user:${row.recipient_user_id}` : `comp:${String(row.recipient_compartiment||'').trim().toLowerCase()}`;
    let recipientLabel;
    if (row.recipient_user_id) {
      const { rows: uRows } = await pool.query('SELECT nume,email FROM users WHERE id=$1', [row.recipient_user_id]);
      recipientLabel = uRows[0]?.nume || uRows[0]?.email || `user #${row.recipient_user_id}`;
    } else {
      recipientLabel = `Compartimentul „${row.recipient_compartiment}"`;
    }
    fdata.events.push({ at: nowIso2, type: 'FLOW_TRANSMITTED', by: null, source: 'auto', recipientKey, recipientLabel, rezolutie: null });
    writeAuditEvent({ flowId, orgId: fdata.orgId, eventType: 'FLOW_TRANSMITTED', payload: { recipientKey, recipientLabel, source: 'auto' } });
  }
  fdata.updatedAt = nowIso2;
  await saveFlow(flowId, fdata);
}
```
Rămâne în interiorul try/catch-ului non-fatal existent — o eroare aici NU trebuie să rupă notificarea COMPLETED. Import `writeAuditEvent`/`saveFlow` dacă nu sunt deja importate în `index.mjs` (probabil da, verifică Etapa 0).

# Implementare — FRONTEND (`public/js/flow/flow.js`)

## 4. `EV_SHOW` — adaugă cele două tipuri
```js
const EV_SHOW = new Set([
  'FLOW_CREATED','SIGNED','SIGNED_PDF_UPLOADED','FLOW_COMPLETED',
  'REFUSED','FLOW_CANCELLED','REVIEW_REQUESTED','DELEGATED',
  'FLOW_REINITIATED','FLOW_REINITIATED_AFTER_REVIEW',
  'EMAIL_SENT','EMAIL_OPENED',
  'FLOW_TRANSMITTED','FLOW_ACKNOWLEDGED'
]);
```

## 5. Bloc nou în `renderTimeline()` — „PAȘI TRANSMITERE INTERNĂ"
Adaugă IMEDIAT DUPĂ blocul „PAȘI EMAIL EXTERN" (înainte de „PAS FINAL: stare finală a fluxului"):
```js
// ── PAȘI TRANSMITERE INTERNĂ (repartizare) ──────────────────────────────
const transmitEvs = relevant.filter(e => e.type === 'FLOW_TRANSMITTED');
for (const ev of transmitEvs) {
  const ackEvs = relevant.filter(e => e.type === 'FLOW_ACKNOWLEDGED' && e.recipientKey === ev.recipientKey);
  const byLabel = ev.by ? resolveName(ev.by) : 'Transmis automat la finalizare';
  steps.push({
    icon: '📨',
    labelHtml: `Transmis către <span style="font-size:.72rem;color:rgba(234,240,255,.45);margin-left:4px;">${esc(ev.recipientLabel||'—')}</span>`,
    actorHtml: `<span class="tl-actor">${esc(byLabel)}</span>` + (ev.rezolutie ? `<span style="font-size:.72rem;color:rgba(234,240,255,.35);margin-left:6px;">"${esc(ev.rezolutie)}"</span>` : ''),
    ts: ev.at,
    state: 'done',
    subRows: ackEvs.map(a => ({ done: true, icon: '✅', label: `Confirmat de ${resolveName(a.by)}`, ts: a.at })),
    extra: null
  });
}
```
Corelarea e pe `recipientKey` (exact, nu cronologică) — o transmitere către compartiment poate avea mai multe confirmări (sub-rânduri multiple); o transmitere directă către un user are cel mult una.

## 6. `EVENT_LABELS` + text extra în `renderEvents()`
Adaugă în harta `EVENT_LABELS`:
```js
'FLOW_TRANSMITTED':  '📨 TRANSMIS INTERN',
'FLOW_ACKNOWLEDGED': '✅ CONFIRMAT DE DESTINATAR',
```
Și în blocul `if/else if` care construiește `extra` (lângă ramurile `EMAIL_SENT`/`EMAIL_OPENED`):
```js
} else if (kind === 'FLOW_TRANSMITTED') {
  extra = `către: ${esc(e.recipientLabel||'')}`;
  if (e.source === 'auto') extra += ' · automat la finalizare';
  if (e.rezolutie) extra += ` · rezoluție: ${esc(e.rezolutie)}`;
} else if (kind === 'FLOW_ACKNOWLEDGED') {
  extra = 'confirmare luare la cunoștință';
}
```
(`who` pentru `FLOW_TRANSMITTED` cu `by: null` — verifică că nu produce text urât gol; poți lăsa `nameMap[byRaw]` să cadă pe string gol, filtrat deja de `.filter(Boolean)` din construcția liniei — testează vizual.)

# Teste — extinde `server/tests/db/flow-transmit-manual.test.mjs` ȘI `server/tests/db/flow-received-ack.test.mjs`
- După o transmitere manuală reușită, `GET /flows/:id` → `data.events` conține un rând `type:'FLOW_TRANSMITTED'` cu `recipientKey`/`recipientLabel` corecte.
- După auto-transmit la COMPLETED (test existent din Etapa 1), `data.events` conține `FLOW_TRANSMITTED` cu `source:'auto'`, `by: null`.
- După acknowledge, `data.events` conține `FLOW_ACKNOWLEDGED` cu `recipientKey` IDENTIC cu cel din evenimentul de transmitere corespunzător (test explicit de corelare).
- Compartiment cu 2 confirmatori → 2 evenimente `FLOW_ACKNOWLEDGED` cu același `recipientKey`, ambele corelabile cu ACEEAȘI transmitere.

`npm test verde, fără regresii` (include fix-ul din Partea A). `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
`server/tests/db/flow-intocmit-lock.test.mjs`, `server/routes/flows/transmit.mjs`, `server/index.mjs`, `public/js/flow/flow.js`, `server/tests/db/flow-transmit-manual.test.mjs`, `server/tests/db/flow-received-ack.test.mjs`, `package.json` (+ `public/js/admin/activity.js`/`audit.js` DOAR dacă guard-ul de traduceri cere `FLOW_ACKNOWLEDGED`, la fel cum a cerut la `FLOW_TRANSMITTED` în push-ul anterior).
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|alop\.mjs|flow-access\.mjs|flow-transmit\.mjs" && echo "⛔ STOP" || echo "✅ NO-TOUCH ok"
```

# Cache busting + versiune
- bump `package.json` 3.9.609 → 3.9.610;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.610` pe `flow/flow.js` (și `admin/activity.js`/`audit.js` dacă atinse) în HTML-urile relevante.

# La final
```bash
git add server/tests/db/flow-intocmit-lock.test.mjs server/routes/flows/transmit.mjs server/index.mjs public/js/flow/flow.js server/tests/db/flow-transmit-manual.test.mjs server/tests/db/flow-received-ack.test.mjs public/sw.js package.json
git commit -m "fix+feat: repară test flow-intocmit-lock + trasabilitate FLOW_TRANSMITTED/FLOW_ACKNOWLEDGED în Progres flux și Evenimente (v3.9.610)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Testul din Partea A verde (root cause: input, nu regresie).
2. `FLOW_TRANSMITTED`/`FLOW_ACKNOWLEDGED` apar în `data.events[]` (auto + manual + confirmare) ȘI în `audit_events`.
3. Corelarea pe `recipientKey` (nu cronologică) — confirmă cu testul de compartiment cu 2 confirmatori.
4. „Progres flux" arată pasul 📨 cu rezoluție (dacă există) și sub-rânduri ✅ de confirmare; „Evenimente" arată liniile cu etichetele noi.
5. NO-TOUCH respectat; status CI (`npm test` + `npm run check`); versiune 3.9.610.
6. Verificare staging: transmiți manual către un compartiment cu 2 membri, ambii confirmă → pe pagina fluxului (inițiator), „Progres flux" arată transmiterea cu 2 sub-rânduri de confirmare separate.
