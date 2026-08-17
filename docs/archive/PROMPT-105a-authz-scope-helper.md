---
prompt: "#105a"
titlu: "Contract unic de scope org — modul authz-scope.mjs + teste (ZERO cablare)"
model_suggested: "Opus 4.8"
target_version: "v3.9.726"
branch: "develop"
migratii: "nu"
cache_bump: "nu (niciun fișier din PRECACHE_ASSETS atins; niciun ?v=)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, gestionat MANUAL de Mircea. Acest prompt NU face checkout/merge/push pe `main`.
Toate modificările stau pe `develop`. La final: commit pe `develop`, atât.

---

## Context (de ce)

Rolul `admin` are azi trei semantici incompatibile pentru scope-ul pe organizație.
Contractul canonic decis (22.07.2026) este:

- **platform-admin** = `role==='admin'` **ȘI fără `org_id`** (contul de platformă, bootstrap
  `admin@docflowai.ro`) → vede/acționează cross-org.
- orice actor **cu** `org_id` (inclusiv un eventual `role==='admin'` cu `org_id`) → org-scoped
  la propriul `org_id`. **Fail-closed**: un actor non-platform fără `org_id` filtrează pe `= NULL`
  (0 rânduri), niciodată „fără filtru".

Acest prompt introduce DOAR modulul canonic + testele. **Nu cablează nimic** — nicio rută, niciun
guard, niciun query nu se schimbă. Cablarea (listări, guard-uri de scriere, lockout) vine în
#105b–#105e. Scopul lui #105a: `npm test` rămâne verde IDENTIC, blast-radius zero.

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD    # Așteptat: develop
git status --short                  # Așteptat: gol (working tree curat)
node --version                      # Așteptat: v22.x (vezi .node-version)
grep '"version"' package.json       # Așteptat: "version": "3.9.725",
```

Dacă branch-ul nu e `develop` sau working tree-ul nu e curat, **oprește-te și raportează**.

---

## PAS 2 — Creează modulul `server/services/authz-scope.mjs`

Fișier NOU (nu trebuie să existe). Conținut EXACT:

```js
/**
 * DocFlowAI — Contract unic de scope pe organizație (authz-scope)
 * ---------------------------------------------------------------
 * Sursa canonică pentru distincția platform-admin vs. org-scoped.
 *
 * Contract (decis 22.07.2026):
 *   - platform-admin = role==='admin' ȘI fără org_id (contul de platformă,
 *     bootstrap admin@docflowai.ro). Vede/acționează cross-org.
 *   - orice actor CU org_id (inclusiv un eventual role==='admin' cu org_id)
 *     e org-scoped la propriul org_id. Fail-CLOSED: un actor non-platform
 *     fără org_id filtrează pe `= NULL` (0 rânduri), niciodată „fără filtru".
 *
 * NOTĂ (#105a): modulul e INTRODUS fără a fi cablat nicăieri. Cablarea
 * efectivă (listări, guard-uri, lockout) vine în #105b–#105e.
 * `authz-formular.mjs` (logică per-compartiment) rămâne separat și neatins.
 */

/**
 * Platform-admin = admin de platformă, fără org_id. Singurul care vede tot cross-org.
 * @param {{role?:string, orgId?:number|string|null}} actor
 * @returns {boolean}
 */
export function isPlatformAdmin(actor) {
  return actor?.role === 'admin' && !actor?.orgId;
}

/**
 * admin SAU org_admin (poartă generală de rol; scoping-ul se face separat).
 * Oglindește `admin/_helpers.mjs:isAdminOrOrgAdmin` — în #105c devine sursa unică.
 * @param {{role?:string}} actor
 * @returns {boolean}
 */
export function isAdminOrOrgAdmin(actor) {
  return actor?.role === 'admin' || actor?.role === 'org_admin';
}

/**
 * Fragment SQL de scope pe org pentru un query.
 *  - platform-admin ⇒ '' (fără filtru, vede tot)
 *  - altfel ⇒ împinge org_id pe `params` și întoarce ` AND <alias>.org_id = $N`.
 *    Un actor non-platform fără org_id împinge `null` ⇒ ` = NULL` ⇒ 0 rânduri
 *    (fail-closed), NICIODATĂ fără filtru.
 * @param {{role?:string, orgId?:number|string|null}} actor
 * @param {string} alias  aliasul tabelei în query (ex. 'a', 'fd', 'f')
 * @param {Array<any>} params  array-ul de parametri al query-ului (mutat prin push)
 * @returns {string}
 */
