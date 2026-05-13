# DocFlowAI — 🛡 SOFT-DELETE USERS + ORGS + DELETE ENDPOINT (v3.9.435)

```
DocFlowAI v3.9.434 → v3.9.435 (SW v150 → v151)
Branch: develop
Subiect: feat(admin): soft-delete utilizatori + organizații cu confirmare typing

═══════════════════════════════════════════════════════════
CONTEXT — 3 PROBLEME REZOLVATE ÎNTR-O SINGURĂ LIVRARE
═══════════════════════════════════════════════════════════

P1 (BUG) — DELETE /admin/users/:id eșuează cu „Eroare la ștergere"
  Cauză: userii cu activitate (flow.initiator_id, flow_signers.user_id,
  alop_instances.created_by NOT NULL, formulare_oficiale.created_by ON
  DELETE RESTRICT, audit_log.actor_id, etc.) NU pot fi șterși fizic —
  PostgreSQL aruncă cod 23503 (FK violation), endpoint-ul îl prinde ca
  generic 500. Frontend-ul afișează „Eroare la ștergere." fără context.

P2 (FEATURE LIPSĂ) — Nu există DELETE pe organizații
  În server/routes/admin/organizations.mjs (281 linii) există GET / PUT
  / POST test-webhook, dar nicio rută DELETE. Super-adminul nu poate
  șterge o organizație din UI.

P3 (PATTERN) — Soft-delete pentru a păstra istoricul
  Hard-delete cu ON DELETE SET NULL pe toate FK-urile ar pierde audit
  trail (cine a inițiat fluxul, cine a semnat, cine a făcut acțiunea
  de admin). Soft-delete (deleted_at TIMESTAMPTZ) păstrează coerența
  istorică ȘI permite reactivarea ulterioară dacă e nevoie.

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH (NU MODIFICA)
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- Toate cele 135 query-urile FROM users care fac JOIN pe date
  ISTORICE (flow.initiator, audit_log, signers) — păstrează userul
  vizibil în istorie chiar dacă e soft-deleted. Filtrează DOAR în
  punctele critice listate la PASUL 3.

═══════════════════════════════════════════════════════════
PASUL 1 — Migrare DB 067 (soft-delete columns + partial unique)
═══════════════════════════════════════════════════════════

În server/db/index.mjs, după blocul migrației '066_updated_by_tracking',
adaugă o nouă migrare:

  {
    id: '067_soft_delete_users_orgs',
    sql: `
      DO $g$ BEGIN
        -- ── Users: soft-delete + partial unique pe email activ ─────
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

        -- Eliminăm constrântul UNIQUE original pe email (auto-numit)
        -- ca să-l înlocuim cu unul partial care permite reutilizare
        -- emailului după soft-delete.
        DO $inner$
        DECLARE
          c text;
        BEGIN
          SELECT conname INTO c
            FROM pg_constraint
           WHERE conrelid = 'users'::regclass
             AND contype  = 'u'
             AND pg_get_constraintdef(oid) ILIKE '%(email)%';
          IF c IS NOT NULL THEN
            EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
          END IF;
        END $inner$;

        -- Index unic parțial: doar pe useri activi (deleted_at IS NULL)
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_uniq
          ON users (lower(email))
          WHERE deleted_at IS NULL;

        -- Index pentru filtrare rapidă în liste
        CREATE INDEX IF NOT EXISTS idx_users_deleted_at
          ON users(deleted_at)
          WHERE deleted_at IS NOT NULL;

        -- ── Organizations: soft-delete ─────────────────────────────
        ALTER TABLE organizations
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

        CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at
          ON organizations(deleted_at)
          WHERE deleted_at IS NOT NULL;
      END $g$;
    `
  },

═══════════════════════════════════════════════════════════
PASUL 2 — Backend: rescrie DELETE /admin/users/:id ca soft-delete
═══════════════════════════════════════════════════════════

În server/routes/admin/users.mjs, înlocuiește în întregime handler-ul
DELETE existent (linia ~585):

old_str:
router.delete('/admin/users/:id', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  // FIX b75: org_admin poate șterge useri din propria organizație (consistent cu PUT/reset-password)
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  if (actor.userId === targetId) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    // SEC-07: verificare cross-tenant — org_admin poate șterge DOAR din propria org
    // FIX: role='admin' (super-admin) poate șterge din orice org, indiferent de org_id propriu
    const { rows: actorRows } = await pool.query('SELECT org_id FROM users WHERE id=$1', [actor.userId]);
    const actorOrgId = actorRows[0]?.org_id || null;
    let deleteWhere, deleteParams;
    if (actor.role === 'org_admin' && actorOrgId) {
      deleteWhere  = 'DELETE FROM users WHERE id=$1 AND org_id=$2';
      deleteParams = [targetId, actorOrgId];
    } else {
      // super-admin: ștergere fără restricție de org
      deleteWhere  = 'DELETE FROM users WHERE id=$1';
      deleteParams = [targetId];
    }
    const { rowCount } = await pool.query(deleteWhere, deleteParams);
    if (!rowCount) return res.status(404).json({ error: 'user_not_found_or_forbidden' });
    invalidateOrgUserCache(actorOrgId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

new_str:
router.delete('/admin/users/:id', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  if (actor.userId === targetId) return res.status(400).json({ error: 'cannot_deactivate_self', message: 'Nu te poți dezactiva singur.' });
  try {
    // SEC-07: cross-tenant — org_admin poate dezactiva DOAR din propria org
    const { rows: actorRows } = await pool.query('SELECT org_id FROM users WHERE id=$1', [actor.userId]);
    const actorOrgId = actorRows[0]?.org_id || null;

    // Citim targetul înainte (pentru audit + verificări last-admin)
    const { rows: tgtRows } = await pool.query(
      'SELECT id, email, nume, role, org_id, deleted_at FROM users WHERE id=$1',
      [targetId]
    );
    const target = tgtRows[0];
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (target.deleted_at) return res.status(409).json({ error: 'already_deactivated', message: 'Utilizatorul este deja dezactivat.' });

    // Cross-tenant pentru org_admin
    if (actor.role === 'org_admin' && target.org_id !== actorOrgId) {
      return res.status(403).json({ error: 'forbidden', message: 'Nu poți dezactiva utilizatori din altă organizație.' });
    }

    // Protecție: ultimul super-admin nu poate fi dezactivat
    if (target.role === 'admin') {
      const { rows: cntRows } = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM users WHERE role='admin' AND deleted_at IS NULL"
      );
      if ((cntRows[0]?.cnt || 0) <= 1) {
        return res.status(409).json({
          error: 'last_admin',
          message: 'Acesta este ultimul super-administrator activ. Promovează alt utilizator înainte de dezactivare.'
        });
      }
    }

    // Soft-delete + bump token_version (invalidează imediat sesiunile JWT existente)
    const { rowCount } = await pool.query(
      `UPDATE users
          SET deleted_at = NOW(),
              token_version = COALESCE(token_version, 0) + 1
        WHERE id = $1 AND deleted_at IS NULL`,
      [targetId]
    );
    if (!rowCount) return res.status(404).json({ error: 'user_not_found_or_already_deleted' });

    invalidateOrgUserCache(target.org_id);
    try {
      await writeAuditEvent({
        actor_id: actor.userId,
        actor_email: actor.email,
        action: 'user.deactivated',
        target_type: 'user',
        target_id: String(targetId),
        org_id: target.org_id,
        meta: { email: target.email, nume: target.nume }
      });
    } catch(_) { /* audit non-fatal */ }

    res.json({ ok: true, deactivated: true, userId: targetId });
  } catch(e) {
    // Defensiv — soft-delete nu ar trebui să aibă FK violation, dar prindem
    // orice eroare nesperată cu mesaj util
    if (e && e.code === '23503') {
      return res.status(409).json({
        error: 'user_has_references',
        message: 'Utilizatorul are date legate care nu permit dezactivarea. Contactează echipa tehnică.'
      });
    }
    return res.status(500).json({ error: 'server_error' });
  }
});

═══════════════════════════════════════════════════════════
PASUL 3 — Backend: filtrare deleted_at IS NULL în puncte critice
═══════════════════════════════════════════════════════════

ATENȚIE: NU modifica toate cele 135 query-uri pe users. Filtrăm DOAR
unde contează (login, refresh, listare admin, lookup activ). Query-urile
istorice (audit, signers) trebuie să rămână ca să păstreze referințele.

3.1 — server/routes/auth.mjs linia ~53 (login):

old_str:
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.trim().toLowerCase()]);

new_str:
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL', [email.trim().toLowerCase()]);

3.2 — server/routes/auth.mjs linia ~154 (token refresh by id):

old_str:
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,force_password_change,token_version FROM users WHERE id=$1', [decoded.userId]);

new_str:
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,force_password_change,token_version FROM users WHERE id=$1 AND deleted_at IS NULL', [decoded.userId]);

3.3 — server/routes/auth.mjs linia ~158 (token refresh by email):

old_str:
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,force_password_change,token_version FROM users WHERE lower(email)=lower($1)', [decoded.email]);

new_str:
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,force_password_change,token_version FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL', [decoded.email]);

3.4 — server/routes/auth.mjs linia ~215 (auth /me):

old_str:
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,token_version FROM users WHERE id=$1', [decoded.userId]);

new_str:
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,token_version FROM users WHERE id=$1 AND deleted_at IS NULL', [decoded.userId]);

3.5 — server/routes/auth.mjs linia ~308 (refresh token endpoint):

old_str:
      const { rows } = await pool.query('SELECT id,email,nume,role,org_id,institutie FROM users WHERE id=$1', [decoded.userId]);

new_str:
      const { rows } = await pool.query('SELECT id,email,nume,role,org_id,institutie FROM users WHERE id=$1 AND deleted_at IS NULL', [decoded.userId]);

3.6 — server/routes/admin/users.mjs GET /admin/users (linia ~111):
    Cele DOUĂ query-uri din branch-urile if/else trebuie ambele filtrate.

old_str:
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users WHERE org_id=$1 ORDER BY institutie ASC, compartiment ASC, nume ASC';

new_str:
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users WHERE org_id=$1 AND deleted_at IS NULL ORDER BY institutie ASC, compartiment ASC, nume ASC';

old_str:
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users ORDER BY institutie ASC, compartiment ASC, nume ASC';

new_str:
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users WHERE deleted_at IS NULL ORDER BY institutie ASC, compartiment ASC, nume ASC';

3.7 — server/db/queries/users.mjs (helpers folosite în mai multe locuri):

old_str:
  return getOne('SELECT * FROM users WHERE id=$1', [id]);

new_str:
  return getOne('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [id]);

old_str:
  return getOne('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);

new_str:
  return getOne('SELECT * FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL', [email]);

═══════════════════════════════════════════════════════════
PASUL 4 — Backend: GET /admin/organizations exclude soft-deleted
═══════════════════════════════════════════════════════════

În server/routes/admin/organizations.mjs handler GET:

old_str:
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.cif, o.compartimente, o.webhook_url, o.webhook_events, o.webhook_enabled,
             o.webhook_secret IS NOT NULL AS webhook_has_secret,
             o.created_at, o.updated_at,
             COUNT(DISTINCT u.id)::int  AS user_count,
             COUNT(DISTINCT f.id)::int  AS flow_count
      FROM organizations o
      LEFT JOIN users u  ON u.org_id  = o.id
      LEFT JOIN flows f  ON f.org_id  = o.id
      GROUP BY o.id
      ORDER BY o.name ASC
    `);

