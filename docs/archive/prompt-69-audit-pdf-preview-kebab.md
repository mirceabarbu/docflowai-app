---
prompt: 69
titlu: "feat(preview): „Audit PDF" în modalul de previzualizare + în kebab-ul „Fluxurile mele" (doar admin/org_admin)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX preview PDF · acțiune admin
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Cerință (owner)
Butonul „Audit PDF" (vizibil doar pentru admin/org_admin în flow detaliu) să se deschidă în **modalul de previzualizare** (ca „PDF original"/„Raport conformitate" din #67). În plus, să apară și în **kebab-ul din „Fluxurile mele"**, tot **doar pentru admin/org_admin**.

## Analiză (confirmată în cod)
- `btnAuditPdf` (`public/js/flow/flow.js:833-855`): admin-gated (`isAdmin = role ∈ {admin, org_admin}`), endpoint `GET /admin/flows/:id/audit?format=pdf` (întoarce PDF), acum face `window.open(_blank)`.
- `openAttPreview(url, name, 'application/pdf')` face `fetch → blob → preview` — merge cu acest endpoint (GET, credentials). Modalul are Descarcă + Print, deci nu se pierde nimic.
- În listă (`semdoc-initiator/main.js`), rolul e disponibil (`JSON.parse(localStorage.getItem('docflow_user')||'{}').role`, folosit deja la gardul de Șterge, ~1300).
- Endpoint-ul e admin-gated server-side → gardul de UI e defense-in-depth.

## Fix

### 1. `public/js/flow/flow.js` — `btnAuditPdf`
Rutează prin modal, cu fallback la comportamentul actual:
```js
btnAudit.onclick = (e) => {
  e.preventDefault();
  const url   = `/admin/flows/${encodeURIComponent(flowId)}/audit?format=pdf`;
  const fname = `Audit_${flowId}.pdf`;
  if (typeof window.openAttPreview === 'function') { window.openAttPreview(url, fname, 'application/pdf'); return; }
  // fallback: logica actuală (fetch blob → window.open _blank)
};
```
Păstrează gardul `btnAudit.style.display = isAdmin ? "" : "none"`.

### 2. `public/js/semdoc-initiator/main.js` — item nou în kebab (admin-only)
Lângă `dlActions` (PDF semnat + Raport conformitate, ~1272), adaugă un item „Audit PDF" **doar** dacă rolul e admin/org_admin:
```js
const _role = (JSON.parse(localStorage.getItem('docflow_user')||'{}').role||'');
const isAdminRole = _role === 'admin' || _role === 'org_admin';
const auditAction = isAdminRole
  ? `<button type="button" class="df-action-btn df-kebab-item" data-audit-action="preview" data-audit-url="/admin/flows/${encodeURIComponent(f.flowId)}/audit?format=pdf" data-audit-name="Audit_${f.flowId}.pdf"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-file-text"/></svg>Audit PDF</button>`
  : '';
```
Include `auditAction` în markup-ul kebab-ului (lângă celelalte `df-kebab-item`). Disponibil pentru admin indiferent de `pdfReady` (auditul e util oricând).

Adaugă un handler delegat, oglindind cel de `data-signed-action="preview"` (~1178-1182):
```js
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-audit-action="preview"]');
  if (!b) return;
  if (typeof window.openAttPreview !== 'function') { window.open(b.getAttribute('data-audit-url'), '_blank'); return; }
  window.openAttPreview(b.getAttribute('data-audit-url'), b.getAttribute('data-audit-name'), 'application/pdf');
});
```
(Dacă există deja un listener delegat centralizat pentru kebab, adaugă acolo ramura `data-audit-action`, ca să nu dublezi listenerii.)

## Ce NU atingem
- ⛔ Backend / endpoint audit (e gata, admin-gated). ⛔ `att-preview.js`. ⛔ STS/PAdES/semnare.
- Doar rerutarea butonului + item nou de kebab gardat pe rol.

## Cache busting + versiune
- Bump `?v=` la `flow.js` și `semdoc-initiator/main.js` în HTML-urile care le referă.
- `sw.js` `CACHE_VERSION` ++. `package.json` următorul patch.

## Guardrails diff
EXCLUSIV: `public/js/flow/flow.js`, `public/js/semdoc-initiator/main.js`, HTML-uri cu `?v=`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "\.mjs$|att-preview|pades|signing|STSCloud" && echo "⛔ STOP!" || echo "✅ doar FE"
```

## Verificare (owner, staging)
- Admin, flow detaliu: „Audit PDF" → se deschide în modal (Descarcă+Print), nu tab nou.
- Admin, „Fluxurile mele" kebab: apare „Audit PDF" → modal.
- User obișnuit: „Audit PDF" **nu apare** nici în detaliu, nici în kebab.

## Final
```bash
git add public/js/flow/flow.js public/js/semdoc-initiator/main.js public/*.html public/sw.js package.json
git commit -m "feat(preview): Audit PDF în modal + în kebab Fluxurile mele (admin/org_admin)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
