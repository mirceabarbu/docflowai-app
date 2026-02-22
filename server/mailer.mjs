import nodemailer from "nodemailer";

let transporter = null;

function ensureTransport() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn("⚠  SMTP not fully configured — email disabled.");
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

export async function sendSignerEmail({ to, subject, html }) {
  const tx = ensureTransport();
  if (!tx) {
    console.log(`[email-disabled] Would send to ${to}: ${subject}`);
    return;
  }
  const from = process.env.MAIL_FROM || SMTP_USER;
  await tx.sendMail({ from, to, subject, html });
  console.log(`📧  Email trimis → ${to}`);
}
