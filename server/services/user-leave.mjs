import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

// ── Lookups ──────────────────────────────────────────────────────────────────

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
    return false;
  }
}

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
    if (!r.leave_start) return null;
    const leaveStart = _isoDate(r.leave_start);
    const leaveEnd = r.leave_end ? _isoDate(r.leave_end) : null;
    const onLeave = !!leaveEnd && leaveStart <= today && leaveEnd >= today;
    return {
      onLeave,
      leaveStart,
      leaveEnd,
      leaveReason: r.leave_reason || null,
      delegate: r.d_id
        ? { id: r.d_id, nume: r.d_nume || '', email: r.d_email || '',
            functie: r.d_functie || '', reason: r.leave_reason || '' }
        : null,
    };
  } catch (e) {
    logger.warn({ err: e, userId }, 'getLeaveInfo lookup failed');
    return null;
  }
}

// Optimizare N+1 pentru /users (50+ useri)
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
          ? { id: r.d_id, nume: r.d_nume || '', email: r.d_email || '',
              functie: r.d_functie || '', reason: r.leave_reason || '' }
          : null,
      });
    }
  } catch (e) {
    logger.warn({ err: e, count: userIds.length }, 'batchGetLeaveInfo failed');
  }
  return map;
}

// ── Validation ───────────────────────────────────────────────────────────────

export async function validateLeaveSettings({ targetUserId, leaveStart, leaveEnd, delegateUserId, leaveReason }) {
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
    if (rows[0].del_has_delegate !== null) throw new Error('delegate_has_own_delegate');
  }
  if (leaveReason && typeof leaveReason === 'string' && leaveReason.length > 500) {
    throw new Error('leave_reason_too_long');
  }
}

export async function setUserLeave({ targetUserId, leaveStart, leaveEnd, delegateUserId, leaveReason }) {
  await pool.query(
    `UPDATE users
     SET leave_start = $2, leave_end = $3, delegate_user_id = $4, leave_reason = $5
     WHERE id = $1`,
    [targetUserId, leaveStart || null, leaveEnd || null, delegateUserId || null, leaveReason || null]
  );
}

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
