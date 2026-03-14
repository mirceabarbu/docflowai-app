# DocFlowAI v3.3.7 — Changelog

## Modificări față de v3.3.6 (b49)

### 🐛 Bug fixes

---

#### b50 — 14.03.2026

**`public/admin.html`**
- Raport PDF fluxuri (Admin → Administrare fluxuri → 📄 PDF): eliminat `window.print()` automat la deschiderea tab-ului nou — utilizatorul decide singur dacă salvează, printează etc.

**`public/semdoc-signer.html`**
- Tabel ancore: eliminat gap-ul de 10pt dintre header-ul "SEMNAT SI APROBAT" și tabelul cu casuțele de semnătură (`cartusH = rows * cellH + titleH`, fără `+ 10`)
- Tabel ancore: fontul header-ului "SEMNAT SI APROBAT" redus de la `size: 9` la `size: 7` — aliniat cu fontul din celule (rol, nume-funcție)

**`server/routes/flows.mjs`**
- `POST /flows/:id/reinitiate`: la crearea fluxului reinițiat, atașamentele (documente suport din `flow_attachments`) se copiază automat în noul flux — anterior nu erau transferate
- `POST /flows/:id/sign-upload` (finalizare flux): eliminat `data.urgent = false` de la completion — badge-ul URGENT rămâne vizibil în admin și după finalizarea fluxului

---

### ℹ️ Notă comportament șterge flux (clarificare, fără cod modificat)
`DELETE /flows/:id` face **hard delete** din DB — fluxul nu mai este vizibil nicăieri. Nu este un soft-delete. Dacă e nevoie de comportament soft-delete (vizibil cu badge "șters" în admin), se va implementa separat cu coloană `deleted_at`.
