---
prompt: 60
titlu: "style(org): select „Compartiment CAB implicit" folosește .df-filter-select (lista derulantă dark, ca restul proiectului)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX · aliniere stil select
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Simptom
Select-ul „Compartiment CAB implicit" (Organizații → General, adăugat la #59) are lista derulantă cu **fundal alb + font default**, diferit de restul proiectului (ex. filtrul de status din „Administrare fluxuri").

## Cauză
Clasa standard de select din proiect e **`.df-filter-select`** (`public/css/admin/admin.css:58`), care include `color-scheme:dark` — de asta lista nativă de opțiuni se randează dark. Select-ul nou nu folosește clasa asta.

## Fix
Pe elementul `<select>` „Compartiment CAB implicit" (în `public/admin.html` dacă markup-ul e static, sau în `public/js/admin/organizations.js` dacă e randat din JS), aplică **`class="df-filter-select"`** — identic cu `#flowStatusFilter` (`admin.html:361`). Elimină orice stil inline/clasă custom care ar suprascrie fundalul/culoarea. Opțiunile injectate NU au nevoie de stil inline propriu — `color-scheme:dark` de pe select acoperă lista derulantă.

Lărgime: dacă e nevoie, adaugă doar un `style="max-width:...;"` punctual (ca la alte select-uri din admin), fără a atinge fundal/culoare/font.

## Interdicții
- ⛔ Nu atinge logica #59 (BE, filtrare modal, migrare). Doar clasa de stil a select-ului.
- ⛔ Nu modifica `.df-filter-select` din CSS (e partajat).

## Cache busting + versiune
- Dacă modifici `public/js/admin/organizations.js` → bump `organizations.js?v=` în `admin.html` la versiunea nouă.
- `public/sw.js`: `CACHE_VERSION` → incrementează de la valoarea curentă (ex. `docflowai-v268` → `docflowai-v269`).
- `package.json`: următorul patch de la valoarea reală curentă (ex. `3.9.640` → `3.9.641`).

## Guardrails diff
`git diff --name-only` = EXCLUSIV: `public/admin.html` și/sau `public/js/admin/organizations.js`, `public/sw.js`, `package.json`.

## Verificare (owner, staging)
Organizații → General → deschide „Compartiment CAB implicit": lista derulantă e dark, font ca la celelalte filtre (captura „Administrare fluxuri").

## Final
```bash
git add -A
git commit -m "style(org): select Compartiment CAB implicit → .df-filter-select (dropdown dark)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
