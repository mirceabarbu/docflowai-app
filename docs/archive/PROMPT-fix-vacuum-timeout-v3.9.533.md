# ⚠️ DEVELOP ONLY — Fix `server_error` la VACUUM + Curăță fluxuri șterse — v3.9.533

⚠️ **BRANCH `develop` EXCLUSIV.** NU face merge / push / checkout pe `main`.
`main` = producție, gestionat manual de Mircea.

⛔ **ZONE INTERZISE — NU ATINGE:**
```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
server/db/index.mjs   ← NU modifica pool-ul / statement_timeout-ul global (rămâne 30s)
```

## Diagnostic (deja confirmat — context)

`statement_timeout: 30000` din pool (`server/db/index.mjs:134`) se aplică
GLOBAL pe orice query. `VACUUM FULL flows_pdfs` (~377 MB) + `flow_attachments`
(~307 MB) depășesc 30s pe prod → Postgres anulează cu
`canceling statement due to statement timeout` → catch-ul întoarce
`{ error: 'server_error', detail: '...' }`. Ambele endpoint-uri
(`/admin/db/vacuum` și `/admin/db/cleanup-orphans`) rulează același bloc VACUUM,
deci pică identic.

**Fix:** VACUUM rulează pe un client dedicat din pool cu `statement_timeout`
extins (15 min) pe sesiunea curentă. Protecția globală de 30s rămâne neatinsă.

═══════════════════════════════════════════════════════════════

## PAS 0 — Stare curată + baseline

```bash
git rev-parse --abbrev-ref HEAD          # develop
git status                               # clean
npm test                                 # verde, fără regresii (baseline)
```

═══════════════════════════════════════════════════════════════

## PAS 1 — Helper `runVacuumFull` în maintenance.mjs

Fișier: `server/routes/admin/maintenance.mjs`. Inserează helper-ul chiar
înaintea rutei `/admin/db/vacuum`.

old_str:
```
router.post('/admin/db/vacuum', csrfMiddleware, async (req, res) => {
```
new_str:
```
// FIX v3.9.533 (server_error la VACUUM/cleanup): statement_timeout-ul global de
// 30s din pool (server/db/index.mjs) anula VACUUM FULL pe tabele mari
// (flows_pdfs ~377MB, flow_attachments ~307MB) → "canceling statement due to
// statement timeout". Rulăm VACUUM pe un client dedicat cu timeout extins
// (15min) pe sesiunea curentă, fără a slăbi protecția globală de 30s.
async function runVacuumFull() {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '15min'");
    await client.query('VACUUM FULL flows_pdfs');
    await client.query('VACUUM FULL flow_attachments');
    await client.query('VACUUM ANALYZE flows');
  } finally {
    client.release();
  }
}

router.post('/admin/db/vacuum', csrfMiddleware, async (req, res) => {
```

═══════════════════════════════════════════════════════════════

## PAS 2 — Înlocuiește blocul VACUUM în handler-ul `/admin/db/vacuum`

old_str:
```
    // VACUUM FULL ia ACCESS EXCLUSIVE LOCK temporar — singurul mod de a returna spațiul la OS.
    // Pe flows_pdfs (~168 MB) și flow_attachments (~253 MB) lock-ul durează ~30s pe prod.
    await pool.query('VACUUM FULL flows_pdfs');
    await pool.query('VACUUM FULL flow_attachments');
    await pool.query('VACUUM ANALYZE flows');
```
new_str:
```
    // VACUUM FULL ia ACCESS EXCLUSIVE LOCK temporar — singurul mod de a returna spațiul la OS.
    // Rulează pe client dedicat cu statement_timeout extins (vezi runVacuumFull).
    await runVacuumFull();
```

═══════════════════════════════════════════════════════════════

## PAS 3 — Înlocuiește blocul VACUUM în handler-ul `/admin/db/cleanup-orphans`

(DELETE-urile + nullify rămân pe `pool.query` — sunt rapide; doar VACUUM se mută.)

