# PROMPT Claude Code — Hardening anti-hang (v3.9.485)

> ⚠️ BRANCH: `develop` EXCLUSIV.
> Nu propune merge / push / checkout pe `main` — main = producție, gestionat manual prin skill-ul `docflowai-deploy`.
> Toate operațiile (`git add/commit/push`) doar pe `develop`.

## Context

Producția (`app.docflowai.ro`) a hang-uit silent în noaptea de 2026-05-20:
- Postgres log @ 00:30 UTC: `could not receive data from client: Connection timed out`
- Railway metrics @ 02:00 UTC: 0 CPU, 0 MEM (process zombie)
- 502 dial timeout pe toate request-urile până la restart manual @ 05:35 UTC

**Cauza identificată în cod**: `server/index.mjs:663-664` are handler-e
`unhandledRejection` / `uncaughtException` care **doar loghează**. Un
unhandled rejection (ex. query Postgres care nu se mai întoarce, fetch
fără timeout către Java signing service) → procesul rămâne UP, ține
conexiuni deschise, dar nu mai servește request-uri. Railway nu
restartează pentru că procesul există tehnic.

## Obiectiv

Un singur commit pe `develop` care:
1. Convertește handler-ele de proces din „log-only" în „log + exit(1)".
2. Adaugă timeout-uri pe pool-ul Postgres (connection + statement).
3. Bump versiune pentru tracking în log-uri post-deploy.

Procesul mort e restartat automat de Railway (restart policy default).
Procesul hang nu — de aici fix-ul.

## ⛔ ZONE NO-TOUCH (absolute)

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
```

Plus: `server/db/migrate.mjs`, orice migrare existentă, orice fișier din
`server/routes/` care nu e listat explicit mai jos.

## Modificări (3 fișiere)

### 1. `server/index.mjs` — process handlers cu exit

Verifică întâi că textul exact există:
```bash
grep -n "unhandledRejection\|uncaughtException" server/index.mjs
# Așteptat: două linii la 663 și 664 cu logger.error
```

Înlocuiește **exact**:

**old_str:**
```javascript
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException',  (err) => logger.error({ err }, 'uncaughtException'));
```

**new_str:**
```javascript
// HANG-FIX (incident 2026-05-20): log + exit(1) ca Railway să restarteze procesul.
// Hang-ul era cauzat de unhandled rejections care doar logau, lăsând procesul UP
// dar inert — Railway nu restartează un proces care „există".
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandledRejection — exiting');
  // setTimeout 0 ca să apuce să se flush-eze log-ul Pino înainte de exit
  setTimeout(() => process.exit(1), 100);
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException — exiting');
  setTimeout(() => process.exit(1), 100);
});
```

### 2. `server/db/index.mjs` — pool timeouts

Verifică linia curentă:
```bash
grep -n "new Pool" server/db/index.mjs
# Așteptat: linia 124, single-line cu max: 20, idleTimeoutMillis: 30000
```

Înlocuiește **exact**:

**old_str:**
```javascript
export const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 20, idleTimeoutMillis: 30000 })
  : null;
```

**new_str:**
```javascript
// HANG-FIX (incident 2026-05-20): timeouts ca un query stuck să nu țină
// procesul ostatec. statement_timeout=30s ucide query-urile care depășesc;
// connectionTimeoutMillis=5s ca pool-ul să nu blocheze indefinit pe achiziție.
export const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    })
  : null;
```

### 3. `package.json` — bump versiune

```bash
# Verifică versiunea curentă
grep '"version"' package.json
# Așteptat: "version": "3.9.484"
```

**old_str:**
```json
  "version": "3.9.484",
```

**new_str:**
```json
  "version": "3.9.485",
```

> Nu bump-a `CACHE_VERSION` în `public/sw.js` — schimbarea e exclusiv
> backend, nu afectează asset-urile cache-uite.

## Verificări obligatorii înainte de commit

```bash
# 1. Niciun fișier NO-TOUCH atins
git status
git diff --name-only
# Așteptat exact: server/index.mjs, server/db/index.mjs, package.json
# DACĂ apare oricare din STSCloudProvider/cloud-signing/bulk-signing/pades/java-pades-client → STOP

