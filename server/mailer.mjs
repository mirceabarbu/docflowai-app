import nodemailer from "nodemailer";

let transporter = null;

function ensureTransport() {
  if (transporter) return transporter;

  const SMTP_HOST   = process.env.SMTP_HOST;
  const SMTP_PORT   = process.env.SMTP_PORT;
  const SMTP_SECURE = process.env.SMTP_SECURE;
  const SMTP_USER   = process.env.SMTP_USER;
  const SMTP_PASS   = process.env.SMTP_PASS;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP incomplet — variabile lipsesc:", {
      SMTP_HOST:   !!SMTP_HOST,
      SMTP_PORT:   !!SMTP_PORT,
      SMTP_USER:   !!SMTP_USER,
      SMTP_PASS:   !!SMTP_PASS,
    });
    return null;
  }

  transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === "true",
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });

  console.log("SMTP configurat: " + SMTP_HOST + ":" + SMTP_PORT);
  return transporter;
}

export async function sendSignerEmail({ to, subject, html }) {
  const tx = ensureTransport();
  if (!tx) {
    console.warn("[email-disabled] Nu s-a trimis email la " + to + " — SMTP neconfigurat");
    return;
  }

  // BUG FIX: in versiunea anterioara "from" era process.env.MAIL_FROM || SMTP_USER
  // dar SMTP_USER era destructurat doar in ensureTransport(), nu in acest scope
  // => "from" devenea undefined si nodemailer refuza sa trimita
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  if (!from) {
    console.error("MAIL_FROM si SMTP_USER lipsesc din variabilele de mediu — email anulat");
    return;
  }

  try {
    await tx.sendMail({ from, to, subject, html });
    console.log("Email trimis -> " + to + " | " + subject);
  } catch (err) {
    // Aruncam eroarea sa apara clar in logs Railway/Vercel
    console.error("sendMail esuat catre " + to + " :", err.message);
    throw err;
  }
}
