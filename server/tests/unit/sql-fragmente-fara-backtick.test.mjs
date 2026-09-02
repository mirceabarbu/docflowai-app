// server/tests/unit/sql-fragmente-fara-backtick.test.mjs — poarta anti-backtick (#169)
//
// De ce: un backtick dintr-un fragment SQL exportat se interpolează într-un template
// literal la consumator și rupe parsarea. S-a întâmplat de patru ori (#134, #144, #157,
// #166), prins abia de `node --check`, DUPĂ ce promptul fusese deja scris și rulat.
// Testul ăsta îl prinde la scriere.
//
// Structură:
//  1. INVOCATIONS — o listă explicită { module, export, args } pentru fiecare funcție
//     SINCRONĂ care întoarce SQL, din modulele din `server/services/*.mjs` care conțin
//     „Sql" (vezi A0.2 din PROMPT-169). Rulăm fiecare invocare și asertăm: rezultat
//     string, fără backtick, fără `${` neevaluat.
//  2. EXCLUSIONS — orice export de tip funcție care NU e o funcție SQL sincronă
//     (predicate boolean, funcții async care au nevoie de `pool` DB real). Fiecare
//     exclusion are un motiv explicit.
//  3. Meta-testul (⭐) — parcurge fiecare modul din MODULES, enumeră exporturile lui, și
//     pentru orice export de tip funcție care nu e nici în INVOCATIONS nici în
//     EXCLUSIONS, CADE cu mesaj care spune ce export lipsește. Fără asta poarta
//     protejează doar ce exista în ziua scrierii.
//
// ⚠️ formular-shared.mjs a fost găsit la A0.2 (conține „Sql") dar e EXCLUS ÎN ÎNTREGIME
// din listă (nu doar exporturile individuale): importă `pool` din `server/db/index.mjs`,
// care citește `process.env.DATABASE_URL` la import și instanțiază `new Pool(...)` —
// import impur pentru un test unitar pur. Raportat în raportul final al lotului #169,
// nu „aranjat" — instrucțiunea explicită a promptului.

import { describe, it, expect } from 'vitest';

const MODULES = [
  'alop-dosar-sql.mjs',
  'alop-link.mjs',
  'authz-scope.mjs',
  'df-aprobat-sql.mjs',
  'flow-link-audit.mjs',
  'flow-provenance.mjs',
];

const modPath = (m) => `../../services/${m}`;

// ── 1. Invocări explicite ale funcțiilor SQL sincrone ──────────────────────────
const INVOCATIONS = [
  { module: 'alop-dosar-sql.mjs', export: 'sqlFdInDosar', args: ['fd', 'a'] },
  { module: 'alop-dosar-sql.mjs', export: 'sqlDosarAreFluxActiv', args: ['a'] },
  { module: 'alop-dosar-sql.mjs', export: 'sqlDosarAreAprobat', args: ['a'] },
  { module: 'alop-dosar-sql.mjs', export: 'sqlRevizieInLucruId', args: ['a'] },
  { module: 'alop-dosar-sql.mjs', export: 'sqlRevizieInLucruNr', args: ['a'] },
  { module: 'alop-dosar-sql.mjs', export: 'sqlRevizieInVigoareId', args: ['a'] },
  { module: 'alop-dosar-sql.mjs', export: 'sqlRevizieInVigoareNr', args: ['a'] },

  { module: 'authz-scope.mjs', export: 'orgScopeSql', args: [{ role: 'user', orgId: 7 }, 'a', []] },

  { module: 'df-aprobat-sql.mjs', export: 'docAprobatSql', args: ['fd', 'f'] },
  { module: 'df-aprobat-sql.mjs', export: 'dfAprobatSql', args: ['fd', 'f'] },
  { module: 'df-aprobat-sql.mjs', export: 'dfAprobatExistsSql', args: ['fx.flow_id', 'fx'] },

  { module: 'flow-provenance.mjs', export: 'validSignedFlowSql', args: ['f'] },
  { module: 'flow-provenance.mjs', export: 'liveFlowSql', args: ['f'] },
];

