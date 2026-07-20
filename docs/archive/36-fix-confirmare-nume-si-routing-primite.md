---
fix(ux): confirmare arată numele destinatarului (nu email) + click pe notificare „Document repartizat" duce direct în tabul Primite
target_branch: develop
model_suggested: Sonnet 5 (2 fix-uri mici, precise)
risk: FOARTE SCĂZUT (adăugiri punctuale, fără schimbare de comportament existent)
version: 3.9.614 → 3.9.615
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Context
Confirmat pe staging: repartizarea + confirmarea funcționează end-to-end („Progres flux" arată
corect 📨 transmiterea + ✅ confirmarea). Trei observații de la owner; DOUĂ sunt fix-uri reale,
UNA e clarificare (nu bug):

1. **Fix real**: sub-rândul de confirmare arată emailul (`mirceabarbu@yahoo.com`) în loc de nume.
2. **Fix real**: click pe notificarea „Document repartizat" ar trebui să ducă direct în tabul
   „📥 Primite" din pagina de notificări (unde e vizibil butonul de confirmare), nu pe fluxul brut.
3. **NU e bug** (clarificare, nu necesită cod): teama că ștergerea unei notificări „pierde
   legătura" cu documentul transmis. Verificat în cod — `listReceivedFor()` citește EXCLUSIV
   din `flow_recipients`/`flow_recipient_acks`/`flows`, ZERO dependență de tabelul
   `notifications`. Datele NU se pierd niciodată la ștergerea unei notificări. Problema reală
   era de DESCOPERIBILITATE (nu știai unde să cauți după ștergere) — fix-ul #2 de mai jos
   rezolvă exact asta, oferind un traseu clar către tabul durabil „Primite".

# 🚫 NO-TOUCH
Logica `listReceivedFor`/`acknowledgeReceipt`/`transmitFlowTo` din `flow-transmit.mjs` —
NU le atinge, sunt corecte, doar consumate. Restul tipurilor de notificare (`YOUR_TURN`,
`formulare` etc.) și click-routing-ul lor — neschimbate.

# Etapa 0 — caracterizare
```bash
grep -n "async function acknowledgeReceipt" server/services/flow-transmit.mjs
sed -n '/router.post(.\/flows\/:flowId\/acknowledge/,/^});/p' server/routes/flows/transmit.mjs | head -30
grep -n "resolveName\|FLOW_ACKNOWLEDGED" public/js/flow/flow.js
sed -n '11,25p' public/js/notifications/notifications.js
grep -n "if (n.flow_id) {" -A 15 public/js/notifications/notifications.js
grep -n "const tabMap" public/js/notifications/notifications.js
```

# Implementare — FIX 1: numele confirmatorului (backend + frontend)

## 1a. `server/routes/flows/transmit.mjs` — `POST /flows/:flowId/acknowledge`
Când se face push în `data.events[]` pentru `FLOW_ACKNOWLEDGED`, adaugă și `byName` (JWT-ul
actorului are deja `nume` cache-uit — vezi payload-ul din `auth.mjs`, câmpul `actor.nume`,
fără interogare extra):
```js
data.events.push({ at: acknowledged_at, type: 'FLOW_ACKNOWLEDGED', by: actor.email, byName: actor.nume || actor.email, recipientKey });
```
(Adaptează la forma EXACTĂ găsită în Etapa 0 — doar adaugă câmpul `byName`, nu schimba restul.)

## 1b. `public/js/flow/flow.js` — `renderTimeline()`, sub-rândurile de confirmare
La construcția `subRows` pentru `FLOW_TRANSMITTED` (linia cu `ackEvs.map(...)`), preferă
`a.byName` dacă există, cu fallback la `resolveName(a.by)` (pentru evenimente vechi, deja
scrise înainte de acest fix, care nu au `byName`):
```js
subRows: ackEvs.map(a => ({ done: true, icon: '✅', label: `Confirmat de ${esc(a.byName || resolveName(a.by))}`, ts: a.at })),
```
(Adaugă `esc(...)` dacă lipsea — `byName` vine din DB/JWT, dar mai bine escapat oricum, pattern
consistent cu restul funcției.)

