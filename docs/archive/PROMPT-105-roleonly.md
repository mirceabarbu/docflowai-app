---
prompt: "#105-roleonly"
titlu: "Contract ROLE-ONLY: isPlatformAdmin = role==='admin' (zero schemă, zero null, zero flip)"
model_suggested: "Opus 4.8"
target_version: "v3.9.735"
branch: "develop"
migratii: "nu"
cache_bump: "nu"
depinde_de: "#105a..#105i (dfdee82)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.

---

## Context (de ce)

`users.org_id` are NOT NULL pe producție ⇒ `admin@docflowai.ro` NU poate avea `org_id=NULL`.
Abandonăm complet flip-ul/null-ul/migrația. În loc, schimbăm **recunoașterea** platform-admin-ului
la **role-only**: `isPlatformAdmin = role==='admin'` (indiferent de org_id). Astfel admin rămâne cu
`org_id=1`, e recunoscut ca platformă după rol, și vede tot — fără atingere de schemă.

Se potrivește cu DocFlowAI: `role='admin'` e DOAR contul bootstrap; primăriile au `org_admin`.
**INVARIANT DE PĂSTRAT** (operațional): nu atribui NICIODATĂ `role='admin'` unui client — ar deveni
superuser cross-org. (Sub role-only, un admin cu org e platform, deci nu mai există „admin scopat".)

Toată logica a→i rămâne neatinsă. Se schimbă **o linie** în `authz-scope.mjs` + aserțiile de test
care presupuneau „admin-cu-org_id = scopat/403". Aserțiile pe **org_admin** cross-org rămân
neschimbate (org_admin nu e niciodată platform).

---

## PAS 1 — Preflight
```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.734",
```

---

## PAS 2 — `server/services/authz-scope.mjs` (SINGURA schimbare de producție)

- old_str:
```
/**
 * Platform-admin = admin de platformă, fără org_id. Singurul care vede tot cross-org.
 * @param {{role?:string, orgId?:number|string|null}} actor
 * @returns {boolean}
 */
export function isPlatformAdmin(actor) {
  return actor?.role === 'admin' && !actor?.orgId;
}
```
- new_str:
```
/**
 * Platform-admin = orice actor cu role==='admin' (contract ROLE-ONLY, 22.07.2026).
 * La DocFlowAI role='admin' e DOAR contul bootstrap de platformă; primăriile folosesc
 * org_admin. INVARIANT: nu atribui NICIODATĂ role='admin' unui client (ar deveni superuser).
 * @param {{role?:string}} actor
 * @returns {boolean}
 */
export function isPlatformAdmin(actor) {
  return actor?.role === 'admin';
}
```

```bash
node --check server/services/authz-scope.mjs
```

> Regula pentru TOATE editările de test de mai jos: un `admin` CU org_id devine acum **platform**
> (vede tot / not-403 / fără filtru). Dacă un `old_str` nu se potrivește exact, găsește aserția
> după descrierea testului și aplică aceeași schimbare semantică. `org_admin` rămâne neschimbat.

---

## PAS 3 — `server/tests/unit/authz-scope.test.mjs`

### 3a. isPlatformAdmin admin+org
- old_str:
```
  it('admin CU org_id ⇒ false (admin instituțional, org-scoped)', () => {
    expect(isPlatformAdmin({ role: 'admin', orgId: 1 })).toBe(false);
  });
```
- new_str:
```
  it('admin CU org_id ⇒ true (role-only: role=admin ⟺ platform)', () => {
    expect(isPlatformAdmin({ role: 'admin', orgId: 1 })).toBe(true);
  });
```

### 3b. orgScopeSql admin+org
- old_str:
```
  it('admin CU org_id ⇒ tratat ca org-scoped (nu platform)', () => {
    const params = [];
    const sql = orgScopeSql({ role: 'admin', orgId: 1 }, 'a', params);
    expect(sql).toBe(' AND a.org_id = $1');
    expect(params).toEqual([1]);
  });
```
- new_str:
```
  it('admin CU org_id ⇒ platform, fără filtru (role-only)', () => {
    const params = [];
    const sql = orgScopeSql({ role: 'admin', orgId: 1 }, 'a', params);
    expect(sql).toBe('');
    expect(params).toEqual([]);
  });
```

### 3c. actorCanAccessOrg admin+org
- old_str:
```
  it('admin CU org_id ⇒ doar propriul org (nu platform)', () => {
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 2)).toBe(false);
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 1)).toBe(true);
  });
```
- new_str:
```
  it('admin CU org_id ⇒ platform, acces la orice org (role-only)', () => {
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 2)).toBe(true);
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 1)).toBe(true);
  });
```

---

## PAS 4 — `server/tests/unit/actor-org-filter.test.mjs`
- old_str:
```
  it('admin CU org_id ⇒ scopat la propriul org (NU null) — fixul central', () => {
    expect(actorOrgFilter({ role: 'admin', orgId: 1 })).toBe(1);
    expect(actorOrgFilter({ role: 'admin', orgId: 2 })).toBe(2);
  });
```
- new_str:
```
  it('admin CU org_id ⇒ platform, fără filtru (null) — role-only', () => {
    expect(actorOrgFilter({ role: 'admin', orgId: 1 })).toBe(null);
    expect(actorOrgFilter({ role: 'admin', orgId: 2 })).toBe(null);
  });
```

---

## PAS 5 — `server/tests/integration/formulare-list.test.mjs` (blocul #105d)

### 5a. /api/formulare/list — admin cu org
- old_str:
```
  it('admin CU org_id → scopat pe org, DAR fără filtru de compartiment (vede tot org-ul)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).toContain('fd.org_id=$1');
    expect(getParams()).toContain(1);
    expect(getSql()).not.toContain('TRIM(uc.compartiment)');
  });
```
- new_str:
```
  it('admin CU org_id → platform, FĂRĂ scopare org (role-only, vede tot)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).not.toContain('fd.org_id=$');
  });
```

### 5b. /api/formulare-df — admin cu org
- old_str:
```
  it('admin CU org_id → scopat pe org (ca org_admin)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).toContain('fd.org_id = $1');
    expect(getParams()).toContain(1);
  });
```
- new_str:
```
  it('admin CU org_id → platform, orgFilter gol (role-only)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).not.toContain('fd.org_id = $1');
  });
```

---

## PAS 6 — `server/tests/unit/flow-access.test.mjs`
- old_str:
```
  it('admin CU org_id, cross-org → false (fail-closed până la flip)', () => {
    expect(canActorReadFlow(actor('admin@y.ro', 'admin', 99), makeData(), null)).toBe(false);
  });
```
- new_str:
```
  it('admin CU org_id, cross-org → true (role-only: admin = platform)', () => {
    expect(canActorReadFlow(actor('admin@y.ro', 'admin', 99), makeData(), null)).toBe(true);
  });
```

---

## PAS 7 — `server/tests/integration/alop.test.mjs` (blocul #105g)
- old_str:
```
  it('admin CU org_id → params[0]=org (scopat)', async () => {
    const cap = captureAlop();
    await request(app105g()).get('/api/alop').set('Cookie', `auth_token=${tok105g('admin', 1, 5)}`).expect(200);
    expect(cap.list().params[0]).toBe(1);
  });
```
- new_str:
```
  it('admin CU org_id → platform, params[0]=null (role-only)', async () => {
    const cap = captureAlop();
    await request(app105g()).get('/api/alop').set('Cookie', `auth_token=${tok105g('admin', 1, 5)}`).expect(200);
    expect(cap.list().params[0]).toBe(null);
  });
```

---

## PAS 8 — `server/tests/integration/lifecycle-org-guard.test.mjs`
- old_str:
```
  it('admin CU org_id, ALT org (2) → 403 (fail-closed până la flip)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).toBe(403);
  });
```
- new_str:
```
  it('admin CU org_id, ALT org (2) → NU 403 (role-only: admin = platform)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).not.toBe(403);
  });
```

---

## PAS 9 — `server/tests/integration/signing-attachments-org-guard.test.mjs`
- old_str:
```
  it('DELETE attachment: admin CU org_id cross-org → 403 (fail-closed)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).toBe(403);
  });
```
- new_str:
```
  it('DELETE attachment: admin CU org_id cross-org → NU 403 (role-only: admin = platform)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).not.toBe(403);
  });
```

---

## PAS 10 — `server/tests/integration/tenant-isolation-report.test.mjs`
- old_str:
```
  it('admin CU org_id=1 pe flux ALT org (2) → 403 (fail-closed până la null org_id)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(2));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', 1));
    expect(res.status).toBe(403);
  });
```
- new_str:
```
  it('admin CU org_id=1 pe flux ALT org (2) → NU 403 (role-only: admin = platform)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(2));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', 1));
    expect(res.status).not.toBe(403);
  });
```

---

## PAS 11 — Suită + catch-all + bump + commit + push

```bash
npm test
```
Dacă mai pică vreo aserție pe care NU am listat-o și e un caz de **admin CU org_id** care aștepta
scopare/403/fail-closed, aplică aceeași schimbare (admin = platform: vede tot / not-403 / no-filter)
și raporteaz-o. Dacă pică ceva ce NU e un caz admin-cu-org (ex. org_admin, user), **oprește-te și
raportează** — ar putea fi o regresie reală, nu o aserție de aliniat.

- old_str: `  "version": "3.9.734",`
- new_str: `  "version": "3.9.735",`

```bash
git add -A
git status --short          # authz-scope.mjs + fișierele de test atinse + package.json
git commit -m "#105 role-only: isPlatformAdmin = role==='admin' (fără dependență de org_id / null / schemă) (v3.9.735)"
git push origin develop
```

---

## RAPORT FINAL (completează)

- authz-scope.mjs: isPlatformAdmin acum `return actor?.role === 'admin'`: da/nu
- Aserțiile listate (PAS 3–10) actualizate: da/nu
- Aserții suplimentare admin-cu-org aliniate în PAS 11 (listează fișier + test): ______
- Vreo pică non-admin (posibilă regresie) — dacă da, ce: ______
- npm test: PASSED (nr. fișiere/teste)
- Bump 3.9.734 → 3.9.735: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ SINGURA schimbare de producție = linia din `authz-scope.mjs`. Restul sunt DOAR teste.
- ⛔ NU atinge aserțiile pe `org_admin` (rămân scopate/403 — corecte). Doar `admin`-cu-org se schimbă.
- ⛔ Dacă pică un test care NU e admin-cu-org, e posibil o regresie reală → oprește-te, raportează.
- ⛔ Fără migrații, fără schemă, fără cache/`?v=`. Zona NO-TOUCH `server/signing/*` neatinsă.