// ── 2. Excluderi explicite, CU motiv ─────────────────────────────────────────
const EXCLUSIONS = [
  // alop-link.mjs — toate patru sunt operații async care primesc `pool` (client DB
  // real) ca prim argument și execută query-uri; nu întorc fragmente SQL sincrone.
  { module: 'alop-link.mjs', export: 'selfHealAlopDfLink', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },
  { module: 'alop-link.mjs', export: 'finalizeDfOnFlowCompleted', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },
  { module: 'alop-link.mjs', export: 'selfHealAlopDfLinkByAlop', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },
  { module: 'alop-link.mjs', export: 'backfillAlopFlowPointers', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },

  // authz-scope.mjs — predicate boolean pe obiect deja încărcat, nu SQL.
  { module: 'authz-scope.mjs', export: 'isPlatformAdmin', reason: 'predicat boolean pe actor, nu SQL' },
  { module: 'authz-scope.mjs', export: 'isAdminOrOrgAdmin', reason: 'predicat boolean pe actor, nu SQL' },
  { module: 'authz-scope.mjs', export: 'actorCanAccessOrg', reason: 'poartă pe obiect deja încărcat, nu SQL (vezi docblock-ul funcției)' },

  // flow-link-audit.mjs — necesită pool DB real.
  { module: 'flow-link-audit.mjs', export: 'findFlowLinkDivergences', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },

  // flow-provenance.mjs — necesită pool DB real.
  { module: 'flow-provenance.mjs', export: 'checkFlowLinkable', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },
  { module: 'flow-provenance.mjs', export: 'checkFlowSigned', reason: 'async, necesită pool DB real — execută query-uri, nu întoarce SQL' },
];

describe('poarta anti-backtick pe fragmentele SQL exportate', () => {
  for (const { module, export: exportName, args } of INVOCATIONS) {
    it(`${module} → ${exportName}(${args.map((a) => JSON.stringify(a)).join(', ')}) nu conține backtick`, async () => {
      const mod = await import(modPath(module));
      const fn = mod[exportName];
      expect(typeof fn).toBe('function');
      const result = fn(...args);
      expect(typeof result).toBe('string');
      expect(result).not.toContain('`');
      // semn de interpolare ratată — un ${ care a supraviețuit neevaluat
      expect(result).not.toMatch(/\$\{/);
    });
  }

  // ── 3. Meta-test ⭐ — lista nu rămâne în urmă ──────────────────────────────
  it('fiecare export de tip funcție din MODULES e ori invocat, ori exclus cu motiv', async () => {
    const lipsa = [];
    for (const module of MODULES) {
      const mod = await import(modPath(module));
      for (const [exportName, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        const invocata = INVOCATIONS.some((i) => i.module === module && i.export === exportName);
        const exclusa = EXCLUSIONS.some((e) => e.module === module && e.export === exportName && e.reason);
        if (!invocata && !exclusa) lipsa.push(`${module} → ${exportName}`);
      }
    }
    expect(lipsa, `Exporturi neacoperite (nici invocate, nici excluse cu motiv): ${lipsa.join(', ')}`).toEqual([]);
  });

  // Dovadă că meta-testul chiar cade pe un export fals, neacoperit — dovedește că
  // poarta se închide, nu doar că pare să se închidă.
  it('meta-testul detectează un export fals neacoperit (auto-verificare a portii)', async () => {
    const modulFals = { moduleFake: { exportFals: () => 'x' } };
    const lipsaSimulata = [];
    for (const [module, mod] of Object.entries(modulFals)) {
      for (const [exportName, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        const invocata = INVOCATIONS.some((i) => i.module === module && i.export === exportName);
        const exclusa = EXCLUSIONS.some((e) => e.module === module && e.export === exportName && e.reason);
        if (!invocata && !exclusa) lipsaSimulata.push(`${module} → ${exportName}`);
      }
    }
    expect(lipsaSimulata).toEqual(['moduleFake → exportFals']);
  });
});