export function orgScopeSql(actor, alias, params) {
  if (isPlatformAdmin(actor)) return '';
  params.push(actor?.orgId ?? null);
  return ` AND ${alias}.org_id = $${params.length}`;
}

/**
 * Poartă pe obiect deja încărcat (nu SQL): platform-admin SAU același org.
 * Fail-closed: dacă oricare org_id lipsește (și nu e platform-admin) ⇒ false.
 * @param {{role?:string, orgId?:number|string|null}} actor
 * @param {number|string|null|undefined} targetOrgId
 * @returns {boolean}
 */
export function actorCanAccessOrg(actor, targetOrgId) {
  if (isPlatformAdmin(actor)) return true;
  return actor?.orgId != null && targetOrgId != null
    && String(actor.orgId) === String(targetOrgId);
}
```

Verificare:
```bash
node --check server/services/authz-scope.mjs   # Așteptat: fără output (sintaxă OK)
```

---

## PAS 3 — Creează testul `server/tests/unit/authz-scope.test.mjs`

Fișier NOU. **Importă din producție, NU redeclară logica.** Conținut EXACT:

```js
import { describe, it, expect } from 'vitest';
import {
  isPlatformAdmin,
  isAdminOrOrgAdmin,
  orgScopeSql,
  actorCanAccessOrg,
} from '../../services/authz-scope.mjs';

describe('isPlatformAdmin', () => {
  it('admin fără org_id ⇒ true (contul de platformă)', () => {
    expect(isPlatformAdmin({ role: 'admin', orgId: null })).toBe(true);
    expect(isPlatformAdmin({ role: 'admin' })).toBe(true);
  });
  it('admin CU org_id ⇒ false (admin instituțional, org-scoped)', () => {
    expect(isPlatformAdmin({ role: 'admin', orgId: 1 })).toBe(false);
  });
  it('org_admin / user ⇒ false indiferent de org_id', () => {
    expect(isPlatformAdmin({ role: 'org_admin', orgId: null })).toBe(false);
    expect(isPlatformAdmin({ role: 'user', orgId: 5 })).toBe(false);
  });
  it('actor null/undefined ⇒ false, fără excepție', () => {
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });
});

describe('isAdminOrOrgAdmin', () => {
  it('admin și org_admin ⇒ true; user ⇒ false; null ⇒ false', () => {
    expect(isAdminOrOrgAdmin({ role: 'admin' })).toBe(true);
    expect(isAdminOrOrgAdmin({ role: 'org_admin' })).toBe(true);
    expect(isAdminOrOrgAdmin({ role: 'user' })).toBe(false);
    expect(isAdminOrOrgAdmin(null)).toBe(false);
  });
});

describe('orgScopeSql', () => {
  it('platform-admin ⇒ fragment gol, params NEATINS', () => {
    const params = ['x'];
    const sql = orgScopeSql({ role: 'admin', orgId: null }, 'a', params);
    expect(sql).toBe('');
    expect(params).toEqual(['x']);
  });
  it('org_admin ⇒ împinge org_id și placeholder corect ($N = params.length)', () => {
    const params = ['x'];
    const sql = orgScopeSql({ role: 'org_admin', orgId: 7 }, 'fd', params);
    expect(sql).toBe(' AND fd.org_id = $2');
    expect(params).toEqual(['x', 7]);
  });
  it('admin CU org_id ⇒ tratat ca org-scoped (nu platform)', () => {
    const params = [];
    const sql = orgScopeSql({ role: 'admin', orgId: 1 }, 'a', params);
    expect(sql).toBe(' AND a.org_id = $1');
    expect(params).toEqual([1]);
  });
  it('non-platform fără org_id ⇒ = NULL (fail-closed, 0 rânduri), NU fără filtru', () => {
    const params = [];
    const sql = orgScopeSql({ role: 'org_admin', orgId: null }, 'a', params);
    expect(sql).toBe(' AND a.org_id = $1');
    expect(params).toEqual([null]);
  });
});

