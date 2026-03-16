# DocFlowAI v3.3.7 — Changelog (b74)

## Modificări față de b73

### 🔴 Bug fix — org_admin putea vedea și selecta roluri superioare în UI

#### b74 — 16.03.2026

**Fișier:** `public/admin.html` — singurul fișier modificat. Zero cod server atins.

**Problema:**
Dropdown-urile de rol (`#nRole` la creare, `#eRole` la editare) afișau toate
cele 3 opțiuni (User, Admin Instituție, Admin) indiferent de rolul utilizatorului
logat. Un `org_admin` putea selecta vizual „Admin" sau „Admin Instituție" din UI.

Backend-ul bloca corect (linia 178 din `admin.mjs`):
`const allowedRoles = actor.role === 'admin' ? [...] : ['user']`
— dar UI-ul nu reflecta această restricție, creând confuzie.

**Fix:**
- Funcție nouă `_lockRoleDropdownsForOrgAdmin()` — elimină opțiunile `org_admin`
  și `admin` din ambele dropdown-uri de rol și le dezactivează
- Apelată la login când `u.role === 'org_admin'`, după setarea `_orgAdminInstitutie`
- Backend rămâne neschimbat — fix pur de UI/UX

**Comportament după fix:**
- `org_admin` logat: dropdown Rol afișează **doar „User"**, dezactivat (readonly)
- `admin` global: dropdown Rol afișează toate 3 opțiunile — neschimbat

**`package.json`** — version bump `3.3.33` → `3.3.34`