new_str:
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.cif, o.compartimente, o.webhook_url, o.webhook_events, o.webhook_enabled,
             o.webhook_secret IS NOT NULL AS webhook_has_secret,
             o.created_at, o.updated_at,
             COUNT(DISTINCT u.id) FILTER (WHERE u.deleted_at IS NULL)::int  AS user_count,
             COUNT(DISTINCT f.id)::int  AS flow_count
      FROM organizations o
      LEFT JOIN users u  ON u.org_id  = o.id
      LEFT JOIN flows f  ON f.org_id  = o.id
      WHERE o.deleted_at IS NULL
      GROUP BY o.id
      ORDER BY o.name ASC
    `);

═══════════════════════════════════════════════════════════
PASUL 5 — Backend: NOU endpoint DELETE /admin/organizations/:id
═══════════════════════════════════════════════════════════

În server/routes/admin/organizations.mjs, IMEDIAT după handler-ul
PUT /admin/organizations/:id (înainte de POST test-webhook),
adaugă:

  // ── DELETE /admin/organizations/:id — soft-delete (super-admin only) ──
  // Cere typing-ul exact al numelui organizației în body.confirm_name
  // ca să prevină ștergeri accidentale.
  router.delete('/admin/organizations/:id', csrfMiddleware, async (req, res) => {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Doar super-administratorul poate șterge organizații.' });
    const orgId = parseInt(req.params.id);
    if (isNaN(orgId)) return res.status(400).json({ error: 'invalid_id' });
    const { confirm_name } = req.body || {};
    try {
      const { rows } = await pool.query(
        'SELECT id, name, deleted_at FROM organizations WHERE id=$1',
        [orgId]
      );
      const org = rows[0];
      if (!org) return res.status(404).json({ error: 'org_not_found' });
      if (org.deleted_at) return res.status(409).json({ error: 'already_deleted', message: 'Organizația este deja ștearsă.' });

      // Confirmare prin typing exact al numelui
      if (!confirm_name || String(confirm_name).trim() !== org.name) {
        return res.status(400).json({
          error: 'confirm_name_mismatch',
          message: `Pentru confirmare, scrie exact numele organizației: "${org.name}".`
        });
      }

      // Blocaj: useri activi rămași în org
      const { rows: uRows } = await pool.query(
        'SELECT COUNT(*)::int AS cnt FROM users WHERE org_id=$1 AND deleted_at IS NULL',
        [orgId]
      );
      const activeUsers = uRows[0]?.cnt || 0;
      if (activeUsers > 0) {
        return res.status(409).json({
          error: 'org_has_active_users',
          message: `Organizația are ${activeUsers} utilizator(i) activ(i). Dezactivează-i înainte de ștergerea organizației.`,
          active_users: activeUsers,
        });
      }

      // Blocaj: fluxuri în derulare (status != completed/refused/cancelled)
      const { rows: fRows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM flows
          WHERE org_id=$1
            AND deleted_at IS NULL
            AND COALESCE(data->>'status','draft') NOT IN ('completed','refused','cancelled')`,
        [orgId]
      );
      const pendingFlows = fRows[0]?.cnt || 0;
      if (pendingFlows > 0) {
        return res.status(409).json({
          error: 'org_has_pending_flows',
          message: `Organizația are ${pendingFlows} flux(uri) în derulare. Finalizează-le sau anulează-le înainte de ștergere.`,
          pending_flows: pendingFlows,
        });
      }

      await pool.query(
        'UPDATE organizations SET deleted_at = NOW() WHERE id=$1 AND deleted_at IS NULL',
        [orgId]
      );

      try {
        await writeAuditEvent({
          actor_id: actor.userId,
          actor_email: actor.email,
          action: 'organization.deleted',
          target_type: 'organization',
          target_id: String(orgId),
          org_id: orgId,
          meta: { name: org.name },
        });
      } catch(_) { /* audit non-fatal */ }

      res.json({ ok: true, deleted: true, orgId });
    } catch(e) {
      logger.error({ err: e, orgId }, 'DELETE /admin/organizations/:id error');
      res.status(500).json({ error: 'server_error' });
    }
  });

