# DocFlowAI v3.4.0 — Changelog

## Refactorizări arhitecturale

### REFACTOR-01 — `stampFooterOnPdf` extras în modul dedicat
- **Fișier nou**: `server/pdf/stamp.mjs`
- Funcția primește `PDFLib` ca parametru injectat (testabilă independent)
- Transliterare diacritice documentată explicit
- `index.mjs` păstrează un wrapper local cu 3 linii — backward compat 100%

### REFACTOR-02 — `notify()` extras în modul dedicat
- **Fișier nou**: `server/notifications/notify.mjs`
- Toate dependențele injectate via `injectNotifyDeps()`: pool, wsPush, pushToUser,
  sendSignerEmail, sendWaSignRequest/Completed/Refused, saveFlow, getFlowData, escHtml
- Template-urile email (`YOUR_TURN` și generic) separate în funcții proprii
- `index.mjs` redus cu ~130 linii

### SEC-02 — Signer token din URL → X-Signer-Token header
- **`public/semdoc-signer.html`**: `_apiFetch` shim extrage automat `?token=` din URL
  și îl trimite ca header `X-Signer-Token` — zero modificări în apelurile existente
- Download-uri (PDF final, attachments) convertite din `<a href>` la `fetch` + blob
  prin noua funcție `downloadWithToken(url, filename)`
- **Backend**: `req.query.token` păstrat ca fallback pentru linkuri deja trimise prin
  email (valabilitate ~90 zile); eliminat complet în v3.5.0

## Livrat în sesiunile anterioare (v3.3.8)

- Versiune dinamică din `package.json`
- `express.json` limite per-rută (global 50kb, PDF 52mb)
- Validare `body.meta` + `flowType` whitelist
- Templates API extras în `routes/templates.mjs`
- `generatePassword()` entropie ~71 bits (OWASP 2025)
- Rate limiter PostgreSQL-backed (`026_api_rate_limits`)
- CSP nonce per-request (`middleware/cspNonce.mjs`)
- Webhook FLOW_COMPLETED cu retry backoff (`server/webhook.mjs`, `027_org_webhook`)
- 25 teste noi unit (flows + templates + auth-crypto)

## Structura modulară finală

```
server/
  index.mjs                     ← orchestrator (curățat: -230 linii față de v3.3.7)
  webhook.mjs                   ← FEAT-01: dispatcher webhook + retry
  pdf/
    stamp.mjs                   ← REFACTOR-01: footer PDF (NOU)
  notifications/
    notify.mjs                  ← REFACTOR-02: dispatcher notificări (NOU)
  routes/
    auth.mjs
    flows.mjs
    admin.mjs                   ← +4 endpoint-uri webhook config
    notifications.mjs
    templates.mjs               ← extras din index.mjs
  middleware/
    auth.mjs                    ← generatePassword() îmbunătățit
    rateLimiter.mjs             ← rescris PostgreSQL-backed
    cspNonce.mjs                ← NOU: CSP nonce per-request
    logger.mjs
    metrics.mjs
  db/
    index.mjs                   ← migrări 026 (rate_limits) + 027 (org_webhook)
  tests/
    unit/
      auth-crypto.test.mjs
      flows-create.test.mjs     ← NOU (13 teste)
      metrics.test.mjs
      templates.test.mjs        ← NOU (12 teste)
    integration/
      login.test.mjs
```

## Rămase pentru v3.5.0
- Eliminare completă `req.query.token` din backend (după 90 zile)
- Teste pentru semnare / refuz / delegare / admin (coverage < 5%)
- `npm audit` + CI pipeline
