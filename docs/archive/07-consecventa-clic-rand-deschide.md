---
fix: Consecvență deschidere formulare — clic pe rând deschide (DF/ORD ca ALOP) + ascunde butonul „Deschide" de listă în toate 3 taburile
target_branch: develop
model_suggested: Sonnet 4.6 (consecvență frontend, replică pattern ALOP existent; zero logică financiară/backend)
risk: SCĂZUT — 2 fișiere frontend, oglindește patternul ALOP deja funcțional
version: 3.9.586 → 3.9.587  (confirmă întâi că package.json e pe 586; dacă diferă, bump +1 de la valoarea curentă)
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner. La final `git push origin develop` și STOP.

## NO-TOUCH semnare (standard)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` curat.

## Context
În tabul ALOP, clic pe rândul din listă deschide ALOP-ul direct — `<tr onclick="openAlop(...)" style="cursor:pointer">` (alop.js:191), iar butoanele de acțiune sunt protejate de un `<td onclick="event.stopPropagation()">` global (alop.js:213). În DF și ORD (list.js) `<tr>`-ul NU e clicabil — deschiderea se face doar din linkul numărului sau din butonul „Deschide". Inconsecvent.

**Decizie owner:** DF/ORD primesc clic-pe-rând ca ALOP, iar butonul „Deschide" de listă se **ascunde în toate 3 taburile** (simetrie reală), **fără a-l șterge** (rămâne în cod, doar `display:none`, reversibil dintr-o linie).

⚠️ Butoanele „Deschide" vizate sunt DOAR cele de **listă**: `alop.js:215` și `list.js:498`. Butoanele de **workflow** „Deschide DF" / „Deschide ORD" (alop.js ~530+, `alopDeschideDF`/`alopDeschideORD`) sunt altceva — **NU le atinge.**

## Caracterizare-întâi (confirmă înainte să modifici)
```bash
# Pattern ALOP (de replicat) — tr clicabil + td acțiuni cu stopPropagation
grep -n "onclick=\"openAlop('\${esc(a.id)}')\" style=\"cursor:pointer\"\|<td onclick=\"event.stopPropagation()\"" public/js/formular/alop.js
# DF/ORD acum — tr fără onclick, td acțiuni fără stopPropagation
sed -n '482,499p' public/js/formular/list.js
# Cele 2 butoane 'Deschide' de LISTĂ (doar acestea se ascund)
grep -n ">Deschide<" public/js/formular/alop.js public/js/formular/list.js
# Butoanele de WORKFLOW (NU se ating) — trebuie să rămână vizibile
grep -n "Deschide DF\|Deschide ORD\|alopDeschideDF\|alopDeschideORD" public/js/formular/alop.js
```
Dacă harta diferă → OPREȘTE și raportează.

## Implementare

### A. DF/ORD — `public/js/formular/list.js` (funcția `_renderLstTable`, ~l.482–499)
1. **Rând clicabil** — `<tr>` devine:
   ```
   <tr onclick="openDocFromList('${type}','${safeId}')" style="cursor:pointer">
   ```
   (`safeId` e deja în scope la acel punct.)
2. **Protejează butoanele de acțiune** — pe `<td>`-ul de acțiuni (cel cu `style="display:flex;gap:4px;flex-wrap:wrap"`, ~l.497) adaugă `onclick="event.stopPropagation()"`, exact ca ALOP:
   ```
   <td onclick="event.stopPropagation()" style="display:flex;gap:4px;flex-wrap:wrap">
   ```
   Asta acoperă „Deschide" + audit + șterge dintr-un foc — NU modifica definițiile `cancelBtn`/`auditBtn`.
3. **Ascunde butonul „Deschide"** (l.498) — adaugă `style="display:none"`:
   ```
   <button class="df-action-btn sm" style="display:none" onclick="openDocFromList('${type}','${safeId}')">Deschide</button>
   ```
   NU șterge linia.

Linkul numărului (l.483, are `return false`) și butonul trasabilitate 🔗 (are deja `event.stopPropagation()`) — **rămân neschimbate.**

### B. ALOP — `public/js/formular/alop.js` (l.215)
Rândul e deja clicabil și `<td>`-ul de acțiuni are deja `stopPropagation` — **NU le atinge.** Doar ascunde butonul „Deschide" de listă:
```
<button class="df-action-btn sm" style="display:none" onclick="openAlop('${esc(a.id)}')">Deschide</button>
```
NU șterge linia. NU atinge butoanele OPME / 🗑 din același `<td>`, nici butoanele de workflow „Deschide DF/ORD".

## Guardrails diff
`git diff --name-only` trebuie să atingă EXCLUSIV:
```
public/js/formular/list.js
public/js/formular/alop.js
public/formular.html   (doar ?v= cache-bust)
package.json  public/sw.js
```
Verifică explicit că butoanele de workflow au rămas neatinse:
```bash
git diff public/js/formular/alop.js | grep -E "alopDeschideDF|alopDeschideORD|Deschide DF|Deschide ORD" && echo "⛔ STOP: ai atins butoane workflow!" || echo "✅ workflow neatins"
```

## Teste
`npm test verde, fără regresii`. (Schimbare pură de randare frontend — fără teste DB noi.) `npm run check` syntax OK pe `list.js` și `alop.js`.

## Cache busting + versiune
- bump `package.json`: `3.9.586` → `3.9.587` (confirmă valoarea curentă întâi);
- incrementează `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.587` pe `list.js` și `alop.js` în `public/formular.html`.

## La final
```bash
git add public/js/formular/list.js public/js/formular/alop.js public/formular.html package.json public/sw.js
git commit -m "feat(formulare): clic pe rând deschide DF/ORD ca ALOP + ascunde butonul Deschide de listă (v3.9.587)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: fișiere atinse, output-ul verificării workflow-neatins, status `npm test`. Confirmare vizuală pe staging la owner: clic pe rând deschide în toate 3 taburile; 🗑/Audit/🔗 NU deschid documentul; butonul „Deschide" invizibil peste tot; butoanele de workflow „Deschide DF/ORD" încă vizibile.
