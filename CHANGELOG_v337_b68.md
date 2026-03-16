# DocFlowAI v3.3.7 — Changelog (b68)

## Modificări față de b67

### 🔴 Hotfix — SyntaxError la startup (handler non-async cu await)

#### b68 — 15.03.2026

**Cauza:** În b67, `requireAdmin()` a devenit `async`. Toate apelurile au primit `await`,
dar două handler-e Express nu au fost declarate `async` — `await` într-o funcție sincronă
cauzează `SyntaxError: Unexpected reserved word` la parsare, înainte de pornirea serverului.

**`server/index.mjs`**
- `app.get('/metrics', (req, res) => {` → `async (req, res) => {`

**`server/routes/admin/outreach.mjs`**
- `router.get('/primarii', (req, res) => {` → `async (req, res) => {`

**`package.json`** — version bump `3.3.27` → `3.3.28`