old_str:
```
    // VACUUM FULL ia ACCESS EXCLUSIVE LOCK temporar — singurul mod de a returna spațiul la OS.
    await pool.query('VACUUM FULL flows_pdfs');
    await pool.query('VACUUM FULL flow_attachments');
    await pool.query('VACUUM ANALYZE flows');
```
new_str:
```
    // VACUUM FULL ia ACCESS EXCLUSIVE LOCK temporar — singurul mod de a returna spațiul la OS.
    // Rulează pe client dedicat cu statement_timeout extins (vezi runVacuumFull).
    await runVacuumFull();
```

═══════════════════════════════════════════════════════════════

## PAS 4 — Actualizează testul (mutarea VACUUM pe client.connect)

Fișier: `server/tests/integration/maintenance-cleanup.test.mjs`

### 4a. Mock pentru `pool.connect` în `beforeEach`

old_str:
```
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  dbModule.getFlowData.mockResolvedValue({ signers: [] }); // flux există → trece de guard
```
new_str:
```
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  // VACUUM FULL rulează pe client dedicat (runVacuumFull) — vezi fix v3.9.533.
  dbModule.pool.connect.mockResolvedValue({
    query: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
  });
  dbModule.getFlowData.mockResolvedValue({ signers: [] }); // flux există → trece de guard
```

### 4b. Scoate cele 3 VACUUM din secvența `mockCleanupSequence` (acum pe client)

old_str:
```
  // Ordinea query-urilor în handler:
  //   1 beforeR, 2 delPdfs, 3 delAtts, 4 nullifyArchived, 5-7 VACUUM, 8 afterR
  function mockCleanupSequence({ archivedWithData = 1, nullifiedRows = 1 } = {}) {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{                      // 1 beforeR
        db_bytes: 1_000_000, pdfs_bytes: 500_000, att_bytes: 300_000,
        orphan_pdfs: 0, orphan_atts: 0, archived_atts_with_data: archivedWithData,
      }] })
      .mockResolvedValueOnce({ rowCount: 0 })                // 2 delPdfs
      .mockResolvedValueOnce({ rowCount: 0 })                // 3 delAtts
      .mockResolvedValueOnce({ rowCount: nullifiedRows })    // 4 nullifyArchived
      .mockResolvedValueOnce({})                             // 5 VACUUM FULL flows_pdfs
      .mockResolvedValueOnce({})                             // 6 VACUUM FULL flow_attachments
      .mockResolvedValueOnce({})                             // 7 VACUUM ANALYZE flows
      .mockResolvedValueOnce({ rows: [{                      // 8 afterR
        db_bytes: 700_000, pdfs_bytes: 400_000, att_bytes: 100_000,
      }] });
  }
```
new_str:
```
  // Ordinea query-urilor pe pool.query (VACUUM rulează separat pe client dedicat):
  //   1 beforeR, 2 delPdfs, 3 delAtts, 4 nullifyArchived, 5 afterR
  function mockCleanupSequence({ archivedWithData = 1, nullifiedRows = 1 } = {}) {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{                      // 1 beforeR
        db_bytes: 1_000_000, pdfs_bytes: 500_000, att_bytes: 300_000,
        orphan_pdfs: 0, orphan_atts: 0, archived_atts_with_data: archivedWithData,
      }] })
      .mockResolvedValueOnce({ rowCount: 0 })                // 2 delPdfs
      .mockResolvedValueOnce({ rowCount: 0 })                // 3 delAtts
      .mockResolvedValueOnce({ rowCount: nullifiedRows })    // 4 nullifyArchived
      .mockResolvedValueOnce({ rows: [{                      // 5 afterR
        db_bytes: 700_000, pdfs_bytes: 400_000, att_bytes: 100_000,
      }] });
  }
```

### 4c. Adaugă un test de regresie pe EXACT acest bug

Inserează acest `it(...)` în interiorul lui
`describe('POST /admin/db/cleanup-orphans ...')`, imediat după funcția
`mockCleanupSequence` (înainte de primul `it`):

