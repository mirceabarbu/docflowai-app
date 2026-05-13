# DocFlowAI — 🔄 REACTIVARE USERI + ORGANIZAȚII DEZACTIVATE (v3.9.436)

```
DocFlowAI v3.9.435 → v3.9.436 (SW v151 → v152)
Branch: develop
Subiect: feat(admin): vizualizare + reactivare entități soft-deleted

═══════════════════════════════════════════════════════════
CONTEXT
═══════════════════════════════════════════════════════════

În v3.9.435 am introdus soft-delete pentru users și organizations,
dar entitățile dezactivate dispar complet din UI. Asta face soft-delete
funcțional indistinct de hard-delete pentru admin: nu vezi ce ai
dezactivat și nu poți recupera o greșeală.

Această livrare adaugă:
  1. Filtru de status în lista utilizatori (Active / Dezactivate / Toate)
  2. Toggle „Arată și organizațiile dezactivate" în lista de organizații
  3. Render diferit pentru entități dezactivate: opacity redus + badge
  4. Buton ↻ Reactivează în loc de ✕ Dezactivează pentru entități deja
     soft-deleted
  5. Endpoint-uri backend POST /admin/users/:id/reactivate și
     POST /admin/organizations/:id/reactivate
  6. Detectare conflicte la reactivare (email duplicat → 23505)

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- Endpoint-urile DELETE existente (din v3.9.435) — rămân neatinse

═══════════════════════════════════════════════════════════
PASUL 1 — Backend: GET /admin/users acceptă include_deleted
═══════════════════════════════════════════════════════════

În server/routes/admin/users.mjs, GET /admin/users (linia ~111),
modifică pentru a accepta query param `?include_deleted=1` și
include deleted_at în SELECT:

old_str:
router.get('/admin/users', async (req, res) => {
  if (requireDb(res)) return;
  const user = requireAuth(req, res); if (!user) return;
  if (!isAdminOrOrgAdmin(user)) return res.status(403).json({ error: 'forbidden' });
  try {
    // Citim orgId din DB — JWT poate fi vechi
    const { rows: selfRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [user.email.toLowerCase()]);
    const orgId = selfRows[0]?.org_id || null;
    // org_admin TREBUIE să aibă org_id setat — altfel nu poate accesa
    if (user.role === 'org_admin' && !orgId) return res.status(403).json({ error: 'org_admin_no_org', message: 'Contul de Administrator Instituție nu are o organizație asociată. Contactați super-administratorul.' });
    let query, params;
    // FIX: role='admin' (super-admin) vede TOȚI userii indiferent de org_id propriu.
    // Filtrarea pe org_id se aplică DOAR pentru org_admin.
    if (user.role === 'org_admin' && orgId) {
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users WHERE org_id=$1 AND deleted_at IS NULL ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [orgId];
    } else {
      // admin (super-admin) — vede toți userii din toate organizațiile
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users WHERE deleted_at IS NULL ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { logger.error({ err: e }, 'GET /admin/users error:'); res.status(500).json({ error: 'server_error' }); }
});

new_str:
router.get('/admin/users', async (req, res) => {
  if (requireDb(res)) return;
  const user = requireAuth(req, res); if (!user) return;
  if (!isAdminOrOrgAdmin(user)) return res.status(403).json({ error: 'forbidden' });
  try {
    // Citim orgId din DB — JWT poate fi vechi
    const { rows: selfRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [user.email.toLowerCase()]);
    const orgId = selfRows[0]?.org_id || null;
    if (user.role === 'org_admin' && !orgId) return res.status(403).json({ error: 'org_admin_no_org', message: 'Contul de Administrator Instituție nu are o organizație asociată. Contactați super-administratorul.' });

    // ?include_deleted=1 → include și utilizatorii dezactivați (deleted_at NOT NULL)
    const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
    const deletedFilter = includeDeleted ? '' : ' AND deleted_at IS NULL';

    const COLS = 'id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error,deleted_at';

    let query, params;
    if (user.role === 'org_admin' && orgId) {
      query = `SELECT ${COLS} FROM users WHERE org_id=$1${deletedFilter} ORDER BY deleted_at IS NOT NULL, institutie ASC, compartiment ASC, nume ASC`;
      params = [orgId];
    } else {
      query = `SELECT ${COLS} FROM users WHERE 1=1${deletedFilter} ORDER BY deleted_at IS NOT NULL, institutie ASC, compartiment ASC, nume ASC`;
      params = [];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { logger.error({ err: e }, 'GET /admin/users error:'); res.status(500).json({ error: 'server_error' }); }
});

NOTĂ: am adăugat `deleted_at` în SELECT (frontend-ul îl folosește
ca să discrimineze render-ul) și `ORDER BY deleted_at IS NOT NULL`
care pune dezactivații la sfârșit indiferent de cum sunt sortați
restul (PostgreSQL: FALSE < TRUE).

═══════════════════════════════════════════════════════════
PASUL 2 — Backend: POST /admin/users/:id/reactivate
═══════════════════════════════════════════════════════════

În server/routes/admin/users.mjs, IMEDIAT DUPĂ handler-ul
DELETE /admin/users/:id (sfârșitul lui, înainte de comentariul
„── PUT /admin/users/:id/assign-org"), adaugă:

router.post('/admin/users/:id/reactivate', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  try {
    // Cross-tenant: org_admin reactivează doar din propria org
    const { rows: actorRows } = await pool.query('SELECT org_id FROM users WHERE id=$1', [actor.userId]);
    const actorOrgId = actorRows[0]?.org_id || null;

    const { rows: tgtRows } = await pool.query(
      'SELECT id, email, nume, role, org_id, deleted_at FROM users WHERE id=$1',
      [targetId]
    );
    const target = tgtRows[0];
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (!target.deleted_at) return res.status(409).json({ error: 'not_deactivated', message: 'Utilizatorul este deja activ.' });

    if (actor.role === 'org_admin' && target.org_id !== actorOrgId) {
      return res.status(403).json({ error: 'forbidden', message: 'Nu poți reactiva utilizatori din altă organizație.' });
    }

    // Verificare proactivă: există alt user activ cu același email?
    const { rows: dupRows } = await pool.query(
      'SELECT id, nume FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL AND id != $2 LIMIT 1',
      [target.email, targetId]
    );
    if (dupRows.length) {
      return res.status(409).json({
        error: 'email_taken_by_active_user',
        message: `Există deja un utilizator activ cu emailul ${target.email} (${dupRows[0].nume || 'fără nume'}). Schimbă emailul utilizatorului existent înainte de reactivare.`
      });
    }

    // Verificare: organizația userului nu e dezactivată
    if (target.org_id) {
      const { rows: orgRows } = await pool.query(
        'SELECT id, name, deleted_at FROM organizations WHERE id=$1',
        [target.org_id]
      );
      if (orgRows.length && orgRows[0].deleted_at) {
        return res.status(409).json({
          error: 'org_is_deleted',
          message: `Organizația „${orgRows[0].name}" este dezactivată. Reactivează-o întâi din tab-ul Organizații.`
        });
      }
    }

    // Reactivare: clear deleted_at + bump token_version (idempotent dacă reactivat de mai multe ori)
    const { rowCount } = await pool.query(
      `UPDATE users
          SET deleted_at = NULL,
              token_version = COALESCE(token_version, 0) + 1
        WHERE id = $1 AND deleted_at IS NOT NULL`,
      [targetId]
    );
    if (!rowCount) return res.status(404).json({ error: 'user_not_found_or_not_deactivated' });

    invalidateOrgUserCache(target.org_id);
    try {
      await writeAuditEvent({
        actor_id: actor.userId,
        actor_email: actor.email,
        action: 'user.reactivated',
        target_type: 'user',
        target_id: String(targetId),
        org_id: target.org_id,
        meta: { email: target.email, nume: target.nume }
      });
    } catch(_) { /* audit non-fatal */ }

    res.json({ ok: true, reactivated: true, userId: targetId });
  } catch(e) {
    // Defensiv: 23505 înseamnă conflict pe unique index (race condition)
    if (e && e.code === '23505') {
      return res.status(409).json({
        error: 'email_taken_by_active_user',
        message: 'Emailul este deja folosit de un alt utilizator activ.'
      });
    }
    logger.error({ err: e }, 'POST /admin/users/:id/reactivate error');
    return res.status(500).json({ error: 'server_error' });
  }
});

