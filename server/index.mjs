import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "crypto";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { sendSignerEmail, verifySmtp } from "./mailer.mjs";
import { sendWaSignRequest, sendWaCompleted, sendWaRefused, verifyWhatsApp, isWhatsAppConfigured } from "./whatsapp.mjs";
import { archiveFlow, verifyDrive } from "./drive.mjs";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "../public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "semdoc-initiator.html")));
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "login.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));
app.get("/notifications", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "notifications.html")));
app.get("/templates", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "templates.html")));

// ==================== TEMPLATE API ====================

// GET /api/templates — sabloanele userului + cele shared din institutie
app.get("/api/templates", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  try {
    const { rows: uRows } = await pool.query("SELECT institutie FROM users WHERE email=$1", [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || "";
    const { rows } = await pool.query(
      `SELECT * FROM templates WHERE user_email=$1 OR (shared=TRUE AND institutie=$2 AND institutie!='')
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), institutie]
    );
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// POST /api/templates — creeaza sablon nou
app.post("/api/templates", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  const { name, signers, shared } = req.body||{};
  if (!name||!name.trim()) return res.status(400).json({error:"name_required"});
  if (!Array.isArray(signers)||signers.length===0) return res.status(400).json({error:"signers_required"});
  try {
    const { rows: uRows } = await pool.query("SELECT institutie FROM users WHERE email=$1", [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || "";
    const { rows } = await pool.query(
      `INSERT INTO templates (user_email,institutie,name,signers,shared) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [actor.email.toLowerCase(), institutie, name.trim(), JSON.stringify(signers), !!shared]
    );
    res.status(201).json({ ...rows[0], isOwner: true });
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// PUT /api/templates/:id — actualizeaza sablon
app.put("/api/templates/:id", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  const { name, signers, shared } = req.body||{};
  try {
    const { rows } = await pool.query(
      `UPDATE templates SET name=$1,signers=$2,shared=$3,updated_at=NOW()
       WHERE id=$4 AND user_email=$5 RETURNING *`,
      [name?.trim(), JSON.stringify(signers), !!shared, parseInt(req.params.id), actor.email.toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({error:"not_found_or_not_owner"});
    res.json({ ...rows[0], isOwner: true });
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// DELETE /api/templates/:id — sterge sablon (doar owner)
app.delete("/api/templates/:id", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM templates WHERE id=$1 AND user_email=$2",
      [parseInt(req.params.id), actor.email.toLowerCase()]
    );
    if (!rowCount) return res.status(404).json({error:"not_found_or_not_owner"});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

function publicBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}
function newFlowId() { return "FLOW_" + crypto.randomBytes(8).toString("hex").toUpperCase(); }
function sha256Hex(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function generatePassword() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let p = "";
  for (let i = 0; i < 9; i++) { if (i===3||i===6) p+="-"; p+=chars[crypto.randomInt(chars.length)]; }
  return p;
}

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const JWT_EXPIRES = "2h";
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha256").toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha256").toString("hex");
  return check === hash;
}
function requireAuth(req, res) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) { res.status(401).json({ error: "unauthorized" }); return null; }
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { res.status(401).json({ error: "token_invalid_or_expired" }); return null; }
}
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
function requireAdmin(req, res) {
  if (!ADMIN_SECRET) { res.status(503).json({ error: "admin_not_configured" }); return true; }
  const provided = req.get("x-admin-secret") || (req.get("authorization")||"").slice(7).trim();
  if (!provided || provided !== ADMIN_SECRET) { res.status(401).json({ error: "unauthorized" }); return true; }
  return false;
}
function stripPdfB64(data) {
  if (!data || typeof data !== "object") return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
}
// Elimină token-urile semnatarilor și pdfB64 din răspunsuri publice
function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== "object") return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ...rest,
    hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === "drive" && data.driveFileLinkFinal)),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = s;
      // Returnează token DOAR pentru semnatarul care face cererea
      return callerSignerToken && s.token === callerSignerToken
        ? { ...signerRest, token }
        : signerRest;
    }),
  };
}

const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;
let DB_READY = false, DB_LAST_ERROR = null;

async function initDbOnce() {
  if (!pool) throw new Error("DATABASE_URL missing");
  await pool.query("SELECT 1");
  await pool.query(`CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_flows_updated_at ON flows(updated_at DESC);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, plain_password TEXT, nume TEXT NOT NULL DEFAULT '', functie TEXT NOT NULL DEFAULT '', institutie TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  // Tabel notificari in-app (nou - nu modifica flows sau users)
  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, flow_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, read BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_email ON notifications(user_email, read, created_at DESC);`);
  const alterCols = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nume TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS functie TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS institutie TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users DROP COLUMN IF EXISTS username",
    // Campuri noi: telefon + preferinte notificari
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_inapp BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_email BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_whatsapp BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS compartiment TEXT NOT NULL DEFAULT ''",  // nou
  ];
  for (const sql of alterCols) await pool.query(sql).catch(() => {});
  const { rows: uc } = await pool.query("SELECT COUNT(*) FROM users");
  if (parseInt(uc[0].count) === 0 && process.env.ADMIN_INIT_PASSWORD) {
    const pwd = process.env.ADMIN_INIT_PASSWORD;
    await pool.query("INSERT INTO users (email, password_hash, plain_password, nume, functie, role) VALUES ($1,$2,$3,$4,$5,'admin') ON CONFLICT DO NOTHING",
      ["admin@docflowai.ro", hashPassword(pwd), pwd, "Administrator", "Administrator sistem"]);
    console.log("✅ Admin user created");
  }
  // Tabel sabloane
  await pool.query(`CREATE TABLE IF NOT EXISTS templates (
    id SERIAL PRIMARY KEY,
    user_email TEXT NOT NULL,
    institutie TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    signers JSONB NOT NULL DEFAULT '[]',
    shared BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tmpl_user ON templates(user_email, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tmpl_inst ON templates(institutie, shared) WHERE shared=TRUE;`);

  DB_READY = true; DB_LAST_ERROR = null;
  console.log("✅ DB ready (flows + users + notifications)");
}
async function initDbWithRetry() {
  const delays = [1000,2000,4000,8000,15000];
  for (let i=0; i<delays.length; i++) {
    try { console.log(`⏳ DB init attempt ${i+1}/${delays.length}...`); await initDbOnce(); return; }
    catch(e) { DB_READY=false; DB_LAST_ERROR=String(e?.message||e); console.error("❌ DB init failed:",e); await new Promise(r=>setTimeout(r,delays[i])); }
  }
  console.error("❌ DB init failed permanently.");
}
function requireDb(res) {
  if (!DB_READY) { res.status(503).json({ error:"db_not_ready", dbLastError:DB_LAST_ERROR }); return true; }
  return false;
}
async function saveFlow(id, data) {
  await pool.query(`INSERT INTO flows (id,data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`, [id, JSON.stringify(data)]);
}
async function getFlowData(id) {
  const r = await pool.query(`SELECT data FROM flows WHERE id=$1`, [id]);
  return r.rows[0]?.data ?? null;
}
function buildSignerLink(req, flowId, token) {
  return `${publicBaseUrl(req)}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(token)}`;
}

// ==================== WEBSOCKET ====================
const wsClients = new Map();
function wsRegister(email, ws) {
  if (!wsClients.has(email)) wsClients.set(email, new Set());
  wsClients.get(email).add(ws);
}
function wsUnregister(email, ws) {
  wsClients.get(email)?.delete(ws);
  if (wsClients.get(email)?.size === 0) wsClients.delete(email);
}
function wsPush(email, payload) {
  const conns = wsClients.get(email.toLowerCase());
  if (!conns) return;
  const msg = JSON.stringify(payload);
  for (const ws of conns) { try { if (ws.readyState===1) ws.send(msg); } catch(e) {} }
}