```
  it('VACUUM rulează pe client dedicat cu statement_timeout extins (fix v3.9.533)', async () => {
    mockCleanupSequence({ archivedWithData: 0, nullifiedRows: 0 });
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    dbModule.pool.connect.mockResolvedValue(client);

    const res = await request(makeApp())
      .post('/admin/db/cleanup-orphans')
      .set('Cookie', adminCookie(makeAdminToken()))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(200);
    expect(dbModule.pool.connect).toHaveBeenCalled();

    const clientSql = client.query.mock.calls.map(c => String(c[0]));
    // a dezactivat (extins) timeout-ul pe sesiune
    expect(clientSql.some(s => /SET\s+statement_timeout/i.test(s))).toBe(true);
    // a rulat VACUUM FULL pe client, nu pe pool.query (care are timeout 30s)
    expect(clientSql.some(s => /VACUUM\s+FULL\s+flows_pdfs/i.test(s))).toBe(true);
    expect(clientSql.some(s => /VACUUM\s+FULL\s+flow_attachments/i.test(s))).toBe(true);
    // clientul a fost eliberat
    expect(client.release).toHaveBeenCalled();
    // VACUUM NU s-a mai emis pe pool.query
    const pooledVacuum = dbModule.pool.query.mock.calls
      .map(c => String(c[0]))
      .some(s => /VACUUM\s+FULL/i.test(s));
    expect(pooledVacuum).toBe(false);
  });
```

═══════════════════════════════════════════════════════════════

## PAS 5 — Verificare

```bash
npm run check        # node --check trece
npm test             # verde, fără regresii + noul test trece
git diff --stat HEAD # doar maintenance.mjs + testul + package.json
```

Dacă pică ceva → `git restore .` și raportează. NU relaxa testul.

═══════════════════════════════════════════════════════════════

## PAS 6 — Bump versiune (backend-only: doar package.json)

Fără schimbări în `public/` → `sw.js CACHE_VERSION` și `?v=` rămân NEATINSE.

old_str:
```
  "version": "3.9.532",
```
new_str:
```
  "version": "3.9.533",
```

═══════════════════════════════════════════════════════════════

## PAS 7 — Commit + push (DOAR develop)

```bash
git add -A
git commit -m "fix(maintenance): VACUUM FULL pe client dedicat cu statement_timeout extins v3.9.533

statement_timeout global de 30s din pool anula VACUUM FULL pe flows_pdfs
(~377MB) + flow_attachments (~307MB) → server_error pe /admin/db/vacuum
și /admin/db/cleanup-orphans. Rulează VACUUM pe client din pool.connect()
cu SET statement_timeout='15min' pe sesiune; protecția globală de 30s
rămâne neatinsă. +1 test regresie."
git push origin develop
```

═══════════════════════════════════════════════════════════════

## ⛔ PROHIBIT

- ⛔ NU modifica `server/db/index.mjs` (statement_timeout global RĂMÂNE 30s).
- ⛔ NU atinge fișierele din ZONE INTERZISE.
- ⛔ NU muta DELETE-urile/nullify pe client (sunt rapide; doar VACUUM se mută).
- ⛔ NU merge / push / checkout pe `main`.

═══════════════════════════════════════════════════════════════

## RAPORT FINAL

1. Fișiere modificate (path + linii +/-).
2. `npm run check`: PASS/FAIL.
3. `npm test`: X teste, verde, fără regresii (noul test inclus).
4. Hash commit + confirmare push pe `develop`.
5. Versiune publicată (3.9.533).

═══════════════════════════════════════════════════════════════

## Verificare manuală pe staging (după redeploy)

1. Admin → Administrare fluxuri → Eliberare spațiu DB.
2. **Rulează VACUUM** → așteaptă (poate dura 30-90s pe staging dacă are date) →
   trebuie să întoarcă „VACUUM ... executat" cu spațiu eliberat, NU `server_error`.
3. **Curăță fluxuri șterse** → la fel, fără `server_error`.
4. Dacă vezi `server_error` ACUM, deschide Railway logs și caută `vacuum error`
   / `cleanup-orphans error` — `detail`-ul logat arată cauza reală (ex. dacă
   ar fi disk full: `could not extend file ... No space left on device` — alt
   bug, raportezi).

NOTĂ (opțional, separat): UI-ul afișează doar `error` (`server_error`), nu
`detail`. Dacă vrei să vezi motivul direct în UI la viitoare erori, e o
schimbare de o linie în `public/js/admin/archive.js` (append `j.detail`) —
dar atinge frontend → necesită bump `sw.js` + `?v=`. O facem separat dacă vrei.
