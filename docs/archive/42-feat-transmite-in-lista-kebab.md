---
feat(ux): „Transmite în aplicație" și în kebab-ul din „Fluxurile mele" — simetrie cu „Trimite" (email extern)
target_branch: develop
model_suggested: Sonnet 5 (adăugare de item în kebab, pe tipar existent — atenție la includerea scriptului modalului)
risk: SCĂZUT (un item nou în meniu + include script; refolosește DFTransmitModal existent)
version: 3.9.620 → 3.9.621
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Scop
Azi „Transmite în aplicație" (repartizare internă) există DOAR pe pagina fluxului (`flow.html`),
pe când „Trimite" (email extern) e și în kebab-ul din „Fluxurile mele" și pe pagina fluxului.
Owner a decis simetrie: adaugă „Transmite în aplicație" ca item în kebab-ul cardurilor din
„Fluxurile mele", lângă „Trimite", cu aceeași condiție de vizibilitate.

# ⚠️ Dependență critică (confirmată în cod)
`df-transmit-modal.js` e inclus DOAR în `flow.html`, NU în `semdoc-initiator.html`. Deci pe
pagina „Fluxurile mele" `window.DFTransmitModal` NU există momentan — click-ul pe noul item ar
eșua. **Includerea scriptului în `semdoc-initiator.html` e OBLIGATORIE, parte din acest task**,
nu opțională.

# 🚫 NO-TOUCH
`df-transmit-modal.js` (componenta) — doar inclusă și consumată, NU modificată. Ruta backend
`POST /flows/:id/transmit` — neatinsă (deja există din prompt 27). Restul itemilor din kebab și
condițiile lor — neschimbate. `_openEmailForFlow` și celelalte handler-e — neatinse.

# Etapa 0 — caracterizare
```bash
grep -n "_openEmailForFlow('\${f.flowId}')\|pdfReady\|df-kebab-item\|kebabMain" public/js/semdoc-initiator/main.js | head
grep -n "df-transmit-modal\|df-email-modal" public/semdoc-initiator.html public/flow.html
grep -n "window.DFTransmitModal\|DFTransmitModal.open" public/js/df-transmit-modal.js | head -3
```
Confirmă: numele exact al variabilei care ține grupul de itemi (kebabMain vs echivalent);
semnătura `DFTransmitModal.open(flowId, { docName, onSuccess })` (din flow.js:927).

# Implementare

## 1. `public/semdoc-initiator.html` — include scriptul modalului
Adaugă (lângă includerea `df-email-modal.js` sau a altor scripturi de modal), cu cache-bust curent:
```html
<script src="/js/df-transmit-modal.js?v=3.9.621" defer></script>
```

## 2. `public/js/semdoc-initiator/main.js` — item nou în kebab
IMEDIAT după item-ul „Trimite" (linia ~1252, condiționat pe `pdfReady`), adaugă un item analog
în același grup `kebabMain` (sau echivalentul găsit în Etapa 0), cu aceeași condiție `pdfReady`
și clasa `df-kebab-item`:
```js
${pdfReady ? `<button onclick="_openTransmitForFlow('${f.flowId}')" class="df-action-btn df-kebab-item" title="Transmite documentul în aplicație"><svg class="df-ico df-ico-sm" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-send"/></svg>Transmite în aplicație</button>` : ''}
```
(Verifică în `icons.svg` că `#ico-send` există; dacă nu, folosește un icon existent apropiat —
ex. `#ico-share` sau `#ico-inbox` — confirmă în Etapa 0 ce iconițe sunt disponibile.)

## 3. `public/js/semdoc-initiator/main.js` — helper `_openTransmitForFlow`
Adaugă o funcție globală analogă cu `_openEmailForFlow`, care deschide modalul de transmitere:
```js
window._openTransmitForFlow = function(flowId) {
  const f = (window._flowsEmailData && window._flowsEmailData[flowId]) || {};
  if (!window.DFTransmitModal) { console.warn('DFTransmitModal indisponibil'); return; }
  window.DFTransmitModal.open(flowId, {
    docName: f.docName || flowId,
    onSuccess: () => { if (typeof loadFlows === 'function') loadFlows(); }
  });
};
```
(Adaptează: `window._flowsEmailData` e populat deja la linia ~1226 pentru fluxurile cu
`pdfReady` — refolosește-l ca sursă de `docName`. Numele funcției de reîncărcare a listei —
confirmă în Etapa 0: `loadFlows` sau echivalent; dacă diferă, folosește-l pe cel real, cu guard
`typeof`.)

# Verificare manuală
- În „Fluxurile mele", pe un flux **finalizat**, kebab → „Transmite în aplicație" apare (lângă „Trimite").
- Click → se deschide modalul de repartizare (selector utilizator/compartiment + rezoluție).
- Transmiți către un destinatar → succes → destinatarul primește notificarea „📨 Document repartizat".
- Pe un flux **nefinalizat** → item-ul NU apare (condiția `pdfReady`, la fel ca „Trimite").
- Meniul se închide după click pe item (comportament kebab existent, neafectat).
- Pagina fluxului (`flow.html`) — butonul „Transmite în aplicație" de acolo funcționează în continuare (neatins).

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `public/js/semdoc-initiator/main.js`, `public/semdoc-initiator.html`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -vE "semdoc-initiator/main\.js|semdoc-initiator\.html|public/sw\.js|package\.json" && echo "⛔ STOP" || echo "✅ scope curat"
git diff public/js/semdoc-initiator/main.js | grep -n "_openEmailForFlow\s*=" && echo "⚠️ verifică: _openEmailForFlow neatins" || echo "✅"
```

# Cache busting + versiune
3.9.620 → 3.9.621; `CACHE_VERSION` sw.js; `?v=3.9.621` pe `semdoc-initiator/main.js` ȘI pe `df-transmit-modal.js` în `semdoc-initiator.html`.

# La final
```bash
git add public/js/semdoc-initiator/main.js public/semdoc-initiator.html public/sw.js package.json
git commit -m "feat(ux): Transmite în aplicație în kebab-ul Fluxurile mele — simetrie cu Trimite (v3.9.621)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Scriptul `df-transmit-modal.js` inclus în semdoc-initiator.html; `window.DFTransmitModal` disponibil pe pagină.
2. Item nou în kebab cu condiția `pdfReady` (identică cu „Trimite"); iconița folosită.
3. Modalul se deschide și transmite corect din listă; pagina fluxului neafectată.
4. CI verde, v3.9.621.