describe('actorCanAccessOrg', () => {
  it('platform-admin ⇒ true pt orice org', () => {
    expect(actorCanAccessOrg({ role: 'admin', orgId: null }, 999)).toBe(true);
  });
  it('același org ⇒ true (comparație pe string, tolerantă number/string)', () => {
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: 3 }, 3)).toBe(true);
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: '3' }, 3)).toBe(true);
  });
  it('org diferit ⇒ false', () => {
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: 3 }, 4)).toBe(false);
  });
  it('admin CU org_id ⇒ doar propriul org (nu platform)', () => {
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 2)).toBe(false);
    expect(actorCanAccessOrg({ role: 'admin', orgId: 1 }, 1)).toBe(true);
  });
  it('org_id lipsă (și non-platform) ⇒ false, fără excepție', () => {
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: null }, 1)).toBe(false);
    expect(actorCanAccessOrg({ role: 'org_admin', orgId: 2 }, null)).toBe(false);
    expect(actorCanAccessOrg(null, 1)).toBe(false);
  });
});
```

Verificare:
```bash
node --check server/tests/unit/authz-scope.test.mjs   # Așteptat: fără output
```

---

## PAS 4 — Rulează suita și confirmă zero regresii

```bash
npm test
# Așteptat: verde. Noul fișier authz-scope.test.mjs trece (toate cazurile).
# NICIUN alt test nu-și schimbă rezultatul (nimic nu e cablat) — suita rămâne verde identic.
```

Confirmă că blast-radius-ul e EXACT cele două fișiere noi + bump-ul de versiune:
```bash
git status --short
# Așteptat: DOAR
#   ?? server/services/authz-scope.mjs
#   ?? server/tests/unit/authz-scope.test.mjs
#   (și, după PAS 5)  M package.json
```
Dacă apare ORICE alt fișier modificat, **oprește-te și raportează** — #105a nu atinge nimic altceva.

---

## PAS 5 — Bump versiune (patch, backend-only)

Un singur increment de patch în `package.json`, fără cache/`?v=` (niciun fișier din
`PRECACHE_ASSETS` nu e atins):

- old_str: `  "version": "3.9.725",`
- new_str: `  "version": "3.9.726",`

```bash
grep '"version"' package.json   # Așteptat: "version": "3.9.726",
```

---

## PAS 6 — Commit pe `develop`

```bash
git add server/services/authz-scope.mjs server/tests/unit/authz-scope.test.mjs package.json
git status --short              # confirmă exact 3 intrări, toate intenționate
git commit -m "#105a: contract unic org-scope (authz-scope.mjs) + teste, zero cablare (v3.9.726)"
```

**NU** face push pe `main`. **NU** face merge. Stai pe `develop`.

---

## RAPORT FINAL (completează)

- Fișiere noi: `server/services/authz-scope.mjs`, `server/tests/unit/authz-scope.test.mjs` — da/nu
- `node --check` pe ambele: OK / eroare
- `npm test`: PASSED (număr fișiere/teste) — și confirmă că niciun alt test nu s-a schimbat
- `git status --short` înainte de commit: exact 3 intrări (2 noi + package.json)? da/nu
- Bump: 3.9.725 → 3.9.726 în package.json — da/nu
- Commit pe `develop` (hash): ______
- Orice abatere sau surpriză: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop` EXCLUSIV. Zero checkout/merge/push pe `main`.
- ⛔ ZERO cablare: NU importa/apela `authz-scope.mjs` din nicio rută, guard sau query. Niciun
  call-site existent nu se schimbă. `admin/_helpers.mjs`, `authz-formular.mjs`, `df.mjs`, `ord.mjs`,
  `alop.mjs`, `flow-access.mjs`, `email.mjs`, `report.mjs`, `lifecycle.mjs` — TOATE NEATINSE în #105a.
- ⛔ Testul IMPORTĂ din producție (`../../services/authz-scope.mjs`) — NU redeclară funcțiile.
- ⛔ Fără migrații. Fără cache bump. Fără `?v=`. Fără fișiere în `PRECACHE_ASSETS`.
- ⛔ Dacă `npm test` schimbă rezultatul ORICĂRUI test existent, ceva e cablat din greșeală —
  oprește-te și raportează.
- ⛔ Zona NO-TOUCH (`server/signing/*`) — neatinsă (nici nu are treabă cu #105a).
