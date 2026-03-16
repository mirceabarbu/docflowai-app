# DocFlowAI v3.3.7 — Changelog (b78)

## Modificări față de b77

### 🟢 Feature — Gestionare Instituții Outreach (CRUD + Import Excel)

#### b78 — 16.03.2026

**Fișier Excel importat:** `date-de-contact-institutii.xlsx`
- 2954 rânduri procesate → 2943 importate
- 9 email-uri duplicate omise automat
- 2 email-uri invalide omise: `bradesti@@cjdolj.ro`, `primtl@tim.ro;eventhi@yahoo.com`

---

**`tools/primarii-romania.json`** — înlocuit cu date din Excel (2943 intrări curate)

**`server/db/index.mjs`** — Migrare 029: tabel `outreach_primarii`
- Coloane: `id, institutie, email (UNIQUE), judet, localitate, activ, created_at, updated_at`
- La primul acces, seed automat din `primarii-romania.json` dacă tabelul e gol

**`server/routes/admin/outreach.mjs`** — 5 endpoint-uri noi:
- `GET  /admin/outreach/primarii` — lista cu filtru județ/căutare, paginare 50/pagină
- `POST /admin/outreach/primarii` — adaugă instituție nouă
- `PUT  /admin/outreach/primarii/:id` — editează instituție
- `DELETE /admin/outreach/primarii/:id` — dezactivează (soft) sau șterge (`?hard=1`)
- `POST /admin/outreach/primarii/import` — import bulk JSON sau CSV

**`public/admin.html`** — UI complet în secțiunea „Instituții":
- Tabel cu coloana Acțiuni: butoane ✏️ Editează și 🗑 Dezactivează per rând
- Buton **➕ Adaugă** — modal cu câmpuri Instituție, Email, Județ, Localitate
- Buton **📥 Import JSON/CSV** — modal cu upload fișier sau paste text, opțiune „Înlocuiește tot"
- Format import JSON: `[{"email", "institutie", "judet", "localitate"}]`
- Format import CSV: `email,institutie,judet,localitate` (prima linie = header, ignorată)

**`package.json`** — version bump `3.3.37` → `3.3.38`
