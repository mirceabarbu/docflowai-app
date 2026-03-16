# DocFlowAI v3.3.7 — Changelog (b77)

## Modificări față de b76

### 🟢 Feature — filtru „Arhivate în Drive" în lista de fluxuri admin

#### b77 — 16.03.2026

**Problema:** Nu existau mijloace în UI să vezi rapid ce fluxuri sunt arhivate în Google Drive.
Indicatorul 💾/⚠️ era vizibil dar nu existau filtru sau link direct.

**`server/routes/admin.mjs`**
- `GET /admin/flows/list` — suport parametru `?storage=drive`
  filtrează doar fluxurile cu `data->>'storage' = 'drive'`
- Răspuns extins cu câmpurile `archivedAt` și `driveFileLinkFinal`

**`public/admin.html`**
- Dropdown status flux: opțiune nouă **💾 Arhivate în Drive**
- La selectare, se trimite `storage=drive` la backend
- Coloana Acțiuni: buton **💾 Drive** vizibil la fluxurile arhivate —
  deschide direct fișierul din Google Drive într-un tab nou

**`package.json`** — version bump `3.3.36` → `3.3.37`

---

### Cum se folosește

1. **Admin → Administrare fluxuri**
2. Dropdown status → selectează **💾 Arhivate în Drive**
3. Lista afișează doar fluxurile arhivate, cu buton **💾 Drive** în coloana Acțiuni
4. Click pe **💾 Drive** → deschide documentul direct în Google Drive