# Implementare — FIX 2: click pe notificare „Document repartizat" → tab Primite

## 2. `public/js/notifications/notifications.js` — click handler
În blocul `if (n.flow_id) { if (n.type === 'YOUR_TURN') {...} else {...} }`, adaugă o ramură
NOUĂ înainte de fallback-ul generic, pentru `type === 'REPARTIZAT'`:
```js
if (n.flow_id) {
  if (n.type === 'YOUR_TURN') {
    // ... neschimbat ...
  } else if (n.type === 'REPARTIZAT') {
    // Comută pe tabul Primite IN-PAGE (suntem deja pe notifications.html — fără reload complet)
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    const primiteBtn = document.querySelector('.filter-btn[data-filter="primite"]');
    if (primiteBtn) primiteBtn.classList.add('active');
    currentFilter = 'primite';
    renderList();
  } else {
    location.href = `/flow.html?flow=${encodeURIComponent(n.flow_id)}`;
  }
}
```
NOTĂ: dacă notificarea e afișată/deschisă din ALTĂ pagină decât `notifications.html` (verifică
`notif-widget.js` — widget-ul de clopoțel din header, disponibil pe toate paginile), acolo
click-ul trebuie să navigheze efectiv, nu doar să comute un tab local inexistent:
```js
// în notif-widget.js, dacă există ramură similară de click routing:
} else if (n.type === 'REPARTIZAT') {
  location.href = '/notifications.html?tab=primite';
}
```
Verifică în Etapa 0 dacă `notif-widget.js` are propriul handler de click (căutare rapidă:
`grep -n "n.flow_id\|location.href" public/notif-widget.js`) — dacă da, aplică fix-ul echivalent
acolo (navigare completă, deep-link `?tab=primite`, care e deja suportat de `tabMap`); dacă
widget-ul doar deschide `notifications.html` generic fără tip specific, adaptează minimal.

# Verificare manuală
- Un flux cu transmitere + confirmare → „Progres flux" arată „Confirmat de {Nume Prenume}",
  NU emailul.
- Click pe o notificare „Document repartizat" (din pagina de notificări) → comută instant pe
  tabul „📥 Primite", fără reload de pagină.
- Click pe aceeași notificare din widget-ul de clopoțel (altă pagină) → navighează la
  `/notifications.html?tab=primite`, tabul corect activ la încărcare.
- Șterge notificarea → documentul rămâne vizibil în tabul „Primite" (verifică manual, confirmă
  că FIX 2 + clarificarea #3 sunt suficiente, fără alt cod necesar).

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/routes/flows/transmit.mjs`, `public/js/flow/flow.js`, `public/js/notifications/notifications.js`, `public/notif-widget.js` (doar dacă necesar, vezi notă), `public/*.html` (doar pentru bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|alop\.mjs|flow-access\.mjs|flow-transmit\.mjs" && echo "⛔ STOP" || echo "✅ NO-TOUCH ok"
```

# Cache busting + versiune
- bump `package.json` 3.9.614 → 3.9.615;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.615` pe `flow/flow.js`, `notifications/notifications.js`, și `notif-widget.js` (dacă atins).

# La final
```bash
git add server/routes/flows/transmit.mjs public/js/flow/flow.js public/js/notifications/notifications.js public/notif-widget.js public/*.html public/sw.js package.json
git commit -m "fix(ux): nume în loc de email la confirmare + click notificare repartizare → tab Primite (v3.9.615)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. `byName` adăugat la push-ul `FLOW_ACKNOWLEDGED`; frontend preferă `byName`, fallback pe `resolveName`.
2. Click pe notificare `REPARTIZAT` → tab Primite (in-page din notifications.html, deep-link din widget).
3. Confirmare că `notif-widget.js` avea sau nu handler propriu, și ce s-a aplicat acolo.
4. Status CI (`npm test` + `npm run check`); versiune 3.9.615.