═══════════════════════════════════════════════════════════
PASUL 3 — Backend: GET /admin/organizations cu include_deleted
═══════════════════════════════════════════════════════════

În server/routes/admin/organizations.mjs handler GET:

old_str:
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

new_str:
    const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
    const orgFilter = includeDeleted ? '' : 'WHERE o.deleted_at IS NULL';
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.cif, o.compartimente, o.webhook_url, o.webhook_events, o.webhook_enabled,
             o.webhook_secret IS NOT NULL AS webhook_has_secret,
             o.created_at, o.updated_at, o.deleted_at,
             COUNT(DISTINCT u.id) FILTER (WHERE u.deleted_at IS NULL)::int  AS user_count,
             COUNT(DISTINCT f.id)::int  AS flow_count
      FROM organizations o
      LEFT JOIN users u  ON u.org_id  = o.id
      LEFT JOIN flows f  ON f.org_id  = o.id
      ${orgFilter}
      GROUP BY o.id
      ORDER BY o.deleted_at IS NOT NULL, o.name ASC
    `);

═══════════════════════════════════════════════════════════
PASUL 4 — Backend: POST /admin/organizations/:id/reactivate
═══════════════════════════════════════════════════════════

În server/routes/admin/organizations.mjs, IMEDIAT DUPĂ handler-ul
DELETE /admin/organizations/:id (înainte de POST test-webhook),
adaugă:

  // ── POST /admin/organizations/:id/reactivate (super-admin only) ────
  router.post('/admin/organizations/:id/reactivate', csrfMiddleware, async (req, res) => {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Doar super-administratorul poate reactiva organizații.' });
    const orgId = parseInt(req.params.id);
    if (isNaN(orgId)) return res.status(400).json({ error: 'invalid_id' });
    try {
      const { rows } = await pool.query(
        'SELECT id, name, deleted_at FROM organizations WHERE id=$1',
        [orgId]
      );
      const org = rows[0];
      if (!org) return res.status(404).json({ error: 'org_not_found' });
      if (!org.deleted_at) return res.status(409).json({ error: 'not_deleted', message: 'Organizația este deja activă.' });

      const { rowCount } = await pool.query(
        'UPDATE organizations SET deleted_at = NULL WHERE id=$1 AND deleted_at IS NOT NULL',
        [orgId]
      );
      if (!rowCount) return res.status(404).json({ error: 'org_not_found_or_already_active' });

      try {
        await writeAuditEvent({
          actor_id: actor.userId,
          actor_email: actor.email,
          action: 'organization.reactivated',
          target_type: 'organization',
          target_id: String(orgId),
          org_id: orgId,
          meta: { name: org.name },
        });
      } catch(_) { /* audit non-fatal */ }

      res.json({ ok: true, reactivated: true, orgId });
    } catch(e) {
      logger.error({ err: e, orgId }, 'POST /admin/organizations/:id/reactivate error');
      res.status(500).json({ error: 'server_error' });
    }
  });

═══════════════════════════════════════════════════════════
PASUL 5 — Frontend: filtru status + render dezactivați (USERS)
═══════════════════════════════════════════════════════════

5.1 — public/js/admin/users.js: în loadUsers(), citește filtrul și
      trimite include_deleted la backend.

old_str:
  async function loadUsers(){
    try{
      const r=await _apiFetch("/admin/users",{headers:hdrs()});

new_str:
  async function loadUsers(){
    try{
      const showInactive = window._userStatusFilter === 'all' || window._userStatusFilter === 'deactivated';
      const url = '/admin/users' + (showInactive ? '?include_deleted=1' : '');
      const r=await _apiFetch(url,{headers:hdrs()});

5.2 — public/js/admin/users.js: în filterUsers(), aplică și filtrul
      pe status local (după ce backend-ul a returnat lista).

old_str:
    const fR=($('fRol')||{value:''}).value.toLowerCase();
    const filtered=window._allUsers.filter(u=>
      (!fN||( u.nume||'').toLowerCase().includes(fN))&&
      (!fF||(u.functie||'').toLowerCase().includes(fF))&&
      (!fI||(u.institutie||'').toLowerCase().includes(fI))&&
      (!fE||(u.email||'').toLowerCase().includes(fE))&&
      (!fC||(u.compartiment||'').toLowerCase().includes(fC))&&
      (!fR||(u.role||'').toLowerCase()===fR)
    );

new_str:
    const fR=($('fRol')||{value:''}).value.toLowerCase();
    const fS=window._userStatusFilter || 'active';  // active | deactivated | all
    const filtered=window._allUsers.filter(u=>
      (!fN||( u.nume||'').toLowerCase().includes(fN))&&
      (!fF||(u.functie||'').toLowerCase().includes(fF))&&
      (!fI||(u.institutie||'').toLowerCase().includes(fI))&&
      (!fE||(u.email||'').toLowerCase().includes(fE))&&
      (!fC||(u.compartiment||'').toLowerCase().includes(fC))&&
      (!fR||(u.role||'').toLowerCase()===fR)&&
      (fS==='all' || (fS==='deactivated' ? !!u.deleted_at : !u.deleted_at))
    );

5.3 — public/js/admin/users.js: în renderPage(), styleaza rândurile
      dezactivate și înlocuiește butonul ✕ cu ↻ pentru ele.

old_str:
    pageUsers.forEach(u=>{
      const tr=document.createElement("tr");
      tr.id="row_"+u.id;
      tr.style.cursor="pointer";
      tr.addEventListener("dblclick", ()=>openEdit(u));
      const dt=u.created_at?new Date(u.created_at).toLocaleDateString("ro-RO"):"—";
      const isMe=u.email===me.email;

new_str:
    pageUsers.forEach(u=>{
      const tr=document.createElement("tr");
      tr.id="row_"+u.id;
      tr.style.cursor="pointer";
      tr.addEventListener("dblclick", ()=>openEdit(u));
      const dt=u.created_at?new Date(u.created_at).toLocaleDateString("ro-RO"):"—";
      const isMe=u.email===me.email;
      const isDeactivated = !!u.deleted_at;
      if (isDeactivated) {
        tr.style.opacity = '.55';
        tr.style.background = 'rgba(255,80,80,.04)';
      }

old_str:
        <td><span class="pill ${u.role}">${u.role==="org_admin"?"Admin Instituție":u.role==="admin"?"Admin":"User"}</span></td>

new_str:
        <td><span class="pill ${u.role}">${u.role==="org_admin"?"Admin Instituție":u.role==="admin"?"Admin":"User"}</span>${isDeactivated?` <span style="display:inline-block;margin-left:4px;padding:1px 7px;border-radius:8px;font-size:.68rem;font-weight:700;background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.35);color:#ff8a8a;">DEZACTIVAT</span>`:''}</td>

old_str:
            ${!isMe?`<button class="df-action-btn danger sm" onclick="delUser(${u.id},'${esc(u.nume||u.email)}')" title="Dezactivează">✕</button>`:""}

new_str:
            ${isDeactivated
              ? `<button class="df-action-btn sm" onclick="reactivateUser(${u.id},'${esc(u.nume||u.email)}')" title="Reactivează" style="background:rgba(45,212,191,.15);border-color:rgba(45,212,191,.4);color:#2dd4bf;">↻</button>`
              : (!isMe?`<button class="df-action-btn danger sm" onclick="delUser(${u.id},'${esc(u.nume||u.email)}')" title="Dezactivează">✕</button>`:"")}

5.4 — public/admin.html: adaugă filtrul de status în filterRow
      din tab Utilizatori. Caută `<select class="th-filter" onchange="filterUsers()" id="fRol"`
      din `public/js/admin/users.js` (rendat dinamic). NU în HTML
      static — în JS, în secțiunea „<thead><tr id="filterRow">".

      Modifică în public/js/admin/users.js, în tabelul rendat în
      loadUsers (sec ~285-305):

old_str:
          <th><select class="th-filter" onchange="filterUsers()" id="fRol" style="padding:4px 6px;">
            <option value="">Toate</option>
            <option value="admin">Admin</option>
            <option value="org_admin">Admin Instituție</option>
            <option value="user">User</option>
          </select></th>
          <th></th><th></th>
        </tr>
      </thead><tbody id="tb"></tbody></table>`;

