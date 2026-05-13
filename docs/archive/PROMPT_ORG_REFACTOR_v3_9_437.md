# DocFlowAI — 🏛 REFACTOR ORG ADMIN UI: TABLE + DETAIL VIEW (v3.9.437)

```
DocFlowAI v3.9.436 → v3.9.437 (SW v152 → v153)
Branch: develop
Subiect: feat(admin): tab Organizații rebuild — tabel + pagină dedicată cu 5 sub-tabs

═══════════════════════════════════════════════════════════
CONTEXT — DE CE REFACTOR
═══════════════════════════════════════════════════════════

UI-ul actual al tab-ului Organizații are 3 probleme majore:

1. „Configurare" e un dump-all-modal: CIF + compartimente + webhook +
   signing providers (cu config STS specific) într-o singură fereastră
   de 580px. La 5+ provideri și 10 compartimente devine ilizibilă.

2. Card-list este nepotrivit la scale: la 50+ primării lista devine
   foarte lungă și nu există căutare/filtrare/sortare.

3. Lipsesc complet statistici per organizație: nu vezi câți useri are
   activi vs dezactivați, câte fluxuri în derulare, ultima activitate.

În această livrare:

  • Cardurile devin TABEL cu căutare + sortare + filtrare status.
  • Modalul „Configurare" este DEMOLAT și înlocuit cu o pagină dedicată
    (sub-view în interiorul tab-ului) cu 5 sub-tab-uri:
       General · Utilizatori · Webhook · Signing Providers · Statistici
  • 2 endpoint-uri noi backend: GET /admin/organizations/:id (single)
    și GET /admin/organizations/:id/stats (KPI per organizație).
  • Hash routing: #organizatii deschide lista, #organizatii/:id deschide
    detaliile (bookmarkabil + back/forward funcțional).

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- Endpoint-urile DELETE / reactivate adăugate în v3.9.435/436 — neatinse
- Modalul renameOrgModal, deleteOrgModal, onboardingModal, assignOrgModal
  — rămân exact așa cum sunt, doar referite din noul UI

═══════════════════════════════════════════════════════════
PASUL 1 — Backend: GET /admin/organizations/:id (single)
═══════════════════════════════════════════════════════════

În server/routes/admin/organizations.mjs, IMEDIAT DUPĂ handler-ul
GET /admin/organizations (linia ~37, după închiderea router.get-ului
pentru listă), adaugă:

  // ── GET /admin/organizations/:id — detaliile unei organizații ──
  router.get('/admin/organizations/:id', async (req, res) => {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const orgId = parseInt(req.params.id);
    if (isNaN(orgId)) return res.status(400).json({ error: 'invalid_id' });
    try {
      // Verificăm dacă există coloana signing_providers_enabled (mig 033)
      const { rows: colCheck } = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name='organizations' AND column_name='signing_providers_enabled' LIMIT 1`
      );
      const hasSigning = colCheck.length > 0;
      const signingCols = hasSigning ? ', signing_providers_enabled, signing_providers_config' : '';

      const { rows } = await pool.query(`
        SELECT id, name, cif, compartimente,
               webhook_url, webhook_events, webhook_enabled,
               webhook_secret IS NOT NULL AS webhook_has_secret,
               created_at, updated_at, deleted_at${signingCols}
        FROM organizations WHERE id=$1
      `, [orgId]);
      if (!rows.length) return res.status(404).json({ error: 'org_not_found' });
      res.json(rows[0]);
    } catch(e) {
      logger.error({ err: e, orgId }, 'GET /admin/organizations/:id error');
      res.status(500).json({ error: 'server_error' });
    }
  });

═══════════════════════════════════════════════════════════
PASUL 2 — Backend: GET /admin/organizations/:id/stats
═══════════════════════════════════════════════════════════

În server/routes/admin/organizations.mjs, IMEDIAT DUPĂ handler-ul
GET /admin/organizations/:id de la PASUL 1, adaugă:

  // ── GET /admin/organizations/:id/stats — KPI per organizație ──
  router.get('/admin/organizations/:id/stats', async (req, res) => {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const orgId = parseInt(req.params.id);
    if (isNaN(orgId)) return res.status(400).json({ error: 'invalid_id' });
    try {
      // Verificăm că org-ul există (chiar și dacă e soft-deleted)
      const { rows: orgRows } = await pool.query(
        'SELECT id, name, deleted_at FROM organizations WHERE id=$1',
        [orgId]
      );
      if (!orgRows.length) return res.status(404).json({ error: 'org_not_found' });

      // Statistici users
      const { rows: uStats } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
          COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deactivated,
          COUNT(*) FILTER (WHERE deleted_at IS NULL AND role='admin')::int AS admins,
          COUNT(*) FILTER (WHERE deleted_at IS NULL AND role='org_admin')::int AS org_admins,
          COUNT(*) FILTER (WHERE deleted_at IS NULL AND role='user')::int AS users
        FROM users WHERE org_id=$1
      `, [orgId]);

      // Statistici flows (folosim aceeași convenție ca analytics.mjs)
      const { rows: fStats } = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE (data->>'completed')='true')::int AS completed,
          COUNT(*) FILTER (WHERE (data->>'status')='refused')::int AS refused,
          COUNT(*) FILTER (WHERE (data->>'status')='cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE (data->>'completed') IS DISTINCT FROM 'true'
            AND (data->>'status') NOT IN ('refused','cancelled','review_requested'))::int AS active,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last_7_days,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last_30_days,
          MAX(updated_at) AS last_activity,
          ROUND(AVG(
            CASE WHEN (data->>'completed')='true' AND (data->>'completedAt') IS NOT NULL
            THEN EXTRACT(EPOCH FROM (
              (data->>'completedAt')::timestamptz - created_at
            ))/3600
            END
          )::numeric, 1) AS avg_completion_hours
        FROM flows WHERE org_id=$1 AND deleted_at IS NULL
      `, [orgId]);

      res.json({
        org_id: orgId,
        users: uStats[0] || { active: 0, deactivated: 0, admins: 0, org_admins: 0, users: 0 },
        flows: fStats[0] || { total: 0, completed: 0, refused: 0, cancelled: 0, active: 0,
                              last_7_days: 0, last_30_days: 0, last_activity: null,
                              avg_completion_hours: null },
      });
    } catch(e) {
      logger.error({ err: e, orgId }, 'GET /admin/organizations/:id/stats error');
      res.status(500).json({ error: 'server_error' });
    }
  });

═══════════════════════════════════════════════════════════
PASUL 3 — Backend: extinde GET /admin/organizations cu last_activity
═══════════════════════════════════════════════════════════

În handler-ul GET /admin/organizations existent, adaugă MAX(f.updated_at)
ca să afișăm ultima activitate în coloana din tabel.

old_str:
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