NOTĂ: Verifică că la începutul fișierului este deja importat `logger`
(grep „import.*logger" în organizations.mjs). Dacă nu, adaugă:
  import { logger } from '../../middleware/logger.mjs';

═══════════════════════════════════════════════════════════
PASUL 6 — Frontend: rebrand „Șterge" → „Dezactivează" (utilizatori)
═══════════════════════════════════════════════════════════

6.1 — public/js/admin/admin.js funcția delUser:

old_str:
async function delUser(id,name){
  if(!confirm('Ștergi utilizatorul "'+name+'"?\nAcțiunea este ireversibilă.'))return;
  const r=await _apiFetch("/admin/users/"+id,{method:"DELETE",headers:hdrs()});
  if(r.ok){const row=$("row_"+id);if(row)row.remove();}
  else alert("Eroare la ștergere.");
}

new_str:
async function delUser(id,name){
  if(!confirm('Dezactivezi utilizatorul "'+name+'"?\n\nUtilizatorul nu va mai putea face login, dar istoricul (fluxuri, semnături, audit) este păstrat.\n\nPoți reactiva ulterior din DB dacă e nevoie.'))return;
  try {
    const r=await _apiFetch("/admin/users/"+id,{method:"DELETE",headers:hdrs()});
    const data = await r.json().catch(()=>({}));
    if(r.ok){
      const row=$("row_"+id);if(row)row.remove();
    } else {
      alert(data.message || ('Eroare la dezactivare: '+(data.error||r.status)));
    }
  } catch(e) {
    alert('Eroare de rețea: '+e.message);
  }
}

6.2 — public/js/admin/users.js linia 90 (buton din rândul tabelei):

old_str:
            ${!isMe?`<button class="df-action-btn danger sm" onclick="delUser(${u.id},'${esc(u.nume||u.email)}')" title="Șterge">✕</button>`:""}

new_str:
            ${!isMe?`<button class="df-action-btn danger sm" onclick="delUser(${u.id},'${esc(u.nume||u.email)}')" title="Dezactivează">✕</button>`:""}

═══════════════════════════════════════════════════════════
PASUL 7 — Frontend: buton + modal pentru ștergere organizație
═══════════════════════════════════════════════════════════

7.1 — public/js/admin/organizations.js, în cardul org, adaugă buton DELETE
       lângă „Configurare". Vizibil DOAR pentru super-admin.

old_str:
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="df-action-btn" onclick="openRenameOrgModal(${org.id},'${esc(org.name)}')">✏️ Redenumește</button>
              <button class="df-action-btn" onclick="openOrgModal(${org.id},'${esc(org.name)}')" style="background:rgba(124,92,255,.12);border-color:rgba(124,92,255,.3);color:#b39dff;">⚙ Configurare</button>
            </div>

new_str:
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="df-action-btn" onclick="openRenameOrgModal(${org.id},'${esc(org.name)}')">✏️ Redenumește</button>
              <button class="df-action-btn" onclick="openOrgModal(${org.id},'${esc(org.name)}')" style="background:rgba(124,92,255,.12);border-color:rgba(124,92,255,.3);color:#b39dff;">⚙ Configurare</button>
              ${window._currentUserRole === 'admin' ? `<button class="df-action-btn danger" onclick="openDeleteOrgModal(${org.id},'${esc(org.name)}',${org.user_count||0},${org.flow_count||0})" title="Șterge organizație">🗑 Șterge</button>` : ''}
            </div>

7.2 — public/js/admin/organizations.js, adaugă funcțiile noi după
       definiția lui doRenameOrg (linia ~449):

ADAUGĂ ÎNAINTE de „async function loadOrgSigningProviders":

  // ── Ștergere organizație (super-admin only, cu typing-confirm) ─────
  function openDeleteOrgModal(id, name, userCount, flowCount) {
    const m = document.getElementById('deleteOrgModal');
    if (!m) return;
    document.getElementById('delOrgName').textContent     = name;
    document.getElementById('delOrgNameTitle').textContent = name;
    document.getElementById('delOrgUserCount').textContent = userCount || 0;
    document.getElementById('delOrgFlowCount').textContent = flowCount || 0;
    document.getElementById('delOrgConfirmInput').value    = '';
    document.getElementById('delOrgMsg').innerHTML         = '';
    m.dataset.orgId   = id;
    m.dataset.orgName = name;
    m.style.display   = 'flex';
    setTimeout(() => document.getElementById('delOrgConfirmInput').focus(), 50);
  }
  function closeDeleteOrgModal() {
    const m = document.getElementById('deleteOrgModal');
    if (m) m.style.display = 'none';
  }
  async function doDeleteOrg() {
    const m = document.getElementById('deleteOrgModal');
    if (!m) return;
    const id   = parseInt(m.dataset.orgId);
    const name = m.dataset.orgName;
    const typed = (document.getElementById('delOrgConfirmInput').value || '').trim();
    const msg = document.getElementById('delOrgMsg');
    if (typed !== name) {
      msg.innerHTML = '<span style="color:#ffaaaa;">Numele introdus nu corespunde. Tastează exact: <strong>'+esc(name)+'</strong></span>';
      return;
    }
    const btn = document.getElementById('btnDelOrgConfirm');
    btn.disabled = true; btn.textContent = 'Se șterge...';
    try {
      const r = await _apiFetch('/admin/organizations/'+id, {
        method: 'DELETE',
        headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_name: typed })
      });
      const data = await r.json().catch(()=>({}));
      if (r.ok) {
        closeDeleteOrgModal();
        if (typeof loadOrganizations === 'function') loadOrganizations();
      } else {
        msg.innerHTML = '<span style="color:#ffaaaa;">'+esc(data.message || data.error || ('Eroare '+r.status))+'</span>';
      }
    } catch(e) {
      msg.innerHTML = '<span style="color:#ffaaaa;">Eroare de rețea: '+esc(e.message)+'</span>';
    } finally {
      btn.disabled = false; btn.textContent = '🗑 Șterge organizația';
    }
  }

