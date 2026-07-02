---
fix: Regresie navigație — butonul „Înapoi" din DF/ORD duce în ALOP (trebuie să ducă în lista DF/ORD)
target_branch: develop
model_suggested: Sonnet 4.6 (un singur handler de navigație; fix determinist, mic)
risk: SCĂZUT — o singură funcție, fix punctual
version: 3.9.587 → 3.9.588  (confirmă valoarea curentă întâi; bump +1)
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH semnare (standard)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` curat.

## Simptom
După livrarea „clic pe rând deschide DF/ORD" (v3.9.587), butonul „← Înapoi la lista DF/ORD" dintr-un document DF sau ORD deschide tabul **ALOP** în loc de lista DF/ORD. Lucru pur în taburile DF/ORD (fără a veni din ALOP). Înainte de 587 se întorcea corect.

## Cauză (de confirmat)
În `public/js/formular/list.js`:
```js
function showListSection(tab){ … switchListTab(tab||'alop'); … }   // default 'alop'
```
Ramura non-ALOP din `_updateBackBtn(ft)` apelează `showListSection()` **fără argument** → `tab` nedefinit → `switchListTab('alop')` → aterizează pe ALOP. Ramura ALOP (`showListSection('alop')`) e explicită și corectă.

## Etapa 0 — caracterizare (OBLIGATORIU înainte de fix)
```bash
# 1. Vezi exact ce a schimbat commit-ul „clic pe rând" (07). A atins cumva navigația?
git log --oneline -6
git show <hash-commit-clic-pe-rand> -- public/js/formular/list.js | grep -nE "showListSection|_updateBackBtn|switchListTab|btn.onclick" 
# 2. Starea curentă a celor 2 funcții
grep -n "function showListSection\|function _updateBackBtn\|switchListTab(tab" public/js/formular/list.js
sed -n "$(grep -n 'function _updateBackBtn' public/js/formular/list.js|cut -d: -f1),+14p" public/js/formular/list.js
```

**Decizie pe baza Etapei 0:**
- **Dacă commit-ul 07 a modificat `_updateBackBtn`/`showListSection`/`switchListTab`** (nu trebuia — promptul cerea doar `<tr>`/`<td>`/butonul „Deschide"): **revino exact la varianta dinainte** a acelor linii (cherry-pick invers doar pe ele), NU peticui peste. Apoi sari la „Teste".
- **Dacă 07 NU le-a atins** (regresia e un default latent `||'alop'`): aplică fix-ul de mai jos.

## Fix (dacă 07 nu a atins navigația)
În `_updateBackBtn(ft)`, ramura **else** (non-ALOP): butonul să paseze tabul corect în loc de a lăsa default-ul `'alop'`.
```js
}else{
  const _listTab = ft==='notafd' ? 'df' : 'ord';
  btn.textContent = ft==='notafd' ? '← Înapoi la lista DF' : '← Înapoi la lista ORD';
  btn.onclick = () => showListSection(_listTab);
}
```
NU atinge ramura `if(inAlop)` — `showListSection('alop')` de acolo e corectă și rămâne. NU schimba semnătura/default-ul lui `showListSection` (alte apeluri pot depinde de el); fix-ul e doar la call-site-ul butonului DF/ORD.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV:
```
public/js/formular/list.js   (doar _updateBackBtn, ramura else — SAU revert pe liniile atinse de 07)
public/formular.html         (doar ?v= cache-bust)
package.json  public/sw.js
```
Confirmă că `<tr onclick>`, `<td onclick="event.stopPropagation()">` și butonul „Deschide" ascuns din 587 **rămân intacte** (nu le atingem — au fost corecte):
```bash
grep -n 'onclick="openDocFromList' public/js/formular/list.js | head
grep -n 'style="display:none"' public/js/formular/list.js public/js/formular/alop.js | grep Deschide || echo "(verifică manual butoanele Deschide ascunse)"
```

## Teste
`npm test verde, fără regresii`. `npm run check` syntax OK.

## Cache busting + versiune
- bump `package.json`: `3.9.587` → `3.9.588`;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.588` pe `list.js` în `public/formular.html`.

## La final
```bash
git add public/js/formular/list.js public/formular.html package.json public/sw.js
git commit -m "fix(formulare): butonul Înapoi din DF/ORD revine la lista DF/ORD, nu la ALOP (v3.9.588)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: ce a arătat Etapa 0 (a atins 07 navigația sau nu), ce ai aplicat (revert vs fix call-site), status `npm test`. Confirmare vizuală la owner: „Înapoi" din DF → lista DF; din ORD → lista ORD; clic-pe-rând încă funcționează în toate 3 taburile.