new_str:
          <th><select class="th-filter" onchange="filterUsers()" id="fRol" style="padding:4px 6px;">
            <option value="">Toate</option>
            <option value="admin">Admin</option>
            <option value="org_admin">Admin Instituție</option>
            <option value="user">User</option>
          </select></th>
          <th></th>
          <th><select class="th-filter" onchange="onUserStatusChange()" id="fStatus" style="padding:4px 6px;">
            <option value="active">Activi</option>
            <option value="deactivated">Doar dezactivați</option>
            <option value="all">Toți</option>
          </select></th>
        </tr>
      </thead><tbody id="tb"></tbody></table>`;
      // Restaurează valoarea selectată după re-render
      setTimeout(()=>{ const s=$('fStatus'); if(s) s.value=window._userStatusFilter||'active'; },0);

5.5 — public/js/admin/users.js: adaugă funcția onUserStatusChange
      (ÎNAINTE de filterUsers):

ADAUGĂ:
  function onUserStatusChange() {
    window._userStatusFilter = ($('fStatus')||{value:'active'}).value;
    // Filtrul 'active' folosește lista deja filtrată din backend (fără ?include_deleted)
    // Filtrele 'deactivated' și 'all' au nevoie să reîncarce backend-ul cu include_deleted=1
    loadUsers();
  }

ȘI la finalul IIFE, lângă celelalte window.X = X, adaugă:
  window.onUserStatusChange = onUserStatusChange;
  window.reactivateUser     = reactivateUser;

NOTĂ: `reactivateUser` este definită în admin.js (PASUL 6). Linia
window.reactivateUser deja-existentă din admin.js o face globală;
adăugarea aici e redundantă dar safe.

═══════════════════════════════════════════════════════════
PASUL 6 — Frontend: funcția reactivateUser în admin.js
═══════════════════════════════════════════════════════════

În public/js/admin/admin.js, IMEDIAT DUPĂ funcția delUser, adaugă:

old_str:
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

new_str:
async function delUser(id,name){
  if(!confirm('Dezactivezi utilizatorul "'+name+'"?\n\nUtilizatorul nu va mai putea face login, dar istoricul (fluxuri, semnături, audit) este păstrat.\n\nÎl poți reactiva oricând din lista de utilizatori (filtru „Doar dezactivați").'))return;
  try {
    const r=await _apiFetch("/admin/users/"+id,{method:"DELETE",headers:hdrs()});
    const data = await r.json().catch(()=>({}));
    if(r.ok){
      // Dacă filtrul e 'active', rândul dispare; dacă e 'all'/'deactivated', re-load ca să-l vedem ca dezactivat
      if (window._userStatusFilter === 'active' || !window._userStatusFilter) {
        const row=$("row_"+id);if(row)row.remove();
      } else if (typeof loadUsers === 'function') {
        loadUsers();
      }
    } else {
      alert(data.message || ('Eroare la dezactivare: '+(data.error||r.status)));
    }
  } catch(e) {
    alert('Eroare de rețea: '+e.message);
  }
}

async function reactivateUser(id,name){
  if(!confirm('Reactivezi utilizatorul "'+name+'"?\n\nUtilizatorul va putea face login din nou.'))return;
  try {
    const r=await _apiFetch("/admin/users/"+id+"/reactivate",{method:"POST",headers:hdrs()});
    const data = await r.json().catch(()=>({}));
    if(r.ok){
      if (typeof loadUsers === 'function') loadUsers();
    } else {
      alert(data.message || ('Eroare la reactivare: '+(data.error||r.status)));
    }
  } catch(e) {
    alert('Eroare de rețea: '+e.message);
  }
}

═══════════════════════════════════════════════════════════
PASUL 7 — Frontend: toggle + render dezactivate (ORGS)
═══════════════════════════════════════════════════════════

7.1 — public/js/admin/organizations.js: în loadOrganizations, citește
      starea toggle-ului și trimite include_deleted la backend.

old_str:
  async function loadOrganizations() {
    const area = $('org-list-area');
    if (!area) return;
    try {
      const r = await _apiFetch('/admin/organizations', { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const orgs = await r.json();

new_str:
  async function loadOrganizations() {
    const area = $('org-list-area');
    if (!area) return;
    try {
      const showInactive = !!window._orgShowInactive;
      const url = '/admin/organizations' + (showInactive ? '?include_deleted=1' : '');
      const r = await _apiFetch(url, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const orgs = await r.json();

7.2 — public/js/admin/organizations.js: modifică render-ul cardului
      pentru a arăta diferit orgs dezactivate și butonul Reactivează.

old_str:
      area.innerHTML = orgs.map(org => `
        <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 24px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
                <div style="font-size:1rem;font-weight:700;color:#eaf0ff;">🏛 ${esc(org.name)}</div>
                ${org.name === 'Default Organization' ? '<span style="font-size:.72rem;padding:2px 8px;background:rgba(255,176,32,.15);border:1px solid rgba(255,176,32,.35);border-radius:10px;color:#ffd580;">⚠ organizație principală — redenumește</span>' : ''}
              </div>
              <div style="font-size:.78rem;color:var(--muted);">
                👥 ${org.user_count} utilizatori &nbsp;·&nbsp; 📁 ${org.flow_count} fluxuri
                ${org.cif ? `&nbsp;·&nbsp; CIF: ${esc(org.cif)}` : ''}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="df-action-btn" onclick="openRenameOrgModal(${org.id},'${esc(org.name)}')">✏️ Redenumește</button>
              <button class="df-action-btn" onclick="openOrgModal(${org.id},'${esc(org.name)}')" style="background:rgba(124,92,255,.12);border-color:rgba(124,92,255,.3);color:#b39dff;">⚙ Configurare</button>
              ${window._currentUserRole === 'admin' ? `<button class="df-action-btn danger" onclick="openDeleteOrgModal(${org.id},'${esc(org.name)}',${org.user_count||0},${org.flow_count||0})" title="Șterge organizație">🗑 Șterge</button>` : ''}
            </div>
          </div>
          <div style="margin-top:14px;font-size:.8rem;">
            ${org.webhook_url ? `
            <div style="color:rgba(234,240,255,.55);">
              🔗 Webhook: <code style="font-size:.76rem;background:rgba(255,255,255,.04);padding:2px 6px;border-radius:4px;">${esc(org.webhook_url)}</code>
              <span style="margin-left:6px;font-size:.7rem;padding:1px 7px;border-radius:8px;background:${org.webhook_enabled?'rgba(45,212,191,.12)':'rgba(255,255,255,.05)'};color:${org.webhook_enabled?'#2dd4bf':'rgba(234,240,255,.35)'};border:1px solid ${org.webhook_enabled?'rgba(45,212,191,.3)':'rgba(255,255,255,.08)'};">${org.webhook_enabled?'activ':'inactiv'}</span>
            </div>
            <div style="color:var(--muted);margin-top:6px;">
              Evenimente: ${(org.webhook_events||[]).join(', ') || '—'}
            </div>` : `
            <span style="color:var(--muted);">⚪ Webhook neconfigurat</span>`}
          </div>
        </div>
      `).join('');

new_str:
      area.innerHTML = orgs.map(org => {
        const isDeactivated = !!org.deleted_at;
        const cardStyle = isDeactivated
          ? 'background:rgba(255,80,80,.04);border:1px solid rgba(255,80,80,.18);border-radius:14px;padding:20px 24px;opacity:.7;'
          : 'background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 24px;';
        const actions = isDeactivated
          ? (window._currentUserRole === 'admin'
              ? `<button class="df-action-btn" onclick="reactivateOrg(${org.id},'${esc(org.name)}')" style="background:rgba(45,212,191,.15);border-color:rgba(45,212,191,.4);color:#2dd4bf;">↻ Reactivează</button>`
              : '')
          : `
              <button class="df-action-btn" onclick="openRenameOrgModal(${org.id},'${esc(org.name)}')">✏️ Redenumește</button>
              <button class="df-action-btn" onclick="openOrgModal(${org.id},'${esc(org.name)}')" style="background:rgba(124,92,255,.12);border-color:rgba(124,92,255,.3);color:#b39dff;">⚙ Configurare</button>
              ${window._currentUserRole === 'admin' ? `<button class="df-action-btn danger" onclick="openDeleteOrgModal(${org.id},'${esc(org.name)}',${org.user_count||0},${org.flow_count||0})" title="Șterge organizație">🗑 Șterge</button>` : ''}`;
        return `
        <div style="${cardStyle}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
                <div style="font-size:1rem;font-weight:700;color:#eaf0ff;">🏛 ${esc(org.name)}</div>
                ${isDeactivated ? '<span style="font-size:.72rem;padding:2px 8px;background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.35);border-radius:10px;color:#ff8a8a;">DEZACTIVATĂ</span>' : ''}
                ${(!isDeactivated && org.name === 'Default Organization') ? '<span style="font-size:.72rem;padding:2px 8px;background:rgba(255,176,32,.15);border:1px solid rgba(255,176,32,.35);border-radius:10px;color:#ffd580;">⚠ organizație principală — redenumește</span>' : ''}
              </div>
              <div style="font-size:.78rem;color:var(--muted);">
                👥 ${org.user_count} utilizatori &nbsp;·&nbsp; 📁 ${org.flow_count} fluxuri
                ${org.cif ? `&nbsp;·&nbsp; CIF: ${esc(org.cif)}` : ''}
                ${isDeactivated ? `&nbsp;·&nbsp; <span style="color:#ff8a8a;">dezactivată ${new Date(org.deleted_at).toLocaleDateString('ro-RO')}</span>` : ''}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">${actions}</div>
          </div>
          ${!isDeactivated ? `
          <div style="margin-top:14px;font-size:.8rem;">
            ${org.webhook_url ? `
            <div style="color:rgba(234,240,255,.55);">
              🔗 Webhook: <code style="font-size:.76rem;background:rgba(255,255,255,.04);padding:2px 6px;border-radius:4px;">${esc(org.webhook_url)}</code>
              <span style="margin-left:6px;font-size:.7rem;padding:1px 7px;border-radius:8px;background:${org.webhook_enabled?'rgba(45,212,191,.12)':'rgba(255,255,255,.05)'};color:${org.webhook_enabled?'#2dd4bf':'rgba(234,240,255,.35)'};border:1px solid ${org.webhook_enabled?'rgba(45,212,191,.3)':'rgba(255,255,255,.08)'};">${org.webhook_enabled?'activ':'inactiv'}</span>
            </div>
            <div style="color:var(--muted);margin-top:6px;">
              Evenimente: ${(org.webhook_events||[]).join(', ') || '—'}
            </div>` : `
            <span style="color:var(--muted);">⚪ Webhook neconfigurat</span>`}
          </div>` : ''}
        </div>`;
      }).join('');

7.3 — public/js/admin/organizations.js: adaugă funcția reactivateOrg
      ÎNAINTE de „async function loadOrgSigningProviders":

  async function reactivateOrg(id, name) {
    if (!confirm('Reactivezi organizația „'+name+'"?')) return;
    try {
      const r = await _apiFetch('/admin/organizations/'+id+'/reactivate', {
        method: 'POST',
        headers: hdrs()
      });
      const data = await r.json().catch(()=>({}));
      if (r.ok) {
        if (typeof loadOrganizations === 'function') loadOrganizations();
      } else {
        alert(data.message || ('Eroare la reactivare: '+(data.error||r.status)));
      }
    } catch(e) {
      alert('Eroare de rețea: '+e.message);
    }
  }

  function toggleShowInactiveOrgs() {
    window._orgShowInactive = !window._orgShowInactive;
    const btn = document.getElementById('btnToggleInactiveOrgs');
    if (btn) {
      btn.innerHTML = window._orgShowInactive
        ? '<svg class="df-ico" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.436#ico-eye"/></svg> Ascunde dezactivatele'
        : '<svg class="df-ico" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.436#ico-eye"/></svg> Arată și dezactivatele';
    }
    loadOrganizations();
  }

ȘI la finalul IIFE, lângă celelalte window.X = X exports, adaugă:
  window.reactivateOrg          = reactivateOrg;
  window.toggleShowInactiveOrgs = toggleShowInactiveOrgs;

7.4 — public/admin.html: adaugă butonul de toggle în tab-ul organizatii,
      lângă „Instituție nouă".

old_str:
<div id="tab-organizatii" style="display:none;">
  <div style="display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
    <button onclick="openOnboardingWizard()" class="df-action-btn lg primary">
      <svg class="df-ico" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.435#ico-plus"/></svg>
      Instituție nouă
    </button>
  </div>

new_str:
<div id="tab-organizatii" style="display:none;">
  <div style="display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
    <button id="btnToggleInactiveOrgs" onclick="toggleShowInactiveOrgs()" class="df-action-btn ghost">
      <svg class="df-ico" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.436#ico-eye"/></svg>
      Arată și dezactivatele
    </button>
    <button onclick="openOnboardingWizard()" class="df-action-btn lg primary">
      <svg class="df-ico" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.436#ico-plus"/></svg>
      Instituție nouă
    </button>
  </div>

NOTĂ: dacă icon-ul `ico-eye` nu există în /public/icons.svg, scoate
elementul <svg> și lasă doar textul. Verifică cu:
  grep "id=\"ico-eye\"" public/icons.svg

═══════════════════════════════════════════════════════════
PASUL 8 — Cache busting (3.9.435 → 3.9.436, SW v151 → v152)
═══════════════════════════════════════════════════════════

8.1 — package.json:
  old_str:   "version": "3.9.435",
  new_str:   "version": "3.9.436",

8.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v151';
  new_str: const CACHE_VERSION = 'docflowai-v152';

8.3 — public/admin.html (sed bulk pe ~100 referințe):
  sed -i 's/v=3\.9\.435/v=3.9.436/g' public/admin.html

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Endpoint reactivate user există:
   grep -c "router.post.*/admin/users/:id/reactivate" server/routes/admin/users.mjs
   → 1

2. Endpoint reactivate org există:
   grep -c "router.post.*/admin/organizations/:id/reactivate" server/routes/admin/organizations.mjs
   → 1

3. Backend acceptă include_deleted:
   grep -c "include_deleted" server/routes/admin/users.mjs server/routes/admin/organizations.mjs
   → ≥ 4 (2 query parsing + 2 query SQL în fiecare fișier — minim)

4. Frontend are funcțiile reactivate:
   grep -c "reactivateUser\b" public/js/admin/admin.js
   → ≥ 2 (definiție + window export indirect prin nume global)
   grep -c "reactivateOrg\b" public/js/admin/organizations.js
   → ≥ 3 (definiție + window export + onclick)

5. Filtru status în UI users:
   grep -c "fStatus\|onUserStatusChange\|_userStatusFilter" public/js/admin/users.js
   → ≥ 5

6. Toggle org în UI:
   grep -c "btnToggleInactiveOrgs\|toggleShowInactiveOrgs" public/admin.html public/js/admin/organizations.js
   → ≥ 4

7. Cache busting aplicat:
   grep -c "v=3.9.436" public/admin.html
   → ~100
   grep -c "v=3.9.435" public/admin.html
   → 0
   grep "^const CACHE_VERSION" public/sw.js
   → docflowai-v152
   grep '"version"' package.json
   → 3.9.436

8. Sintaxă OK:
   node --check public/js/admin/users.js
   node --check public/js/admin/admin.js
   node --check public/js/admin/organizations.js
   node --check public/sw.js
   npm run check

9. TESTE — verde, fără regresii:
   npm test
   ATENȚIE: testele care fac GET /admin/users vor primi acum și
   coloana deleted_at în rezultate (în plus față de înainte). Dacă
   există assertion-uri stricte pe forma exactă a obiectului user
   returnat de listare, ele ar putea avea nevoie de actualizare
   (păstrăm deleted_at: null implicit).

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/routes/admin/users.mjs \
        server/routes/admin/organizations.mjs \
        public/js/admin/admin.js \
        public/js/admin/users.js \
        public/js/admin/organizations.js \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "feat(admin): reactivare entitati soft-deleted (v3.9.436)

Continuare la v3.9.435 — fara reactivare, soft-delete era functional
indistinct de hard-delete pentru admin. Acum:

USERS:
- GET /admin/users accepta ?include_deleted=1
- POST /admin/users/:id/reactivate (admin/org_admin)
  - Detecteaza conflict: email folosit de alt user activ → 409
  - Detecteaza conflict: organizatie dezactivata → 409
  - Bumpa token_version la reactivare (curatare cache JWT vechi)
- UI: filtru 'Activi / Dezactivati / Toti' in filterRow
- UI: render dezactivati cu opacity .55 + badge DEZACTIVAT
- UI: buton ↻ Reactiveaza in loc de ✕ Dezactiveaza

ORGS:
- GET /admin/organizations accepta ?include_deleted=1
- POST /admin/organizations/:id/reactivate (super-admin only)
- UI: toggle 'Arata si dezactivatele' in toolbar
- UI: card dezactivat cu border rosu + opacity + badge + data deactivare
- UI: ascunde sectiunea webhook pe card-urile dezactivate
- UI: buton ↻ Reactiveaza inlocuieste actiunile normale

Audit events: user.reactivated + organization.reactivated.

Cache: package 3.9.435 -> 3.9.436, SW v151 -> v152."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging)
═══════════════════════════════════════════════════════════

1. /admin → tab Utilizatori → filtrul implicit „Activi" → mirceabarbu
   nu apare (e dezactivat din v3.9.435)

2. Schimbă filtrul la „Doar dezactivați" → mirceabarbu apare cu opacity
   redus + badge roșu „DEZACTIVAT" + buton ↻ verde

3. Click ↻ Reactivează → confirmă → rândul reaparare cu styling normal,
   buton ✕ standard
   → Mircea poate face din nou login

4. Test conflict email:
   - Dezactivează „test2@docflowai.ro"
   - Creează un alt user nou cu același email „test2@docflowai.ro"
     (trebuie să meargă datorită partial unique index)
   - Încearcă să reactivezi userul vechi → eroare 409 cu mesaj util

5. /admin → tab Organizații → click „Arată și dezactivatele"
   → orgs dezactivate apar la sfârșit cu border roșu + badge
   → buton ↻ Reactivează vizibil (doar pentru super-admin)

6. Reactivează o org → revine la stilul normal, butoanele Configurare
   și Șterge devin disponibile din nou

7. Test conflict org dezactivată:
   - Dezactivează userul X dintr-o org Y
   - Dezactivează org Y (după ce ai dezactivat toți userii)
   - Reactivează org Y → OK
   - Reactivează userul X → OK
   - Dacă ai încercat invers (user înainte de org) → eroare 409
     „Organizația X este dezactivată"
```
