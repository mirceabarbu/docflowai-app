import nodemailer from "nodemailer";

const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM } =
  process.env;

let transporter = null;

function ensureTransport() {
  if (transporter) return transporter;

  console.log("📬 SMTP config check:", {
    SMTP_HOST: SMTP_HOST || "❌ MISSING",
    SMTP_PORT: SMTP_PORT || "❌ MISSING",
    SMTP_SECURE: SMTP_SECURE || "(false)",
    SMTP_USER: SMTP_USER ? SMTP_USER.slice(0, 4) + "****" : "❌ MISSING",
    SMTP_PASS: SMTP_PASS ? "set(****)" : "❌ MISSING",
    MAIL_FROM: MAIL_FROM || "❌ MISSING",
  });

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
    console.warn("⚠ SMTP not fully configured. Email disabled.");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transporter;
}

export async function verifySmtp() {
  const tx = ensureTransport();
  if (!tx) {
    return {
      ok: false,
      error: "SMTP not configured",
      config: {
        SMTP_HOST: SMTP_HOST || "missing",
        SMTP_PORT: SMTP_PORT || "missing",
        SMTP_USER: SMTP_USER ? "set" : "missing",
        SMTP_PASS: SMTP_PASS ? "set" : "missing",
        MAIL_FROM: MAIL_FROM || "missing",
      },
    };
  }
  try {
    await tx.verify();
    return { ok: true, host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER };
  } catch (e) {
    return { ok: false, error: String(e.message || e), host: SMTP_HOST, port: SMTP_PORT };
  }
}

export async function sendSignerEmail({ to, subject, html }) {
  const tx = ensureTransport();
  if (!tx) {
    console.warn("⚠ sendSignerEmail skipped — SMTP not configured.");
    return;
  }
  try {
    const info = await tx.sendMail({ from: MAIL_FROM, to, subject, html });
    console.log(`📧 Email sent to ${to} | messageId: ${info.messageId}`);
  } catch (e) {
    console.error(`❌ sendMail FAILED to ${to}:`, e.message);
    throw e;
  }
}
