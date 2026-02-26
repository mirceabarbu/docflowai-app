import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import nodemailer from "nodemailer";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---- Basics
app.disable("x-powered-by");
app.use(express.json({ limit: "35mb" }));
app.use(express.urlencoded({ extended: true, limit: "35mb" }));

// CORS: keep permissive for now (you can lock it later)
app.use(cors());

// ---- Env / config helpers
const envBool = (v, d = false) => {
  if (v === undefined || v === null || v === "") return d;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true" || String(v) === "1";
};
const envInt = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// Mail envs: accept both SMTP_* and MAIL_* styles
const SMTP_HOST = process.env.SMTP_HOST || process.env.MAIL_HOST || "";
const SMTP_PORT = envInt(process.env.SMTP_PORT ?? process.env.MAIL_PORT, 587);
const SMTP_SECURE = envBool(process.env.SMTP_SECURE ?? process.env.MAIL_SECURE, false);
const SMTP_USER = process.env.SMTP_USER || process.env.MAIL_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || process.env.MAIL_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || process.env.FROM_EMAIL || process.env.SMTP_FROM || "noreply@docflowai.ro";

// Public base URL (used in links)
const normalizeBaseUrl = (u) => {
  if (!u) return "";
  return String(u).replace(/\/+$/, ""); // remove trailing /
};
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || "");

// ---- Static UI
// IMPORTANT: UI should be at root https://app.docflowai.ro (no /app)
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir, { maxAge: "1h" }));

app.get("/", (req, res) => {
  // Main UI (flow initiate)
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---- DB
let DB_READY = false;
let DB_LAST_ERROR = null;

const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
    })
  : null;

async function initDbOnce() {
  if (!pool) throw new Error("DATABASE_URL missing");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  DB_READY = true;
  DB_LAST_ERROR = null;
  console.log("✅ DB ready (flows table ensured)");
}

