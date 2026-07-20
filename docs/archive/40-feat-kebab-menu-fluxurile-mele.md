---
feat(ux): meniu kebab („⋮") pe cardurile din „Fluxurile mele" — TOATE acțiunile în meniu, cardul păstrează doar statusul + informațiile
target_branch: develop
model_suggested: Opus 4.8 (refactor de randare într-un monolit de 2300+ linii, cu 8 acțiuni condiționate — precizie pe păstrarea condițiilor)
risk: MEDIU (UI central, dar handler-ele existente se PĂSTREAZĂ identic — se mută doar markup-ul)
version: 3.9.618 → 3.9.619
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Scop (decizie owner: kebab COMPLET)
Cardurile din „Fluxurile mele" au până la 8 butoane de acțiune (Semnează, Vezi flow, PDF semnat,
Raport conformitate, Trimite, Reinițiază, Doc revizuit, Șterge/Anulează) — cardul e aglomerat.
TOATE acțiunile se mută într-un meniu kebab („⋮") în colțul din dreapta al cardului. Pe card
rămân DOAR: titlul, informațiile (Creat, tip, provider, Inițiator, ID), badge-urile de status
(✓ Finalizat, Email trimis etc.) și bara de progres a semnatarilor.

# 🚫 NO-TOUCH
Funcțiile globale apelate de acțiuni (`signFromFluxuri`, `_openEmailForFlow`, `reinitiateFlow`,
`showReviewUploadModal`, `deleteFlow`, `cancelFlow`, `downloadTrustReportInit`) — NEATINSE.
Condițiile de vizibilitate ale fiecărei acțiuni (cine/când o vede) — IDENTICE, doar mutate.
Logica de date a listei (fetch, paginare, filtre) — neatinsă.

# ⚠️ Principiu de execuție — ZERO rewiring
Butoanele existente folosesc `onclick` inline (pattern pre-existent al paginii). NU le rescrie
pe addEventListener — mută markup-ul EXACT cum e (aceleași `onclick`, aceleași condiții ternare)
din bara de butoane în interiorul dropdown-ului kebab. Singurul cod NOU (toggle-ul kebab,
închiderea pe click-afară/Escape) se scrie CSP-safe cu event delegation pe container, fără
inline handlers noi.

# Etapa 0 — caracterizare
```bash
grep -n "Vezi flow\|PDF semnat\|signFromFluxuri\|reinitiateFlow\|deleteFlow\|cancelFlow\|_openEmailForFlow\|showReviewUploadModal" public/js/semdoc-initiator/main.js | head -15
sed -n '1220,1265p' public/js/semdoc-initiator/main.js   # blocul complet de butoane per card
grep -n "df-flow-card\|renderFlows\|fluxuri" public/js/semdoc-initiator/main.js | head -10
grep -rn "\.df-action-btn" public/css/ 2>/dev/null | head -3   # unde stau stilurile (pt CSS-ul kebab)
```
Raportează structura exactă a cardului (containerul, clasa, unde se inserează kebab-ul) înainte
de a modifica.

# Implementare — `public/js/semdoc-initiator/main.js` (+ CSS-ul paginii)

## 1. Markup kebab per card
În template-ul cardului, înlocuiește bara de butoane de acțiune cu:
```html
<div class="df-kebab-wrap">
  <button type="button" class="df-action-btn icon-only df-kebab-btn" aria-haspopup="true" aria-expanded="false" aria-label="Acțiuni" data-flow="${f.flowId}">
    <svg class="df-ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>
  </button>
  <div class="df-kebab-menu" hidden>
    <!-- AICI se mută, identic, fiecare buton/anchor existent cu toate condițiile lui ternare,
         cu clasa suplimentară df-kebab-item pentru stilizare de rând de meniu -->
  </div>
</div>
```
Poziționat în colțul dreapta-sus al cardului (lângă badge-ul de status sau în header-ul cardului
— aliniat cu designul existent). Ordinea itemilor în meniu: Semnează (dacă e cazul, primul —
e acțiunea cea mai importantă), Vezi flow, PDF semnat, Raport conformitate, Trimite, Reinițiază,
Doc revizuit, Anulează, Șterge (destructive la coadă, vizual separate cu un divider).

## 2. Comportament (cod NOU, CSP-safe, un singur set de listeneri prin delegation)
Pe containerul listei de fluxuri (o singură dată, nu per card):
```js
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.df-kebab-btn');
  if (btn) {
    const menu = btn.parentElement.querySelector('.df-kebab-menu');
    const isOpen = !menu.hidden;
    document.querySelectorAll('.df-kebab-menu').forEach(m => { m.hidden = true; });
    document.querySelectorAll('.df-kebab-btn').forEach(b => b.setAttribute('aria-expanded','false'));
    if (!isOpen) { menu.hidden = false; btn.setAttribute('aria-expanded','true'); }
    ev.stopPropagation();
    return;
  }
  // click în afara oricărui meniu → închide tot
  if (!ev.target.closest('.df-kebab-menu')) {
    document.querySelectorAll('.df-kebab-menu').forEach(m => { m.hidden = true; });
    document.querySelectorAll('.df-kebab-btn').forEach(b => b.setAttribute('aria-expanded','false'));
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    document.querySelectorAll('.df-kebab-menu').forEach(m => { m.hidden = true; });
    document.querySelectorAll('.df-kebab-btn').forEach(b => b.setAttribute('aria-expanded','false'));
  }
});
```
Un click pe un item din meniu își execută `onclick`-ul existent normal (nu-l intercepta), iar
meniul se închide după (fie prin navigare, fie adaugă închiderea în delegation la click pe
`.df-kebab-item`). Un singur meniu deschis simultan (garantat de logica de mai sus).

## 3. CSS (în fișierul de stiluri al paginii, scoped)
```css
.df-kebab-wrap { position: relative; }
.df-kebab-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 50;
  min-width: 220px; padding: 6px;
  background: var(--df-card-bg, #141a2c); border: 1px solid rgba(255,255,255,.08);
  border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.45);
  display: flex; flex-direction: column; gap: 2px;
}
.df-kebab-menu .df-kebab-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; justify-content: flex-start; text-align: left;
  border: none; background: transparent; border-radius: 7px; padding: 8px 10px;
}
.df-kebab-menu .df-kebab-item:hover { background: rgba(255,255,255,.06); }
.df-kebab-divider { height: 1px; background: rgba(255,255,255,.08); margin: 4px 2px; }
```
Refolosește token-urile/variabilele existente ale design-system-ului (df-shell) unde există —
nu inventa culori noi hardcodate dacă există variabile.

## 4. Card compactat
După mutare, cardul păstrează: titlu, linia de informații (Creat · tip · provider · Inițiator ·
ID), badge-urile de status existente și bara de progres semnatari. NIMIC altceva nu se schimbă
în structura cardului.

# Verificare manuală (CRITICĂ — 8 acțiuni condiționate, fiecare trebuie re-verificată)
Pe staging, cu un cont care are fluxuri în toate stările:
1. Flux finalizat → kebab conține: Vezi flow, PDF semnat, Raport conformitate, Trimite. Toate funcționează.
2. Flux în curs, unde ești semnatar curent → „Semnează" apare PRIMUL în meniu și funcționează.
3. Flux refuzat, ca inițiator → „Reinițiază" apare și funcționează.
4. Flux cu revizuire cerută, ca inițiator → „Doc revizuit" apare.
5. Flux proaspăt, fără semnături, ca inițiator → „Șterge" + „Anulează" apar, cu divider, la coadă.
6. Cont NON-inițiator pe fluxul altcuiva → acțiunile de inițiator NU apar (condițiile mutate identic).
7. Doar UN meniu deschis simultan; click-afară și Escape închid; aria-expanded corect.
8. Mobil/îngust: meniul nu iese din viewport (dacă iese, adaugă fallback `right:0` → `left:0` la nevoie).

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
EXCLUSIV: `public/js/semdoc-initiator/main.js`, fișierul CSS al paginii (identificat în Etapa 0),
`public/semdoc-initiator.html` (bump ?v=), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "server/|cloud-signing|pades|alop" && echo "⛔ STOP: frontend-only!" || echo "✅ scope curat"
git diff public/js/semdoc-initiator/main.js | grep -nE "^-.*(signFromFluxuri|reinitiateFlow|deleteFlow|cancelFlow|_openEmailForFlow|showReviewUploadModal|downloadTrustReportInit)\(" | grep -v "onclick" && echo "⚠️ verifică: funcțiile globale nu trebuie modificate, doar apelurile mutate" || echo "✅"
```

# Cache busting + versiune
3.9.618 → 3.9.619; `CACHE_VERSION` sw.js; `?v=3.9.619` pe main.js (+ CSS dacă e fișier separat) în semdoc-initiator.html.

# La final
```bash
git add -A -- public/js/semdoc-initiator/main.js public/css/ public/semdoc-initiator.html public/sw.js package.json
git commit -m "feat(ux): meniu kebab pe cardurile Fluxurile mele — toate acțiunile în meniu, card compact (v3.9.619)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Toate cele 8 acțiuni mutate cu condițiile IDENTICE (listează-le cu condiția fiecăreia, ca dovadă).
2. Toggle CSP-safe prin delegation; un singur meniu deschis; Escape/click-afară funcționale.
3. CI verde, v3.9.619.
4. Cere owner-ului verificarea manuală pe cele 8 scenarii de mai sus înainte de a considera închis.