new_str:
    const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
    const orgFilter = includeDeleted ? '' : 'WHERE o.deleted_at IS NULL';
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.cif, o.compartimente, o.webhook_url, o.webhook_events, o.webhook_enabled,
             o.webhook_secret IS NOT NULL AS webhook_has_secret,
             o.created_at, o.updated_at, o.deleted_at,
             COUNT(DISTINCT u.id) FILTER (WHERE u.deleted_at IS NULL)::int  AS user_count,
             COUNT(DISTINCT f.id) FILTER (WHERE f.deleted_at IS NULL)::int  AS flow_count,
             MAX(f.updated_at) FILTER (WHERE f.deleted_at IS NULL)         AS last_activity
      FROM organizations o
      LEFT JOIN users u  ON u.org_id  = o.id
      LEFT JOIN flows f  ON f.org_id  = o.id
      ${orgFilter}
      GROUP BY o.id
      ORDER BY o.deleted_at IS NOT NULL, o.name ASC
    `);

═══════════════════════════════════════════════════════════
PASUL 4 — HTML: rescriere completă a tab-organizatii
═══════════════════════════════════════════════════════════

Tab-ul are mai multe secțiuni — modal-uri (onboarding, deleteOrg etc.)
și conținut. Vom REȘINE TOATE MODAL-URILE EXISTENTE (onboardingModal,
deleteOrgModal, renameOrgModal — toate sunt încă folosite din butoanele
din detail view) ȘI VOM ȘTERGE orgEditModal (înlocuit de detail view).

4.1 — Înlocuiește toolbar-ul de la începutul tab-ului:

old_str:
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

new_str:
<div id="tab-organizatii" style="display:none;">

  <!-- ═══════════════ LIST VIEW (tabel + toolbar) ═══════════════ -->
  <div id="org-list-view">
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:18px;">
      <input id="orgSearchInput" type="text" placeholder="🔍 Caută după nume sau CIF..." oninput="filterOrgsTable()"
        style="flex:1;min-width:220px;max-width:400px;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.88rem;outline:none;font-family:inherit;"/>
      <select id="orgStatusFilter" class="df-filter-select" onchange="onOrgStatusChange()" style="width:auto;max-width:200px;cursor:pointer;">
        <option value="active">Doar active</option>
        <option value="all">Toate</option>
        <option value="deactivated">Doar dezactivate</option>
      </select>
      <div style="flex:1;"></div>
      <button onclick="openOnboardingWizard()" class="df-action-btn lg primary">
        <svg class="df-ico" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.436#ico-plus"/></svg>
        Instituție nouă
      </button>
    </div>

    <div id="org-table-wrap" style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;overflow:hidden;">
      <table id="org-table" style="width:100%;border-collapse:collapse;font-size:.86rem;">
        <thead style="background:rgba(124,92,255,.08);">
          <tr>
            <th style="text-align:left;padding:12px 16px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">Nume</th>
            <th style="text-align:left;padding:12px 8px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">CIF</th>
            <th style="text-align:right;padding:12px 8px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">Useri</th>
            <th style="text-align:right;padding:12px 8px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">Fluxuri</th>
            <th style="text-align:center;padding:12px 8px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">Webhook</th>
            <th style="text-align:center;padding:12px 8px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">Status</th>
            <th style="text-align:left;padding:12px 8px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">Ultima activitate</th>
            <th style="text-align:right;padding:12px 16px;font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:rgba(234,240,255,.55);">Acțiuni</th>
          </tr>
        </thead>
        <tbody id="org-table-body"></tbody>
      </table>
      <div id="org-table-empty" style="display:none;padding:48px 24px;text-align:center;color:var(--muted);">Nicio organizație găsită.</div>
    </div>
  </div>

  <!-- ═══════════════ DETAIL VIEW (sub-tabs per organizație) ═══════════════ -->
  <div id="org-detail-view" style="display:none;">
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:18px;">
      <button class="df-action-btn ghost" onclick="closeOrgDetail()">
        <svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-arrow-left"/></svg>
        Înapoi la listă
      </button>
      <div style="flex:1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:200px;">
        <h2 id="orgDetailHeader" style="margin:0;font-size:1.15rem;color:#eaf0ff;font-weight:700;">🏛 <span id="orgDetailName">—</span></h2>
        <span id="orgDetailStatusBadge"></span>
      </div>
      <div id="orgDetailActions" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
    </div>

    <!-- Sub-tab nav -->
    <div style="display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:18px;">
      <button class="df-subtab-btn active" data-subtab="general" onclick="switchOrgSubTab('general')">⚙ General</button>
      <button class="df-subtab-btn" data-subtab="users"   onclick="switchOrgSubTab('users')">👥 Utilizatori</button>
      <button class="df-subtab-btn" data-subtab="webhook" onclick="switchOrgSubTab('webhook')">🔗 Webhook</button>
      <button class="df-subtab-btn" data-subtab="signing" onclick="switchOrgSubTab('signing')">🔐 Signing Providers</button>
      <button class="df-subtab-btn" data-subtab="stats"   onclick="switchOrgSubTab('stats')">📊 Statistici</button>
    </div>

    <!-- ─── Sub-tab General ─── -->
    <div id="org-subtab-general" class="org-subtab-panel">
      <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 24px;max-width:720px;">
        <div style="font-size:.78rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px;">Date generale</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
          <div>
            <label style="display:block;font-size:.78rem;color:var(--muted);margin-bottom:5px;">CIF Instituție</label>
            <input id="orgCif" type="text" maxlength="10" placeholder="ex: 1234567"
              style="width:100%;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.88rem;box-sizing:border-box;"/>
            <div style="font-size:.72rem;color:var(--muted);margin-top:3px;">Folosit la auto-completare formulare</div>
          </div>
          <div>
            <label style="display:block;font-size:.78rem;color:var(--muted);margin-bottom:5px;">Compartimente instituție</label>
            <input id="orgCompartimenteInput" type="text" placeholder="Adaugă compartiment + Enter"
              style="width:100%;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.88rem;box-sizing:border-box;"
              onkeydown="if(event.key==='Enter'){event.preventDefault();orgAddCompartiment();}"/>
          </div>
        </div>
        <div id="orgCompartimenteList" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:18px;min-height:24px;"></div>

        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.78rem;color:var(--muted);padding-top:14px;border-top:1px solid rgba(255,255,255,.06);margin-bottom:14px;">
          <div>📅 Creat: <span id="orgDetailCreatedAt" style="color:rgba(234,240,255,.7);">—</span></div>
          <div>🔄 Actualizat: <span id="orgDetailUpdatedAt" style="color:rgba(234,240,255,.7);">—</span></div>
        </div>

        <div style="display:flex;justify-content:flex-end;">
          <button class="df-action-btn primary" onclick="saveOrgGeneral()">
            <svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-save"/></svg>Salvează
          </button>
        </div>
        <div id="orgGeneralMsg" style="margin-top:10px;font-size:.83rem;text-align:right;"></div>
      </div>

      <!-- Zona periculoasă -->
      <div id="orgDangerZone" style="margin-top:20px;background:rgba(255,80,80,.04);border:1px solid rgba(255,80,80,.18);border-radius:14px;padding:20px 24px;max-width:720px;">
        <div style="font-size:.78rem;color:#ff8a8a;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">⚠ Zona periculoasă</div>
        <div id="orgDangerZoneContent"></div>
      </div>
    </div>

    <!-- ─── Sub-tab Utilizatori ─── -->
    <div id="org-subtab-users" class="org-subtab-panel" style="display:none;">
      <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 24px;max-width:720px;">
        <div style="font-size:.78rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px;">Utilizatori în această instituție</div>
        <div id="orgUsersStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px;">
          <!-- populat din JS -->
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="df-action-btn" onclick="goToUsersTabFiltered()">
            <svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-users"/></svg>Vezi toți utilizatorii din această instituție
          </button>
          <button class="df-action-btn primary" onclick="goToUsersTabAddNew()">
            <svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-plus"/></svg>Adaugă utilizator nou
          </button>
        </div>
      </div>
    </div>

    <!-- ─── Sub-tab Webhook ─── -->
    <div id="org-subtab-webhook" class="org-subtab-panel" style="display:none;">
      <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 24px;max-width:720px;">
        <div style="font-size:.78rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px;">🔗 Configurare Webhook</div>

        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:.78rem;color:var(--muted);margin-bottom:5px;">URL Webhook</label>
          <input id="orgWebhookUrl" type="url" placeholder="https://sistemul-vostru.ro/api/docflowai/webhook"
            style="width:100%;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.88rem;box-sizing:border-box;"/>
          <div style="font-size:.73rem;color:var(--muted);margin-top:4px;">DocFlowAI va trimite un POST JSON la acest URL la evenimentele selectate.</div>
        </div>

        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:.78rem;color:var(--muted);margin-bottom:5px;">Secret HMAC-SHA256 (opțional, recomandat)</label>
          <div style="display:flex;gap:8px;">
            <input id="orgWebhookSecret" type="password" placeholder="Lasă gol pentru a păstra secretul existent"
              style="flex:1;padding:9px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.88rem;"/>
            <button class="df-action-btn" onclick="orgGenSecret()" style="background:rgba(124,92,255,.15);border-color:rgba(124,92,255,.3);color:#b39dff;white-space:nowrap;"><svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-dices"/></svg>Generează</button>
          </div>
          <div style="font-size:.73rem;color:var(--muted);margin-top:4px;">Header: <code>X-DocFlowAI-Signature: sha256=HMAC(secret, body)</code></div>
        </div>

        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:.78rem;color:var(--muted);margin-bottom:8px;">Evenimente</label>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer;">
              <input type="checkbox" id="evtCompleted" value="flow.completed" style="accent-color:#7c5cff;"/> flow.completed
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer;">
              <input type="checkbox" id="evtRefused" value="flow.refused" style="accent-color:#7c5cff;"/> flow.refused
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer;">
              <input type="checkbox" id="evtCancelled" value="flow.cancelled" style="accent-color:#7c5cff;"/> flow.cancelled
            </label>
          </div>
        </div>

        <div style="margin-bottom:18px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.88rem;">
            <input type="checkbox" id="orgWebhookEnabled" style="accent-color:#2dd4bf;width:16px;height:16px;"/>
            <span>Webhook activ</span>
          </label>
        </div>

        <div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap;padding-top:14px;border-top:1px solid rgba(255,255,255,.06);">
          <button class="df-action-btn teal" onclick="orgTestWebhook()"><svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-flask"/></svg>Test Webhook</button>
          <button class="df-action-btn primary" onclick="saveOrgWebhook()"><svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-save"/></svg>Salvează</button>
        </div>
        <div id="orgWebhookMsg" style="margin-top:10px;font-size:.83rem;text-align:right;"></div>
      </div>
    </div>

    <!-- ─── Sub-tab Signing Providers ─── -->
    <div id="org-subtab-signing" class="org-subtab-panel" style="display:none;">
      <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:20px 24px;max-width:720px;">
        <div style="font-size:.78rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">🔐 Provideri Semnare Electronică</div>
        <div style="font-size:.77rem;color:rgba(234,240,255,.4);margin-bottom:14px;line-height:1.5;">
          Bifează providerii contractați de organizație. Semnatarul va putea alege la semnare.<br>
          <strong style="color:rgba(234,240,255,.6);">Upload local</strong> este întotdeauna disponibil (nu poate fi dezactivat).
        </div>
        <div id="orgProvidersGrid" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
          <!-- populat din JS -->
        </div>

        <!-- Config API per provider — apare la click ⚙ Config -->
        <div id="orgProviderConfigArea" style="display:none;background:rgba(0,0,0,.2);border-radius:10px;padding:14px;margin-bottom:14px;">
          <div id="orgProviderConfigTitle" style="font-size:.8rem;color:#b39dff;font-weight:700;margin-bottom:12px;"></div>

          <div id="configGeneric">
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">API URL</label>
            <input id="orgProviderApiUrl" type="text" placeholder="https://api.provider.ro/v1"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:8px;"/>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">API Key</label>
            <input id="orgProviderApiKey" type="password" placeholder="API key provider"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:8px;" autocomplete="off"/>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">Webhook Secret (HMAC)</label>
            <input id="orgProviderWebhookSecret" type="password" placeholder="Secret pentru verificare callback"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:10px;" autocomplete="off"/>
          </div>

          <div id="configSts" style="display:none;">
            <div style="font-size:.75rem;color:rgba(45,212,191,.7);margin-bottom:10px;line-height:1.5;padding:8px;background:rgba(45,212,191,.06);border-radius:6px;border:1px solid rgba(45,212,191,.15);">
              ℹ️ STS necesită înregistrare prin <strong>formulare.sts.ro</strong> de către reprezentantul instituției.
              Generați perechea de chei, trimiteți cheia publică la STS și completați câmpurile după ce primiți răspuns.
            </div>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">IDP URL <span style="color:rgba(234,240,255,.35);">(default: https://idp.stsisp.ro)</span></label>
            <input id="stsIdpUrl" type="text" placeholder="https://idp.stsisp.ro"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:8px;"/>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">Sign API URL <span style="color:rgba(234,240,255,.35);">(default: https://sign.stsisp.ro)</span></label>
            <input id="stsApiUrl" type="text" placeholder="https://sign.stsisp.ro"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:8px;"/>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">Client ID <span style="color:#ff8080;">*</span> <span style="color:rgba(234,240,255,.35);">— primit de la STS</span></label>
            <input id="stsClientId" type="text" placeholder="Ex: docflowai-primaria-test"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:8px;"/>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">Key ID (kid) <span style="color:#ff8080;">*</span> <span style="color:rgba(234,240,255,.35);">— primit de la STS prin email</span></label>
            <input id="stsKid" type="text" placeholder="Ex: key-abc123"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:8px;"/>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">Redirect URI <span style="color:#ff8080;">*</span> <span style="color:rgba(234,240,255,.35);">— înregistrat la STS</span></label>
            <input id="stsRedirectUri" type="text" placeholder="https://app.docflowai.ro/flows/sts-oauth-callback"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.85rem;margin-bottom:8px;"/>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">Cheie privată RSA (PEM) <span style="color:#ff8080;">*</span></label>
            <textarea id="stsPrivateKeyPem" rows="4" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eaf0ff;font-size:.78rem;font-family:monospace;margin-bottom:10px;resize:vertical;" autocomplete="off"></textarea>
            <label style="display:block;font-size:.77rem;color:var(--muted);margin-bottom:5px;">Cheie publică RSA (PEM) <span style="color:rgba(234,240,255,.35);">— trimisă la STS, stocată ca referință</span></label>
            <textarea id="stsPublicKeyPem" rows="4" placeholder="-----BEGIN PUBLIC KEY-----&#10;...&#10;-----END PUBLIC KEY-----"
              style="width:100%;box-sizing:border-box;padding:8px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(45,212,191,.2);border-radius:8px;color:#7cf0e0;font-size:.78rem;font-family:monospace;margin-bottom:10px;resize:vertical;" autocomplete="off"></textarea>
            <div style="border-top:1px solid rgba(255,255,255,.08);padding-top:10px;margin-bottom:10px;">
              <div style="font-size:.77rem;color:#b39dff;font-weight:600;margin-bottom:6px;">🔑 Generator pereche chei RSA</div>
              <div style="font-size:.73rem;color:rgba(234,240,255,.4);margin-bottom:8px;">Generați o pereche de chei RSA-2048. Cheia publică se trimite la STS, cea privată rămâne confidențială.</div>
              <button class="df-action-btn" onclick="generateStsKeyPair()" style="background:rgba(124,92,255,.15);border-color:rgba(124,92,255,.3);color:#b39dff;">
                <svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-key"/></svg>Generează pereche chei RSA-2048
              </button>
              <div id="stsKeyGenResult" style="display:none;margin-top:10px;">
                <div style="font-size:.75rem;color:#2dd4bf;font-weight:600;margin-bottom:4px;">✅ Cheie publică (trimiteți aceasta la STS):</div>
                <textarea id="stsPublicKeyDisplay" rows="6" readonly
                  style="width:100%;box-sizing:border-box;padding:8px;background:rgba(0,0,0,.3);border:1px solid rgba(45,212,191,.3);border-radius:6px;color:#7cf0e0;font-size:.72rem;font-family:monospace;resize:none;margin-bottom:6px;"></textarea>
                <button class="df-action-btn teal sm" onclick="copyPublicKey()"><svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-clipboard"/></svg>Copiază cheia publică</button>
              </div>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:10px;margin-top:4px;">
            <button class="df-action-btn teal" onclick="verifyProviderConfig()"><svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-search"/></svg>Verifică</button>
            <div id="orgProviderVerifyStatus" style="font-size:.77rem;flex:1;"></div>
          </div>
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;padding-top:14px;border-top:1px solid rgba(255,255,255,.06);">
          <button class="df-action-btn primary" onclick="saveOrgSigningOnly()"><svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-save"/></svg>Salvează provideri</button>
        </div>
        <div id="orgSigningMsg" style="margin-top:10px;font-size:.83rem;text-align:right;"></div>
      </div>
    </div>

    <!-- ─── Sub-tab Statistici ─── -->
    <div id="org-subtab-stats" class="org-subtab-panel" style="display:none;">
      <div id="orgStatsContent" style="max-width:960px;">
        <div style="text-align:center;padding:48px 24px;color:var(--muted);">⏳ Se încarcă statisticile...</div>
      </div>
    </div>

  </div>

NOTĂ ico: dacă vreun id de icon (ico-arrow-left, ico-users, ico-eye)
nu există în public/icons.svg, în loc de eroare browser-ul afișează
o iconiță goală — nu e fatal. Verifică:
  grep -o 'id="ico-[a-z-]*"' public/icons.svg | sort -u
și înlocuiește cu echivalente existente dacă lipsesc.

4.2 — Adaugă CSS pentru sub-tab buttons. În admin.html, în <style>
       aproape de finalul head-ului SAU înainte de </style> existent,
       adaugă:

  .df-subtab-btn {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 10px 14px;
    color: rgba(234,240,255,.5);
    font-size: .85rem;
    font-weight: 600;
    cursor: pointer;
    transition: all .15s ease;
    font-family: inherit;
  }
  .df-subtab-btn:hover { color: rgba(234,240,255,.85); background: rgba(124,92,255,.05); }
  .df-subtab-btn.active {
    color: #c4b5ff;
    border-bottom-color: #7c5cff;
  }
  #org-table tbody tr {
    border-top: 1px solid rgba(255,255,255,.04);
    cursor: pointer;
    transition: background .12s ease;
  }
  #org-table tbody tr:hover { background: rgba(124,92,255,.05); }
  #org-table tbody td { padding: 12px 8px; vertical-align: middle; }
  #org-table tbody td:first-child { padding-left: 16px; }
  #org-table tbody td:last-child  { padding-right: 16px; text-align: right; white-space: nowrap; }

4.3 — ȘTERGE COMPLET orgEditModal (HTML). Caută în admin.html blocul
       care începe cu `<div id="orgEditModal"` și se termină cu
       `</div>` corespunzător (același nivel — verifică indentare).
       Conform sed -n '688,838p' public/admin.html, blocul orgEditModal
       are ~150 linii.

       Este SIGUR să-l ștergi PENTRU CĂ:
       - openOrgModal() / closeOrgModal() sunt înlocuite de
         openOrgDetail() / closeOrgDetail() (PASUL 6)
       - Toate ID-urile interne (orgCif, orgWebhookUrl, evtCompleted etc.)
         există acum în detail view — funcțiile saveOrgWebhook,
         orgTestWebhook etc. continuă să găsească aceleași ID-uri

Comandă rapidă pentru identificare blocă (rulează ÎNAINTE de ștergere
ca să te asiguri că ai linia de start corectă):
  grep -n 'id="orgEditModal"' public/admin.html
  → folosește numărul liniei + sed pentru ștergere fizică, sau editor.

═══════════════════════════════════════════════════════════
PASUL 5 — JS: rescriere loadOrganizations ca tabel
═══════════════════════════════════════════════════════════

În public/js/admin/organizations.js, înlocuiește COMPLET funcția
loadOrganizations:

old_str:
  async function loadOrganizations() {
    const area = $('org-list-area');
    if (!area) return;
    try {
      const showInactive = !!window._orgShowInactive;
      const url = '/admin/organizations' + (showInactive ? '?include_deleted=1' : '');
      const r = await _apiFetch(url, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const orgs = await r.json();

new_str:
  async function loadOrganizations() {
    const tbody = $('org-table-body');
    if (!tbody) return;
    try {
      const fS = window._orgStatusFilter || 'active';  // active | deactivated | all
      const includeDel = (fS === 'all' || fS === 'deactivated');
      const url = '/admin/organizations' + (includeDel ? '?include_deleted=1' : '');
      const r = await _apiFetch(url, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      let orgs = await r.json();
      // Filtrare client-side pentru opțiunea „doar dezactivate"
      if (fS === 'deactivated') orgs = orgs.filter(o => !!o.deleted_at);

      window._allOrgs = orgs;
      renderOrgsTable(orgs);
    } catch(e) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:#ffaaaa;">Eroare: ${esc(e.message)}</td></tr>`;
    }
  }

  function renderOrgsTable(orgs) {
    const tbody = $('org-table-body');
    const empty = $('org-table-empty');
    if (!tbody) return;
    if (!orgs.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = orgs.map(org => {
      const isDeactivated = !!org.deleted_at;
      const lastAct = org.last_activity ? new Date(org.last_activity).toLocaleDateString('ro-RO') : '—';
      const webhookIcon = org.webhook_url
        ? (org.webhook_enabled ? '<span title="Activ" style="color:#2dd4bf;">●</span>' : '<span title="Configurat dar inactiv" style="color:#ffd580;">●</span>')
        : '<span title="Neconfigurat" style="color:rgba(234,240,255,.25);">○</span>';
      const statusBadge = isDeactivated
        ? '<span style="font-size:.7rem;padding:2px 8px;border-radius:8px;background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.35);color:#ff8a8a;font-weight:700;">DEZACTIVATĂ</span>'
        : '<span style="font-size:.7rem;padding:2px 8px;border-radius:8px;background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.3);color:#2dd4bf;font-weight:700;">ACTIVĂ</span>';
      const rowStyle = isDeactivated ? 'opacity:.55;' : '';
      const actions = isDeactivated
        ? `<button class="df-action-btn sm" onclick="event.stopPropagation();reactivateOrg(${org.id},'${esc(org.name)}')" title="Reactivează" style="background:rgba(45,212,191,.15);border-color:rgba(45,212,191,.4);color:#2dd4bf;">↻</button>`
        : `<button class="df-action-btn sm" onclick="event.stopPropagation();openOrgDetail(${org.id})" title="Detalii"><svg class="df-ic"><use href="/icons.svg?v=3.9.436#ico-settings"/></svg></button>
           <button class="df-action-btn danger sm" onclick="event.stopPropagation();openDeleteOrgModal(${org.id},'${esc(org.name)}',${org.user_count||0},${org.flow_count||0})" title="Șterge">🗑</button>`;
      return `
        <tr style="${rowStyle}" onclick="${isDeactivated?'':`openOrgDetail(${org.id})`}">
          <td><strong style="color:#eaf0ff;">${esc(org.name)}</strong>${(org.name === 'Default Organization' && !isDeactivated) ? ' <span style="font-size:.68rem;color:#ffd580;">⚠ redenumește</span>' : ''}</td>
          <td style="color:rgba(234,240,255,.7);">${esc(org.cif || '—')}</td>
          <td style="text-align:right;color:rgba(234,240,255,.85);font-variant-numeric:tabular-nums;">${org.user_count || 0}</td>
          <td style="text-align:right;color:rgba(234,240,255,.85);font-variant-numeric:tabular-nums;">${org.flow_count || 0}</td>
          <td style="text-align:center;font-size:1.2rem;">${webhookIcon}</td>
          <td style="text-align:center;">${statusBadge}</td>
          <td style="color:rgba(234,240,255,.6);font-size:.82rem;">${lastAct}</td>
          <td><div style="display:flex;gap:4px;justify-content:flex-end;">${actions}</div></td>
        </tr>`;
    }).join('');
  }

  function filterOrgsTable() {
    const q = ($('orgSearchInput')?.value || '').toLowerCase().trim();
    const all = window._allOrgs || [];
    if (!q) { renderOrgsTable(all); return; }
    const filtered = all.filter(o =>
      (o.name || '').toLowerCase().includes(q) ||
      (o.cif || '').toLowerCase().includes(q)
    );
    renderOrgsTable(filtered);
  }

  function onOrgStatusChange() {
    window._orgStatusFilter = ($('orgStatusFilter')||{value:'active'}).value;
    loadOrganizations();
  }

ȘI la finalul IIFE adaugă în window exports:
  window.filterOrgsTable    = filterOrgsTable;
  window.onOrgStatusChange  = onOrgStatusChange;
  window.renderOrgsTable    = renderOrgsTable;

ELIMINĂ EXPORTURILE moștenite NEMAIFOLOSITE (toggleShowInactiveOrgs)
și înlocuirea-l atât în window cât și în uzaje:

old_str:
  window.reactivateOrg          = reactivateOrg;
  window.toggleShowInactiveOrgs = toggleShowInactiveOrgs;

new_str:
  window.reactivateOrg          = reactivateOrg;

═══════════════════════════════════════════════════════════
PASUL 6 — JS: openOrgDetail / closeOrgDetail / switchOrgSubTab
═══════════════════════════════════════════════════════════

ÎNLOCUIEȘTE COMPLET funcțiile openOrgModal și closeOrgModal cu noile
funcții pentru detail view. Caută:

old_str:
  function openOrgModal(id, name) {
    _currentOrgId = id;
    $('orgEditName').textContent = name;
    $('orgWebhookUrl').value = '';
    $('orgWebhookSecret').value = '';
    $('orgWebhookEnabled').checked = false;
    $('evtCompleted').checked = true;
    $('evtRefused').checked = false;
    $('evtCancelled').checked = false;
    $('orgEditMsg').textContent = '';
    $('orgCif').value = '';
    $('orgCompartimenteInput').value = '';
    _orgCompartimente = [];
    _renderCompartimente();
    // Încarcă config curentă
    _apiFetch('/admin/organizations', { headers: hdrs() }).then(r => r.json()).then(orgs => {
      const org = orgs.find(o => o.id === id);
      if (!org) return;
      $('orgWebhookUrl').value = org.webhook_url || '';
      $('orgWebhookEnabled').checked = !!org.webhook_enabled;
      const evts = org.webhook_events || [];
      $('evtCompleted').checked = evts.includes('flow.completed');
      $('evtRefused').checked = evts.includes('flow.refused');
      $('evtCancelled').checked = evts.includes('flow.cancelled');
      $('orgCif').value = org.cif || '';
      _orgCompartimente = Array.isArray(org.compartimente) ? [...org.compartimente] : [];
      _renderCompartimente();
    }).catch(() => {});
    // Încarcă providerii de semnare ai org-ului
    _selectedProviders = new Set(['local-upload']);
    _activeConfigProvider = null;
    loadOrgSigningProviders(id);
    $('orgEditModal').style.display = 'flex';
  }

  function closeOrgModal() {
    $('orgEditModal').style.display = 'none';
    _currentOrgId = null;
  }

new_str:
  // ── Detail view: deschide pagina cu sub-tabs pentru o organizație ─
  async function openOrgDetail(id) {
    _currentOrgId = id;
    // Schimbă view-ul
    $('org-list-view').style.display   = 'none';
    $('org-detail-view').style.display = '';
    // Setează hash pentru bookmark + back/forward
    if (location.hash !== `#organizatii/${id}`) {
      history.pushState(null, '', `#organizatii/${id}`);
    }
    // Reset UI states
    $('orgDetailName').textContent          = 'Se încarcă...';
    $('orgDetailStatusBadge').innerHTML     = '';
    $('orgDetailActions').innerHTML         = '';
    $('orgCif').value                       = '';
    $('orgCompartimenteInput').value        = '';
    $('orgWebhookUrl').value                = '';
    $('orgWebhookSecret').value             = '';
    $('orgWebhookEnabled').checked          = false;
    $('evtCompleted').checked               = true;
    $('evtRefused').checked                 = false;
    $('evtCancelled').checked               = false;
    $('orgGeneralMsg').textContent          = '';
    $('orgWebhookMsg').textContent          = '';
    $('orgSigningMsg').textContent          = '';
    _orgCompartimente = [];
    _renderCompartimente();
    // Default tab la deschidere
    switchOrgSubTab('general');
    try {
      const r = await _apiFetch(`/admin/organizations/${id}`, { headers: hdrs() });
      if (!r.ok) throw new Error(`Eroare ${r.status}`);
      const org = await r.json();
      _populateOrgDetail(org);
    } catch(e) {
      $('orgDetailName').textContent = '⚠ Eroare la încărcare';
    }
    // Provideri semnare
    _selectedProviders = new Set(['local-upload']);
    _activeConfigProvider = null;
    loadOrgSigningProviders(id);
  }

  function _populateOrgDetail(org) {
    $('orgDetailName').textContent          = org.name || '—';
    const isDeactivated = !!org.deleted_at;
    $('orgDetailStatusBadge').innerHTML = isDeactivated
      ? '<span style="font-size:.72rem;padding:3px 10px;border-radius:10px;background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.35);color:#ff8a8a;font-weight:700;">DEZACTIVATĂ</span>'
      : '<span style="font-size:.72rem;padding:3px 10px;border-radius:10px;background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.3);color:#2dd4bf;font-weight:700;">ACTIVĂ</span>';
    // Acțiuni header (Redenumește + Șterge/Reactivează)
    const actions = [];
    if (!isDeactivated) {
      actions.push(`<button class="df-action-btn" onclick="openRenameOrgModal(${org.id},'${esc(org.name)}')">✏️ Redenumește</button>`);
    }
    $('orgDetailActions').innerHTML = actions.join(' ');
    // Câmpuri General
    $('orgCif').value = org.cif || '';
    _orgCompartimente = Array.isArray(org.compartimente) ? [...org.compartimente] : [];
    _renderCompartimente();
    $('orgDetailCreatedAt').textContent = org.created_at ? new Date(org.created_at).toLocaleString('ro-RO') : '—';
    $('orgDetailUpdatedAt').textContent = org.updated_at ? new Date(org.updated_at).toLocaleString('ro-RO') : '—';
    // Câmpuri Webhook
    $('orgWebhookUrl').value     = org.webhook_url || '';
    $('orgWebhookEnabled').checked = !!org.webhook_enabled;
    const evts = org.webhook_events || [];
    $('evtCompleted').checked = evts.includes('flow.completed');
    $('evtRefused').checked   = evts.includes('flow.refused');
    $('evtCancelled').checked = evts.includes('flow.cancelled');
    // Zona periculoasă
    const dz = $('orgDangerZoneContent');
    if (dz) {
      if (isDeactivated) {
        const delDate = org.deleted_at ? new Date(org.deleted_at).toLocaleDateString('ro-RO') : '—';
        dz.innerHTML = `
          <div style="font-size:.85rem;color:rgba(234,240,255,.75);margin-bottom:10px;">Această organizație a fost dezactivată pe <strong>${delDate}</strong>. Datele sunt păstrate pentru conformitate.</div>
          <button class="df-action-btn" onclick="reactivateOrg(${org.id},'${esc(org.name)}')" style="background:rgba(45,212,191,.15);border-color:rgba(45,212,191,.4);color:#2dd4bf;">↻ Reactivează organizația</button>`;
      } else {
        dz.innerHTML = `
          <div style="font-size:.85rem;color:rgba(234,240,255,.75);margin-bottom:10px;">Ștergerea organizației o ascunde din toate listele. Datele istorice (fluxuri, audit, semnături) rămân în baza de date.</div>
          <button class="df-action-btn danger" onclick="openDeleteOrgModal(${org.id},'${esc(org.name)}',0,0)">🗑 Șterge organizația</button>`;
      }
    }
  }

  function closeOrgDetail() {
    $('org-detail-view').style.display = 'none';
    $('org-list-view').style.display   = '';
    _currentOrgId = null;
    if (location.hash.startsWith('#organizatii/')) {
      history.pushState(null, '', '#organizatii');
    }
    // Refresh listă pentru a reflecta eventuale modificări
    if (typeof loadOrganizations === 'function') loadOrganizations();
  }

  function switchOrgSubTab(name) {
    ['general','users','webhook','signing','stats'].forEach(t => {
      const panel = $('org-subtab-' + t);
      if (panel) panel.style.display = (t === name ? '' : 'none');
    });
    document.querySelectorAll('.df-subtab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.subtab === name);
    });
    if (name === 'users' && _currentOrgId) loadOrgUsersStats(_currentOrgId);
    if (name === 'stats' && _currentOrgId) loadOrgStats(_currentOrgId);
  }

  // Backward-compat: vechiul openOrgModal redirecționează la openOrgDetail
  function openOrgModal(id /*, name*/) { return openOrgDetail(id); }
  function closeOrgModal() { return closeOrgDetail(); }