async function initDbWithRetry() {
  const delays = [1000, 2000, 4000, 8000, 15000];
  for (let i = 0; i < delays.length; i++) {
    try {
      console.log(`⏳ DB init attempt ${i + 1}/${delays.length}...`);
      await initDbOnce();
      return;
    } catch (e) {
      DB_READY = false;
      DB_LAST_ERROR = String(e?.message || e);
      console.error("❌ DB init failed:", e);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

function requireDb(res) {
  if (DB_READY) return false;
  res.status(503).json({ error: "db_not_ready", detail: DB_LAST_ERROR });
  return true;
}

async function saveFlow(flowId, data) {
  await pool.query(
    `INSERT INTO flows (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [flowId, JSON.stringify(data)]
  );
}

async function fetchFlow(flowId) {
  const r = await pool.query(`SELECT data FROM flows WHERE id=$1`, [flowId]);
  if (r.rowCount === 0) return null;
  return r.rows[0].data;
}

// ---- Admin auth
function requireAdmin(req, res) {
  if (!ADMIN_SECRET) return false; // if not set, allow (MVP)
  const h = req.headers["x-admin-secret"];
  if (h && String(h) === String(ADMIN_SECRET)) return false;
  res.status(401).json({ error: "unauthorized" });
  return true;
}

// ---- Utils
function stripPdfB64(flowData) {
  // avoid returning huge base64 for list/get calls (UI can call /pdf endpoint)
  const copy = JSON.parse(JSON.stringify(flowData || {}));
  if (copy?.pdfBase64) copy.pdfBase64 = "__omitted__";
  return copy;
}

function buildSignerLink(flowId, token) {
  const base = PUBLIC_BASE_URL || ""; // must be set in Railway
  const b = base ? base : ""; // fallback empty
  // signer page is a static file at root: /semdoc-signer.html
  return `${b}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(token)}`;
}

function newId(prefix = "FLOW") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}
function newToken() {
  return crypto.randomBytes(18).toString("hex");
}

// ---- Mailer (non-blocking)
function makeTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 12_000,
  });
}

async function sendEmailNonBlocking({ to, subject, html, text }) {
  try {
    const transport = makeTransport();
    if (!transport) {
      console.warn("⚠️ Mail not configured (missing SMTP_*). Skipping send.");
      return;
    }
    await transport.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text,
      html,
    });
    console.log(`✉️ Email sent to ${to}`);
  } catch (e) {
    // DO NOT throw (must not kill request)
    console.error("✖ Email send failed (non-blocking):", e?.message || e);
  }
}

// ---- Health
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "SemDoc+", dbReady: DB_READY, dbLastError: DB_LAST_ERROR });
});

// Optional: keepalive log (harmless)
setInterval(() => {
  console.log("❤️ heartbeat alive");
}, 5000).unref?.();

// ---- API: Create flow
async function handleCreateFlow(req, res) {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;

    const body = req.body || {};
    const title = String(body.title || "Document");
    const pdfBase64 = typeof body.pdfBase64 === "string" ? body.pdfBase64 : "";

    const rawSigners = Array.isArray(body.signers) ? body.signers : [];
    const signers = rawSigners.map((s, idx) => ({
      i: idx,
      name: String(s?.name || `Semnatar ${idx + 1}`),
      email: String(s?.email || ""),
      role: String(s?.role || ""),
      status: "PENDING", // PENDING | SIGNED
      token: s?.token ? String(s.token) : newToken(),
      signedAt: null,
      signature: null,
    }));

    const flowId = newId("FLOW");
    const createdAt = new Date().toISOString();

    const flow = {
      flowId,
      title,
      createdAt,
      updatedAt: createdAt,
      pdfBase64,
      signers,
    };

    await saveFlow(flowId, flow);

    // prepare links
    const links = signers.map((s) => ({
      name: s.name,
      email: s.email,
      role: s.role,
      token: s.token,
      url: buildSignerLink(flowId, s.token),
    }));

    // send mails (best-effort)
    for (const l of links) {
      if (!l.email) continue;
      const subject = `SemDoc: semnare document – ${title}`;
      const text = `Ai fost invitat(ă) să semnezi: ${title}\nLink: ${l.url}`;
      const html = `
        <div style="font-family:Arial,sans-serif">
          <h3>SemDoc – Semnare document</h3>
          <p>Salut, ${escapeHtml(l.name)}!</p>
          <p>Ai fost invitat(ă) să semnezi documentul: <b>${escapeHtml(title)}</b></p>
          <p><a href="${l.url}">Deschide link-ul de semnare</a></p>
        </div>
      `;
      sendEmailNonBlocking({ to: l.email, subject, text, html });
    }

    res.json({ ok: true, flowId, links });
  } catch (e) {
    console.error("POST /flows error:", e);
    res.status(500).json({ error: "server_error" });
  }
}

// escape helper for email HTML
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// aliases
app.post("/flows", handleCreateFlow);
app.post("/api/flows", handleCreateFlow);

// ---- API: Get flow (metadata)
async function handleGetFlow(req, res) {
  try {
    if (requireDb(res)) return;
    const data = await fetchFlow(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    return res.json(stripPdfB64(data));
  } catch (e) {
    console.error("GET /flows/:flowId error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
app.get("/flows/:flowId", handleGetFlow);
app.get("/api/flows/:flowId", handleGetFlow);

// ---- API: Get PDF (base64)
async function handleGetPdf(req, res) {
  try {
    if (requireDb(res)) return;
    const data = await fetchFlow(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    const b64 = data?.pdfBase64;
    if (!b64 || b64 === "__omitted__") return res.status(404).json({ error: "pdf_missing" });
    return res.json({ flowId: req.params.flowId, pdfBase64: b64 });
  } catch (e) {
    console.error("GET /flows/:flowId/pdf error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
app.get("/flows/:flowId/pdf", handleGetPdf);
app.get("/api/flows/:flowId/pdf", handleGetPdf);

// ---- API: Update flow (replace)
async function handlePutFlow(req, res) {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;

    const { flowId } = req.params;
    const existing = await fetchFlow(flowId);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const next = req.body || {};
    next.flowId = flowId;
    next.updatedAt = new Date().toISOString();

    await saveFlow(flowId, next);
    return res.json({ ok: true });
  } catch (e) {
    console.error("PUT /flows/:flowId error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
app.put("/flows/:flowId", handlePutFlow);
app.put("/api/flows/:flowId", handlePutFlow);

// ---- API: Sign
async function handleSign(req, res) {
  try {
    if (requireDb(res)) return;

    const { flowId } = req.params;
    const { token, signature } = req.body || {};
    const sig = typeof signature === "string" ? signature.trim() : "";
    if (!sig) return res.status(400).json({ error: "signature_required" });
    if (!token) return res.status(400).json({ error: "token_required" });

    const data = await fetchFlow(flowId);
    if (!data) return res.status(404).json({ error: "not_found" });

    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex((s) => String(s.token) === String(token));
    if (idx === -1) return res.status(403).json({ error: "invalid_token" });

    // enforce sequential signing: all previous must be SIGNED
    for (let i = 0; i < idx; i++) {
      if (String(signers[i].status) !== "SIGNED") {
        return res.status(409).json({ error: "not_your_turn" });
      }
    }

    signers[idx].status = "SIGNED";
    signers[idx].signedAt = new Date().toISOString();
    signers[idx].signature = sig;

    data.signers = signers;
    data.updatedAt = new Date().toISOString();
    await saveFlow(flowId, data);

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /flows/:flowId/sign error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
app.post("/flows/:flowId/sign", handleSign);
app.post("/api/flows/:flowId/sign", handleSign);

// ---- Start
const PORT = process.env.PORT;
if (!PORT) {
  console.error("❌ PORT missing. Railway didn't inject PORT. Check Service Type (must be Web Service).");
  process.exit(1);
}

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`🚀 SemDoc+ server running on port ${PORT}`);
  initDbWithRetry();
});

// ---- Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  pool?.end?.().catch(() => {});
  process.exit(0);
});