// Verifica token semnatar cu expiry (90 zile)
const SIGNER_TOKEN_EXPIRY_DAYS = 90;
function isSignerTokenExpired(signer) {
  if (!signer.tokenCreatedAt) return false; // token vechi fără dată — permitem
  const created = new Date(signer.tokenCreatedAt).getTime();
  return Date.now() - created > SIGNER_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

async function notify({ userEmail, flowId=null, type, title, message, waParams=null }) {
  if (!pool || !DB_READY) return;
  try {
    // 1. Notificare in-app (intotdeauna, daca userul are notif_inapp=true sau ca fallback)
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_email,flow_id,type,title,message) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userEmail.toLowerCase(), flowId, type, title, message]
    );
    wsPush(userEmail, { event:"notification", data:rows[0] });
    const { rows:cnt } = await pool.query("SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE", [userEmail.toLowerCase()]);
    wsPush(userEmail, { event:"unread_count", count:parseInt(cnt[0].count) });

    // 2. Email + WhatsApp — fetch user preferences o singură dată
    try {
      const { rows: uRows } = await pool.query(
        "SELECT phone, notif_whatsapp, notif_email FROM users WHERE email=$1", [userEmail.toLowerCase()]
      );
      const u = uRows[0];

      // 2a. Email — dacă userul are notif_email=true
      if (u?.notif_email && waParams) {
        let emailSent = false, emailErr = null;
        try {
          let emailSubject = title;
          let emailHtml = `<p>${message}</p>`;
          if (type === "YOUR_TURN") {
            emailSubject = `📄 Document de semnat: ${waParams.docName||""}`;
            emailHtml = `<p>Bună ziua,</p><p>${message}</p><p>Intră în <a href="${process.env.PUBLIC_BASE_URL||"https://app.docflowai.ro"}">DocFlowAI</a> pentru a semna documentul.</p>`;
          } else if (type === "COMPLETED") {
            emailSubject = `✅ Document semnat complet: ${waParams.docName||""}`;
            emailHtml = `<p>Bună ziua,</p><p>${message}</p><p>Poți descărca documentul din <a href="${process.env.PUBLIC_BASE_URL||"https://app.docflowai.ro"}">DocFlowAI</a>.</p>`;
          } else if (type === "REFUSED") {
            emailSubject = `⛔ Document refuzat: ${waParams.docName||""}`;
            emailHtml = `<p>Bună ziua,</p><p>${message}</p>`;
          }
          await sendSignerEmail({ to: userEmail, subject: emailSubject, html: emailHtml });
          emailSent = true;
        } catch(e) { emailErr = e.message; console.error("Email notify error:", e.message); }
        // Log în events
        if (flowId) {
          try {
            const fd = await getFlowData(flowId);
            if (fd) {
              fd.events = fd.events || [];
              fd.events.push({at:new Date().toISOString(), type:"NOTIFY", channel:"email", to:userEmail, notifType:type, ok:emailSent, err:emailErr||undefined});
              await saveFlow(flowId, fd);
            }
          } catch(logErr) { /* nu blocăm pentru log */ }
        }
      }

      // 2b. WhatsApp — dacă userul are notif_whatsapp=true și telefon
      if (isWhatsAppConfigured() && waParams && u?.notif_whatsapp && u?.phone) {
        let waSent = false, waErr = null;
        try {
          if (type === "YOUR_TURN") await sendWaSignRequest({ phone: u.phone, signerName: waParams.signerName||"", docName: waParams.docName||"" });
          else if (type === "COMPLETED") await sendWaCompleted({ phone: u.phone, docName: waParams.docName||"" });
          else if (type === "REFUSED") await sendWaRefused({ phone: u.phone, docName: waParams.docName||"", refuserName: waParams.refuserName||"", reason: waParams.reason||"" });
          waSent = true;
        } catch(e) { waErr = e.message; console.error("WhatsApp notify error:", e.message); }
        // Log în events
        if (flowId) {
          try {
            const fd = await getFlowData(flowId);
            if (fd) {
              fd.events = fd.events || [];
              fd.events.push({at:new Date().toISOString(), type:"NOTIFY", channel:"whatsapp", to:userEmail, notifType:type, ok:waSent, err:waErr||undefined});
              await saveFlow(flowId, fd);
            }
          } catch(logErr) { /* nu blocăm pentru log */ }
        }
      }
    } catch(e) { console.error("notify() channels error:", e.message); }
  } catch(e) { console.error("notify() error:", e.message); }
}

// ==================== AUTH ====================
// Rate limiter in-memory pentru login (fără dependențe externe)
const loginAttempts = new Map(); // key: ip+email -> {count, firstAt, blockedUntil}
const LOGIN_MAX = 10;          // max încercări
const LOGIN_WINDOW = 15*60*1000; // 15 minute fereastră
const LOGIN_BLOCK = 15*60*1000;  // 15 minute blocare
function loginRateKey(req, email) { return `${req.ip||""}:${(email||"").toLowerCase()}`; }
function checkLoginRate(req, email) {
  const key = loginRateKey(req, email);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (entry?.blockedUntil && now < entry.blockedUntil) {
    const remainSec = Math.ceil((entry.blockedUntil - now) / 1000);
    return { blocked: true, remainSec };
  }
  return { blocked: false };
}
function recordLoginFail(req, email) {
  const key = loginRateKey(req, email);
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count:0, firstAt:now };
  if (now - entry.firstAt > LOGIN_WINDOW) { entry.count = 0; entry.firstAt = now; delete entry.blockedUntil; }
  entry.count++;
  if (entry.count >= LOGIN_MAX) entry.blockedUntil = now + LOGIN_BLOCK;
  loginAttempts.set(key, entry);
}
function clearLoginRate(req, email) { loginAttempts.delete(loginRateKey(req, email)); }
// Curăță periodic intrările vechi
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of loginAttempts.entries()) {
    if (now - v.firstAt > LOGIN_WINDOW*2 && (!v.blockedUntil || now > v.blockedUntil)) loginAttempts.delete(k);
  }
}, 5*60*1000);

app.post("/auth/login", async (req,res) => {
  if (requireDb(res)) return;
  const { email, password } = req.body||{};
  if (!email||!password) return res.status(400).json({error:"email_and_password_required"});
  // Rate limit check
  const rateCheck = checkLoginRate(req, email);
  if (rateCheck.blocked) {
    return res.status(429).json({error:"too_many_attempts", message:`Prea multe încercări. Încearcă din nou în ${Math.ceil(rateCheck.remainSec/60)} minute.`, remainSec: rateCheck.remainSec});
  }
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [email.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordLoginFail(req, email);
      return res.status(401).json({error:"invalid_credentials"});
    }
    clearLoginRate(req, email); // reset la login reușit
    const token = jwt.sign({userId:user.id, email:user.email, role:user.role, nume:user.nume, functie:user.functie, institutie:user.institutie}, JWT_SECRET, {expiresIn:JWT_EXPIRES});
    return res.json({token, email:user.email, role:user.role, nume:user.nume, functie:user.functie, institutie:user.institutie});
  } catch(e) { return res.status(500).json({error:"server_error"}); }
});
app.get("/auth/me", async (req,res) => {
  const decoded = requireAuth(req,res);
  if (!decoded) return;
  if (!pool||!DB_READY) return res.json(decoded);
  try {
    const { rows } = await pool.query("SELECT id,email,nume,functie,institutie,role FROM users WHERE id=$1", [decoded.userId]);
    if (!rows[0]) return res.status(401).json({error:"user_not_found"});
    res.json({userId:rows[0].id, email:rows[0].email, nume:rows[0].nume, functie:rows[0].functie, institutie:rows[0].institutie, role:rows[0].role});
  } catch(e) { res.json(decoded); }
});

