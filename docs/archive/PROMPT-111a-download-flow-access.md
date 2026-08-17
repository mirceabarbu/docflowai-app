---
task: "#111a — GET /my-flows/:flowId/download aliniat la poarta partajată isFlowAccessAllowed"
branch: develop
model_suggested: Sonnet 4.6   # schimbare mică, cu trei precedente în același fișier
target_version: v3.9.740
migrations: none
cache_version_bump: NO   # doar backend
---

# ⚠️ BRANCH: develop

## PASUL 0 — CONFIRMĂ BRANCH-UL ÎNAINTE DE ORICE
```
git branch --show-current      # Așteptat: develop
git fetch origin && git status
```

===============================================================================
## CONTEXT / BUG
===============================================================================

`GET /my-flows/:flowId/download` (`server/routes/flows/crud.mjs`, ~linia 903)
îşi calculează accesul **inline**, cu un duplicat divergent al porții partajate:

```js
const sameOrg = actor.orgId && d.orgId && String(actor.orgId) === String(d.orgId);
const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
if (!isInit && !isSigner && !(isAdmin && sameOrg)) {
  return res.status(403).json({ error: 'forbidden' });
}
```

Poarta canonică e `isFlowAccessAllowed` din `server/services/flow-access.mjs`,
folosită DEJA de trei rute din ACELAȘI fișier (liniile 553, 587, 643) și de
`GET /flows/:flowId`, signed-pdf, pdf, attachments, audit. Checkul inline ratează
**două ramuri** pe care poarta le are:

1. **destinatar repartizat** (`isFlowRecipient`, transmitere internă, v3.9.601+) —
   **bug funcțional REAL, care mușcă azi**: un utilizator căruia i s-a repartizat
   documentul îl vede pe `signed-pdf`/`pdf`, dar primește **403 la download**.
