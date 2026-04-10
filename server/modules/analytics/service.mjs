/**
 * server/modules/analytics/service.mjs — Analytics queries (all SQL, zero JS math).
 */

import { pool } from '../../db/index.mjs';

// ── getSummary ────────────────────────────────────────────────────────────────

/**
 * @param {number} org_id
 * @param {{ from?: string, to?: string }} opts
 */
export async function getSummary(org_id, { from, to } = {}) {
  const fromVal = from ? new Date(from) : null;
  const toVal   = to   ? new Date(to)   : null;

  // ── Flows aggregate ───────────────────────────────────────────────────────
  const { rows: [flowRow] } = await pool.query(
    `SELECT
       COUNT(*)                                         AS total,
       COUNT(*) FILTER (WHERE status='completed')       AS completed,
       COUNT(*) FILTER (WHERE status='refused')         AS refused,
       COUNT(*) FILTER (WHERE status='cancelled')       AS cancelled,
       COUNT(*) FILTER (WHERE status='in_progress')     AS in_progress,
       COUNT(*) FILTER (WHERE status='draft')           AS draft,
       ROUND(
         AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/3600.0)
           FILTER (WHERE status='completed' AND completed_at IS NOT NULL)
       ::numeric, 2)                                    AS avg_completion_hours
     FROM flows
     WHERE org_id=$1
       AND deleted_at IS NULL
       AND ($2::timestamptz IS NULL OR created_at >= $2)
       AND ($3::timestamptz IS NULL OR created_at <= $3)`,
    [org_id, fromVal, toVal]
  );

  // ── Signing aggregate ─────────────────────────────────────────────────────
  const { rows: sigRows } = await pool.query(
    `SELECT
       ss.provider_code,
       COUNT(*)                                       AS total,
       COUNT(*) FILTER (WHERE ss.status='completed')  AS completed,
       COUNT(*) FILTER (WHERE ss.status='failed')     AS failed
     FROM signature_sessions ss
     JOIN flows f ON f.id = ss.flow_id
     WHERE f.org_id=$1
       AND f.deleted_at IS NULL
       AND ($2::timestamptz IS NULL OR ss.created_at >= $2)
       AND ($3::timestamptz IS NULL OR ss.created_at <= $3)
     GROUP BY ss.provider_code`,
    [org_id, fromVal, toVal]
  );

  const sigTotal     = sigRows.reduce((s, r) => s + Number(r.total), 0);
  const sigCompleted = sigRows.reduce((s, r) => s + Number(r.completed), 0);
  const byProvider   = {};
  for (const r of sigRows) byProvider[r.provider_code] = Number(r.total);

  // ── Forms aggregate ───────────────────────────────────────────────────────
  const { rows: formRows } = await pool.query(
    `SELECT
       ft.code, ft.name,
       COUNT(fi.id) AS count
     FROM form_instances fi
     JOIN form_templates ft ON ft.id = fi.template_id
     WHERE fi.org_id=$1
       AND ($2::timestamptz IS NULL OR fi.created_at >= $2)
       AND ($3::timestamptz IS NULL OR fi.created_at <= $3)
     GROUP BY ft.code, ft.name
     ORDER BY count DESC`,
    [org_id, fromVal, toVal]
  );

  // ── Users aggregate ───────────────────────────────────────────────────────
  const { rows: [userRow] } = await pool.query(
    `SELECT
       COUNT(*)                                     AS total,
       COUNT(*) FILTER (WHERE status='active')      AS active
     FROM users WHERE org_id=$1`,
    [org_id]
  );

  // ── Recent activity (last 30 days) ────────────────────────────────────────
  const { rows: activityRows } = await pool.query(
    `SELECT
       gs.date::date                                              AS date,
       COUNT(f.id) FILTER (WHERE f.id IS NOT NULL)               AS flows_created,
       COUNT(f.id) FILTER (WHERE f.status='completed')           AS flows_completed
     FROM generate_series(
       (NOW() - INTERVAL '29 days')::date,
       NOW()::date,
       INTERVAL '1 day'
     ) AS gs(date)
     LEFT JOIN flows f
       ON f.org_id=$1
       AND f.deleted_at IS NULL
       AND f.created_at::date = gs.date::date
     GROUP BY gs.date
     ORDER BY gs.date`,
    [org_id]
  );

  return {
    flows: {
      total:       Number(flowRow.total),
      completed:   Number(flowRow.completed),
      refused:     Number(flowRow.refused),
      cancelled:   Number(flowRow.cancelled),
      in_progress: Number(flowRow.in_progress),
      draft:       Number(flowRow.draft),
    },
    signing: {
      total:        sigTotal,
      by_provider:  byProvider,
      success_rate: sigTotal > 0
        ? Math.round((sigCompleted / sigTotal) * 10000) / 100
        : 0,
    },
    forms: {
      total_instances: formRows.reduce((s, r) => s + Number(r.count), 0),
      by_template:     formRows.map(r => ({
        code:  r.code,
        name:  r.name,
        count: Number(r.count),
      })),
    },
    users: {
      total:  Number(userRow.total),
      active: Number(userRow.active),
    },
    avg_completion_hours: flowRow.avg_completion_hours
      ? parseFloat(flowRow.avg_completion_hours)
      : null,
    recent_activity: activityRows.map(r => ({
      date:             r.date,
      flows_created:    Number(r.flows_created),
      flows_completed:  Number(r.flows_completed),
    })),
  };
}