═══════════════════════════════════════════════════════════
PASUL 7 — JS: stats per tab (Users + Stats) + nav helpers
═══════════════════════════════════════════════════════════

ADAUGĂ în public/js/admin/organizations.js, ÎNAINTE de
„function _renderCompartimente":

  // ── Sub-tab Utilizatori ───────────────────────────────────────────
  async function loadOrgUsersStats(orgId) {
    const wrap = $('orgUsersStats');
    if (!wrap) return;
    wrap.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);">⏳ Se încarcă...</div>';
    try {
      const r = await _apiFetch(`/admin/organizations/${orgId}/stats`, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const s = await r.json();
      const u = s.users || {};
      wrap.innerHTML = [
        _kpiCard('Activi',         u.active || 0,        '#2dd4bf'),
        _kpiCard('Dezactivați',    u.deactivated || 0,   '#ff8a8a'),
        _kpiCard('Admin',          u.admins || 0,        '#b39dff'),
        _kpiCard('Admin Inst.',    u.org_admins || 0,    '#7cf0e0'),
        _kpiCard('Useri',          u.users || 0,         '#eaf0ff'),
      ].join('');
    } catch(e) {
      wrap.innerHTML = `<div style="grid-column:1/-1;color:#ffaaaa;">Eroare: ${esc(e.message)}</div>`;
    }
  }

  function goToUsersTabFiltered() {
    if (!_currentOrgId) return;
    const org = (window._allOrgs || []).find(o => o.id === _currentOrgId);
    if (!org) return;
    if (typeof switchTab === 'function') switchTab('utilizatori');
    setTimeout(() => {
      const f = document.getElementById('fInstitutie');
      if (f) { f.value = org.name; if (typeof filterUsers === 'function') filterUsers(); }
    }, 100);
  }

  function goToUsersTabAddNew() {
    if (!_currentOrgId) return;
    const org = (window._allOrgs || []).find(o => o.id === _currentOrgId);
    if (!org) return;
    if (typeof switchTab === 'function') switchTab('utilizatori');
    setTimeout(() => {
      // Pre-completează numele instituției în formul de creare
      const inst = document.getElementById('nInstitutie');
      if (inst) inst.value = org.name;
      // Scroll la formul de creare (caută tab "Utilizator nou")
      const newTabBtn = document.querySelector('[data-utab="new"], #subtab-new-user');
      if (newTabBtn) newTabBtn.click();
      const sec = document.getElementById('createUserCard') || document.getElementById('tab-utilizatori');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }

  // ── Sub-tab Statistici ─────────────────────────────────────────────
  async function loadOrgStats(orgId) {
    const wrap = $('orgStatsContent');
    if (!wrap) return;
    wrap.innerHTML = '<div style="text-align:center;padding:48px 24px;color:var(--muted);">⏳ Se încarcă statisticile...</div>';
    try {
      const r = await _apiFetch(`/admin/organizations/${orgId}/stats`, { headers: hdrs() });
      if (!r.ok) throw new Error('Eroare server');
      const s = await r.json();
      const u = s.users || {};
      const f = s.flows || {};
      const lastAct = f.last_activity ? new Date(f.last_activity).toLocaleString('ro-RO') : '—';
      const avgH = f.avg_completion_hours != null ? `${f.avg_completion_hours} h` : '—';
      wrap.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px;">
          ${_kpiCard('Total fluxuri',   f.total || 0,     '#eaf0ff')}
          ${_kpiCard('Active',          f.active || 0,    '#7cf0e0')}
          ${_kpiCard('Completate',      f.completed || 0, '#2dd4bf')}
          ${_kpiCard('Refuzate',        f.refused || 0,   '#ffd580')}
          ${_kpiCard('Anulate',         f.cancelled || 0, '#ff8a8a')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px;">
          ${_kpiCard('Ultimele 7 zile',  f.last_7_days || 0,  '#b39dff')}
          ${_kpiCard('Ultimele 30 zile', f.last_30_days || 0, '#b39dff')}
          ${_kpiCard('Useri activi',     u.active || 0,       '#2dd4bf')}
          ${_kpiCard('Useri dezactivați', u.deactivated || 0, '#ff8a8a')}
        </div>
        <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:.85rem;">
          <div><span style="color:var(--muted);">Ultima activitate flux:</span><br><strong style="color:#eaf0ff;">${lastAct}</strong></div>
          <div><span style="color:var(--muted);">Timp mediu completare:</span><br><strong style="color:#eaf0ff;">${avgH}</strong></div>
        </div>`;
    } catch(e) {
      wrap.innerHTML = `<div style="text-align:center;padding:48px 24px;color:#ffaaaa;">Eroare: ${esc(e.message)}</div>`;
    }
  }

  function _kpiCard(label, value, color) {
    return `<div style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px 16px;text-align:center;">
      <div style="font-size:1.6rem;font-weight:800;color:${color};line-height:1;margin-bottom:4px;font-variant-numeric:tabular-nums;">${value}</div>
      <div style="font-size:.72rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
    </div>`;
  }

═══════════════════════════════════════════════════════════
PASUL 8 — JS: split saveOrgWebhook în 3 funcții (General, Webhook, Signing)
═══════════════════════════════════════════════════════════

Funcția existentă saveOrgWebhook salvează TOTUL deodată. Cu sub-tab-uri,
fiecare tab are propriul Save. Adaugăm 2 funcții noi și păstrăm
saveOrgWebhook (rebrand: doar webhook config).

ÎNLOCUIEȘTE saveOrgWebhook EXISTENT:

old_str:
  async function saveOrgWebhook() {
    if (!_currentOrgId) return;
    const msg = $('orgEditMsg');
    const events = [];
    if ($('evtCompleted').checked) events.push('flow.completed');
    if ($('evtRefused').checked) events.push('flow.refused');
    if ($('evtCancelled').checked) events.push('flow.cancelled');
    _selectedProviders.add('local-upload');
    const compInp = $('orgCompartimenteInput');
    if (compInp?.value.trim()) orgAddCompartiment();
    const body = {
      webhook_url:               $('orgWebhookUrl').value.trim() || null,
      webhook_events:            events,
      webhook_enabled:           $('orgWebhookEnabled').checked,
      signing_providers_enabled: [..._selectedProviders],
      cif:                       $('orgCif').value.trim() || null,
      compartimente:             _orgCompartimente,
    };
    const secret = $('orgWebhookSecret').value.trim();
    if (secret) body.webhook_secret = secret;
    msg.textContent = '⏳ Se salvează...';
    try {
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        await saveOrgSigningProviders(_currentOrgId);
        msg.innerHTML = '<span style="color:#2dd4bf;">✅ Salvat cu succes.</span>';
        setTimeout(() => { closeOrgModal(); loadOrganizations(); }, 800);
      } else {
        msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

new_str:
  // Salvează DOAR webhook config (din tab Webhook)
  async function saveOrgWebhook() {
    if (!_currentOrgId) return;
    const msg = $('orgWebhookMsg');
    const events = [];
    if ($('evtCompleted').checked) events.push('flow.completed');
    if ($('evtRefused').checked)   events.push('flow.refused');
    if ($('evtCancelled').checked) events.push('flow.cancelled');
    const body = {
      webhook_url:     $('orgWebhookUrl').value.trim() || null,
      webhook_events:  events,
      webhook_enabled: $('orgWebhookEnabled').checked,
    };
    const secret = $('orgWebhookSecret').value.trim();
    if (secret) body.webhook_secret = secret;
    if (msg) msg.textContent = '⏳ Se salvează...';
    try {
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        if (msg) msg.innerHTML = '<span style="color:#2dd4bf;">✅ Webhook salvat.</span>';
        $('orgWebhookSecret').value = '';
      } else {
        if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

  // Salvează DOAR General (CIF + compartimente) — din tab General
  async function saveOrgGeneral() {
    if (!_currentOrgId) return;
    const msg = $('orgGeneralMsg');
    const compInp = $('orgCompartimenteInput');
    if (compInp?.value.trim()) orgAddCompartiment();
    const body = {
      cif:           $('orgCif').value.trim() || null,
      compartimente: _orgCompartimente,
    };
    if (msg) msg.textContent = '⏳ Se salvează...';
    try {
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        if (msg) msg.innerHTML = '<span style="color:#2dd4bf;">✅ Date generale salvate.</span>';
      } else {
        if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

  // Salvează DOAR signing providers — din tab Signing Providers
  async function saveOrgSigningOnly() {
    if (!_currentOrgId) return;
    const msg = $('orgSigningMsg');
    _selectedProviders.add('local-upload');
    if (msg) msg.textContent = '⏳ Se salvează...';
    try {
      // saveOrgSigningProviders trimite atât config-ul plain cât și
      // signing_providers_enabled prin endpoint-ul dedicat
      await saveOrgSigningProviders(_currentOrgId);
      // Trimitem și flag-urile enabled prin PUT-ul general
      const r = await _apiFetch(`/admin/organizations/${_currentOrgId}`, {
        method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ signing_providers_enabled: [..._selectedProviders] }),
      });
      if (r.ok) {
        if (msg) msg.innerHTML = '<span style="color:#2dd4bf;">✅ Provideri salvați.</span>';
      } else {
        const j = await r.json().catch(()=>({}));
        if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(j.error||'Eroare')}</span>`;
      }
    } catch(e) {
      if (msg) msg.innerHTML = `<span style="color:#ffaaaa;">❌ ${esc(e.message)}</span>`;
    }
  }

ȘI la finalul IIFE adaugă în window exports:
  window.openOrgDetail        = openOrgDetail;
  window.closeOrgDetail       = closeOrgDetail;
  window.switchOrgSubTab      = switchOrgSubTab;
  window.saveOrgGeneral       = saveOrgGeneral;
  window.saveOrgSigningOnly   = saveOrgSigningOnly;
  window.loadOrgUsersStats    = loadOrgUsersStats;
  window.loadOrgStats         = loadOrgStats;
  window.goToUsersTabFiltered = goToUsersTabFiltered;
  window.goToUsersTabAddNew   = goToUsersTabAddNew;
  // Backward-compat: păstrate ca alias-uri
  window.openOrgModal         = openOrgModal;
  window.closeOrgModal        = closeOrgModal;

═══════════════════════════════════════════════════════════
PASUL 9 — JS: hash routing pentru detail view (bookmarkable)
═══════════════════════════════════════════════════════════

În public/js/admin/admin.js, în funcția care procesează `_initialTab`
(căutare: `const _initialTab = (location.hash || ''`), modifică pentru
a recunoaște și hash-uri de forma `#organizatii/123`:

old_str:
    const _validTabs = ['dashboard','utilizatori','fluxuri','rapoarte',
                        'organizatii','outreach','analytics','audit'];
    const _initialTab = (location.hash || '').replace(/^#/,'').trim();
    const _startTab = _validTabs.includes(_initialTab) ? _initialTab : 'dashboard';
    switchTab(_startTab);

new_str:
    const _validTabs = ['dashboard','utilizatori','fluxuri','rapoarte',
                        'organizatii','outreach','analytics','audit'];
    const _rawHash = (location.hash || '').replace(/^#/,'').trim();
    // Suportăm și pattern-ul `organizatii/:id` pentru detail view
    const _hashParts = _rawHash.split('/');
    const _initialTab = _validTabs.includes(_hashParts[0]) ? _hashParts[0] : 'dashboard';
    const _initialOrgId = (_hashParts[0] === 'organizatii' && _hashParts[1] && /^\d+$/.test(_hashParts[1])) ? parseInt(_hashParts[1]) : null;
    switchTab(_initialTab);
    if (_initialOrgId && typeof openOrgDetail === 'function') {
      // așteptăm ca tab-ul + lista să se încarce, apoi deschidem detail-ul
      setTimeout(() => openOrgDetail(_initialOrgId), 250);
    }

ADAUGĂ ascultător pentru navigare browser back/forward:

ÎNAINTE de finalul fetch("/auth/me") (după închiderea blocului `.then`),
adaugă DUPĂ ultimul `_loaded = false;`:

  // Hash routing: răspunde la back/forward în browser pentru #organizatii/:id
  window.addEventListener('hashchange', () => {
    const m = (location.hash || '').match(/^#organizatii\/(\d+)$/);
    if (m && typeof openOrgDetail === 'function') {
      openOrgDetail(parseInt(m[1]));
    } else if (location.hash === '#organizatii' && typeof closeOrgDetail === 'function') {
      const dv = document.getElementById('org-detail-view');
      if (dv && dv.style.display !== 'none') closeOrgDetail();
    }
  });

═══════════════════════════════════════════════════════════
PASUL 10 — Cache busting (3.9.436 → 3.9.437, SW v152 → v153)
═══════════════════════════════════════════════════════════

10.1 — package.json:
  old_str:   "version": "3.9.436",
  new_str:   "version": "3.9.437",

10.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v152';
  new_str: const CACHE_VERSION = 'docflowai-v153';

10.3 — public/admin.html:
  sed -i 's/v=3\.9\.436/v=3.9.437/g' public/admin.html

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Endpoint-uri noi backend:
   grep -c "router.get.*'/admin/organizations/:id'" server/routes/admin/organizations.mjs
   → 1
   grep -c "router.get.*'/admin/organizations/:id/stats'" server/routes/admin/organizations.mjs
   → 1

2. Tab-organizatii are noile sub-view-uri:
   grep -c 'id="org-list-view"\|id="org-detail-view"' public/admin.html
   → 2
   grep -c 'id="org-subtab-' public/admin.html
   → 5 (general, users, webhook, signing, stats)

3. orgEditModal a fost ȘTERS:
   grep -c 'id="orgEditModal"' public/admin.html
   → 0

4. Funcții noi JS prezente:
   grep -c "function openOrgDetail\b\|function closeOrgDetail\b\|function switchOrgSubTab\b\|function loadOrgStats\b\|function loadOrgUsersStats\b\|function saveOrgGeneral\b\|function saveOrgSigningOnly\b\|function renderOrgsTable\b\|function filterOrgsTable\b\|function _kpiCard\b" public/js/admin/organizations.js
   → 10

5. Window exports:
   grep -c "window.openOrgDetail\|window.closeOrgDetail\|window.switchOrgSubTab\|window.saveOrgGeneral\|window.saveOrgSigningOnly" public/js/admin/organizations.js
   → ≥ 5

6. Hash routing:
   grep -c "hashchange\|organizatii/" public/js/admin/admin.js
   → ≥ 2

7. Cache busting aplicat:
   grep -c "v=3.9.437" public/admin.html
   → ~100 (depinde de cât a rămas din original)
   grep -c "v=3.9.436" public/admin.html
   → 0
   grep "^const CACHE_VERSION" public/sw.js
   → docflowai-v153
   grep '"version"' package.json
   → 3.9.437

8. Sintaxă:
   node --check public/js/admin/organizations.js
   node --check public/js/admin/admin.js
   node --check public/sw.js
   npm run check

9. TESTE:
   npm test
   ATENȚIE: testele de integrare pe organizations endpoint nu ar
   trebui să fie afectate (PUT/DELETE păstrează contractul). Dacă
   un test verifică EXACT lista de field-uri returnate de
   GET /admin/organizations, ar putea pica pe `last_activity`
   adăugat — actualizează assertion-ul.

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/routes/admin/organizations.mjs \
        public/admin.html \
        public/js/admin/organizations.js \
        public/js/admin/admin.js \
        public/sw.js \
        package.json

git commit -m "feat(admin): refactor org admin UI — tabel + detail view cu sub-tabs (v3.9.437)

Cardurile de organizații înlocuite cu un tabel cu căutare, filtru
status (activi/dezactivați/toți) și sortare alfabetică.

Modalul 'Configurare' (~150 linii HTML, dump-all) demolat și înlocuit
cu pagină dedicată (sub-view în tab) cu 5 sub-tabs:
  • General — CIF, compartimente, metadata, zona periculoasa
  • Utilizatori — KPI + butoane de delegare la tab Utilizatori
  • Webhook — URL, secret HMAC, events, test, save independent
  • Signing Providers — grid + config STS, save independent
  • Statistici — 9 KPI carduri (fluxuri, useri, activitate)

Backend:
  • GET /admin/organizations/:id — detalii single
  • GET /admin/organizations/:id/stats — KPI per org
  • GET /admin/organizations extins cu MAX(f.updated_at) AS last_activity

Hash routing: #organizatii/:id deschide direct detail-ul (bookmark
+ back/forward funcțional). Tabelul are click-pe-rand pentru deschidere.

Save split per tab — fiecare sub-tab cu propriul buton Salvează,
atomic și mai puțin disruptiv decât un mega-save.

Modal-urile renameOrgModal, deleteOrgModal, onboardingModal pastrate
neschimbate — referite din butoanele detail view.

Cache: package 3.9.436 -> 3.9.437, SW v152 -> v153."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging)
═══════════════════════════════════════════════════════════

1. Hard refresh /admin → tab Organizații
   → Vezi TABEL cu coloane: Nume / CIF / Useri / Fluxuri / Webhook /
     Status / Ultima activitate / Acțiuni
   → Filtru search merge la typing (filtrează pe nume + CIF)
   → Filtru status are 3 opțiuni (Active / Toate / Doar dezactivate)

2. Click pe orice rând → deschide detail view cu numele org-ului
   → URL devine /admin#organizatii/123
   → Sub-tab default: General
   → Vezi badge ACTIVĂ verde lângă numele org-ului

3. Sub-tab General:
   → Modifică CIF, click Salvează → vezi „✅ Date generale salvate"
   → Adaugă compartiment + Enter, salvează → idem
   → Zona periculoasă: buton 🗑 Șterge organizația deschide modalul
     existent (din v3.9.435)

4. Sub-tab Webhook:
   → Verifică că URL + Events sunt populate corect
   → Schimbă URL, click Salvează → vezi „✅ Webhook salvat"
   → Click Test Webhook → trimite payload de test

5. Sub-tab Signing Providers:
   → Bifează un provider, click ⚙ Config, completează → Verifică
   → Salvează provideri

6. Sub-tab Utilizatori:
   → Vezi 5 KPI carduri (Activi/Dezactivați/Admin/Admin Inst./Useri)
   → Click „Vezi toți utilizatorii" → trece la tab Utilizatori
     cu filtrul Instituție pre-completat
   → Click „Adaugă utilizator nou" → trece la tab Utilizatori
     cu instituția pre-completată în formul de creare

7. Sub-tab Statistici:
   → Vezi 9 KPI carduri pentru fluxuri + ultima activitate +
     timp mediu completare

8. Hash routing:
   → Copiază URL /admin#organizatii/123 într-un tab nou
   → Se deschide automat detail-ul org-ului 123
   → Buton ← Înapoi → revine la lista
   → Buton browser Back → revine la lista (hash devine #organizatii)
   → Buton browser Forward → reintră în detail

9. Org dezactivată:
   → Filtru status = „Doar dezactivate"
   → Click pe rând → detail cu badge DEZACTIVATĂ roșu
   → Sub-tab General: zona periculoasă afișează „↻ Reactivează"
     în loc de „🗑 Șterge"
   → Sub-tab-urile Webhook + Signing Providers funcționează normal
     (poți modifica config-ul org-ului dezactivat dacă e nevoie)

STOP dacă:
- Tabelul rămâne gol → verifică că GET /admin/organizations întoarce
  array și că window._allOrgs e populat
- Click pe rând nu deschide detail-ul → verifică în DevTools că
  openOrgDetail e definit pe window
- Sub-tab Statistici afișează „Eroare 404" → verifică că endpoint-ul
  /admin/organizations/:id/stats e mountat corect (logger output la deploy)
- ID-uri input duplicate (orgCif, orgWebhookUrl etc.) → asigură-te că
  ai ȘTERS COMPLET orgEditModal HTML din admin.html
```