ȘI la finalul IIFE, lângă celelalte window.X = X exports, adaugă:

  window.openDeleteOrgModal  = openDeleteOrgModal;
  window.closeDeleteOrgModal = closeDeleteOrgModal;
  window.doDeleteOrg         = doDeleteOrg;

VERIFICĂ în organizations.js dacă există deja `_currentUserRole` setat
prin window. Dacă NU, asigură-te că e setat undeva la load (ex. în
admin.js după /auth/me se setează `window._currentUserRole = u.role`).
Grep: `grep -n "_currentUserRole" public/js/admin/*.js` — dacă apare
deja folosit, e OK.

7.3 — public/admin.html: adaugă HTML-ul modalului de confirmare.
       Caută blocul „<!-- Modal Onboarding Wizard -->" în tab-ul
       organizatii și adaugă IMEDIAT DUPĂ închiderea acelui modal
       (după </div> care închide #onboardingModal):

  <!-- Modal Confirmare Ștergere Organizație -->
  <div id="deleteOrgModal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.78);backdrop-filter:blur(4px);align-items:center;justify-content:center;" onclick="if(event.target===this)closeDeleteOrgModal()">
    <div style="background:#0f1731;border:1px solid rgba(255,80,80,.45);border-radius:18px;padding:32px;max-width:520px;width:calc(100%-32px);box-shadow:0 20px 60px rgba(0,0,0,.7);position:relative;">
      <button class="df-action-btn icon-only sm ghost" onclick="closeDeleteOrgModal()" style="position:absolute;top:14px;right:16px;" aria-label="Închide"><svg class="df-ic"><use href="/icons.svg?v=3.9.435#ico-x"/></svg></button>
      <div style="font-size:1.1rem;font-weight:800;color:#ff8a8a;margin-bottom:6px;">⚠ Ștergere organizație: <span id="delOrgNameTitle"></span></div>
      <div style="font-size:.83rem;color:var(--muted);line-height:1.6;margin-bottom:18px;">
        Această acțiune ascunde organizația din toate listele și o marchează ca ștearsă (<code>deleted_at = NOW()</code>).
        Datele istorice (fluxuri, audit, semnături) <strong>rămân în baza de date</strong> pentru conformitate.
      </div>
      <div style="background:rgba(255,80,80,.08);border:1px solid rgba(255,80,80,.25);border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:.82rem;color:rgba(234,240,255,.85);">
        Statistici curente:<br>
        👥 <strong id="delOrgUserCount">0</strong> utilizatori activi<br>
        📁 <strong id="delOrgFlowCount">0</strong> fluxuri totale<br>
        <em style="color:var(--muted);">Ștergerea va eșua dacă există utilizatori activi sau fluxuri în derulare.</em>
      </div>
      <label style="font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px;">
        Pentru confirmare, scrie exact: <strong style="color:#ff8a8a;" id="delOrgName"></strong>
      </label>
      <input id="delOrgConfirmInput" type="text" autocomplete="off"
        style="width:100%;box-sizing:border-box;padding:10px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,80,80,.35);border-radius:8px;color:#eaf0ff;font-size:.95rem;outline:none;font-family:inherit;margin-bottom:12px;"/>
      <div id="delOrgMsg" style="font-size:.82rem;min-height:20px;margin-bottom:12px;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="df-action-btn ghost" onclick="closeDeleteOrgModal()">Anulează</button>
        <button class="df-action-btn danger" id="btnDelOrgConfirm" onclick="doDeleteOrg()">🗑 Șterge organizația</button>
      </div>
    </div>
  </div>

═══════════════════════════════════════════════════════════
PASUL 8 — Cache busting (3.9.434 → 3.9.435, SW v150 → v151)
═══════════════════════════════════════════════════════════

8.1 — package.json:
  old_str:   "version": "3.9.434",
  new_str:   "version": "3.9.435",

8.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v150';
  new_str: const CACHE_VERSION = 'docflowai-v151';

8.3 — public/admin.html (sed bulk pe ~100 referințe):
  sed -i 's/v=3\.9\.434/v=3.9.435/g' public/admin.html

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Migrarea există și are structura corectă:
   grep -A 3 "067_soft_delete_users_orgs" server/db/index.mjs | head -8

2. Coloanele deleted_at sunt referite în SQL-ul migrației:
   grep -c "deleted_at TIMESTAMPTZ" server/db/index.mjs
   → trebuie ≥ 2 (users + organizations)

3. Login filtrează soft-deleted:
   grep -c "deleted_at IS NULL" server/routes/auth.mjs
   → trebuie ≥ 4 (login + 3 puncte refresh/me)

4. Endpoint DELETE org există:
   grep -c "router.delete.*/admin/organizations/:id" server/routes/admin/organizations.mjs
   → trebuie 1

5. Frontend folosește terminologia nouă:
   grep -c "Dezactivează" public/js/admin/admin.js
   → trebuie ≥ 1
   grep -c "openDeleteOrgModal" public/js/admin/organizations.js
   → trebuie ≥ 3 (definiție + window export + onclick din card)

6. Modal HTML există în admin.html:
   grep -c "deleteOrgModal" public/admin.html
   → trebuie ≥ 2 (modalul + onclick="if(event.target===this)closeDeleteOrgModal()")

7. Cache busting aplicat:
   grep -c "v=3.9.435" public/admin.html
   → trebuie ~100
   grep -c "v=3.9.434" public/admin.html
   → trebuie 0
   grep "^const CACHE_VERSION" public/sw.js
   → docflowai-v151
   grep '"version"' package.json
   → 3.9.435

8. Sintaxa OK:
   node --check public/js/admin/organizations.js
   node --check public/js/admin/admin.js
   node --check public/sw.js
   npm run check

9. TESTE — verde, fără regresii:
   npm test
   ATENȚIE: testele care creează useri și apoi fac login pe ei
   trebuie să continue să meargă (nu sunt soft-deleted). Dacă vreun
   test eșuează cu „invalid_credentials" pe un user proaspăt creat,
   verifică că INSERT-ul nu setează deleted_at din greșeală — coloana
   are DEFAULT NULL deci nu ar trebui.

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/db/index.mjs \
        server/routes/admin/users.mjs \
        server/routes/admin/organizations.mjs \
        server/routes/auth.mjs \
        server/db/queries/users.mjs \
        public/js/admin/admin.js \
        public/js/admin/users.js \
        public/js/admin/organizations.js \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "feat(admin): soft-delete users + orgs + DELETE org endpoint (v3.9.435)

P1 — fix bug 'Eroare la stergere' user mirceabarbu@yahoo.com
  Cauza: FK violations din flow_signers/audit/alop la DELETE fizic.
  Fix: soft-delete cu users.deleted_at TIMESTAMPTZ. Endpoint marcheaza
  deleted_at=NOW() si bumpa token_version (invalideaza JWT existent).
  Mesaj de eroare util: ultim super-admin, deja dezactivat, etc.

P2 — feature: DELETE /admin/organizations/:id (super-admin only)
  Soft-delete cu organizations.deleted_at TIMESTAMPTZ. Cere typing-ul
  exact al numelui in confirm_name. Blocheaza stergerea daca org are:
  - useri activi (cere dezactivarea lor intai)
  - fluxuri in derulare (status NOT IN completed/refused/cancelled)
  Audit event: organization.deleted.

P3 — pattern: filtrare deleted_at IS NULL in puncte critice
  Login + token refresh + GET /admin/users + getUserById/Email helpers.
  Query-urile istorice (audit, signers, flow.initiator) raman
  nefiltrate ca sa pastreze contextul istoric.

Migrare 067 — partial unique index pe lower(email) WHERE deleted_at
IS NULL: permite reutilizarea emailului dupa dezactivare.

UI — buton 'Dezactiveaza' in lista useri + buton rosu 'Sterge' in card
organizatie cu modal de confirmare prin typing exact al numelui.

Cache: package 3.9.434 -> 3.9.435, SW v150 -> v151."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging)
═══════════════════════════════════════════════════════════

1. Aplica migrarea (auto la startup) — verifica logul Railway sa vezi
   "067_soft_delete_users_orgs" rulat cu succes.

2. /admin → tab Utilizatori → click ✕ pe mirceabarbu@yahoo.com
   → Confirma dezactivarea
   → Rezultat asteptat: rândul dispare, NICI O eroare
   → Verifica in DB: SELECT id,email,deleted_at FROM users
       WHERE email='mirceabarbu@yahoo.com' → deleted_at populat
   → Mircea NU mai poate face login (invalid_credentials)
   → Fluxurile lui istorice apar in continuare in liste cu numele lui

3. Dezactiveaza ultimul super-admin → eroare 'last_admin' cu mesaj util

4. /admin → tab Organizatii → click 🗑 pe Primaria Test
   → Modal: arata 6 useri activi, 288 fluxuri
   → Tasteaza alt nume → eroare locala 'nu corespunde'
   → Tasteaza 'Primaria Test' → click Sterge
   → Daca are useri activi: eroare 'org_has_active_users' cu numar
   → Dezactiveaza utilizatorii → reincearca → verifica daca mai
     sunt fluxuri in derulare → finalizeaza-le sau anuleaza-le
   → La final: org dispare din lista

5. Reactivare manuala daca ai gresit:
   UPDATE users SET deleted_at=NULL, token_version=token_version+1
     WHERE email='X';
   UPDATE organizations SET deleted_at=NULL WHERE id=X;
```