# 2. Sintaxa OK
npm run check

# 3. Linia nouă în index.mjs există
grep -n "HANG-FIX" server/index.mjs server/db/index.mjs
# Așteptat: 2 hituri (unul în index.mjs, unul în db/index.mjs)

# 4. process.exit(1) prezent
grep -n "process.exit(1)" server/index.mjs
# Așteptat: 2 hituri (unul în unhandledRejection, unul în uncaughtException)

# 5. Pool config nou
grep -A 7 "new Pool" server/db/index.mjs
# Așteptat: să vezi connectionTimeoutMillis: 5000 și statement_timeout: 30000

# 6. Teste
npm test
# Așteptat: npm test verde, fără regresii. Niciun test șters/dezactivat.
```

Dacă oricare verificare pică → STOP, nu commit-a, raportează-mi simptomul.

## Commit + push pe develop

```bash
git add server/index.mjs server/db/index.mjs package.json
git commit -m "fix(stability): crash-on-error + DB timeouts (v3.9.485)

Incident 2026-05-20: producție hang-uită silent (0 CPU, 0 MEM, 502 dial
timeout) între ~00:30 UTC și 05:35 UTC restart manual.

- server/index.mjs: unhandled rejection / uncaught exception fac exit(1)
  după log, ca Railway să restarteze procesul (era log-only)
- server/db/index.mjs: connectionTimeoutMillis=5s, statement_timeout=30s
  pe pool-ul Postgres, ca un query stuck să nu țină procesul ostatec
- bump v3.9.484 → v3.9.485 pentru tracking în log-uri post-deploy

Refs: incident 2026-05-20 (Postgres 'could not receive data from client:
Connection timed out' @ 00:30 UTC)"

git push origin develop
```

## RAPORT FINAL (formatul așteptat)

```
COMMIT: <SHA scurt> pe develop
Fișiere modificate: 3 (server/index.mjs, server/db/index.mjs, package.json)
Linii: +<X> -<Y>
Verificări:
  - git diff --name-only: doar cele 3 fișiere ✅
  - npm run check: pass ✅
  - npm test: pass (Z/Z) ✅
  - grep HANG-FIX: 2 hituri ✅
  - grep process.exit(1): 2 hituri ✅
  - grep connectionTimeoutMillis: 1 hit ✅
NO-TOUCH respectat: ✅ (signing-ul + migrările + main neatinse)
Push: develop @ <SHA scurt>
Staging: redeploy automat declanșat
```

## Pași MANUALI după push (Mircea — NU Claude Code)

Aceste lucruri nu se fac din cod, ci din Railway dashboard:

1. **Healthcheck pe service `docflowai-app`** (Settings → Healthcheck):
   - Path: `/health`
   - Interval: 30s
   - Timeout: 10s
   - Failure threshold: 3 (= după 90s fără răspuns, restart automat)
   - Aplicat pentru ambele environments: `production` și `staging`.

2. **Restart policy** (Settings → Restart Policy):
   - Confirmă că e setat `ON_FAILURE` (sau `ALWAYS`), nu `NEVER`.

3. **Verificare staging după redeploy** (~2-3 min):
   ```bash
   curl -s https://docflowai-app-staging.up.railway.app/health | grep -oE '"version":"[^"]+"'
   # Așteptat: "version":"3.9.485"
   ```

4. **Monitorizare 24h staging** — dacă staging stă în picioare fără
   restart neașteptat până mâine seară, fix-ul e validat. Atunci poți
   declanșa skill-ul `docflowai-deploy` pentru merge → main.

## Ce NU rezolvă acest commit

- Nu identifică **cauza** unhandled rejection-ului care a stricat noaptea
  trecută. Dacă era un cron, se va repeta — dar de data asta procesul
  va muri+restarta în <1 min în loc să rămână zombie 5 ore, ȘI vei avea
  stack trace în log-uri (`logger.error` cu obiectul `err` complet).
- Nu adaugă timeout pe fetch-urile către Java signing service. Dacă ăla
  era vinovat, raportează-mi după ce vezi stack trace-ul și fac patch
  țintit (cu `AbortSignal.timeout(...)` pe fetch-urile relevante).