// ==================== NOTIFICATIONS API ====================
app.get("/api/notifications", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res);
  if (!actor) return;
  try {
    const { rows } = await pool.query(`SELECT * FROM notifications WHERE user_email=$1 ORDER BY created_at DESC LIMIT 100`, [actor.email.toLowerCase()]);
    res.json(rows);
  } catch(e) { res.status(500).json({error:"server_error"}); }
});
// GET /api/notifications/with-status — notificari imbogatite cu statusul curent al semnatorului
app.get("/api/notifications/with-status", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res);
  if (!actor) return;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE user_email=$1 ORDER BY created_at DESC LIMIT 100`,
      [actor.email.toLowerCase()]
    );
    // Pentru notificarile YOUR_TURN, verifica daca userul a semnat deja in flow
    const enriched = await Promise.all(rows.map(async (n) => {
      if (n.type === 'YOUR_TURN' && n.flow_id) {
        try {
          const fRow = await pool.query("SELECT data FROM flows WHERE id=$1", [n.flow_id]);
          const flowData = fRow.rows[0]?.data;
          if (flowData) {
            const signer = (flowData.signers||[]).find(s=>(s.email||"").toLowerCase()===actor.email.toLowerCase());
            return { ...n, signer_status: signer?.status || null };
          }
        } catch(e) {}
      }
      return { ...n, signer_status: null };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

app.get("/api/notifications/unread-count", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res);
  if (!actor) return;
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE", [actor.email.toLowerCase()]);
    res.json({count:parseInt(rows[0].count)});
  } catch(e) { res.status(500).json({error:"server_error"}); }
});
app.post("/api/notifications/:id/read", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res);
  if (!actor) return;
  try {
    await pool.query("UPDATE notifications SET read=TRUE WHERE id=$1 AND user_email=$2", [parseInt(req.params.id), actor.email.toLowerCase()]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:"server_error"}); }
});
app.post("/api/notifications/read-all", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res);
  if (!actor) return;
  try {
    await pool.query("UPDATE notifications SET read=TRUE WHERE user_email=$1 AND read=FALSE", [actor.email.toLowerCase()]);
    wsPush(actor.email, {event:"unread_count", count:0});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:"server_error"}); }
});
// GET /api/my-signer-token/:flowId — returneaza token-ul de semnare pentru userul curent
app.get("/api/my-signer-token/:flowId", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res);
  if (!actor) return;
  try {
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    const signer = (data.signers||[]).find(s=>(s.email||"").toLowerCase()===actor.email.toLowerCase());
    if (!signer) return res.status(403).json({error:"not_a_signer"});
    res.json({ token: signer.token, flowId: req.params.flowId, status: signer.status });
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

app.delete("/api/notifications/:id", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res);
  if (!actor) return;
  try {
    await pool.query("DELETE FROM notifications WHERE id=$1 AND user_email=$2", [parseInt(req.params.id), actor.email.toLowerCase()]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// ==================== ADMIN ====================
app.post("/admin/users/:id/send-credentials", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  const targetId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query("SELECT email,nume,functie,plain_password FROM users WHERE id=$1", [targetId]);
    const u = rows[0];
    if (!u) return res.status(404).json({error:"user_not_found"});
    if (!u.plain_password) return res.status(400).json({error:"no_password_available"});
    const appUrl = process.env.PUBLIC_BASE_URL || "https://app.docflowai.ro";
    await sendSignerEmail({ to:u.email, subject:"Cont DocFlowAI — credențiale de acces",
      html:`<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
        <div style="text-align:center;margin-bottom:28px;"><div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;">📋 DocFlowAI</div></div>
        <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${u.nume?', '+u.nume:''},</h2>
        <p style="color:#9db0ff;margin:0 0 24px;line-height:1.6;">Contul tău în <strong style="color:#eaf0ff;">DocFlowAI</strong> a fost creat.</p>
        <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px 24px;margin-bottom:24px;">
          <div style="margin-bottom:14px;"><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">EMAIL</span><strong>${u.email}</strong></div>
          <div><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">PAROLĂ</span><strong style="color:#ffd580;font-family:monospace;">${u.plain_password}</strong></div>
        </div>
        <div style="text-align:center;"><a href="${appUrl}/login" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;">Intră în cont →</a></div>
      </div>` });
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:"email_failed", detail:String(e.message||e)}); }
});
app.post("/admin/flows/clean", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  const { olderThanDays, all } = req.body||{};
  try {
    let result;
    if (all) result = await pool.query("DELETE FROM flows");
    else result = await pool.query("DELETE FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL", [parseInt(olderThanDays)||30]);
    res.json({ok:true, deleted:result.rowCount});
  } catch(e) { res.status(500).json({error:"server_error"}); }
});
app.get("/my-flows", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  try {
    const { rows } = await pool.query(`SELECT id,data,created_at,updated_at FROM flows ORDER BY updated_at DESC LIMIT 200`);
    const email = actor.email.toLowerCase();
    // Fetch user details for functie+compartiment lookup
    const { rows: userRows } = await pool.query("SELECT email,functie,compartiment FROM users");
    const userMap = {};
    userRows.forEach(u => { userMap[(u.email||"").toLowerCase()] = u; });

    const myFlows = rows.map(r=>r.data).filter(d => {
      if (!d) return false;
      return (d.initEmail||"").toLowerCase()===email || (d.signers||[]).some(s=>(s.email||"").toLowerCase()===email);
    }).map(d => ({
      flowId:d.flowId, docName:d.docName||"—", initName:d.initName, initEmail:d.initEmail,
      createdAt:d.createdAt, updatedAt:d.updatedAt,
      signers:(d.signers||[]).map(s=>{
        const u = userMap[(s.email||"").toLowerCase()] || {};
        return {
          name:s.name, email:s.email, rol:s.rol,
          functie: s.functie || u.functie || "",
          compartiment: s.compartiment || u.compartiment || "",
          status:s.status, signedAt:s.signedAt, refuseReason:s.refuseReason
        };
      }),
      hasSignedPdf:!!(d.signedPdfB64||(d.storage==="drive"&&d.driveFileLinkFinal)), allSigned:(d.signers||[]).every(s=>s.status==="signed"),
    }));
    res.json(myFlows);
  } catch(e) { res.status(500).json({error:"server_error"}); }
});
app.get("/my-flows/:flowId/download", async (req,res) => {
  if (requireDb(res)) return;
  const qToken = req.query.token;
  let actor = null;
  if (qToken) { try { actor = jwt.verify(qToken, JWT_SECRET); } catch(e) {} }
  if (!actor) actor = requireAuth(req,res);
  if (!actor) return;
  try {
    const { rows } = await pool.query("SELECT data FROM flows WHERE id=$1", [req.params.flowId]);
    const d = rows[0]?.data;
    if (!d) return res.status(404).json({error:"not_found"});
    const email = actor.email.toLowerCase();
    const isInit = (d.initEmail||"").toLowerCase()===email;
    const isSigner = (d.signers||[]).some(s=>(s.email||"").toLowerCase()===email);
    if (!isInit&&!isSigner) return res.status(403).json({error:"forbidden"});
    if (!d.signedPdfB64) {
      // Arhivat în Drive — proxy stream (nu redirect public)
      if (d.storage==="drive" && d.driveFileIdFinal) {
        try {
          const { streamFromDrive } = await import("./drive.mjs");
          const safeName2 = (d.docName||"document").replace(/[^\w\-]+/g,"_");
          res.setHeader("Content-Type","application/pdf");
          res.setHeader("Content-Disposition",`attachment; filename="${safeName2}_semnat.pdf"`);
          await streamFromDrive(d.driveFileIdFinal, res);
          return;
        } catch(driveErr) {
          console.error("Drive stream error:", driveErr);
          return res.status(502).json({error:"drive_unavailable"});
        }
      }
      return res.status(404).json({error:"no_signed_pdf"});
    }
    const buf = Buffer.from(d.signedPdfB64.split(",")[1]||d.signedPdfB64, "base64");
    const safeName = (d.docName||"document").replace(/[^a-zA-Z0-9_\-\.]/g,"_");
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`attachment; filename="${safeName}_semnat.pdf"`);
    res.send(buf);
  } catch(e) { res.status(500).json({error:"server_error"}); }
});
app.get("/users", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  const r2 = await pool.query("SELECT institutie FROM users WHERE email=$1", [actor.email.toLowerCase()]);
  const inst = (r2.rows[0]?.institutie||"").trim();
  let rows;
  if (inst) {
    // Returneaza toti userii din aceeasi institutie (inclusiv admini)
    const q = await pool.query("SELECT id,email,nume,functie,institutie FROM users WHERE institutie=$1 ORDER BY nume ASC", [inst]);
    rows = q.rows;
  } else {
    // Institutie goala — returneaza toti userii (fallback pentru admin fara institutie)
    const q = await pool.query("SELECT id,email,nume,functie,institutie,compartiment FROM users ORDER BY nume ASC");
    rows = q.rows;
  }
  res.json(rows);
});
app.get("/admin/users", async (req,res) => {
  if (requireDb(res)) return;
  const user = requireAuth(req,res); if (!user) return;
  if (user.role !== "admin") return res.status(403).json({error:"forbidden"});
  const { rows } = await pool.query("SELECT id,email,nume,functie,institutie,compartiment,plain_password,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at FROM users ORDER BY institutie ASC, compartiment ASC, nume ASC");
  res.json(rows);
});
app.post("/admin/users", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  const { email,password,nume,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp } = req.body||{};
  if (!email||!nume) return res.status(400).json({error:"email_and_nume_required"});
  const validRole = ["admin","user"].includes(role)?role:"user";
  const plainPwd = password&&password.length>=4?password:generatePassword();
  const phoneVal = (phone||"").trim();
  const ni = notif_inapp!==false; const ne = !!notif_email; const nw = !!notif_whatsapp;
  try {
    const compartimentVal2 = (compartiment||"").trim();
    const { rows } = await pool.query(`INSERT INTO users (email,password_hash,plain_password,nume,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,email,nume,functie,institutie,compartiment,plain_password,role,phone,notif_inapp,notif_email,notif_whatsapp`,
      [email.trim().toLowerCase(), hashPassword(plainPwd), plainPwd, (nume||"").trim(), (functie||"").trim(), (institutie||"").trim(), compartimentVal2, validRole, phoneVal, ni, ne, nw]);
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code==="23505") return res.status(409).json({error:"email_exists"});
    res.status(500).json({error:"server_error"});
  }
});
app.put("/admin/users/:id", async (req,res) => {
  console.log(`PUT /admin/users/${req.params.id} START`);
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({error:"invalid_id"});
  const { email,nume,functie,institutie,compartiment,password,role,phone,notif_inapp,notif_email,notif_whatsapp } = req.body||{};
  const updates=[], vals=[]; let i=1;
  if (email) { updates.push(`email=$${i++}`); vals.push(email.trim().toLowerCase()); }
  if (nume!==undefined) { updates.push(`nume=$${i++}`); vals.push((nume||"").trim()); }
  if (functie!==undefined) { updates.push(`functie=$${i++}`); vals.push((functie||"").trim()); }
  if (institutie!==undefined) { updates.push(`institutie=$${i++}`); vals.push((institutie||"").trim()); }
  if (compartiment!==undefined) { updates.push(`compartiment=$${i++}`); vals.push((compartiment||"").trim()); }
  if (role&&["admin","user"].includes(role)) { updates.push(`role=$${i++}`); vals.push(role); }
  if (phone!==undefined) { updates.push(`phone=$${i++}`); vals.push((phone||"").trim()); }
  if (notif_inapp!==undefined) { updates.push(`notif_inapp=$${i++}`); vals.push(!!notif_inapp); }
  if (notif_email!==undefined) { updates.push(`notif_email=$${i++}`); vals.push(!!notif_email); }
  if (notif_whatsapp!==undefined) { updates.push(`notif_whatsapp=$${i++}`); vals.push(!!notif_whatsapp); }
  if (password&&password.length>=4) { updates.push(`password_hash=$${i++}`); vals.push(hashPassword(password)); updates.push(`plain_password=$${i++}`); vals.push(password); }
  if (!updates.length) return res.status(400).json({error:"nothing_to_update"});
  vals.push(targetId);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(",")} WHERE id=$${i} RETURNING id,email,nume,functie,institutie,compartiment,plain_password,role,phone,notif_inapp,notif_email,notif_whatsapp`,
      vals
    );
    if (!rows.length) return res.status(404).json({error:"user_not_found"});
    console.log(`PUT /admin/users/${targetId} OK`);
    return res.json(rows[0]);
  } catch(e) {
    console.error(`PUT /admin/users/${targetId} ERROR:`, e.message);
    if (e.code==="23505") return res.status(409).json({error:"email_exists"});
    return res.status(500).json({error:"server_error", detail: e.message});
  }
});
app.post("/admin/users/:id/reset-password", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  const newPwd = generatePassword();
  await pool.query("UPDATE users SET password_hash=$1, plain_password=$2 WHERE id=$3", [hashPassword(newPwd), newPwd, parseInt(req.params.id)]);
  res.json({plain_password:newPwd});
});
app.delete("/admin/users/:id", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  const targetId = parseInt(req.params.id);
  if (actor.userId===targetId) return res.status(400).json({error:"cannot_delete_self"});
  await pool.query("DELETE FROM users WHERE id=$1", [targetId]);
  res.json({ok:true});
});

