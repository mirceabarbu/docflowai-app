# PROMPT — BLOC 4.1 (Backend concediu/delegare semnatari)

## CONTEXT

DocFlowAI v3.9.378+. Feature nou: utilizatorii pot marca perioade de concediu și un delegat. Când userul e în concediu, fluxurile NOI selectează automat delegatul, iar fluxurile EXISTENTE care ajung la el sunt redirecționate (logică implementată în 4.3).

**BLOC 4.1 = doar backend.** UI vine în 4.2, integrarea în flux în 4.3. Acest prompt NU atinge frontend, NU atinge logica de creare flux, NU atinge nicio pagină existentă.

**Decizii arhitecturale stabilite:**
- Maria semnează cu certificatul ei STS propriu (legal, eIDAS-corect)
- PDF-ul reflectă semnătura reală a Mariei
- UI/audit menționează „în delegare pentru Ion"
- User își setează singur, admin poate seta pentru oricine din instituția lui
- **NO CHAIN** — refuzăm la SET dacă delegat are deja un delegat propriu
- Validări critice server-side (no-self, same-org, no-retroactive, leave_end ≥ leave_start)

## ⛔ CONSTRÂNGERI ABSOLUTE

1. NU atinge zona STS:
   - `server/signing/providers/STSCloudProvider.mjs`
   - `server/routes/flows/cloud-signing.mjs`
   - `server/routes/flows/bulk-signing.mjs`
   - `server/signing/pades.mjs`
   - `server/signing/java-pades-client.mjs`
2. NU atinge `df-apifetch-shim*.js`, `admin/core.js`
3. NU atinge logica `createFlow` din `server/routes/flows/crud.mjs` — vine în BLOC 4.3
4. NU atinge UI-ul (HTML/CSS/JS) — vine în BLOC 4.2
5. **NU adăuga fișiere SQL** în `server/db/migrations/` — REGULA 1 din CLAUDE.md: migrările noi se scriu EXCLUSIV inline în `server/db/index.mjs`
6. `npm test` verde

## ARHITECTURĂ

### Migrare 063 (inline, în `server/db/index.mjs`)

Adaugă coloane pe `users`:
- `leave_start DATE` — început concediu (NULL = nu e în concediu)
- `leave_end DATE` — sfârșit concediu (inclusiv)
- `delegate_user_id INTEGER` — FK self-referencing la users.id (cine semnează în lipsa lui)
- `leave_reason TEXT` — opțional, pentru audit

Plus:
- Index parțial pe `(leave_start, leave_end) WHERE leave_start IS NOT NULL`
- FK constraint `users_delegate_fk` cu `ON DELETE SET NULL` (dacă ștergi delegatul, leave-ul stă dar fără delegat)
- CHECK constraint `users_leave_dates_chk` (leave_end >= leave_start)
- CHECK constraint `users_no_self_delegate_chk` (delegate_user_id != id)

### Helper `server/services/user-leave.mjs` (NOU)

Funcții pure (export named):
- `isUserOnLeave(userId, asOfDate?)` → bool
- `getActiveSigner(userId, asOfDate?)` → returnează `{userId, isDelegate, originalUserId}` sau original dacă nu e concediu
- `getLeaveInfo(userId)` → `{onLeave, leaveStart, leaveEnd, leaveReason, delegate: {id, nume, email, functie} | null}`
- `validateLeaveSettings(userId, leaveStart, leaveEnd, delegateId, orgId)` → throw cu eroare clară dacă invalid

`asOfDate` permite verificare „la ce dată" (default: today). Util pentru fluxurile create în trecut.

### Endpoint-uri API noi (în `server/routes/admin/users.mjs`)

1. `PUT /api/users/me/leave` (auth, csrf) — userul își setează singur concediu/delegat
2. `DELETE /api/users/me/leave` (auth, csrf) — userul își anulează concediul
3. `PUT /admin/users/:id/leave` (auth admin, csrf) — admin setează pentru oricine din org
4. `DELETE /admin/users/:id/leave` (auth admin, csrf) — admin anulează concediul oricui