// ── getFlowsTimeline ──────────────────────────────────────────────────────────

/**
 * @param {number} org_id
 * @param {{ days?: number }} opts
 */
export async function getFlowsTimeline(org_id, { days = 30 } = {}) {
  const safeDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);

  const { rows } = await pool.query(
    `SELECT
       gs.date::date                                    AS date,
       COUNT(f.id) FILTER (WHERE f.id IS NOT NULL)     AS created,
       COUNT(f.id) FILTER (WHERE f.status='completed') AS completed,
       COUNT(f.id) FILTER (WHERE f.status='refused')   AS refused
     FROM generate_series(
       (NOW() - ($2 || ' days')::interval)::date,
       NOW()::date,
       INTERVAL '1 day'
     ) AS gs(date)
     LEFT JOIN flows f
       ON f.org_id=$1
       AND f.deleted_at IS NULL
       AND f.created_at::date = gs.date::date
     GROUP BY gs.date
     ORDER BY gs.date`,
    [org_id, safeDays]
  );

  return rows.map(r => ({
    date:      r.date,
    created:   Number(r.created),
    completed: Number(r.completed),
    refused:   Number(r.refused),
  }));
}

// ── getSigningStats ───────────────────────────────────────────────────────────

export async function getSigningStats(org_id) {
  const { rows } = await pool.query(
    `SELECT
       ss.provider_code,
       COUNT(*)                                        AS total,
       COUNT(*) FILTER (WHERE ss.status='completed')   AS completed,
       COUNT(*) FILTER (WHERE ss.status='failed')      AS failed,
       CASE
         WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(
           COUNT(*) FILTER (WHERE ss.status='completed')::numeric / COUNT(*) * 100,
           2
         )
       END AS success_rate
     FROM signature_sessions ss
     JOIN flows f ON f.id = ss.flow_id
     WHERE f.org_id=$1 AND f.deleted_at IS NULL
     GROUP BY ss.provider_code
     ORDER BY total DESC`,
    [org_id]
  );

  return rows.map(r => ({
    provider_code: r.provider_code,
    total:         Number(r.total),
    completed:     Number(r.completed),
    failed:        Number(r.failed),
    success_rate:  parseFloat(r.success_rate),
  }));
}

// ── getFormsStats ─────────────────────────────────────────────────────────────

export async function getFormsStats(org_id) {
  const { rows } = await pool.query(
    `SELECT
       ft.code         AS template_code,
       ft.name         AS template_name,
       COUNT(fi.id)    AS total,
       COUNT(fi.id) FILTER (WHERE fi.status='generated') AS completed
     FROM form_instances fi
     JOIN form_templates ft ON ft.id = fi.template_id
     WHERE fi.org_id=$1
     GROUP BY ft.code, ft.name
     ORDER BY total DESC`,
    [org_id]
  );

  return rows.map(r => ({
    template_code: r.template_code,
    template_name: r.template_name,
    total:         Number(r.total),
    completed:     Number(r.completed),
  }));
}