// ==================== HEALTH / SMTP ====================
// ==================== TEMPLATES API ====================

app.get("/templates", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "templates.html")));

// GET /api/templates — sabloanele userului + shared din institutie
app.get("/api/templates", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: uRows } = await pool.query("SELECT institutie FROM users WHERE id=$1", [actor.userId]);
    const inst = uRows[0]?.institutie || "";
    const { rows } = await pool.query(
      `SELECT * FROM templates
       WHERE user_email=$1 OR (shared=TRUE AND institutie=$2)
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), inst]
    );
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// POST /api/templates — creeaza sablon nou
app.post("/api/templates", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({error:"name_required"});
  if (!Array.isArray(signers) || !signers.length) return res.status(400).json({error:"signers_required"});
  try {
    const { rows: uRows } = await pool.query("SELECT institutie FROM users WHERE id=$1", [actor.userId]);
    const inst = uRows[0]?.institutie || "";
    const { rows } = await pool.query(
      `INSERT INTO templates (user_email, institutie, name, signers, shared)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [actor.email.toLowerCase(), inst, name.trim(), JSON.stringify(signers), !!shared]
    );
    res.status(201).json({ ...rows[0], isOwner: true });
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// PUT /api/templates/:id — actualizeaza sablon (doar owner)
app.put("/api/templates/:id", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  try {
    const { rows: existing } = await pool.query("SELECT * FROM templates WHERE id=$1", [req.params.id]);
    if (!existing[0]) return res.status(404).json({error:"not_found"});
    if (existing[0].user_email !== actor.email.toLowerCase()) return res.status(403).json({error:"forbidden"});
    const updates = [], vals = []; let i = 1;
    if (name) { updates.push(`name=$${i++}`); vals.push(name.trim()); }
    if (signers) { updates.push(`signers=$${i++}`); vals.push(JSON.stringify(signers)); }
    if (shared !== undefined) { updates.push(`shared=$${i++}`); vals.push(!!shared); }
    updates.push(`updated_at=NOW()`);
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE templates SET ${updates.join(",")} WHERE id=$${i} RETURNING *`, vals
    );
    res.json({ ...rows[0], isOwner: true });
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// DELETE /api/templates/:id — sterge sablon (doar owner)
app.delete("/api/templates/:id", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query("SELECT user_email FROM templates WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({error:"not_found"});
    if (rows[0].user_email !== actor.email.toLowerCase()) return res.status(403).json({error:"forbidden"});
    await pool.query("DELETE FROM templates WHERE id=$1", [req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:"server_error"}); }
});

// WhatsApp test endpoints
app.get("/wa-test", async (req,res) => {
  const result = await verifyWhatsApp();
  res.status(result.ok ? 200 : 500).json(result);
});
app.post("/wa-test", async (req,res) => {
  const { to } = req.body||{};
  if (!to) return res.status(400).json({error:"to (phone) missing"});
  const { sendWaSignRequest: waTest } = await import("./whatsapp.mjs");
  const r = await waTest({ phone:to, signerName:"Test", docName:"Document test DocFlowAI" });
  res.status(r.ok ? 200 : 500).json(r);
});

app.get("/health", async (req,res) => {
  const base = {ok:true, service:"DocFlowAI", version:"2.0", dbReady:DB_READY, dbLastError:DB_LAST_ERROR, wsClients:wsClients.size, ts:new Date().toISOString()};
  if (!pool || !DB_READY) return res.json(base);
  try {
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM flows"),
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM notifications WHERE read=FALSE"),
      pool.query("SELECT COUNT(*) FROM flows WHERE data->>'storage'='drive'"),
    ]);
    const sizeR = await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes");
    return res.json({
      ...base,
      stats: {
        flows: parseInt(flowsR.rows[0].count),
        flowsArchived: parseInt(archR.rows[0].count),
        users: parseInt(usersR.rows[0].count),
        unreadNotifications: parseInt(notifsR.rows[0].count),
        dbSize: sizeR.rows[0].db_size,
        dbBytes: parseInt(sizeR.rows[0].db_bytes),
      }
    });
  } catch(e) { return res.json({...base, statsError: e.message}); }
});
app.get("/smtp-test", async (req,res) => { const r=await verifySmtp(); res.status(r.ok?200:500).json(r); });
app.post("/smtp-test", async (req,res) => {
  const { to } = req.body||{};
  if (!to) return res.status(400).json({error:"to missing"});
  try {
    const v=await verifySmtp(); if (!v.ok) return res.status(500).json({error:"smtp_not_ready",detail:v});
    await sendSignerEmail({to, subject:"Test SMTP DocFlowAI", html:"<p>SMTP funcționează! ✅</p>"});
    res.json({ok:true,to});
  } catch(e) { res.status(500).json({ok:false,error:String(e.message||e)}); }
});

// ==================== DRIVE ARCHIVE ====================
app.get("/admin/drive/verify", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  try {
    const result = await verifyDrive();
    res.json(result);
  } catch(e) { res.status(500).json({ok:false, error:String(e.message||e)}); }
});

app.get("/admin/flows/archive-preview", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  try {
    const days = parseInt(req.query.days||"30");
    const cutoff = new Date(Date.now() - days*24*60*60*1000).toISOString();
    // Filtrare în SQL după data — nu mai încărcăm toate fluxurile în memorie
    const { rows } = await pool.query(
      "SELECT id,data,created_at FROM flows WHERE created_at < $1 ORDER BY created_at ASC",
      [cutoff]
    );
    const eligible = rows.filter(r => {
      const d = r.data;
      if (!d) return false;
      const done = d.completed || (d.signers||[]).every(s=>s.status==="signed");
      const refused = (d.signers||[]).some(s=>s.status==="refused");
      const notArchived = d.storage !== "drive";
      return (done||refused) && notArchived;
    });
    const totalBytes = eligible.reduce((acc,r) => {
      const d = r.data;
      const b1 = d.pdfB64 ? Math.round(d.pdfB64.length*0.75) : 0;
      const b2 = d.signedPdfB64 ? Math.round(d.signedPdfB64.length*0.75) : 0;
      return acc + b1 + b2;
    }, 0);
    return res.json({
      count: eligible.length,
      totalMB: Math.round(totalBytes/1024/1024*100)/100,
      flows: eligible.map(r => ({
        flowId: r.data.flowId,
        docName: r.data.docName,
        createdAt: r.data.createdAt||r.created_at,
        status: r.data.completed?"finalizat":(r.data.signers||[]).some(s=>s.status==="refused")?"refuzat":"necunoscut",
        sizeMB: Math.round(((r.data.pdfB64?.length||0)+(r.data.signedPdfB64?.length||0))*0.75/1024/1024*100)/100,
      }))
    });
  } catch(e) { return res.status(500).json({error:String(e.message||e)}); }
});

app.post("/admin/flows/archive", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  try {
    const { flowIds, batchIndex = 0 } = req.body||{};
    if (!Array.isArray(flowIds)||!flowIds.length) return res.status(400).json({error:"flowIds_required"});
    // Procesare în batch de 10 — evită timeout pe request
    const BATCH_SIZE = 10;
    const start = batchIndex * BATCH_SIZE;
    const batch = flowIds.slice(start, start + BATCH_SIZE);
    const hasMore = start + BATCH_SIZE < flowIds.length;
    const results = [];
    for (const flowId of batch) {
      try {
        const data = await getFlowData(flowId);
        if (!data) { results.push({flowId, ok:false, error:"not_found"}); continue; }
        const driveResult = await archiveFlow(data);
        data.pdfB64 = null;
        data.signedPdfB64 = null;
        data.storage = "drive";
        data.archivedAt = new Date().toISOString();
        data.driveFileIdFinal = driveResult.driveFileIdFinal||null;
        data.driveFileIdOriginal = driveResult.driveFileIdOriginal||null;
        data.driveFileIdAudit = driveResult.driveFileIdAudit||null;
        data.driveFolderId = driveResult.driveFolderId||null;
        data.driveFileLinkFinal = driveResult.driveFileLinkFinal||null;
        data.driveFileLinkOriginal = driveResult.driveFileLinkOriginal||null;
        await saveFlow(flowId, data);
        results.push({flowId, ok:true});
        console.log(`📦 Archived flow ${flowId} to Drive`);
      } catch(e) {
        console.error(`📦 Archive error ${flowId}:`, e.message);
        results.push({flowId, ok:false, error:String(e.message||e)});
      }
    }
    return res.json({ok:true, results, hasMore, nextBatchIndex: batchIndex + 1, totalProcessed: start + batch.length, total: flowIds.length});
  } catch(e) { return res.status(500).json({error:String(e.message||e)}); }
});

// Sugestie VACUUM după arhivare masivă (doar hint — VACUUM FULL e periculos pe producție)
app.post("/admin/db/vacuum", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  try {
    await pool.query("VACUUM ANALYZE flows");
    const sizeR = await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size");
    return res.json({ok:true, message:"VACUUM ANALYZE flows executat.", dbSize: sizeR.rows[0].db_size});
  } catch(e) { return res.status(500).json({error:String(e.message||e)}); }
});

// ==================== FLOWS ====================
const createFlow = async (req,res) => {
  try {
    if (requireDb(res)) return;
    const body = req.body||{};
    const docName = String(body.docName||"").trim();
    const initName = String(body.initName||"").trim();
    const initEmail = String(body.initEmail||"").trim();
    const signers = Array.isArray(body.signers)?body.signers:[];
    if (!docName||!initName||!initEmail) return res.status(400).json({error:"docName/initName/initEmail missing"});
    if (!signers.length) return res.status(400).json({error:"signers missing"});

    const normalizedSigners = signers.map((s,idx) => ({
      order: Number(s.order||idx+1),
      rol: String(s.rol||s.atribut||"").trim(),
      functie: String(s.functie||"").trim(),
      compartiment: String(s.compartiment||"").trim(),
      name: String(s.name||"").trim(),
      email: String(s.email||"").trim(),
      token: String(s.token||crypto.randomBytes(16).toString("hex")),
      tokenCreatedAt: new Date().toISOString(),
      status: idx===0?"current":"pending",
      signedAt: null, signature: null,
    }));

    const flowId = newFlowId();
    const data = {
      flowId, docName, initName, initEmail,
      meta: body.meta||{}, flowType: body.flowType||"tabel",
      pdfB64: body.pdfB64??null,
      signers: normalizedSigners,
      createdAt: body.createdAt||new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [{at:new Date().toISOString(), type:"FLOW_CREATED", by:initEmail}],
    };
    await saveFlow(flowId, data);

    const first = data.signers.find(s=>s.status==="current");
    // Daca initiatorul e primul semnatar (INTOCMIT), nu trimite notificare - il redirectionam direct
    const initIsSigner = first && first.email.toLowerCase() === initEmail.toLowerCase();
    if (first?.email && !initIsSigner) {
      await notify({ userEmail:first.email, flowId, type:"YOUR_TURN",
        title:"Document de semnat",
        message:`${initName} te-a adăugat ca semnatar pe documentul „${data.docName}". Intră în aplicație pentru a semna.`,
        waParams:{ signerName:first.name||first.email, docName:data.docName } });
    }
    return res.json({ok:true, flowId, firstSignerEmail:first?.email||null, initIsSigner: !!initIsSigner, signerToken: initIsSigner ? first.token : null});
  } catch(e) { console.error("POST /flows error:",e); return res.status(500).json({error:"server_error"}); }
};
app.post("/flows", createFlow);
app.post("/api/flows", createFlow);