### Extindere endpoint existent `GET /users` (în `server/routes/admin/users.mjs`, linia 38)

Răspuns nou per user (păstrează backward-compat — câmpurile vechi rămân, se adaugă obiect `leave`):
```json
{
  "id": 5,
  "email": "ion@primaria.ro",
  "nume": "Ion Popescu",
  "functie": "Director",
  "institutie": "Primăria X",
  "compartiment": "...",
  "org_id": 1,
  "leave": {
    "onLeave": true,
    "leaveStart": "2026-05-01",
    "leaveEnd": "2026-05-15",
    "delegate": { "id": 7, "nume": "Maria Pop", "email": "maria@primaria.ro" }
  }
}
```

`leave: null` dacă userul n-a setat concediu (sau nu mai are dată activă).

---

## FAZA 0 — Pre-checks

```bash
# 0.1 — Verificare ultima migrare inline (trebuie să fie 062)
grep -nE "id: '06[0-9]_" server/db/index.mjs | tail -3
# Așteptat: 060_alop_plata_documente, 061_alop_lichidare_data_pv, 062_alop_multi_ord

# 0.2 — Confirm structura services/
ls server/services/
# Așteptat: certificate-verify.mjs, format-money.mjs, formulare-oficiale, pdf.mjs, ...
# Verifică că NU există deja user-leave.mjs

# 0.3 — Verifică pattern import csrfMiddleware
grep -n "csrfMiddleware" server/routes/admin/users.mjs | head -3
# Așteptat: import + cel puțin o utilizare

# 0.4 — Confirmă că nu există deja coloane leave_* pe users
grep -nE "leave_start|leave_end|delegate_user_id" server/db/index.mjs
# Așteptat: NIMIC

# 0.5 — Confirmă pattern requireAuth + isAdmin
grep -nE "requireAuth|requireAdmin|isAdmin\(" server/routes/admin/users.mjs | head -10
```

---

## FAZA 1 — Migrare 063 (inline)

**Fișier:** `server/db/index.mjs`

**Locație:** la sfârșitul `MIGRATIONS` array, după blocul `062_alop_multi_ord` (în jur de linia 1183-1190, înainte de `];`).

Caută acest pattern (linii ~1183-1185):
```js
      END $g$;
    `
  }
];
```

**Înlocuiește cu:**
```js
      END $g$;
    `
  },
  {
    id: '063_user_leave_delegate',
    sql: `
      DO $g$ BEGIN
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS leave_start DATE,
          ADD COLUMN IF NOT EXISTS leave_end DATE,
          ADD COLUMN IF NOT EXISTS delegate_user_id INTEGER,
          ADD COLUMN IF NOT EXISTS leave_reason TEXT;

        BEGIN
          ALTER TABLE users
            ADD CONSTRAINT users_delegate_fk
            FOREIGN KEY (delegate_user_id) REFERENCES users(id) ON DELETE SET NULL;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;

        BEGIN
          ALTER TABLE users
            ADD CONSTRAINT users_leave_dates_chk
            CHECK (leave_end IS NULL OR leave_start IS NULL OR leave_end >= leave_start);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;

        BEGIN
          ALTER TABLE users
            ADD CONSTRAINT users_no_self_delegate_chk
            CHECK (delegate_user_id IS NULL OR delegate_user_id != id);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;

        CREATE INDEX IF NOT EXISTS idx_users_leave_active
          ON users(leave_start, leave_end)
          WHERE leave_start IS NOT NULL;
      END $g$;
    `
  }
];
```

**Verificare imediată:**
```bash
grep -c "063_user_leave_delegate" server/db/index.mjs
# Așteptat: 1
node --check server/db/index.mjs && echo "Syntax OK"
# Așteptat: "Syntax OK"
```

---

## FAZA 2 — Helper `server/services/user-leave.mjs` (NOU)

**Creează fișier nou** la `server/services/user-leave.mjs` cu următorul conținut:

```js
/**
 * server/services/user-leave.mjs — User leave/delegation lookups & validation.
 *
 * Pure functions (no side effects). Used by:
 *  - /users dropdown enrichment (BLOC 4.1)
 *  - PUT /api/users/me/leave + admin variants (BLOC 4.1)
 *  - Flow signer redirection (BLOC 4.3)
 *
 * Decizie arhitecturală: NO CHAIN. Dacă Ion deleagă la Maria, Maria nu poate
 * avea propriul delegat (validat la SET în endpoint-uri). Asta înseamnă că
 * resolve-ul rămâne 1-hop, simplu și predictibil.
 */

import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

// ── Lookups ──────────────────────────────────────────────────────────────────

/**
 * isUserOnLeave — verifică dacă userul e în concediu la o dată dată.
 * @param {number}      userId
 * @param {Date|string} asOfDate — default azi
 * @returns {Promise<boolean>}
 */
export async function isUserOnLeave(userId, asOfDate = null) {
  if (!userId) return false;
  const isoDate = (asOfDate ? new Date(asOfDate) : new Date()).toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM users
       WHERE id=$1
         AND leave_start IS NOT NULL
         AND leave_end IS NOT NULL
         AND leave_start <= $2::date
         AND leave_end >= $2::date
       LIMIT 1`,
      [userId, isoDate]
    );
    return rows.length > 0;
  } catch (e) {
    logger.warn({ err: e, userId }, 'isUserOnLeave lookup failed');
    return false; // fail-safe: tratează ca "nu e în concediu" decât să blocheze
  }
}

/**
 * getActiveSigner — returnează userul care trebuie să semneze efectiv:
 * userul original dacă NU e în concediu, sau delegatul dacă E în concediu.
 * @param {number}      userId
 * @param {Date|string} asOfDate — default azi
 * @returns {Promise<{userId, isDelegate, originalUserId} | null>}
 */
export async function getActiveSigner(userId, asOfDate = null) {
  if (!userId) return null;
  const isoDate = (asOfDate ? new Date(asOfDate) : new Date()).toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT id, leave_start, leave_end, delegate_user_id
       FROM users WHERE id=$1`,
      [userId]
    );
    if (!rows.length) return null;
    const u = rows[0];
    const onLeave =
      u.leave_start && u.leave_end &&
      _isoDate(u.leave_start) <= isoDate && _isoDate(u.leave_end) >= isoDate;
    if (onLeave && u.delegate_user_id) {
      return { userId: u.delegate_user_id, isDelegate: true, originalUserId: userId };
    }
    return { userId, isDelegate: false, originalUserId: userId };
  } catch (e) {
    logger.warn({ err: e, userId }, 'getActiveSigner lookup failed');
    return { userId, isDelegate: false, originalUserId: userId };
  }
}

/**
 * getLeaveInfo — returnează informații complete despre concediul unui user
 * (pentru afișare în dropdown semnatari + UI setări).
 * @param {number} userId
 * @returns {Promise<{onLeave, leaveStart, leaveEnd, leaveReason, delegate} | null>}
 *   Returnează null DOAR dacă userul n-a setat niciodată leave_start.
 *   Dacă a setat dar concediul e expirat → returnează cu onLeave: false.
 */
export async function getLeaveInfo(userId) {
  if (!userId) return null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT u.leave_start, u.leave_end, u.leave_reason,
              d.id AS d_id, d.nume AS d_nume, d.email AS d_email, d.functie AS d_functie
       FROM users u
       LEFT JOIN users d ON d.id = u.delegate_user_id
       WHERE u.id=$1`,
      [userId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    if (!r.leave_start) return null; // nu a setat
    const leaveStart = _isoDate(r.leave_start);
    const leaveEnd = r.leave_end ? _isoDate(r.leave_end) : null;
    const onLeave = !!leaveEnd && leaveStart <= today && leaveEnd >= today;
    return {
      onLeave,
      leaveStart,
      leaveEnd,
      leaveReason: r.leave_reason || null,
      delegate: r.d_id
        ? { id: r.d_id, nume: r.d_nume || '', email: r.d_email || '', functie: r.d_functie || '' }
        : null,
    };
  } catch (e) {
    logger.warn({ err: e, userId }, 'getLeaveInfo lookup failed');
    return null;
  }
}

