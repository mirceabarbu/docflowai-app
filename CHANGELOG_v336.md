# DocFlowAI v3.3.6 — Changelog

## Modificări față de v3.3.5

### 🐛 Bug fixes & îmbunătățiri UI

---

#### b36 — 13.03.2026

**`public/semdoc-signer.html`**
- Textul butonului "Alege fișier PDF semnat" → **"Încarcă fișier PDF semnat calificat"**

---

#### b35 — 13.03.2026

**`public/semdoc-initiator.html`**
- Header `position:sticky` — nu dispărea la scroll vertical în *Flux nou* / *Fluxuri mele*
- Limita atașament PDF: **5 MB → 50 MB** (label + validare client-side)
- Tip flux afișat în cardul din *Fluxurile mele*: `📋 Tabel generat` / `⚓ Ancore`, după data creării
- Icon semnatar `🚫` la status `cancelled` (anterior doar la `pending` după refuz)
- Buton 🗑 Șterge flux vizibil și pentru **org_admin**, nu doar inițiator

**`public/templates.html`**
- Buton **🔑 Parolă** adăugat în `userBar` (lipsea față de celelalte pagini)
- Modal schimbare parolă complet (`changePwdModal`) cu funcțiile aferente

**`public/flow.html`**
- Tip flux afișat în secțiunea *Detalii*: `📋 Tabel generat` / `⚓ Ancore`, după denumire document
- Semnatarii cu status `pending`/`current` afișați cu badge `🚫 anulat` când fluxul e anulat
- Link *Semnează acum* ascuns dacă fluxul are status `cancelled`

**`server/routes/flows.mjs`**
- Limita server-side PDF: **30 MB → 50 MB**
- `DELETE /flows/:id` — permis și pentru **org_admin** (anterior doar `admin` global)
- `POST /flows/:id/cancel` — semnatarii cu status `pending`/`current` sunt marcați automat `cancelled`
