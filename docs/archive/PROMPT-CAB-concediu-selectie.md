---
prompt: "#CAB-CO-selectie"
titlu: "Responsabil CAB în CO la selecție DF/ORD — soft-disable + badge „În CO” (fără redirect)"
model_suggested: "Sonnet 4.6 (schimbare mică, UI + un SELECT)"
target_version: "v3.9.736"
branch: "develop"
migratii: "nu (coloanele leave_* există deja, folosite de user-leave.mjs)"
cache_bump: "DA — ?v= pe doc.js (NU e în PRECACHE_ASSETS, deci NU se atinge CACHE_VERSION din sw.js)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.

---

## Context (de ce)

La selecția „Responsabilul Buget / Responsabil CAB" din DF/ORD (modalul `#modal-p2`, populat din
`/api/formulare/utilizatori-org`), un utilizator aflat în **concediu** apare azi normal, fără niciun
semn. Responsabilul CAB e un **pool** (userul alege liber pe oricine din Serviciul Buget), fără
înlocuitor desemnat. Decizie (Mircea): un utilizator în CO apare **dezactivat** (soft-disable) cu
badge „În CO", iar userul alege pe altcineva disponibil. FĂRĂ redirect obligatoriu către înlocuitor
(nu se folosește pe pool). NU-l ascunde — doar dezactivat + motiv.

Coloanele `leave_start` / `leave_end` există deja pe `users` (folosite de `services/user-leave.mjs`).

---

## PAS 1 — Preflight
```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.735",
```

---

## PAS 2 — Backend: `server/routes/formulare/shared.mjs` (`/api/formulare/utilizatori-org`)

Adaugă `leave_start`, `leave_end` și `on_leave` (calculat în SQL: azi în interval) în SELECT.

- old_str:
```
    const { rows } = await pool.query(
      `SELECT id, email, nume, functie, compartiment
       FROM users
       WHERE org_id=$1 AND id != $2
       ORDER BY
         CASE WHEN TRIM(COALESCE(compartiment,'')) = $3 AND $3 <> '' THEN 0 ELSE 1 END,
         COALESCE(nume, email) ASC`,
      [actor.orgId, actor.userId, actorComp]
    );
```
- new_str:
```
    const { rows } = await pool.query(
      `SELECT id, email, nume, functie, compartiment,
              leave_start, leave_end,
              (leave_start IS NOT NULL AND leave_end IS NOT NULL
               AND leave_start <= CURRENT_DATE AND leave_end >= CURRENT_DATE) AS on_leave
       FROM users
       WHERE org_id=$1 AND id != $2
       ORDER BY
         CASE WHEN TRIM(COALESCE(compartiment,'')) = $3 AND $3 <> '' THEN 0 ELSE 1 END,
         COALESCE(nume, email) ASC`,
      [actor.orgId, actor.userId, actorComp]
    );
```

```bash
node --check server/routes/formulare/shared.mjs
```

---

## PAS 3 — Frontend: `public/js/formular/doc.js`

### 3a. Helper de formatare dată (înainte de `function filterModalUsers(){`)
- old_str:
```
function filterModalUsers(){
```
- new_str:
```
function _fmtLeaveDate(d){
  try{ const s=String(d).slice(0,10); const p=s.split('-'); return (p.length===3)?`${p[2]}.${p[1]}.${p[0]}`:s; }catch(_){ return String(d||''); }
}
function filterModalUsers(){
```

