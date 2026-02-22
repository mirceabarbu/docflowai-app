import nodemailer from "nodemailer";

const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM } =
  process.env;

let transporter = null;

function ensureTransport() {
  if (transporter) return transporter;

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

export async function sendSignerEmail({ to, subject, html }) {
  const tx = ensureTransport();
  if (!tx) return;
  await tx.sendMail({ from: MAIL_FROM, to, subject, html });
  console.log(`📧 Email sent to ${to}`);
}
