# Incident: Production DB init failure (2026-04-19)

## Summary

Post merge PR #17 (develop → main) production `app.docflowai.ro` returned
"Baza de date nu este disponibilă" on login. Root cause: inline migrations
055-062 attempted `ALTER TABLE alop_instances` on a table that didn't exist
on production (ALOP feature was staging-only).

**Total downtime: ~2 hours. Data loss: 0. STS config preserved.**

## Timeline

- **15:02 UTC** — PR #17 merged, Railway auto-deployed production
- **15:05 UTC** — Users report login error "Baza de date nu este disponibilă"
- **15:15 UTC** — Diagnostic started
- **15:22 UTC** — Root cause identified (migration 055 fails on missing table)
- **15:35 UTC** — Hotfix pushed with guards on migrations 055-062
- **15:45 UTC** — PR develop → main merged, production partially functional
- **15:52 UTC** — Schema drift fully diagnosed (18 tables + 36 columns missing on prod)
- **16:30 UTC** — Reconcile script generated (ADD-ONLY, idempotent)
- **16:45 UTC** — Dry-run on staging successful (exit 0, 78 NOTICE skipping)
- **16:55 UTC** — Production reconcile executed successfully
- **17:00 UTC** — Production fully functional, schema matches staging

## Root cause

### Architecture issue

DocFlowAI runs two migration systems:
1. Inline migrations in `server/db/index.mjs` (001-062)
2. File-based V4 migrations in `server/db/migrations/*.sql` (000-014)

Both run at boot, in sequence (inline first, then V4 via `.then()`).

### Specific trigger

Migrations 055, 059, 060, 061, 062 (inline) contain:
```sql
ALTER TABLE alop_instances ADD COLUMN ...
```

Table `alop_instances` is created by V4 migration `014_alop.sql` —
but V4 runs AFTER inline. On production where `alop_instances` never
existed (ALOP not used in prod), inline 055 fails:

```
ERROR: relation "alop_instances" does not exist
```

### Cascade effect

1. Inline 055 fails → single transaction ROLLBACK on all inline migrations
2. `initDbWithRetry` retries 5 times, all fail
3. `markDbReady()` never called → `DB_READY = false` permanent
4. All endpoints return 503 `db_not_ready`
5. Login shows "Baza de date nu este disponibilă"

### Why it wasn't caught earlier

Staging had `alop_instances` from a previous V4 run during ALOP development.
Production only received these migrations via PR #17, triggering the
fresh-DB failure mode for the first time.

## Resolution

### Phase 1: Hotfix

Added `DO $g$ BEGIN IF NOT EXISTS ... RETURN; END IF; ALTER ... END $g$`
guards to migrations 055, 059, 060, 061, 062.

Commit: `hotfix(db): guard inline migrations 055-062`
PR: develop → main, merged same day.

### Phase 2: Schema reconciliation

Identified schema drift: 18 tables and 36 columns present on staging but
missing on production. Generated ADD-ONLY SQL reconcile script from staging
`pg_dump --schema-only` output:

- 18 new tables (CREATE TABLE IF NOT EXISTS)
- 36 columns on existing tables (ALTER TABLE ADD COLUMN IF NOT EXISTS)
- 24 indexes (CREATE INDEX IF NOT EXISTS)
- 61 constraints in DO blocks (EXCEPTION duplicate_object)
- ZERO drops / truncates

Execution flow:
1. `pg_dump` full backup saved locally (796KB)
2. Dry-run on staging: exit 0, 78 NOTICE skipping (idempotent confirmed)
3. State snapshot before: users=44, orgs=1, flows=2, tables=25
4. Script executed on production with `ON_ERROR_STOP=1` inside `BEGIN/COMMIT`
5. State after: users=44, orgs=1, flows=2, tables=43 (+18 ✅)
6. STS config verified intact, admin users intact, `/health` 200

Script: `backups/reconcile-production-20260420-095735.sql`

## Lessons learned

1. **Never trust non-fatal error handling on migrations** — V4 errors were
   silently swallowed for months, masking schema drift between staging and
   production.

2. **Dual migration systems are a smell** — consolidation into a single
   system is future work.

3. **Railway free tier has no automatic DB backup** — manual `pg_dump` to
   local disk is mandatory before any schema-modifying operation.

4. **Staging vs production schema drift can be invisible** — automated diff
   via `pg_dump --schema-only | diff` caught all 18 missing tables instantly.
   This should run in CI post-deploy.

5. **ADD-ONLY scripts with IF NOT EXISTS are idempotent and safe to re-run**
   — confirmed empirically: dry-run on staging (schema already complete)
   was a full no-op, exit 0.

6. **BEGIN/COMMIT + ON_ERROR_STOP=1 = safety net** — any failure triggers
   automatic ROLLBACK, leaving DB untouched.

7. **PKs must come before FKs in reconcile scripts** — when creating new
   tables, PRIMARY KEY constraints must be added before FOREIGN KEY
   constraints that reference them. Learned via two failed production
   attempts before correct ordering.

## Follow-up work

- [ ] Consolidate inline + V4 into single migration system
- [ ] Automated staging vs production schema diff in CI post-deploy
- [ ] Automated `pg_dump` backup before PR develop → main
- [ ] Backfill `flows.status` and `flows.current_step` from JSONB before
      deploying code that reads from dedicated columns
- [ ] Review `flows_pdfs` cascade delete behaviour on new FK tables