2. **platform-admin** (`isPlatformAdmin`, ramura #105f) — lockout, mușcă la a doua primărie.

Direcția greșelii e „prea strict" (lockout), NU leak — nimeni nu vede ce nu trebuie.

⛔ Contextul de securitate al rutei, de PĂSTRAT intact: suportul `?token=<JWT>` a fost
ELIMINAT deliberat la SEC-88.2, cu un comentariu-explicație lung deasupra handlerului.
**NU reintroduce niciun token din query.** Autentificarea rămâne exclusiv cookie/Bearer
prin `requireAuth`. Comentariul SEC-88.2 rămâne pe loc, neatins.

===============================================================================
## PASUL 1 — Înlocuiește checkul inline cu poarta partajată
===============================================================================

Fișier: `server/routes/flows/crud.mjs`.
`pool` și `isFlowAccessAllowed` sunt DEJA importate (liniile 7 și 15) — nu adăuga importuri.

old_str:
```
    const email = (actor.email || '').toLowerCase();
    const isInit = (d.initEmail || '').toLowerCase() === email;
    const isSigner = (d.signers || []).some(s => (s.email || '').toLowerCase() === email);
    const sameOrg = actor.orgId && d.orgId && String(actor.orgId) === String(d.orgId);
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
    if (!isInit && !isSigner && !(isAdmin && sameOrg)) {
      return res.status(403).json({ error: 'forbidden' });
    }
```
new_str:
```
    // #111a: aceeași poartă ca GET /flows/:flowId, signed-pdf, pdf, attachments și audit.
    // Checkul inline de dinainte era un duplicat divergent: rata ramura „destinatar
    // repartizat" (un repartizat vedea documentul, dar primea 403 la download) și ramura
    // platform-admin (#105f). signerToken = null: ruta NU acceptă token din query (SEC-88.2).
    if (!(await isFlowAccessAllowed(pool, actor, d, null, req.params.flowId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
```

⛔ Handlerul e deja `async` (are `await getFlowData`) — nu schimba semnătura.
⛔ NU atinge nimic din restul rutei (ramura Drive, `safeDocName`, headerele, `no_signed_pdf`).
⛔ NU atinge celelalte trei apeluri `isFlowAccessAllowed` din fișier.

Verificare:
```
grep -n "isFlowAccessAllowed" server/routes/flows/crud.mjs
# Așteptat: importul (l.15) + PATRU apeluri (553, 587, 643 + cel nou din download)

grep -n "isAdmin && sameOrg" server/routes/flows/crud.mjs
# Așteptat: GOL (era singura apariție)

grep -n "SEC-88.2" server/routes/flows/crud.mjs
# Așteptat: comentariul e încă acolo, neatins
```

===============================================================================
## PASUL 2 — Test DB (poarta cere PG real: isFlowRecipient interoghează flow_recipients)
===============================================================================

Fișier NOU: `server/tests/db/myflows-download-access.test.mjs`.
Model de urmat: testul de acces al rutei de audit din v3.9.710 (aceeași poartă,
aceleași ramuri) — refolosește helperele din `server/tests/helpers/db-real.mjs`
(`seedOrgUser`, `seedFlow`), nu inventa fixture noi.

⚠️ La `seedOrgUser` cu DOUĂ organizații, dă `orgName` DISTINCT pentru a doua
(`organizations_name_key` e unique — a picat deja de două ori în istoricul suitei).

Cazuri (toate pe `GET /my-flows/:flowId/download`):
1. **inițiator** → 200 (sau 404 `no_signed_pdf` dacă fixture-ul n-are PDF —
   important e să NU fie 403; asertează explicit `status !== 403`).
2. **semnatar** → nu 403.
3. **destinatar repartizat** (rând în `flow_recipients`) → **nu 403** ← bug-ul reparat.
4. **org_admin din aceeași org** → nu 403.
5. **org_admin din ALTĂ org** → **403**.
6. **utilizator oarecare din aceeași org, fără legătură cu fluxul** → **403**.
7. **platform-admin** (`role='admin'`) pe un flux din altă org → nu 403 (ramura #105f).
8. **anonim** (fără cookie) → 401 sau 403.

⛔ Testul trece prin `request(app)` pe ruta reală — nu re-implementa poarta în test.

===============================================================================
## PASUL 3 — Versiune
===============================================================================
Bump `package.json` → `3.9.740`.
⛔ FĂRĂ `?v=` (niciun asset frontend atins). ⛔ FĂRĂ bump `CACHE_VERSION`.

===============================================================================
## PASUL 4 — Porți
===============================================================================
```
npm test
# Baseline la intrare = 108 fișiere / 1396 teste.

npm run test:db     # OBLIGATORIU — ramura recipient nu se poate testa fără PG real
```
⛔ „Docker absent" NU e motiv de skip: instanță PG 17 EFEMERĂ, rețeta din CLAUDE.md
(port 55432). `test:db` SKIPPED = prompt NEterminat. Baseline test:db = 75 fișiere / 496.

===============================================================================
## PASUL 5 — Commit + PUSH
===============================================================================
```
git add server/routes/flows/crud.mjs package.json server/tests/db/myflows-download-access.test.mjs
git commit -m "fix(flows): download my-flows folosește poarta partajată isFlowAccessAllowed (repartizat + platform-admin) — v3.9.740"
git push origin develop
```

===============================================================================
## RAPORT FINAL
===============================================================================
- Commit hash + versiune.
- `npm test` / `npm run test:db`: fișiere, teste, PASS/FAIL. Dacă `test:db` n-a rulat REAL, spune-o.
- Ieșirea reală a celor trei `grep` din Pasul 1.
- Confirmă că ramura Drive și comentariul SEC-88.2 sunt neatinse.
- Orice abatere + justificare.

===============================================================================
## ⛔ CONSTRÂNGERI
===============================================================================
- ⛔ BRANCH develop; PASUL 0 nu e opțional.
- ⛔ NU reintroduce `?token=` din query (SEC-88.2). `signerToken` = `null`, explicit.
- ⛔ NU modifica `flow-access.mjs` — se folosește ca atare.
- ⛔ NU atinge celelalte rute din crud.mjs.
- ⛔ `git push origin develop` la final. Pe `main` niciodată.
