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

/**
 * Nodemailer accepta doua formate pentru "from":
 *   1. simplu:    noreply@docflowai.ro
 *   2. cu nume:   { name: "DocFlowAI", address: "noreply@docflowai.ro" }
 *
 * EBADNAME apare cand MAIL_FROM din .env este un string de tipul:
 *   DocFlowAI <noreply@docflowai.ro>
 * si nodemailer primeste obiectul { name, address } gresit formatat.
 *
 * Solutia: parsam manual string-ul si construim obiectul corect.
 */
function parseFrom(raw) {
  if (!raw) return null;

  // Format "Nume <email@domeniu.ro>"
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), address: match[2].trim() };
  }

  // Format simplu "email@domeniu.ro"
  return raw.trim();
}

export async function sendSignerEmail({ to, subject, html }) {
  const tx = ensureTransport();
  if (!tx) {
    console.warn("[email-disabled] Nu s-a trimis email la " + to + " — SMTP neconfigurat");
    return;
  }

  const rawFrom = process.env.MAIL_FROM || process.env.SMTP_USER;
  const from    = parseFrom(rawFrom);

  if (!from) {
    console.error("MAIL_FROM si SMTP_USER lipsesc — email anulat");
    return;
  }

  try {
    await tx.sendMail({ from, to, subject, html });
    console.log("Email trimis -> " + to + " | " + subject);
  } catch (err) {
    console.error("sendMail esuat catre " + to + " :", err.message);
    throw err;
  }
}