### 3b. Randare rând: badge „În CO” + dezactivare pentru on_leave
- old_str:
```
    return `<div class="modal-user${ST.selectedP2Id===u.id?' sel':''}" onclick="selectP2(${u.id})">
      <div style="flex:1">
        <div class="modal-u-name">${(u.nume||u.email||'').replace(/</g,'&lt;')}${otherCompBadge}</div>
        <div class="modal-u-sub">${(u.email||'').replace(/</g,'&lt;')}${u.compartiment?` · ${u.compartiment.replace(/</g,'&lt;')}`:''}</div>
      </div>
    </div>`;
```
- new_str:
```
    const onLeave=!!u.on_leave;
    const coBadge=onLeave
      ? ` <span style="font-size:.66rem;padding:1px 6px;border-radius:8px;background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.25);margin-left:4px">În CO${u.leave_end?` până la ${_fmtLeaveDate(u.leave_end)}`:''}</span>`
      : '';
    const rowAttrs=onLeave
      ? ` style="opacity:.5;cursor:not-allowed" title="Utilizator în concediu — indisponibil, alegeți alt responsabil"`
      : ` onclick="selectP2(${u.id})"`;
    return `<div class="modal-user${ST.selectedP2Id===u.id?' sel':''}"${rowAttrs}>
      <div style="flex:1">
        <div class="modal-u-name">${(u.nume||u.email||'').replace(/</g,'&lt;')}${otherCompBadge}${coBadge}</div>
        <div class="modal-u-sub">${(u.email||'').replace(/</g,'&lt;')}${u.compartiment?` · ${u.compartiment.replace(/</g,'&lt;')}`:''}</div>
      </div>
    </div>`;
```

### 3c. Guard în `selectP2` (backup peste dezactivarea din UI)
- old_str:
```
function selectP2(id){
  ST.selectedP2Id=id;
  document.getElementById('modal-confirm').disabled=false;
  filterModalUsers();
}
```
- new_str:
```
function selectP2(id){
  const u=(ST.orgUsers||[]).find(x=>x.id===id);
  if(u&&u.on_leave) return; // În CO — neselectabil
  ST.selectedP2Id=id;
  document.getElementById('modal-confirm').disabled=false;
  filterModalUsers();
}
```

```bash
node --check public/js/formular/doc.js
```

---

## PAS 4 — Cache-bust `doc.js` în `public/formular.html`

`doc.js` NU e în `PRECACHE_ASSETS` (sw.js) ⇒ e suficient bump-ul de `?v=`, NU se atinge `CACHE_VERSION`.

- old_str: `<script src="/js/formular/doc.js?v=3.9.725" defer></script>`
- new_str: `<script src="/js/formular/doc.js?v=3.9.736" defer></script>`

---

## PAS 5 — Bump + suită + commit + push

- package.json old_str: `  "version": "3.9.735",`
- package.json new_str: `  "version": "3.9.736",`

```bash
npm test
# Așteptat: verde (schimbarea nu atinge logică testată; e SELECT + randare UI).
```

```bash
git add server/routes/formulare/shared.mjs public/js/formular/doc.js public/formular.html package.json
git status --short          # exact 4 intrări
git commit -m "#CAB: utilizator în CO apare dezactivat + badge la selecția Responsabil CAB (DF/ORD) (v3.9.736)"
git push origin develop
```

---

## PAS 6 — Verificare pe STAGING (manual, după deploy)

1. Setează `leave_start`/`leave_end` pe un user din Serviciul Buget (interval care include azi).
2. În DF/ORD → „Trimite la Responsabil CAB" → modalul: userul apare **estompat + badge „În CO până la <data>”**, nu se poate selecta.
3. Ceilalți din serviciu rămân selectabili normal.
4. Un user cu concediu în TRECUT/VIITOR (nu azi) apare normal (selectabil).

---

## RAPORT FINAL (completează)

- shared.mjs: SELECT extins cu leave_start/leave_end/on_leave: da/nu
- doc.js: helper dată + badge/dezactivare rând + guard selectP2: da/nu
- formular.html: `?v=` doc.js 3.9.725 → 3.9.736: da/nu
- node --check pe shared.mjs + doc.js: OK
- npm test: PASSED (nr. fișiere/teste)
- Bump 3.9.735 → 3.9.736: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `shared.mjs` (SELECT), `doc.js` (3 edituri), `formular.html` (?v=), `package.json`.
- ⛔ NU ascunde userul în CO — doar dezactivat + badge (rămâne vizibil cu motivul).
- ⛔ Fără migrații (coloanele leave_* există). NU atinge CACHE_VERSION (doc.js nu e precache).
- ⛔ Zona NO-TOUCH `server/signing/*` neatinsă. Fluxul de semnare/delegare NU se atinge (e ok).
- ⛔ Orice `old_str` care nu se potrivește (whitespace): NU forța, raportează linia reală.
