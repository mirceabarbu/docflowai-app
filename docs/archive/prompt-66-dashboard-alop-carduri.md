---
prompt: 66
titlu: "feat(dashboard): 4 carduri ALOP în Dashboard admin (active, angajat an-curent, plătit an-curent, finalizate an-curent)"
model_suggested: Opus 4.8
branch: develop
zona: Dashboard admin · agregare financiară ALOP (read-only)
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Cerință (owner)
În Dashboard-ul admin (pe lângă cele 4 carduri existente: Utilizatori, Fluxuri active, Fluxuri finalizate, Notificări necitite) adăugăm **4 carduri ALOP**:
1. **ALOP active** — număr ALOP în progres (`status IN ('angajare','lichidare','ordonantare','plata')`).
2. **Valoare angajată (an curent)** — sumă DF angajat pe exercițiul curent.
3. **Valoare plătită (an curent)** — sumă plăți efectuate pe exercițiul curent.
4. **ALOP finalizate (an curent)** — număr `status='completed'` pe exercițiul curent.

**Scop:** org-ul adminului; super-admin global (`role='admin' && !orgId`) → tot sistemul. Oglindește scoping-ul din `/admin/flows/stats`.

## Implementare (read-only, additiv)

### 1. Backend — endpoint nou `GET /admin/alop/stats`
Adaugă-l lângă `/admin/flows/stats` (`server/routes/admin/flows.mjs:47`), cu același pattern de scoping (org vs. sistem pentru super-admin). Agregă din `alop_instances a` (JOIN `formulare_df df` pentru valori), **reutilizând expresiile deja existente** din `server/routes/alop.mjs`:
- `alop_active` = `COUNT(*) FILTER (WHERE a.status IN ('angajare','lichidare','ordonantare','plata'))`.
- `alop_finalizate_an` = `COUNT(*) FILTER (WHERE a.status='completed' AND df.an_referinta = <an_exercitiu_curent>)`.
- `valoare_angajata_an` = `SUM(${sqlCrediteBugetareCol10('df')})` pe ALOP cu `df.an_referinta = <an curent>` (folosește helperul **verbatim** — nu rescrie formula col.10).
- `valoare_platita_an` = `SUM(COALESCE(a.suma_totala_platita,0) + COALESCE(a.plata_suma_efectiva,0))` pe ALOP din exercițiul curent.
- `cancelled_at IS NULL` peste tot.

> „An curent" = același ancoraj de exercițiu ca în restul ALOP (`an_referinta` / helperii din `buget-an.mjs`). NU inventa altă definiție. Dacă `an_referinta` e NULL pe rânduri vechi, tratează-l ca anul curent (COALESCE), consecvent cu restul aplicației.

Răspuns: `{ alop_active, valoare_angajata_an, valoare_platita_an, alop_finalizate_an }`.

### 2. Frontend — 4 carduri în `public/admin.html`
După cardul `dashKpiNotif` (~linia 194), adaugă 4 carduri KPI cu aceeași structură/clasă (`df-kpi-*`):
- `dashKpiAlopActive` — „ALOP active" · subtitlu „în progres".
- `dashKpiAlopAngajat` — „Valoare angajată" · subtitlu „an curent" (format RON).
- `dashKpiAlopPlatit` — „Valoare plătită" · subtitlu „an curent" (format RON).
- `dashKpiAlopFinal` — „ALOP finalizate" · subtitlu „an curent".

### 3. Frontend — `public/js/admin/audit.js` `loadDashboard()` (~linia 89)
Adaugă `_apiFetch('/admin/alop/stats')` în `Promise.all`, apoi populează cele 4 carduri. Valorile financiare formatate RON (`toLocaleString('ro-RO', {style:'currency',currency:'RON'})` sau helperul de format existent din admin); numerele întregi cu `toLocaleString('ro-RO')`. Fallback `—` la eroare (ca celelalte).

## Ce NU atingem
- ⛔ Nicio scriere, nicio modificare a ALOP-ului sau a endpoint-urilor existente. Doar endpoint nou + carduri + fetch.
- ⛔ NU rescrie formulele financiare — reutilizează `sqlCrediteBugetareCol10` / ancorajul de an existent.

## Test
Test DB pentru `/admin/alop/stats`: seed org cu ALOP în diverse stări + valori → verifică cele 4 câmpuri (count-uri corecte; sumele = suma per-rând a acelorași expresii). Scoping: org_admin vede org-ul, super-admin global vede tot. `npm test verde, fără regresii`.

## Cache busting + versiune
FE atins (`admin.html`, `audit.js`) ⇒ bump `audit.js?v=` în `admin.html`, `CACHE_VERSION` în `sw.js`, `package.json` — de la valorile reale curente.

## Guardrails diff
EXCLUSIV: `server/routes/admin/flows.mjs` (endpoint nou), `public/admin.html`, `public/js/admin/audit.js`, `public/sw.js`, `package.json` (+ test).
```bash
git diff --name-only | grep -iE "routes/alop\.mjs|alop-capabilities|signing|pades" && echo "⛔ STOP: zonă nepermisă!" || echo "✅ doar dashboard"
```

## Verificare (owner, staging)
- Dashboard admin: 8 carduri; cele 4 ALOP corecte.
- **Verifică că `Valoare angajată`/`plătită` = suma valorilor din lista ALOP** (an curent) pentru org-ul respectiv.
- Super-admin global vede totalurile pe sistem; admin instituție doar org-ul.

## Final
```bash
git add server/routes/admin/flows.mjs public/admin.html public/js/admin/audit.js public/sw.js package.json server/tests
git commit -m "feat(dashboard): 4 carduri ALOP (active/angajat/platit/finalizate an-curent)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Raportează
- că sumele financiare coincid cu suma din lista ALOP (an curent);
- `npm test` verde;
- scoping-ul org vs. sistem verificat.
