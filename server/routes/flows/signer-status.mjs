/**
 * server/routes/flows/signer-status.mjs
 *
 * GET /flows/:id/signer-status?token=xxx
 * Returnează starea curentă a semnătarului pentru recovery după refresh pagină.
 * Folosit de frontend pentru a detecta stsPending=true și a relua polling-ul STS.
 */

import { Router }             from 'express';
import { pool, requireDb }    from '../../db/index.mjs';

const router = Router();

router.get('/:id/signer-status', async (req, res) => {
  if (requireDb(res)) return;                 // v3 pattern: requireDb(res) → true dacă DB nu-i gata
  try {
    const { id }    = req.params;
    const { token } = req.query;

    const result = await pool.query(
      'SELECT data FROM flows WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'flow_not_found' });
    }

    const data    = result.rows[0].data;
    const signers = Array.isArray(data.signers) ? data.signers : [];

    const signer = token
      ? signers.find(s => s.token === token)
      : signers.find(s => s.status === 'current');

    if (!signer) {
      return res.status(404).json({ error: 'signer_not_found' });
    }

    return res.json({
      flowId:          id,
      signerEmail:     signer.email,
      status:          signer.status,
      stsPending:      signer.stsPending  || false,
      stsOpId:         signer.stsOpId     || null,
      provider:        signer.signingProvider || 'local-upload',
      // true → frontend trebuie să reia polling-ul STS imediat
      shouldResumePoll: signer.stsPending === true && !!signer.stsOpId,
    });
  } catch (err) {
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
