/**
 * Admin routes — organizations + signing config.
 * DocFlowAI — server/routes/admin/organizations.mjs
 */

import { Router } from 'express';
import crypto from 'crypto';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import { requireAuth } from '../../middleware/auth.mjs';
import { pool, requireDb } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { listAllProviders, getProvider, getOrgProviders } from '../../signing/index.mjs';
import { isAdminOrOrgAdmin } from './_helpers.mjs';

const router = Router();

// ── GET /admin/organizations — listă organizații cu statistici și config webhook ──
router.get('/admin/organizations', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
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
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── PUT /admin/organizations/:id — actualizare organizație + config webhook ──
router.put('/admin/organizations/:id', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  const { name, webhook_url, webhook_secret, webhook_events, webhook_enabled,
          signing_providers_enabled, signing_providers_config,
          cif, compartimente } = req.body || {};
  try {
    const updates = []; const params = [];
    if (name !== undefined) { params.push(String(name).trim()); updates.push(`name=$${params.length}`); }
    if (cif !== undefined) { params.push(cif ? String(cif).replace(/\D/g,'').substring(0,10) : null); updates.push(`cif=$${params.length}`); }
    if (compartimente !== undefined && Array.isArray(compartimente)) {
      params.push(compartimente.map(c => String(c).trim()).filter(Boolean));
      updates.push(`compartimente=$${params.length}`);
    }
    if (webhook_url !== undefined) { params.push(webhook_url ? String(webhook_url).trim() : null); updates.push(`webhook_url=$${params.length}`); }
    if (webhook_secret !== undefined && webhook_secret !== '') { params.push(String(webhook_secret).trim()); updates.push(`webhook_secret=$${params.length}`); }
    if (webhook_events !== undefined) { params.push(Array.isArray(webhook_events) ? webhook_events : []); updates.push(`webhook_events=$${params.length}`); }
    if (webhook_enabled !== undefined) { params.push(!!webhook_enabled); updates.push(`webhook_enabled=$${params.length}`); }
    // Signing providers — salvate doar dacă coloana există în DB (migrarea 033)
    // Dacă coloana lipsește, ignorăm silențios (non-fatal — webhook se salvează oricum)
    if (signing_providers_enabled !== undefined && Array.isArray(signing_providers_enabled)) {
      try {
        const { rows: colCheck } = await pool.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name='organizations' AND column_name='signing_providers_enabled' LIMIT 1`
        );
        if (colCheck.length > 0) {
          const enabled = signing_providers_enabled.includes('local-upload')
            ? signing_providers_enabled : ['local-upload', ...signing_providers_enabled];
          params.push(enabled); updates.push(`signing_providers_enabled=$${params.length}`);
          if (signing_providers_config !== undefined && typeof signing_providers_config === 'object') {
            params.push(JSON.stringify(signing_providers_config));
            updates.push(`signing_providers_config=$${params.length}`);
          }
        }
      } catch(colErr) { /* coloana nu există — ignorăm */ }
    }
    if (!updates.length) return res.status(400).json({ error: 'no_fields' });
    updates.push(`updated_at=NOW()`);
    params.push(orgId);
    const { rows } = await pool.query(
      `UPDATE organizations SET ${updates.join(',')} WHERE id=$${params.length} RETURNING id, name, cif, compartimente, webhook_url, webhook_events, webhook_enabled, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'org_not_found' });
    res.json({ ok: true, org: rows[0] });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── POST /admin/organizations/:id/test-webhook — trimite un eveniment de test ──
router.post('/admin/organizations/:id/test-webhook', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const orgId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query('SELECT webhook_url, webhook_secret, webhook_enabled FROM organizations WHERE id=$1', [orgId]);
    const org = rows[0];
    if (!org) return res.status(404).json({ error: 'org_not_found' });
    if (!org.webhook_url) return res.status(400).json({ error: 'no_webhook_url', message: 'Configurați mai întâi URL-ul webhook.' });
    // Payload de test
    const testPayload = {
      event: 'webhook.test',
      flowId: 'TEST_' + Date.now(),
      docName: 'Document test DocFlowAI',
      institutie: 'Organizație test',
      status: 'completed',
      completedAt: new Date().toISOString(),
      signers: [{ name: 'Ion Popescu', email: 'test@example.com', rol: 'SEMNAT', status: 'signed', signedAt: new Date().toISOString() }],
      sentAt: new Date().toISOString(),
    };
    const body = JSON.stringify(testPayload);
    const sig = org.webhook_secret
      ? crypto.createHmac('sha256', org.webhook_secret).update(body).digest('hex')
      : 'unsigned';
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(org.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DocFlowAI-Event': 'webhook.test', 'X-DocFlowAI-Signature': `sha256=${sig}` },
        body, signal: ctrl.signal,
      });
      res.json({ ok: r.ok, status: r.status, statusText: r.statusText, message: r.ok ? 'Webhook livrat cu succes.' : `Server-ul destinatar a returnat ${r.status}.` });
    } catch(fetchErr) {
      res.json({ ok: false, error: fetchErr.message, message: 'Eroare de rețea — verificați URL-ul.' });
    }
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── Signing Providers — API ──────────────────────────────────────────────
// ── POST /admin/signing/sts/generate-keypair — generează pereche chei RSA pentru STS ──
// Super-admin generează cheia publică de trimis la STS + cheia privată de configurat.
// Nu necesită CSRF — nu modifică stare în DB, generează chei RSA în memorie și le returnează.
router.post('/admin/signing/sts/generate-keypair', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { generateKeyPairSync } = await import('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength:     2048,
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    logger.info({ actor: actor.email }, 'STS: pereche chei RSA generată');
    res.json({
      ok:            true,
      publicKeyPem:  publicKey,
      privateKeyPem: privateKey,
      instructions:  'Trimiteți publicKeyPem la STS (contact@sts.ro) pentru a primi client_id și kid. Stocați privateKeyPem în configurația providerului STS.',
    });
  } catch(e) {
    res.status(500).json({ error: 'keygen_failed' });
  }
});


// Arhitectură: provideri la nivel de org (ce e disponibil), ales per semnatar.

// GET /admin/signing/providers — toți providerii disponibili în platformă
router.get('/admin/signing/providers', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  res.json(listAllProviders());
});

