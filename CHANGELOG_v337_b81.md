# DocFlowAI v3.3.7 — Changelog (b81)

## Modificări față de b80

### 🟢 FEAT-N01 — Webhook generic per organizație

**Fișiere noi:** `server/webhook.mjs`
**Fișiere modificate:** `server/index.mjs`, `server/routes/flows.mjs`, `server/routes/admin.mjs`, `server/db/index.mjs`

Integrare cu orice sistem extern care acceptă HTTP POST:
AvanDoc, iDocNet, aplicații proprii de registratură, Zapier, n8n, Make.com etc.

**Migrare 032** — coloane noi în `organizations`:
- `webhook_url TEXT` — URL destinatar
- `webhook_secret TEXT` — secret HMAC-SHA256 (opțional, recomandat)
- `webhook_events TEXT[]` — evenimente abonate (default: `{flow.completed}`)
- `webhook_enabled BOOLEAN` — activare/dezactivare

**Payload JSON standardizat:**
```json
{
  "event": "flow.completed",
  "flowId": "PZ_...",
  "docName": "...",
  "institutie": "...",
  "signers": [...],
  "downloadUrl": "https://app.docflowai.ro/flows/.../signed-pdf",
  "sentAt": "2026-03-17T..."
}
```

**Securitate:** Header `X-DocFlowAI-Signature: sha256=HMAC(secret, body)`
pentru verificarea autenticității pe sistemul receptor.

**Evenimente suportate:** `flow.completed`, `flow.refused`, `flow.cancelled`

**Livrare:** fire-and-forget async (`setImmediate`) — nu blochează response-ul HTTP.
Un singur retry după 5 secunde. Timeout 10s per tentativă.

**Endpoint-uri noi:**
- `PUT /admin/organizations/:id` — configurare webhook + actualizare org
- `POST /admin/organizations/:id/test-webhook` — livrare eveniment de test
- `GET /admin/organizations` — extins cu statistici (user_count, flow_count) și config webhook

---

### 🟢 FEAT-N02 — Tab Organizații în Admin Panel

**Fișier:** `public/admin.html`

Tab nou **🏛 Organizații** (vizibil doar super-admin) cu:
- Lista tuturor organizațiilor cu statistici (utilizatori, fluxuri)
- Status webhook per organizație (activ/dezactivat, URL, evenimente, HMAC)
- Modal configurare webhook cu:
  - URL endpoint
  - Secret HMAC cu generare automată (32 bytes hex)
  - Selectare evenimente individuale
  - Buton **🧪 Test Webhook** — trimite eveniment de test și afișează răspunsul HTTP

**package.json** — version bump `3.3.49` → `3.3.50`
