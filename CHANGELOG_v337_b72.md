# DocFlowAI v3.3.7 — Changelog (b72)

## Modificări față de b71

### 🟢 Calitate — OpenAPI 3.0 / Swagger UI

#### b72 — 15.03.2026

**Fișiere noi/modificate:**
- `server/swagger.mjs` *(nou)* — spec OpenAPI 3.0 complet (40+ endpoint-uri)
- `server/index.mjs` — 2 endpoint-uri noi + import swagger

**Endpoint-uri noi (publice, fără autentificare):**
- `GET /api-docs` — Swagger UI interactiv (browser), powered by SwaggerUI CDN v5
- `GET /api-docs.json` — spec JSON brut (Postman, Insomnia, integrări externe)

**Caracteristici spec:**
- Toate cele 40+ endpoint-uri documentate cu parametri, request body, response schemas
- 3 scheme de autentificare: cookieAuth, bearerAuth, signerToken, adminSecret
- Tag-uri organizate: Auth, Fluxuri, Semnare, Atașamente, Notificări, Template-uri, Admin, Sistem
- Scheme reutilizabile: FlowSummary, Signer, User, Error
- Zero dependențe npm noi — SwaggerUI servit din CDN (unpkg.com)

**`package.json`** — version bump `3.3.31` → `3.3.32`

**Notă:** Spec-ul este menținut manual în `server/swagger.mjs`.
La adăugarea de endpoint-uri noi, actualizați și spec-ul.