app.get("/flows/:flowId/signed-pdf", async (req,res) => {
  try {
    if (requireDb(res)) return;
    // Auth obligatorie: token semnatar SAU JWT
    const signerToken = req.query.token;
    let actor = null;
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Bearer ")) {
      try { actor = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) {}
    }
    if (!actor && !signerToken) return res.status(403).json({error:"forbidden", message:"Token de acces obligatoriu."});
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    if (!actor && signerToken) {
      const valid = (data.signers||[]).some(s => s.token === signerToken);
      if (!valid) return res.status(403).json({error:"forbidden"});
    }
    const safeName = (data.docName||"document").replace(/[^\w\-]+/g,"_");
    const b64 = data.signedPdfB64;
    if (!b64||typeof b64!=="string") {
      // Arhivat în Drive — proxy stream (nu redirect public)
      if (data.storage==="drive" && data.driveFileIdFinal) {
        try {
          const { streamFromDrive } = await import("./drive.mjs");
          res.setHeader("Content-Type","application/pdf");
          res.setHeader("Content-Disposition",`attachment; filename="${safeName}_semnat.pdf"`);
          await streamFromDrive(data.driveFileIdFinal, res);
          return;
        } catch(driveErr) {
          console.error("Drive stream error:", driveErr);
          return res.status(502).json({error:"drive_unavailable"});
        }
      }
      return res.status(404).json({error:"signed_pdf_missing"});
    }
    const raw = b64.includes("base64,")?b64.split("base64,")[1]:b64;
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`attachment; filename="${safeName}_semnat.pdf"`);
    return res.status(200).send(Buffer.from(raw,"base64"));
  } catch(e) { return res.status(500).json({error:"server_error"}); }
});
app.get("/flows/:flowId/pdf", async (req,res) => {
  try {
    if (requireDb(res)) return;
    const signerToken = req.query.token;
    // Auth obligatorie: token semnatar SAU JWT
    let actor = null;
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Bearer ")) {
      try { actor = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) {}
    }
    if (!actor && !signerToken) return res.status(403).json({error:"forbidden", message:"Token de acces obligatoriu."});
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    // Verifică că token-ul semnatar e valid pentru acest flow
    if (!actor && signerToken) {
      const valid = (data.signers||[]).some(s => s.token === signerToken);
      if (!valid) return res.status(403).json({error:"forbidden"});
    }
    const b64 = data.pdfB64;
    if (!b64||typeof b64!=="string") return res.status(404).json({error:"pdf_missing"});
    const raw = b64.includes("base64,")?b64.split("base64,")[1]:b64;
    const pdfBuf = Buffer.from(raw,"base64");
    const preHash = sha256Hex(pdfBuf);
    // Emite uploadToken JWT doar pentru semnatarul valid
    if (signerToken) {
      const signer = (data.signers||[]).find(s=>s.token===signerToken);
      if (signer) {
        const uploadToken = jwt.sign(
          { flowId: req.params.flowId, signerToken, preHash },
          JWT_SECRET,
          { expiresIn: "4h" }
        );
        res.setHeader("X-Docflow-Prehash", preHash);
        res.setHeader("X-Docflow-UploadToken", uploadToken);
        res.setHeader("Access-Control-Expose-Headers", "X-Docflow-Prehash, X-Docflow-UploadToken");
      }
    }
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename="${(data.docName||"document").replace(/[^\w\-]+/g,"_")}.pdf"`);
    return res.status(200).send(pdfBuf);
  } catch(e) { return res.status(500).json({error:"server_error"}); }
});
const getFlowHandler = async (req,res) => {
  try {
    if (requireDb(res)) return;
    // Auth: acceptă JWT (inițiator/admin) SAU token semnatar în query
    const signerToken = req.query.token || null;
    let actor = null;
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Bearer ")) {
      try { actor = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) {}
    }
    // Verifică token semnatar dacă nu avem JWT
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    if (!actor && signerToken) {
      const valid = (data.signers||[]).some(s => s.token === signerToken);
      if (!valid) return res.status(403).json({error:"forbidden"});
    } else if (!actor) {
      return res.status(401).json({error:"auth_required"});
    }
    // Enrich signers + flow cu institutie/compartiment din DB
    const { rows: uRows } = await pool.query("SELECT email,functie,compartiment,institutie FROM users");
    const uMap = {};
    uRows.forEach(u => { uMap[(u.email||"").toLowerCase()] = u; });
    const initUser = uMap[(data.initEmail||"").toLowerCase()] || {};
    const enriched = {
      ...data,
      institutie: data.institutie || initUser.institutie || (data.signers||[]).map(s=>uMap[(s.email||"").toLowerCase()]?.institutie).find(Boolean) || "",
      compartiment: data.compartiment || initUser.compartiment || "",
      signers:(data.signers||[]).map(s=>{
        const u = uMap[(s.email||"").toLowerCase()]||{};
        return {...s, functie:s.functie||u.functie||"", compartiment:s.compartiment||u.compartiment||"", institutie:s.institutie||u.institutie||""};
      })
    };
    // Returnează token DOAR semnatarului care face cererea (nu tuturor)
    return res.json(stripSensitive(enriched, signerToken));
  } catch(e) { return res.status(500).json({error:"server_error"}); }
};
app.get("/flows/:flowId", getFlowHandler);
app.get("/api/flows/:flowId", getFlowHandler);

app.put("/flows/:flowId", async (req,res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req,res)) return;
    const { flowId } = req.params;
    const existing = await getFlowData(flowId);
    if (!existing) return res.status(404).json({error:"not_found"});
    const next = req.body||{};
    next.flowId = flowId; next.updatedAt = new Date().toISOString();
    await saveFlow(flowId, next);
    return res.json({ok:true});
  } catch(e) { return res.status(500).json({error:"server_error"}); }
});

const signFlow = async (req,res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, signature } = req.body||{};
    const sig = typeof signature==="string"?signature.trim():"";
    if (!sig) return res.status(400).json({error:"signature_required"});
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    const signers = Array.isArray(data.signers)?data.signers:[];
    const idx = signers.findIndex(s=>s.token===token);
    if (idx===-1) return res.status(400).json({error:"invalid_token"});
    if (isSignerTokenExpired(signers[idx])) return res.status(403).json({error:"token_expired", message:"Link-ul de semnare a expirat (90 zile). Contactează inițiatorul pentru un nou link."});
    if (signers[idx].status!=="current") return res.status(409).json({error:"not_current_signer"});
    signers[idx].status="signed"; signers[idx].signedAt=new Date().toISOString();
    signers[idx].signature=sig; signers[idx].pdfUploaded=false;
    data.signers=signers; data.updatedAt=new Date().toISOString();
    data.events=Array.isArray(data.events)?data.events:[];
    data.events.push({at:new Date().toISOString(), type:"SIGNED", by:signers[idx].email||signers[idx].name||"unknown", order:signers[idx].order});
    await saveFlow(flowId, data);
    return res.json({ok:true, flowId, completed:data.signers.every(s=>s.status==="signed"), nextSigner:null, nextLink:null, awaitingUpload:true, flow:stripPdfB64(data)});
  } catch(e) { return res.status(500).json({error:"server_error"}); }
};
app.post("/flows/:flowId/sign", signFlow);
app.post("/api/flows/:flowId/sign", signFlow);

app.post("/flows/:flowId/refuse", async (req,res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, reason } = req.body||{};
    if (!reason||!String(reason).trim()) return res.status(400).json({error:"reason_required"});
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    const signers = Array.isArray(data.signers)?data.signers:[];
    const idx = signers.findIndex(s=>s.token===token);
    if (idx===-1) return res.status(400).json({error:"invalid_token"});
    if (isSignerTokenExpired(signers[idx])) return res.status(403).json({error:"token_expired", message:"Link-ul de semnare a expirat (90 zile). Contactează inițiatorul pentru un nou link."});
    if (signers[idx].status!=="current") return res.status(409).json({error:"not_current_signer"});
    const refuserName = signers[idx].name||signers[idx].email||"Semnatar";
    const refuserRol = signers[idx].rol||"";
    const refuseReason = String(reason).trim();
    signers[idx].status="refused"; signers[idx].refusedAt=new Date().toISOString(); signers[idx].refuseReason=refuseReason;
    data.signers=signers; data.status="refused"; data.refusedAt=new Date().toISOString(); data.updatedAt=new Date().toISOString();
    data.events=Array.isArray(data.events)?data.events:[];
    data.events.push({at:new Date().toISOString(), type:"REFUSED", by:signers[idx].email, reason:refuseReason});
    await saveFlow(flowId, data);

    // Notificari in-app pentru initiator + semnatarii anteriori
    const refuseMsg = `${refuserName}${refuserRol?" ("+refuserRol+")":""} a refuzat semnarea documentului „${data.docName}". Motiv: ${refuseReason}`;
    const toNotify = [
      {email:data.initEmail},
      ...signers.filter((s,i)=>i<idx&&s.status==="signed"&&s.email).map(s=>({email:s.email}))
    ];
    const sent = new Set();
    for (const r of toNotify) {
      if (!r.email||sent.has(r.email)) continue;
      sent.add(r.email);
      await notify({userEmail:r.email, flowId, type:"REFUSED", title:"⛔ Document refuzat", message:refuseMsg,
        waParams:{ docName:data.docName, refuserName:refuserName, reason:refuseReason }});
    }
    return res.json({ok:true, refused:true});
  } catch(e) { console.error("refuse error:",e); return res.status(500).json({error:"server_error"}); }
});