// GET /admin/organizations/:id/signing — configurația curentă de signing a unei org
router.get('/admin/organizations/:id/signing', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rows } = await pool.query(
      'SELECT id, name, signing_providers_enabled, signing_providers_config FROM organizations WHERE id=$1',
      [orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'org_not_found' });
    const org = rows[0];
    // Returnăm config fără API keys (securitate) — doar metadata
    const configSafe = {};
    for (const [pid, cfg] of Object.entries(org.signing_providers_config || {})) {
      if (pid === 'sts-cloud') {
        // STS: returnăm câmpurile non-sensitive complet, mascăm cheia privată
        configSafe[pid] = {
          clientId:       cfg.clientId      || '',
          kid:            cfg.kid            || '',
          redirectUri:    cfg.redirectUri    || '',
          idpUrl:         cfg.idpUrl         || '',
          apiUrl:         cfg.apiUrl         || '',
          publicKeyPem:   cfg.publicKeyPem   || '',  // non-sensitivă, returnată complet
          hasPrivateKey:  !!(cfg.privateKeyPem),      // boolean — nu returnăm cheia privată
        };
      } else {
        configSafe[pid] = { apiUrl: cfg.apiUrl || '', hasApiKey: !!(cfg.apiKey), hasWebhookSecret: !!(cfg.webhookSecret) };
      }
    }
    res.json({
      orgId:    org.id,
      name:     org.name,
      enabled:  org.signing_providers_enabled || ['local-upload'],
      configSafe,
      providers: getOrgProviders(org),
    });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// PUT /admin/organizations/:id/signing — actualizează providerii activi + configurația
// Doar super-admin — configurația conține API keys sensibile
router.put('/admin/organizations/:id/signing', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Doar super-admin poate configura providerii de semnare.' });
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  const { enabled, config } = req.body || {};
  if (!Array.isArray(enabled) || !enabled.length) {
    return res.status(400).json({ error: 'enabled_required', message: 'Lista de provideri activi nu poate fi goală.' });
  }
  // Validăm că toți providerii din enabled există în platformă
  const allIds = listAllProviders().map(p => p.id);
  const unknown = enabled.filter(id => !allIds.includes(id));
  if (unknown.length) return res.status(400).json({ error: 'unknown_providers', unknown, available: allIds });
  // 'local-upload' trebuie să fie întotdeauna în listă (fallback obligatoriu)
  const finalEnabled = enabled.includes('local-upload') ? enabled : ['local-upload', ...enabled];
  try {
    // Mergem config-ul nou cu cel existent (nu suprascrie API keys omise)
    const { rows: existing } = await pool.query('SELECT signing_providers_config FROM organizations WHERE id=$1', [orgId]);
    if (!existing.length) return res.status(404).json({ error: 'org_not_found' });
    const existingConfig = existing[0].signing_providers_config || {};
    const mergedConfig   = { ...existingConfig };
    for (const [pid, cfg] of Object.entries(config || {})) {
      mergedConfig[pid] = { ...(existingConfig[pid] || {}), ...cfg };
    }
    const { rows } = await pool.query(
      `UPDATE organizations
          SET signing_providers_enabled = $1,
              signing_providers_config  = $2,
              updated_at = NOW()
        WHERE id = $3
        RETURNING id, name, signing_providers_enabled, updated_at`,
      [finalEnabled, JSON.stringify(mergedConfig), orgId]
    );
    logger.info({ orgId, enabled: finalEnabled, actor: actor.email }, 'Signing providers actualizați');
    res.json({ ok: true, org: rows[0] });
  } catch(e) { logger.error({ err: e }, 'PUT signing error'); res.status(500).json({ error: 'server_error' }); }
});

// POST /admin/signing/verify — verifică conexiunea cu un provider
router.post('/admin/signing/verify', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { providerId, config } = req.body || {};
  if (!providerId) return res.status(400).json({ error: 'providerId_required' });
  try {
    let effectiveConfig = { ...(config || {}) };
    // Dacă frontend-ul semnalează că trebuie folosită cheia stocată în DB (câmp gol = nu s-a introdus una nouă)
    if (effectiveConfig._useStoredPrivateKey && actor.orgId) {
      try {
        const { rows: orgRows } = await pool.query(
          'SELECT signing_providers_config FROM organizations WHERE id=$1', [actor.orgId]
        );
        const storedKey = orgRows[0]?.signing_providers_config?.[providerId]?.privateKeyPem;
        if (storedKey) effectiveConfig.privateKeyPem = storedKey;
      } catch(_) { /* non-fatal — continuăm fără cheie */ }
    }
    delete effectiveConfig._useStoredPrivateKey;
    const provider = getProvider(providerId);
    const result   = await provider.verify(effectiveConfig);
    res.json(result);
  } catch(e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
