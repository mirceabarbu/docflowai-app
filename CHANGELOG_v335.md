# DocFlowAI v3.3.5 — Changelog

## Modificări față de v3.3.4

### 🟢 Metrics operaționale (METRICS-01)

**`server/middleware/metrics.mjs`** — Colector lightweight Prometheus format
- Zero dependențe externe — contoare in-memory expuse ca text Prometheus
- API: `incCounter(name, labels?)`, `setGauge(name, value, labels?)`, `renderMetrics()`, `resetMetrics()`
- Prometheus exposition format standard — compatibil Railway Metrics, Grafana Cloud, Datadog

**`GET /metrics`** endpoint nou în `server/index.mjs`
- Implicit: **admin-only** (JWT rol admin sau ADMIN_SECRET)
- Opțional public: `METRICS_PUBLIC=1` în ENV pentru scrape Prometheus extern
- Include automat: `process_heap_used_bytes`, `process_rss_bytes`, `process_uptime_seconds`
- Custom: `http_requests_total{method, status_class}` — contor per method + 2xx/4xx/5xx
- Custom: `ws_clients` gauge — număr conexiuni WebSocket active la momentul scrape

**Utilizare pentru monitoring:**
```
# Railway Metrics → adăugați URL /metrics ca target Prometheus scrape
# Grafana Cloud → configurați data source Prometheus cu URL-ul aplicației
```

### 🧪 Infrastructură teste automate (TEST-01)

**`vitest.config.mjs`** — Configurație Vitest
- `environment: node`, `setupFiles`, pattern `server/tests/**/*.test.mjs`
- Timeout 15s (PBKDF2 100k iterații durează ~200ms/test)
- Coverage opțional via `npm run test:coverage`

**`server/tests/setup.mjs`** — Setup global
- Setează `JWT_SECRET`, `LOG_LEVEL=error`, `NODE_ENV=test` înainte de orice import

**`server/tests/unit/auth-crypto.test.mjs`** — 11 teste pure (zero mocking)
- `hashPassword`: format v2, unicitate salt, lungime, diacritice/caractere speciale
- `verifyPassword`: hash v2, hash v1 legacy + needsRehash, parolă greșită, edge cases null
- Round-trip consistency pe 5 parole diverse

**`server/tests/unit/metrics.test.mjs`** — 9 teste pure
- `incCounter`: incrementare, labels multiple, contoare independente
- `setGauge`: setare, suprascrierea valorii, labels
- `renderMetrics`: format Prometheus valid, headers `# TYPE`, process metrics
- `resetMetrics`: stare curată post-reset

**`server/tests/integration/login.test.mjs`** — 10 teste cu DB mock
- Pool PostgreSQL mock-uit via `vi.mock` — fără bază de date reală
- `POST /auth/login`: 400 câmpuri lipsă, 400 parolă prea lungă, 429 rate limited
- `POST /auth/login`: 401 user inexistent, 401 parolă greșită
- `POST /auth/login`: 200 login reușit, cookie JWT HttpOnly, force_password_change
- `POST /auth/login`: 200 hash v1 legacy → lazy re-hash UPDATE declanșat
- `POST /auth/login`: email case-insensitive → normalizat lowercase în query

**`package.json`** — devDependencies adăugate
- `vitest@^2.1.0`
- `supertest@^7.0.0`
- `@vitest/coverage-v8@^2.1.0`

**Scripts noi:**
```bash
npm test              # rulează toate testele o dată
npm run test:watch    # watch mode pentru development
npm run test:coverage # raport coverage HTML + JSON
```

## Fișiere modificate
- `server/middleware/metrics.mjs` ← **fișier nou**
- `server/index.mjs` ← import metrics + incCounter în request middleware + GET /metrics
- `vitest.config.mjs` ← **fișier nou**
- `server/tests/setup.mjs` ← **fișier nou**
- `server/tests/unit/auth-crypto.test.mjs` ← **fișier nou**
- `server/tests/unit/metrics.test.mjs` ← **fișier nou**
- `server/tests/integration/login.test.mjs` ← **fișier nou**
- `package.json` ← version 3.3.5 + devDependencies + test scripts

## Ce nu s-a modificat
- Nicio schimbare la logica existentă de business
- Nicio schimbare la schema DB (fără migrații noi)
- Nicio schimbare la frontend
- Toate rutele existente funcționează identic

## Pași după deploy
```bash
# Local (development):
npm install          # instalează vitest + supertest
npm test             # rulează cele 30 de teste

# Railway: rebuild automat — devDependencies instalate automat în CI
# Testele rulează în CI înainte de deploy dacă adăugați npm test în build command
```

## Note arhitecturale
- Metricele sunt in-memory — se resetează la restart (comportament corect pentru Railway ephemeral)
- Contorul `http_requests_total` nu include label `url` (evită cardinality explosion cu flow IDs)
- Testele de integrare mock-uiesc DOAR pool-ul DB și logger-ul — tot restul (JWT, rate limiter injectat, Express routing) funcționează real