// Lista fluxuri pentru admin
app.get("/admin/flows/list", async (req,res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req,res); if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({error:"forbidden"});
  try {
    const { rows } = await pool.query("SELECT id,data,created_at FROM flows ORDER BY created_at DESC LIMIT 200");
    const flows = rows.map(r => {
      const d = r.data||{};
      return {
        flowId: d.flowId,
        docName: d.docName,
        initEmail: d.initEmail,
        initName: d.initName,
        status: d.status||"active",
        completed: !!(d.completed || (d.signers||[]).every(s=>s.status==="signed")),
        storage: d.storage||"db",
        createdAt: d.createdAt||r.created_at,
        signers: (d.signers||[]).map(s => ({
          name: s.name, email: s.email, rol: s.rol,
          status: s.status, tokenCreatedAt: s.tokenCreatedAt||null,
        })),
      };
    });
    return res.json(flows);
  } catch(e) { return res.status(500).json({error:String(e.message||e)}); }
});

// Regenerare token semnatar expirat (admin only)
app.post("/flows/:flowId/regenerate-token", async (req,res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req,res)) return;
    const { flowId } = req.params;
    const { signerEmail } = req.body||{};
    if (!signerEmail) return res.status(400).json({error:"signerEmail_required"});
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    const signers = Array.isArray(data.signers)?data.signers:[];
    const idx = signers.findIndex(s=>(s.email||"").toLowerCase()===signerEmail.toLowerCase());
    if (idx===-1) return res.status(404).json({error:"signer_not_found"});
    if (signers[idx].status==="signed") return res.status(409).json({error:"already_signed", message:"Semnatarul a semnat deja, nu e nevoie de token nou."});
    // Generează token nou
    const newToken = crypto.randomBytes(16).toString("hex");
    signers[idx].token = newToken;
    signers[idx].tokenCreatedAt = new Date().toISOString();
    data.signers = signers;
    data.updatedAt = new Date().toISOString();
    data.events = data.events||[];
    data.events.push({at:new Date().toISOString(), type:"TOKEN_REGENERATED", by:"admin", signerEmail, order:signers[idx].order});
    await saveFlow(flowId, data);
    // Trimite notificare cu noul link
    const newLink = makeSignerLink({params:{flowId}}, newToken);
    await notify({userEmail:signers[idx].email, flowId, type:"YOUR_TURN",
      title:"Link de semnare reînnoit",
      message:`Link-ul tău de semnare pentru documentul „${data.docName}" a fost reînnoit. Accesează noul link pentru a semna.`,
      waParams:{signerName:signers[idx].name||signers[idx].email, docName:data.docName}
    });
    console.log(`🔑 Token regenerat pentru ${signerEmail} pe flow ${flowId}`);
    return res.json({ok:true, signerEmail, newLink, message:"Token regenerat și notificare trimisă."});
  } catch(e) { console.error("regenerate-token error:", e); return res.status(500).json({error:"server_error"}); }
});

