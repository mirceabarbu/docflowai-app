# DocFlowAI v3.3.7 — Changelog (continuare b51)

## Modificări față de b50

### 🆕 Modul Outreach — campanii email către instituții publice

---

#### b51 — 14.03.2026

**`server/routes/admin/outreach.mjs`** *(fișier nou)*
- `GET  /admin/outreach/stats` — statistici globale (trimise azi, total, deschideri, erori, pending)
- `GET  /admin/outreach/track/:trackingId` — pixel GIF 1×1 transparent pentru tracking deschidere (public, fără auth)
- `GET  /admin/outreach/campaigns` — lista campanii cu agregare statistici per campanie
- `POST /admin/outreach/campaigns` — creare campanie (name, subject, html_body)
- `GET  /admin/outreach/campaigns/:id` — detalii campanie + lista completă destinatari
- `DELETE /admin/outreach/campaigns/:id` — ștergere campanie + destinatari (cascade)
- `POST /admin/outreach/campaigns/:id/recipients` — adăugare destinatari: JSON array `[{email, institutie}]` sau CSV bulk `email,institutie`; deduplicare automată
- `DELETE /admin/outreach/campaigns/:id/recipients/:rid` — ștergere destinatar individual
- `POST /admin/outreach/campaigns/:id/send` — trimitere batch (default 50, max 100); rate limit zilnic enforced în DB; PDF prezentare atașat dacă există la `OUTREACH_PDF_PATH`; tracking pixel injectat automat în HTML
- `POST /admin/outreach/campaigns/:id/reset-errors` — resetează destinatarii cu `status=error` înapoi la `pending` (retry)
- Toate endpoint-urile protejate cu `requireAdmin()` (doar `role=admin` global)

**`server/db/index.mjs`**
- Migrare `026_outreach`:
  - Tabel `outreach_campaigns` (id, name, subject, html_body, created_by, created_at)
  - Tabel `outreach_recipients` (id, campaign_id FK cascade, email, institutie, status, tracking_id, sent_at, opened_at, error_msg) cu constraint UNIQUE(campaign_id, email) și CHECK status ∈ (pending/sent/opened/error)
  - Indecși pe campaign_id, status, tracking_id

**`server/index.mjs`**
- Import `outreachRouter` din `./routes/admin/outreach.mjs`
- Mount `app.use('/admin/outreach', outreachRouter)`

**`public/admin.html`**
- Tab nou `📧 Outreach` adăugat în bara de navigare admin
- `switchTab()` extins cu `outreach` + lazy-load la prima deschidere
- UI complet inline (fără pagină separată):
  - Stats bar: trimise azi / total / deschideri
  - Formular creare campanie cu editor HTML + buton template implicit
  - Template implicit DocFlowAI cu `{{institutie}}`, CTA button, semnătură
  - Lista campanii cu progress bars (pending/trimis/deschis/erori)
  - Panou detalii: mini-stats, import CSV, adăugare individuală, tabel destinatari cu badge-uri status, retry, ștergere

**`tools/send-campaign.mjs`** *(fișier nou)*
- CLI Node.js pentru trimitere batch din linia de comandă sau cron
- `--list` — afișează toate campaniile cu statistici
- `--campaign <id> --batch <n>` — trimite N emailuri pending
- `--dry-run` — simulare fără trimitere, afișează lista destinatarilor
- Respects `OUTREACH_DAILY_LIMIT` la fel ca API-ul web
- Exit code 1 dacă există erori de trimitere (compatibil CI/cron alerts)

**`env.example`**
- `OUTREACH_DAILY_LIMIT` — limita zilnică (default 100)
- `OUTREACH_FROM` — adresa From (default `DocFlowAI <contact@docflowai.ro>`)
- `OUTREACH_PDF_PATH` — cale absolută spre PDF prezentare (opțional)

---

### Variabile env de adăugat pe Railway

```
OUTREACH_DAILY_LIMIT=100
OUTREACH_FROM=DocFlowAI <contact@docflowai.ro>
OUTREACH_PDF_PATH=/app/tools/DocFlowAI_Prezentare.pdf
```

### CLI usage

```bash
# Listează campanii
node tools/send-campaign.mjs --list

# Dry run — ce urmează să fie trimis
node tools/send-campaign.mjs --campaign 1 --batch 50 --dry-run

# Trimitere efectivă
node tools/send-campaign.mjs --campaign 1 --batch 50

# Cron zilnic (exemplu crontab)
0 8 * * * cd /app && node tools/send-campaign.mjs --campaign 1 --batch 100 >> /var/log/outreach.log 2>&1
```