/**
 * batchGetLeaveInfo — versiune optimizată pentru a evita N+1 queries
 * în endpoint-ul /users (50+ useri).
 * @param {number[]} userIds
 * @returns {Promise<Map<number, leaveInfo>>}
 */
export async function batchGetLeaveInfo(userIds) {
  const map = new Map();
  if (!userIds?.length) return map;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.leave_start, u.leave_end, u.leave_reason,
              d.id AS d_id, d.nume AS d_nume, d.email AS d_email, d.functie AS d_functie
       FROM users u
       LEFT JOIN users d ON d.id = u.delegate_user_id
       WHERE u.id = ANY($1::int[]) AND u.leave_start IS NOT NULL`,
      [userIds]
    );
    for (const r of rows) {
      const leaveStart = _isoDate(r.leave_start);
      const leaveEnd = r.leave_end ? _isoDate(r.leave_end) : null;
      const onLeave = !!leaveEnd && leaveStart <= today && leaveEnd >= today;
      map.set(r.id, {
        onLeave,
        leaveStart,
        leaveEnd,
        leaveReason: r.leave_reason || null,
        delegate: r.d_id
          ? { id: r.d_id, nume: r.d_nume || '', email: r.d_email || '', functie: r.d_functie || '' }
          : null,
      });
    }
  } catch (e) {
    logger.warn({ err: e, count: userIds.length }, 'batchGetLeaveInfo failed');
  }
  return map;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * validateLeaveSettings — verifică toate regulile de business înainte de SET.
 * Throws Error cu mesaj descriptiv (router-ul îl mapează la 400).
 *
 * @param {object} input
 * @param {number} input.targetUserId   — userul pentru care se setează concediul
 * @param {string|null} input.leaveStart — YYYY-MM-DD sau null pentru clear
 * @param {string|null} input.leaveEnd   — YYYY-MM-DD sau null pentru clear
 * @param {number|null} input.delegateUserId — id delegat sau null
 * @param {string|null} input.leaveReason
 */
export async function validateLeaveSettings({ targetUserId, leaveStart, leaveEnd, delegateUserId, leaveReason }) {
  // Clear case: dacă leaveStart e null, restul nu contează
  if (leaveStart === null && leaveEnd === null && delegateUserId === null) return;

  if (!leaveStart || !leaveEnd) {
    throw new Error('leave_dates_required');
  }
  if (!_isValidIsoDate(leaveStart) || !_isValidIsoDate(leaveEnd)) {
    throw new Error('leave_dates_invalid_format');
  }
  if (leaveEnd < leaveStart) {
    throw new Error('leave_end_before_start');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (leaveStart < today) {
    throw new Error('leave_start_in_past');
  }
  if (delegateUserId !== null && delegateUserId !== undefined) {
    if (typeof delegateUserId !== 'number' || delegateUserId === targetUserId) {
      throw new Error('delegate_invalid');
    }
    // Verifică same-org + delegate fără propriul delegate (NO CHAIN)
    const { rows } = await pool.query(
      `SELECT u_target.org_id AS target_org, u_del.org_id AS del_org,
              u_del.delegate_user_id AS del_has_delegate
       FROM users u_target
       LEFT JOIN users u_del ON u_del.id = $2
       WHERE u_target.id = $1`,
      [targetUserId, delegateUserId]
    );
    if (!rows.length) throw new Error('user_not_found');
    if (rows[0].del_org === null) throw new Error('delegate_not_found');
    if (rows[0].target_org !== rows[0].del_org) throw new Error('delegate_different_org');
    if (rows[0].del_has_delegate !== null) throw new Error('delegate_has_own_delegate'); // NO CHAIN
  }
  if (leaveReason && typeof leaveReason === 'string' && leaveReason.length > 500) {
    throw new Error('leave_reason_too_long');
  }
}

/**
 * setUserLeave — UPDATE user cu noile setări de concediu (după validare).
 * @param {object} input — același shape ca validateLeaveSettings
 */
export async function setUserLeave({ targetUserId, leaveStart, leaveEnd, delegateUserId, leaveReason }) {
  await pool.query(
    `UPDATE users
     SET leave_start = $2, leave_end = $3, delegate_user_id = $4, leave_reason = $5
     WHERE id = $1`,
    [targetUserId, leaveStart || null, leaveEnd || null, delegateUserId || null, leaveReason || null]
  );
}

/**
 * clearUserLeave — anulează concediul (toate câmpurile NULL).
 * @param {number} targetUserId
 */
export async function clearUserLeave(targetUserId) {
  await pool.query(
    `UPDATE users SET leave_start=NULL, leave_end=NULL, delegate_user_id=NULL, leave_reason=NULL
     WHERE id=$1`,
    [targetUserId]
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _isoDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function _isValidIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
```

**Verificare:**
```bash
ls -la server/services/user-leave.mjs
# Așteptat: fișier prezent, ~7-9 KB

node --check server/services/user-leave.mjs && echo "Syntax OK"
# Așteptat: "Syntax OK"
```

---

## FAZA 3 — Endpoint-uri API noi în `server/routes/admin/users.mjs`

### 3.1 — Adaugă import în top (după linia 26 unde e import-ul existent pentru pool)

Caută:
```js
import { pool, requireDb, invalidateOrgUserCache } from '../../db/index.mjs';
```

Adaugă **imediat după**:
```js
import {
  validateLeaveSettings, setUserLeave, clearUserLeave, getLeaveInfo, batchGetLeaveInfo,
} from '../../services/user-leave.mjs';
```

### 3.2 — Adaugă cele 4 endpoint-uri noi

**Locație:** la sfârșitul fișierului, ÎNAINTE de `export default router;` (caută această linie ca reper).

Inserează blocul:

```js

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE / DELEGATION ENDPOINTS (BLOC 4.1)
// ═══════════════════════════════════════════════════════════════════════════

// Map pentru error_code → mesaj prietenos UI (RO)
const LEAVE_ERR_MSG = {
  leave_dates_required: 'Datele de concediu sunt obligatorii.',
  leave_dates_invalid_format: 'Format dată invalid (necesar YYYY-MM-DD).',
  leave_end_before_start: 'Data sfârșit nu poate fi înainte de data început.',
  leave_start_in_past: 'Concediu nu poate fi setat retroactiv.',
  delegate_invalid: 'Delegat invalid.',
  user_not_found: 'Utilizator inexistent.',
  delegate_not_found: 'Delegatul nu există.',
  delegate_different_org: 'Delegatul trebuie să fie din aceeași instituție.',
  delegate_has_own_delegate: 'Delegatul ales are deja propriul delegat (lanț de delegări neacceptat).',
  leave_reason_too_long: 'Motivul depășește 500 de caractere.',
};

function _mapLeaveError(err, res) {
  const code = err?.message || 'server_error';
  const userMsg = LEAVE_ERR_MSG[code] || 'Eroare neașteptată.';
  const status = (code in LEAVE_ERR_MSG) ? 400 : 500;
  return res.status(status).json({ error: code, message: userMsg });
}

// ── PUT /api/users/me/leave — userul își setează singur concediu ────────────
router.put('/api/users/me/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: meRows } = await pool.query(
      'SELECT id FROM users WHERE email=$1', [actor.email.toLowerCase()]
    );
    if (!meRows.length) return res.status(404).json({ error: 'user_not_found' });
    const targetUserId = meRows[0].id;

    const { leave_start, leave_end, delegate_user_id, leave_reason } = req.body || {};
    const input = {
      targetUserId,
      leaveStart: leave_start || null,
      leaveEnd: leave_end || null,
      delegateUserId: delegate_user_id ? Number(delegate_user_id) : null,
      leaveReason: leave_reason || null,
    };
    await validateLeaveSettings(input);
    await setUserLeave(input);
    invalidateOrgUserCache?.(); // dacă există cache pe useri
    const info = await getLeaveInfo(targetUserId);
    res.json({ ok: true, leave: info });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});

// ── DELETE /api/users/me/leave — userul își anulează singur concediul ──────
router.delete('/api/users/me/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: meRows } = await pool.query(
      'SELECT id FROM users WHERE email=$1', [actor.email.toLowerCase()]
    );
    if (!meRows.length) return res.status(404).json({ error: 'user_not_found' });
    await clearUserLeave(meRows[0].id);
    invalidateOrgUserCache?.();
    res.json({ ok: true, leave: null });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});

// ── PUT /admin/users/:id/leave — admin setează concediu pentru oricine ─────
router.put('/admin/users/:id/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'admin_only' });

  const targetUserId = Number(req.params.id);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  try {
    // Verifică same-org pentru admin (un admin nu poate seta concediu cuiva din altă org)
    const { rows: orgRows } = await pool.query(
      `SELECT u_actor.org_id AS actor_org, u_target.org_id AS target_org
       FROM users u_actor
       JOIN users u_target ON u_target.id = $2
       WHERE u_actor.email = $1`,
      [actor.email.toLowerCase(), targetUserId]
    );
    if (!orgRows.length) return res.status(404).json({ error: 'user_not_found' });
    if (orgRows[0].actor_org !== orgRows[0].target_org) {
      return res.status(403).json({ error: 'different_org' });
    }

    const { leave_start, leave_end, delegate_user_id, leave_reason } = req.body || {};
    const input = {
      targetUserId,
      leaveStart: leave_start || null,
      leaveEnd: leave_end || null,
      delegateUserId: delegate_user_id ? Number(delegate_user_id) : null,
      leaveReason: leave_reason || null,
    };
    await validateLeaveSettings(input);
    await setUserLeave(input);
    invalidateOrgUserCache?.();
    const info = await getLeaveInfo(targetUserId);
    res.json({ ok: true, leave: info });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});

// ── DELETE /admin/users/:id/leave — admin anulează concediu ────────────────
router.delete('/admin/users/:id/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'admin_only' });

  const targetUserId = Number(req.params.id);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  try {
    const { rows: orgRows } = await pool.query(
      `SELECT u_actor.org_id AS actor_org, u_target.org_id AS target_org
       FROM users u_actor
       JOIN users u_target ON u_target.id = $2
       WHERE u_actor.email = $1`,
      [actor.email.toLowerCase(), targetUserId]
    );
    if (!orgRows.length) return res.status(404).json({ error: 'user_not_found' });
    if (orgRows[0].actor_org !== orgRows[0].target_org) {
      return res.status(403).json({ error: 'different_org' });
    }
    await clearUserLeave(targetUserId);
    invalidateOrgUserCache?.();
    res.json({ ok: true, leave: null });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});
```

NB: Dacă `actor.role` nu există în JWT, atunci pattern-ul corect e ce folosește restul fișierului — verifică prin `grep -nE "actor\.role|isAdmin\(actor\)|requireAdmin" server/routes/admin/users.mjs` și adaptează verificarea de admin în consecință (e posibil ca pattern-ul să fie diferit, ex. `actor.isAdmin` sau un middleware separat).

### 3.3 — Verificare endpoint-uri

```bash
grep -c "router\.\(put\|delete\)\(.*/leave" server/routes/admin/users.mjs
# Așteptat: 4

node --check server/routes/admin/users.mjs && echo "Syntax OK"
# Așteptat: "Syntax OK"
```

---

## FAZA 4 — Extindere endpoint `GET /users` cu info `leave`

**Fișier:** `server/routes/admin/users.mjs`, linia 38 (`router.get('/users', ...)`)

**Modificare:** după ce se obține `rows` din query, îmbogățește fiecare user cu `leave` info folosind `batchGetLeaveInfo`.

**Caută blocul exact** (linii ~62-65):
```js
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});
```

**Înlocuiește cu:**
```js
    const { rows } = await pool.query(query, params);

    // BLOC 4.1: îmbogățește fiecare user cu info concediu/delegare
    const userIds = rows.map(u => u.id).filter(Boolean);
    const leaveMap = await batchGetLeaveInfo(userIds);
    const enriched = rows.map(u => ({
      ...u,
      leave: leaveMap.get(u.id) || null,
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});
```

**Verificare:**
```bash
grep -A2 "BLOC 4.1: îmbogățește" server/routes/admin/users.mjs | head -5
# Așteptat: să apară blocul nou
```

---

## FAZA 5 — Verificări finale

```bash
# 5.1 — Migrare 063 prezentă
grep -c "063_user_leave_delegate" server/db/index.mjs
# Așteptat: 1

# 5.2 — Helper user-leave.mjs prezent și validează sintactic
ls -la server/services/user-leave.mjs
node --check server/services/user-leave.mjs && echo "Syntax OK"

# 5.3 — Cele 4 endpoint-uri /leave prezente
grep -nE "router\.(put|delete)\([^)]*/leave" server/routes/admin/users.mjs
# Așteptat: 4 linii (PUT /api/users/me/leave, DELETE /api/users/me/leave, PUT /admin/users/:id/leave, DELETE /admin/users/:id/leave)

# 5.4 — Import din user-leave.mjs prezent
grep -c "from '../../services/user-leave.mjs'" server/routes/admin/users.mjs
# Așteptat: 1

# 5.5 — GET /users îmbogățit
grep -c "batchGetLeaveInfo" server/routes/admin/users.mjs
# Așteptat: 2 (1× import + 1× utilizare)

# 5.6 — Sintaxă OK pe toate fișierele atinse
node --check server/db/index.mjs && \
node --check server/services/user-leave.mjs && \
node --check server/routes/admin/users.mjs && \
echo "ALL OK"
```

---

## FAZA 6 — Test pe DB local (dacă e posibil) sau direct staging

**Opțiunea A — fresh DB local** (recomandat per CLAUDE.md):
```bash
# Asumând că ai PostgreSQL local + .env cu DATABASE_URL pointând la docflowai_dev
dropdb docflowai_dev 2>/dev/null
createdb docflowai_dev
npm start &
SERVER_PID=$!
sleep 8

# Verifică logs că migrarea 063 a rulat
# Caută în output: "✓ Migration 063_user_leave_delegate" sau similar

# Verifică în DB că coloanele există
psql docflowai_dev -c "\d users" | grep -E "leave_start|leave_end|delegate_user_id|leave_reason"
# Așteptat: 4 linii

# Stop server
kill $SERVER_PID
```

**Opțiunea B — direct staging** (dacă nu ai DB local):
- Push la develop
- Verifică Railway logs imediat după deploy
- Verifică că NU apare `db_not_ready` sau `ROLLBACK`

---

## FAZA 7 — Run tests + commit + push

```bash
npm test
# Așteptat: toate verzi

git add server/db/index.mjs \
        server/services/user-leave.mjs \
        server/routes/admin/users.mjs

git commit -m "feat(users): BLOC 4.1 — backend concediu/delegare semnatari

Migrare 063_user_leave_delegate (inline):
- Coloane noi pe users: leave_start, leave_end, delegate_user_id, leave_reason
- FK self-referencing users.delegate_user_id → users.id ON DELETE SET NULL
- CHECK constraint: leave_end >= leave_start
- CHECK constraint: delegate_user_id != id (no self-delegate)
- Index parțial pe (leave_start, leave_end) WHERE leave_start IS NOT NULL

Helper server/services/user-leave.mjs (NOU):
- isUserOnLeave(userId, asOfDate?) → bool
- getActiveSigner(userId, asOfDate?) → original sau delegat dacă în concediu
- getLeaveInfo(userId) → info complet pentru UI
- batchGetLeaveInfo(userIds[]) → optimizare pentru /users dropdown
- validateLeaveSettings(...) → throw cu cod de eroare descriptiv
- setUserLeave / clearUserLeave

Endpoint-uri noi (server/routes/admin/users.mjs):
- PUT  /api/users/me/leave         — user își setează singur
- DELETE /api/users/me/leave       — user își anulează singur
- PUT  /admin/users/:id/leave      — admin setează pentru oricine din org
- DELETE /admin/users/:id/leave    — admin anulează pentru oricine

Validări server-side (toate prin validateLeaveSettings):
- leave_end >= leave_start
- leave_start >= today (no retroactive)
- delegat din aceeași instituție (org_id egal)
- delegat != self
- NO CHAIN: refuzăm dacă delegatul are propriul delegate_user_id setat

Extindere GET /users:
- Răspuns enriched cu obiect 'leave' per user (folosind batchGetLeaveInfo)
- Backward-compat: câmpurile vechi rămân, doar se adaugă 'leave: {...} | null'

Decizii arhitecturale:
- 'NO CHAIN' previne delegări complicate (Maria → Ion → Vasile)
- Maria semnează cu certificatul ei STS propriu (legal eIDAS)
- UI vine în BLOC 4.2, integrarea în flux în BLOC 4.3

Conformitate cu CLAUDE.md REGULA 1: migrarea 063 e EXCLUSIV inline,
NU s-a adăugat fișier nou în server/db/migrations/.

Conformitate cu CLAUDE.md REGULA 2: toate ALTER TABLE folosesc IF NOT EXISTS.

Conformitate cu CLAUDE.md REGULA 3: constraints sunt în BEGIN/EXCEPTION
WHEN duplicate_object blocks (PostgreSQL nu are ADD CONSTRAINT IF NOT EXISTS).
"

git push origin develop
```

---

## REZUMAT BLOC 4.1

**Fișiere atinse:** 3
- `server/db/index.mjs` (migrare 063 inline)
- `server/services/user-leave.mjs` (NOU, ~250 linii)
- `server/routes/admin/users.mjs` (4 endpoint-uri noi + 1 endpoint extins)

**Fișiere STS:** 0

**Fișiere SQL noi în migrations/:** 0 (per REGULA 1 din CLAUDE.md)

**Surface API expus pentru BLOC 4.2 + 4.3:**
- 4 endpoint-uri /leave pentru UI setări (BLOC 4.2)
- `getActiveSigner()` helper pentru auto-redirect flux (BLOC 4.3)
- `GET /users` enriched cu `leave: {...}` pentru dropdown smart (BLOC 4.3)

## Verificare după Railway redeploy (staging)

```bash
# 1. Health check
curl https://docflowai-app-staging.up.railway.app/health
# Așteptat: {"ok":true,...}

# 2. Verifică în Railway logs
# Caută: "✓ Migration 063_user_leave_delegate" sau echivalent
# NU TREBUIE: "ROLLBACK", "DB init failed", "503 db_not_ready"

# 3. Test endpoint /users (cu cookie de sesiune valid)
# Răspunsul trebuie să conțină câmpul 'leave' pentru fiecare user
# (null pentru cei fără concediu setat — toți, deocamdată)
```

## Atenție / posibile observații

- **Migrarea 063 modifică `users`** — tabelă cu trafic real. ALTER TABLE pe coloane noi e fast operation (PostgreSQL nu re-scrie tabela), dar dacă `users` are constraint validation pe coloane noi cu DEFAULT non-null ar fi încet. Aici NU avem DEFAULT non-null → safe.
- **Cache utilizatori** — dacă `invalidateOrgUserCache` nu există în db/index.mjs, ignoră ce e pus cu `?.()` (nu strică nimic, doar nu invalidează). Verifică prin `grep -n "invalidateOrgUserCache" server/db/index.mjs`.
- **Verificare `actor.role`** — codul presupune că JWT-ul conține `role: 'admin'`. Dacă pattern-ul real e diferit (ex. `isAdmin`, `actor.adminFlag`), adaptează cele 2 verificări `if (actor.role !== 'admin')`. Caută cu: `grep -rn "actor\.role\|isAdmin\|adminOnly" server/routes/admin/users.mjs`.

După acest BLOC verde pe staging 24h+, atac BLOC 4.2 (UI setări `setari.html`).