app.post("/flows/:flowId/resend", async (req,res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req,res)) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    const current = (data.signers||[]).find(s=>s.status==="current");
    if (!current) return res.status(409).json({error:"no_current_signer"});
    if (!current.email) return res.status(400).json({error:"current_missing_email"});
    await notify({userEmail:current.email, flowId, type:"YOUR_TURN", title:"Reminder: Document de semnat",
      message:`Ai un document în așteptare pentru semnare: „${data.docName}". Te rugăm să accesezi aplicația.`,
      waParams:{ signerName:current.name||current.email, docName:data.docName }});
    return res.json({ok:true, to:current.email});
  } catch(e) { return res.status(500).json({error:"server_error"}); }
});

app.post("/flows/:flowId/upload-signed-pdf", async (req,res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, signedPdfB64, signerName, uploadToken } = req.body||{};
    if (!token) return res.status(400).json({error:"token_missing"});
    if (!signedPdfB64||typeof signedPdfB64!=="string") return res.status(400).json({error:"signedPdfB64_missing"});
    if (signedPdfB64.length>40*1024*1024) return res.status(413).json({error:"pdf_too_large_max_30mb"});
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({error:"not_found"});
    const signers = Array.isArray(data.signers)?data.signers:[];
    const idx = signers.findIndex(s=>s.token===token);
    if (idx===-1) return res.status(400).json({error:"invalid_token"});
    if (isSignerTokenExpired(signers[idx])) return res.status(403).json({error:"token_expired", message:"Link-ul de semnare a expirat (90 zile). Contactează inițiatorul pentru un nou link."});

    // Verificare uploadToken (Nivel 1 securitate) — OBLIGATORIE
    if (!uploadToken) {
      return res.status(403).json({error:"upload_token_missing", message:"Lipsește tokenul de verificare. Descarcă documentul din sistem înainte de a-l încărca."});
    }
    try {
      const payload = jwt.verify(uploadToken, JWT_SECRET);
      if (payload.flowId !== flowId) return res.status(403).json({error:"upload_token_flow_mismatch", message:"Token invalid pentru acest flux."});
      if (payload.signerToken !== token) return res.status(403).json({error:"upload_token_signer_mismatch", message:"Token invalid pentru acest semnatar."});
      // Verifică hash-ul PDF-ului de bază (originalul descărcat de semnatar)
      const b64curr = data.pdfB64||"";
      const rawCurr = b64curr.includes("base64,")?b64curr.split("base64,")[1]:b64curr;
      const currentHash = rawCurr ? sha256Hex(Buffer.from(rawCurr,"base64")) : null;
      if (currentHash && payload.preHash !== currentHash) {
        console.warn(`⚠️  preHash mismatch flow ${flowId} signer ${signers[idx].email}`);
        return res.status(409).json({error:"pdf_version_mismatch", message:"PDF-ul semnat nu corespunde versiunii descărcate din sistem. Descarcă documentul din nou și semnează-l."});
      }
      signers[idx].uploadVerified = true;
    } catch(jwtErr) {
      return res.status(403).json({error:"upload_token_invalid", message:"Token de upload invalid sau expirat. Descarcă documentul din nou."});
    }
    if (signers[idx].status!=="signed") return res.status(409).json({error:"signer_not_signed_yet"});
    if (!Array.isArray(data.signedPdfVersions)) data.signedPdfVersions=[];
    data.signedPdfVersions.push({uploadedAt:new Date().toISOString(), uploadedBy:signers[idx].email||signers[idx].name||"unknown", signerIndex:idx, signerName:signerName||signers[idx].name||""});
    data.signedPdfB64=signedPdfB64;
    data.signedPdfUploadedAt=new Date().toISOString();
    data.signedPdfUploadedBy=signers[idx].email||signers[idx].name||"unknown";
    signers[idx].pdfUploaded=true;
    data.updatedAt=new Date().toISOString();
    data.events=Array.isArray(data.events)?data.events:[];
    data.events.push({at:new Date().toISOString(), type:"SIGNED_PDF_UPLOADED", by:signers[idx].email||signers[idx].name||"unknown", order:signers[idx].order});

    const nextIdx = signers.findIndex((s,i)=>i>idx&&s.status!=="signed");
    if (nextIdx!==-1) {
      signers.forEach((s,i)=>{ if (s.status!=="signed") s.status = i===nextIdx?"current":"pending"; });
    }
    data.signers=signers; signers[idx].notifiedNext=true;

    const allDone = data.signers.every(s=>s.status==="signed"&&s.pdfUploaded);
    if (allDone) {
      data.completed=true; data.completedAt=new Date().toISOString();
      data.events.push({at:new Date().toISOString(), type:"FLOW_COMPLETED", by:"system"});
      // Notificare completare pentru initiator
      if (data.initEmail) {
        await notify({userEmail:data.initEmail, flowId, type:"COMPLETED", title:"✅ Document semnat complet",
          message:`Documentul „${data.docName}" a fost semnat de toți semnatarii. Îl poți descărca din secțiunea Fluxuri mele.`,
          waParams:{ docName:data.docName }});
      }
    }
    await saveFlow(flowId, data);

    // Notificare pentru urmatorul semnatar
    const nextSigner = data.signers.find(s=>s.status==="current"&&!s.emailSent);
    if (nextSigner?.email) {
      nextSigner.emailSent=true; await saveFlow(flowId, data);
      await notify({userEmail:nextSigner.email, flowId, type:"YOUR_TURN", title:"Document de semnat",
        message:`Este rândul tău să semnezi documentul „${data.docName}". Documentul conține semnăturile semnatarilor anteriori.`,
        waParams:{ signerName:nextSigner.name||nextSigner.email, docName:data.docName }});
    }
    console.log(`📎 Signed PDF uploaded for flow ${flowId} by ${signers[idx].email||signers[idx].name}`);
    return res.json({ok:true, flowId, completed:allDone, uploadedAt:data.signedPdfUploadedAt, downloadUrl:`/flows/${flowId}/signed-pdf`, nextSigner:nextSigner||null});
  } catch(e) { console.error("upload-signed-pdf error:",e); return res.status(500).json({error:"server_error"}); }
});

