const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "DocFlowAI <noreply@docflowai.ro>";

export async function verifySmtp() {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY missing" };
  }
  try {
    const r = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j?.message || "Resend auth failed", status: r.status };
    return { ok: true, provider: "resend", from: MAIL_FROM, domains: j?.data?.map(d => d.name) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function sendSignerEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    logger.warn("⚠ sendSignerEmail skipped — RESEND_API_KEY not set.");
    return;
  }

  const payload = { from: MAIL_FROM, to, subject, html };

  logger.info(`📬 Sending email via Resend to ${to}...`);

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => ({}));

  if (!r.ok) {
    logger.error(`❌ Resend FAILED to ${to}:`, j);
    throw new Error(j?.message || `Resend error ${r.status}`);
  }

  logger.info(`📧 Email sent to ${to} | id: ${j.id}`);
  return { ok: true, id: j.id };
}