// ==================== HTTP SERVER + WEBSOCKET ====================
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server:httpServer, path:"/ws" });

wss.on("connection", (ws, req) => {
  let clientEmail = null;
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type==="auth"&&msg.token) {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          clientEmail = decoded.email.toLowerCase();
          wsRegister(clientEmail, ws);
          ws.send(JSON.stringify({event:"auth_ok", email:clientEmail}));
          if (pool&&DB_READY) {
            pool.query("SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE", [clientEmail])
              .then(r=>ws.send(JSON.stringify({event:"unread_count", count:parseInt(r.rows[0].count)})))
              .catch(()=>{});
          }
          console.log(`🔌 WS auth: ${clientEmail}`);
        } catch(e) { ws.send(JSON.stringify({event:"auth_error", message:"invalid_token"})); }
      }
      if (msg.type==="ping") ws.send(JSON.stringify({event:"pong"}));
    } catch(e) {}
  });
  ws.on("close", () => { if (clientEmail) { wsUnregister(clientEmail, ws); console.log(`🔌 WS closed: ${clientEmail}`); } });
  ws.on("error", (e) => console.error("WS error:", e.message));
});

// ==================== GRACEFUL SHUTDOWN ====================
function shutdown(signal) {
  console.log(`🧯 ${signal} received.`);
  httpServer.close(()=>{ console.log("✅ Server closed."); process.exit(0); });
  setTimeout(()=>process.exit(0), 10_000).unref();
}
process.on("SIGTERM", ()=>shutdown("SIGTERM"));
process.on("SIGINT", ()=>shutdown("SIGINT"));

const PORT = process.env.PORT;
if (!PORT) { console.error("❌ PORT missing."); process.exit(1); }
httpServer.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`🚀 DocFlowAI server on port ${PORT}`);
  console.log(`🔌 WebSocket ready at ws://0.0.0.0:${PORT}/ws`);
  initDbWithRetry();
});
