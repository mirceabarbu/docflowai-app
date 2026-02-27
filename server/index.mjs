import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { sendSignerEmail, verifySmtp } from "./mailer.mjs";
import jwt from "jsonwebtoken";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));

// -------------------- Static public/ --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "../public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "semdoc-initiator.html"));
});

// Serve login page
app.get("/login", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

// Serve admin page
app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

// -------------------- Helpers --------------------
function publicBaseUrl(req) {
  // Set in Railway Variables for stable links:
  // PUBLIC_BASE_URL=https://app.docflowai.ro
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");

  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function newFlowId() {
  return "FLOW_" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

function generatePassword() {
  // Parolă ușor de citit: 3 grupe de 3 caractere alfanumerice
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let p = "";
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 6) p += "-";
    p += chars[crypto.randomInt(chars.length)];
  }
  return p;
}



// -------------------- JWT + User Auth --------------------
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const JWT_EXPIRES = "8h";

// Password hashing with Node built-in crypto (PBKDF2 - no extra deps)
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
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch(e) {
    res.status(401).json({ error: "token_invalid_or_expired" });
    return null;
  }
}

// -------------------- Admin auth (MVP) --------------------
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

function requireAdmin(req, res) {
  // Use header: x-admin-secret: <ADMIN_SECRET>
  // or Authorization: Bearer <ADMIN_SECRET>
  if (!ADMIN_SECRET) {
    res.status(503).json({ error: "admin_not_configured" });
    return true;
  }
  const headerSecret = req.get("x-admin-secret");
  const auth = req.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const provided = headerSecret || bearer;
  if (!provided || provided !== ADMIN_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return true;
  }
  return false;
}

function stripPdfB64(data) {
  if (!data || typeof data !== "object") return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
}
// -------------------- Postgres --------------------
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    })
  : null;

let DB_READY = false;
let DB_LAST_ERROR = null;

async function initDbOnce() {
  if (!pool) throw new Error("DATABASE_URL missing (pool not created)");
  await pool.query("SELECT 1");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_flows_updated_at ON flows(updated_at DESC);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plain_password TEXT,
      nume TEXT NOT NULL DEFAULT '',
      functie TEXT NOT NULL DEFAULT '',
      institutie TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Migrare: adaugă coloane noi dacă tabela există deja fără ele
  const alterCols = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nume TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS functie TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS institutie TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users DROP COLUMN IF EXISTS username",
  ];
  for (const sql of alterCols) {
    await pool.query(sql).catch(() => {});
  }
  // Create default admin if no users exist and ADMIN_INIT_PASSWORD is set
  const { rows: userCount } = await pool.query("SELECT COUNT(*) FROM users");
  if (parseInt(userCount[0].count) === 0 && process.env.ADMIN_INIT_PASSWORD) {
    const pwd = process.env.ADMIN_INIT_PASSWORD;
    const hash = hashPassword(pwd);
    await pool.query(
      "INSERT INTO users (email, password_hash, plain_password, nume, functie, role) VALUES ($1,$2,$3,$4,$5,'admin') ON CONFLICT DO NOTHING",
      ["admin@docflowai.ro", hash, pwd, "Administrator", "Administrator sistem"]
    );
    console.log("✅ Admin user created (email: admin@docflowai.ro)");
  }
  DB_READY = true;
  DB_LAST_ERROR = null;
  console.log("✅ DB ready (flows + users tables ensured)");
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
  console.error("❌ DB init failed permanently (after retries). Server stays up for debugging.");
}

function requireDb(res) {
  if (!DB_READY) {
    res.status(503).json({
      error: "db_not_ready",
      dbLastError: DB_LAST_ERROR,
    });
    return true;
  }
  return false;
}

async function saveFlow(id, data) {
  await pool.query(
    `
    INSERT INTO flows (id, data)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (id)
    DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `,
    [id, JSON.stringify(data)]
  );
}

async function getFlowData(id) {
  const r = await pool.query(`SELECT data FROM flows WHERE id=$1`, [id]);
  return r.rows[0]?.data ?? null;
}

function buildSignerLink(req, flowId, token) {
  const base = publicBaseUrl(req);
  return `${base}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(
    token
  )}`;
}

// -------------------- Auth Routes --------------------

// POST /auth/login — autentificare cu email + parolă
app.post("/auth/login", async (req, res) => {
  if (requireDb(res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, nume: user.nume, functie: user.functie, institutie: user.institutie },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
    res.json({ token, email: user.email, role: user.role, nume: user.nume, functie: user.functie, institutie: user.institutie });
  } catch(e) {
    console.error("login error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// GET /auth/me — verifică token și returnează profilul
app.get("/auth/me", async (req, res) => {
  const decoded = requireAuth(req, res);
  if (!decoded) return;
  if (!pool || !DB_READY) return res.json(decoded);
  try {
    const { rows } = await pool.query("SELECT id, email, nume, functie, institutie, role FROM users WHERE id=$1", [decoded.userId]);
    if (!rows[0]) return res.status(401).json({ error: "user_not_found" });
    res.json({ userId: rows[0].id, email: rows[0].email, nume: rows[0].nume, functie: rows[0].functie, institutie: rows[0].institutie, role: rows[0].role });
  } catch(e) { res.json(decoded); }
});

// -------------------- Admin User Management --------------------

// POST /admin/users/:id/send-credentials — trimite email cu credențiale
app.post("/admin/users/:id/send-credentials", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const targetId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      "SELECT email, nume, functie, plain_password FROM users WHERE id=$1",
      [targetId]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: "user_not_found" });
    if (!u.plain_password) return res.status(400).json({ error: "no_password_available" });

    const appUrl = process.env.PUBLIC_BASE_URL || "https://app.docflowai.ro";
    await sendSignerEmail({
      to: u.email,
      subject: "Cont DocFlowAI — credențiale de acces",
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
          <div style="text-align:center;margin-bottom:28px;">
            <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;letter-spacing:-.02em;">📋 DocFlowAI</div>
          </div>
          <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${u.nume ? ', ' + u.nume : ''},</h2>
          <p style="color:#9db0ff;margin:0 0 24px;line-height:1.6;">Contul tău în sistemul de semnare electronică <strong style="color:#eaf0ff;">DocFlowAI</strong> a fost creat. Folosește credențialele de mai jos pentru a te autentifica.</p>
          <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px 24px;margin-bottom:24px;">
            <div style="margin-bottom:14px;"><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">EMAIL (utilizator)</span><strong style="font-size:1rem;color:#eaf0ff;">${u.email}</strong></div>
            <div><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">PAROLĂ</span><strong style="font-size:1.1rem;color:#ffd580;font-family:monospace;letter-spacing:.08em;">${u.plain_password}</strong></div>
          </div>
          <div style="text-align:center;margin-bottom:24px;">
            <a href="${appUrl}/login" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:.95rem;">Intră în cont →</a>
          </div>
          <p style="color:#9db0ff;font-size:.8rem;text-align:center;margin:0;">Dacă nu ai solicitat acest cont, ignoră acest mesaj.</p>
        </div>`,
    });
    res.json({ ok: true });
  } catch(e) {
    console.error("send-credentials error:", e);
    res.status(500).json({ error: "email_failed", detail: String(e.message || e) });
  }
});

// POST /admin/flows/clean — șterge fluxuri vechi sau toate (doar admin)
app.post("/admin/flows/clean", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const { olderThanDays, all } = req.body || {};
  try {
    let result;
    if (all) {
      result = await pool.query("DELETE FROM flows");
    } else {
      const days = parseInt(olderThanDays) || 30;
      result = await pool.query(
        "DELETE FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL",
        [days]
      );
    }
    res.json({ ok: true, deleted: result.rowCount });
  } catch(e) {
    console.error("flows/clean error:", e);
    res.status(500).json({ error: "server_error", detail: String(e.message) });
  }
});

// GET /my-flows — fluxurile userului curent (inițiator sau semnatar)
app.get("/my-flows", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, data, created_at, updated_at FROM flows ORDER BY updated_at DESC LIMIT 200`
    );
    // Filtrăm în JS: fluxurile unde userul e inițiator SAU semnatar
    const email = actor.email.toLowerCase();
    const myFlows = rows
      .map(r => r.data)
      .filter(d => {
        if (!d) return false;
        const isInit = (d.initEmail || "").toLowerCase() === email;
        const isSigner = (d.signers || []).some(s => (s.email || "").toLowerCase() === email);
        return isInit || isSigner;
      })
      .map(d => ({
        flowId: d.flowId,
        docName: d.docName || "—",
        initName: d.initName,
        initEmail: d.initEmail,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        signers: (d.signers || []).map(s => ({
          name: s.name, email: s.email, rol: s.rol,
          status: s.status, signedAt: s.signedAt,
        })),
        hasSignedPdf: !!d.signedPdfB64,
        allSigned: (d.signers || []).every(s => s.status === "signed"),
      }));
    res.json(myFlows);
  } catch(e) {
    console.error("my-flows error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// GET /my-flows/:flowId/download — descarcă PDF final (token din query sau header)
app.get("/my-flows/:flowId/download", async (req, res) => {
  if (requireDb(res)) return;
  // Acceptă token din query param (pentru <a href> direct din browser)
  const qToken = req.query.token;
  let actor = null;
  if (qToken) {
    try { actor = jwt.verify(qToken, JWT_SECRET); } catch(e) {}
  }
  if (!actor) actor = requireAuth(req, res);
  if (!actor) return;
  try {
    const { rows } = await pool.query("SELECT data FROM flows WHERE id=$1", [req.params.flowId]);
    const d = rows[0]?.data;
    if (!d) return res.status(404).json({ error: "not_found" });
    const email = actor.email.toLowerCase();
    const isInit = (d.initEmail || "").toLowerCase() === email;
    const isSigner = (d.signers || []).some(s => (s.email || "").toLowerCase() === email);
    if (!isInit && !isSigner) return res.status(403).json({ error: "forbidden" });
    if (!d.signedPdfB64) return res.status(404).json({ error: "no_signed_pdf" });
    const buf = Buffer.from(d.signedPdfB64.split(",")[1] || d.signedPdfB64, "base64");
    const safeName = (d.docName || "document").replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}_semnat.pdf"`);
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: "server_error" });
  }
});

// GET /users — lista useri pentru dropdown (orice user autentificat, fără parole)
app.get("/users", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const actor2 = await pool.query("SELECT institutie FROM users WHERE id=$1", [actor.userId]);
  const inst = actor2.rows[0]?.institutie || "";
  const { rows } = await pool.query(
    "SELECT id, email, nume, functie, institutie FROM users WHERE institutie = $1 AND role != 'admin' ORDER BY nume ASC",
    [inst]
  );
  res.json(rows);
});

// GET /admin/users — listă useri cu parolă plain (doar admin)
app.get("/admin/users", async (req, res) => {
  if (requireDb(res)) return;
  const user = requireAuth(req, res);
  if (!user) return;
  if (user.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const { rows } = await pool.query(
    "SELECT id, email, nume, functie, institutie, plain_password, role, created_at FROM users ORDER BY institutie ASC, nume ASC"
  );
  res.json(rows);
});

// POST /admin/users — crează user (doar admin)
app.post("/admin/users", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const { email, password, nume, functie, institutie, role } = req.body || {};
  if (!email || !nume) {
    return res.status(400).json({ error: "email_and_nume_required" });
  }
  const validRole = ["admin", "user"].includes(role) ? role : "user";
  const plainPwd = password && password.length >= 4 ? password : generatePassword();
  try {
    const hash = hashPassword(plainPwd);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, plain_password, nume, functie, institutie, role)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, email, nume, functie, institutie, plain_password, role`,
      [email.trim().toLowerCase(), hash, plainPwd, (nume||"").trim(), (functie||"").trim(), (institutie||"").trim(), validRole]
    );
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code === "23505") return res.status(409).json({ error: "email_exists" });
    console.error("create user error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// PUT /admin/users/:id — editează user complet (doar admin)
app.put("/admin/users/:id", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const targetId = parseInt(req.params.id);
  const { email, nume, functie, institutie, password, role } = req.body || {};
  const updates = [];
  const vals = [];
  let i = 1;
  if (email) { updates.push(`email=$${i++}`); vals.push(email.trim().toLowerCase()); }
  if (nume !== undefined) { updates.push(`nume=$${i++}`); vals.push((nume||"").trim()); }
  if (functie !== undefined) { updates.push(`functie=$${i++}`); vals.push((functie||"").trim()); }
  if (institutie !== undefined) { updates.push(`institutie=$${i++}`); vals.push((institutie||"").trim()); }
  if (role && ["admin","user"].includes(role)) { updates.push(`role=$${i++}`); vals.push(role); }
  if (password && password.length >= 4) {
    const hash = hashPassword(password);
    updates.push(`password_hash=$${i++}`); vals.push(hash);
    updates.push(`plain_password=$${i++}`); vals.push(password);
  }
  if (!updates.length) return res.status(400).json({ error: "nothing_to_update" });
  vals.push(targetId);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(",")} WHERE id=$${i} RETURNING id, email, nume, functie, institutie, plain_password, role`,
      vals
    );
    res.json(rows[0]);
  } catch(e) {
    if (e.code === "23505") return res.status(409).json({ error: "email_exists" });
    res.status(500).json({ error: "server_error" });
  }
});

// POST /admin/users/:id/reset-password — generează parolă nouă automată
app.post("/admin/users/:id/reset-password", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const targetId = parseInt(req.params.id);
  const newPwd = generatePassword();
  const hash = hashPassword(newPwd);
  await pool.query("UPDATE users SET password_hash=$1, plain_password=$2 WHERE id=$3", [hash, newPwd, targetId]);
  res.json({ plain_password: newPwd });
});

// DELETE /admin/users/:id — șterge user (doar admin, nu se poate șterge pe sine)
app.delete("/admin/users/:id", async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (actor.role !== "admin") return res.status(403).json({ error: "forbidden" });
  const targetId = parseInt(req.params.id);
  if (actor.userId === targetId) return res.status(400).json({ error: "cannot_delete_self" });
  await pool.query("DELETE FROM users WHERE id=$1", [targetId]);
  res.json({ ok: true });
});

// -------------------- Health --------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "SemDoc+",
    dbReady: DB_READY,
    dbLastError: DB_LAST_ERROR,
  });
});


// -------------------- SMTP Test --------------------
app.get("/smtp-test", async (req, res) => {
  const result = await verifySmtp();
  res.status(result.ok ? 200 : 500).json(result);
});

app.post("/smtp-test", async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: "to missing" });
  try {
    const verify = await verifySmtp();
    if (!verify.ok) return res.status(500).json({ error: "smtp_not_ready", detail: verify });
    await sendSignerEmail({
      to,
      subject: "Test SMTP DocFlowAI",
      html: "<p>Acesta este un email de test de la DocFlowAI.</p><p>SMTP funcționează corect! ✅</p>",
    });
    return res.json({ ok: true, to });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// -------------------- FLOWS API --------------------
// Create flow
const createFlow = async (req, res) => {
  try {
    if (requireDb(res)) return;

    const body = req.body || {};
    const docName = String(body.docName || "").trim();
    const initName = String(body.initName || "").trim();
    const initEmail = String(body.initEmail || "").trim();
    const signers = Array.isArray(body.signers) ? body.signers : [];

    if (!docName || !initName || !initEmail) {
      return res.status(400).json({ error: "docName/initName/initEmail missing" });
    }
    if (!signers.length) {
      return res.status(400).json({ error: "signers missing" });
    }

    const normalizedSigners = signers.map((s, idx) => ({
      order: Number(s.order || idx + 1),
      rol: String(s.rol || s.atribut || "").trim(),
      functie: String(s.functie || "").trim(),
      name: String(s.name || "").trim(),
      email: String(s.email || "").trim(),
      token: String(s.token || crypto.randomBytes(16).toString("hex")),
      status: idx === 0 ? "current" : "pending",
      signedAt: null,
      signature: null, // MVP: store anything (optional) from signer page
    }));

    const flowId = newFlowId();

    const data = {
      flowId,
      docName,
      initName,
      initEmail,
      meta: body.meta || {},
      pdfB64: body.pdfB64 ?? null,
      signers: normalizedSigners,
      createdAt: body.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [{ at: new Date().toISOString(), type: "FLOW_CREATED", by: initEmail }],
    };

    await saveFlow(flowId, data);

    const first = data.signers.find((s) => s.status === "current");
    const signerLink = first ? buildSignerLink(req, flowId, first.token) : null;

    // Email first signer (NON-BLOCKING) — mark as notified so upload doesn't re-send
    if (first) first.emailSent = true;
    await saveFlow(flowId, data);

    if (first?.email && signerLink) {
      sendSignerEmail({
        to: first.email,
        subject: `Semnare document: ${data.docName}`,
        html: `
          <p>Bună ${first.name || ""},</p>
          <p>Ai un document de semnat:</p>
          <p><strong>${data.docName}</strong></p>
          <p>Link semnare:</p>
          <p><a href="${signerLink}">${signerLink}</a></p>
          <br/>
          <p>— DocFlowAI</p>
        `,
      }).catch((e) => console.error("❌ Email send failed (non-blocking):", e));
    }

    return res.json({
      ok: true,
      flowId,
      signerLink,
      firstSignerEmail: first?.email || null,
    });
  } catch (e) {
    console.error("POST /flows error:", e);
    return res.status(500).json({ error: "server_error" });
  }
};

app.post("/flows", createFlow);
app.post("/api/flows", createFlow);

// Get signed PDF (uploaded by signer)
app.get("/flows/:flowId/signed-pdf", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    const b64 = data.signedPdfB64;
    if (!b64 || typeof b64 !== "string") return res.status(404).json({ error: "signed_pdf_missing" });
    const raw = b64.includes("base64,") ? b64.split("base64,")[1] : b64;
    const buf = Buffer.from(raw, "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${(data.docName || "document").replace(/[^\w\-]+/g,"_")}_semnat_calificat.pdf"`);
    return res.status(200).send(buf);
  } catch (e) {
    console.error("GET /flows/:flowId/signed-pdf error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// Get flow
app.get("/flows/:flowId/pdf", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    const b64 = data.pdfB64;
    if (!b64 || typeof b64 !== "string") return res.status(404).json({ error: "pdf_missing" });

    // support both "data:application/pdf;base64,..." and raw base64
    const raw = b64.includes("base64,") ? b64.split("base64,")[1] : b64;
    const buf = Buffer.from(raw, "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${(data.docName || "document").replace(/[^\w\-]+/g,"_")}.pdf"`);
    return res.status(200).send(buf);
  } catch (e) {
    console.error("GET /flows/:flowId/pdf error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

const getFlowHandler = async (req, res) => {
  try {
    if (requireDb(res)) return;
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    return res.json(stripPdfB64(data));
  } catch (e) {
    console.error("GET /flows/:flowId error:", e);
    return res.status(500).json({ error: "server_error" });
  }
};

app.get("/flows/:flowId", getFlowHandler);
app.get("/api/flows/:flowId", getFlowHandler);

// Update flow (replace)
app.put("/flows/:flowId", async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;
    const { flowId } = req.params;
    const existing = await getFlowData(flowId);
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
});

// Sign step
const signFlow = async (req, res) => {
  try {
    if (requireDb(res)) return;

    const { flowId } = req.params;
    const { token, signature } = req.body || {};

    const sig = typeof signature === 'string' ? signature.trim() : '';
    if (!sig) return res.status(400).json({ error: 'signature_required' });

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: "not_found" });

    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex((s) => s.token === token);
    if (idx === -1) return res.status(400).json({ error: "invalid_token" });

    // enforce "current"
    if (signers[idx].status !== "current") {
      return res.status(409).json({ error: "not_current_signer" });
    }

    signers[idx].status = "signed";
    signers[idx].signedAt = new Date().toISOString();
    signers[idx].signature = sig ?? signers[idx].signature ?? null;
    signers[idx].pdfUploaded = false; // waiting for qualified PDF upload

    // Keep next signers as "pending" until PDF is uploaded
    // (status advancement happens in upload-signed-pdf endpoint)

    data.signers = signers;
    data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({
      at: new Date().toISOString(),
      type: "SIGNED",
      by: signers[idx].email || signers[idx].name || "unknown",
      order: signers[idx].order,
    });

    await saveFlow(flowId, data);

    const next = data.signers.find((s) => s.status === "current");
    const nextLink = next ? buildSignerLink(req, flowId, next.token) : null;

    // allSigned in signFlow means everyone pressed sign button
    // Full completion (with PDFs) is checked in upload-signed-pdf
    const allSigned = data.signers.every((s) => s.status === "signed");

    // NOTE: Email to next signer is sent only after signed PDF is uploaded
    // (see POST /flows/:flowId/upload-signed-pdf)

    return res.json({
      ok: true,
      flowId,
      completed: allSigned,
      nextSigner: next || null,
      nextLink: null, // withheld until PDF upload
      awaitingUpload: !allSigned,
      flow: stripPdfB64(data),
    });
  } catch (e) {
    console.error("POST /flows/:flowId/sign error:", e);
    return res.status(500).json({ error: "server_error" });
  }
};

app.post("/flows/:flowId/sign", signFlow);
app.post("/api/flows/:flowId/sign", signFlow);

// Admin: resend email to current signer
app.post("/flows/:flowId/resend", async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;

    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: "not_found" });

    const current = (data.signers || []).find((s) => s.status === "current");
    if (!current) return res.status(409).json({ error: "no_current_signer" });
    if (!current.email) return res.status(400).json({ error: "current_missing_email" });

    const signerLink = buildSignerLink(req, flowId, current.token);

    await sendSignerEmail({
      to: current.email,
      subject: `Re-trimitere link semnare: ${data.docName}`,
      html: `
        <p>Bună ${current.name || ""},</p>
        <p>Revenim cu link-ul de semnare pentru documentul:</p>
        <p><strong>${data.docName}</strong></p>
        <p>Link semnare:</p>
        <p><a href="${signerLink}">${signerLink}</a></p>
        <br/>
        <p>— DocFlowAI</p>
      `,
    });

    return res.json({ ok: true, to: current.email, signerLink });
  } catch (e) {
    console.error("POST /flows/:flowId/resend error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});


// Upload signed PDF (qualified e-signature, uploaded by signer)
app.post("/flows/:flowId/upload-signed-pdf", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, signedPdfB64, signerName } = req.body || {};

    if (!token) return res.status(400).json({ error: "token_missing" });
    if (!signedPdfB64 || typeof signedPdfB64 !== "string") return res.status(400).json({ error: "signedPdfB64_missing" });
    if (signedPdfB64.length > 40 * 1024 * 1024) return res.status(413).json({ error: "pdf_too_large_max_30mb" });

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: "not_found" });

    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex((s) => s.token === token);
    if (idx === -1) return res.status(400).json({ error: "invalid_token" });

    // Verify signer has signed (status = "signed") and hasn't uploaded yet
    if (signers[idx].status !== "signed") {
      return res.status(409).json({ error: "signer_not_signed_yet" });
    }

    // Store signed PDF — keep all versions with timestamp
    if (!Array.isArray(data.signedPdfVersions)) data.signedPdfVersions = [];
    data.signedPdfVersions.push({
      uploadedAt: new Date().toISOString(),
      uploadedBy: signers[idx].email || signers[idx].name || "unknown",
      signerIndex: idx,
      signerName: signerName || signers[idx].name || "",
    });

    // Latest signed PDF = what next signer will download
    data.signedPdfB64 = signedPdfB64;
    data.signedPdfUploadedAt = new Date().toISOString();
    data.signedPdfUploadedBy = signers[idx].email || signers[idx].name || "unknown";
    signers[idx].pdfUploaded = true;
    data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({
      at: new Date().toISOString(),
      type: "SIGNED_PDF_UPLOADED",
      by: signers[idx].email || signers[idx].name || "unknown",
      order: signers[idx].order,
    });

    // NOW advance next signer to "current"
    const nextIdx = signers.findIndex((s, i) => i > idx && s.status !== "signed");
    if (nextIdx !== -1) {
      signers.forEach((s, i) => {
        if (s.status !== "signed") s.status = i === nextIdx ? "current" : "pending";
      });
    }
    data.signers = signers;
    // Mark this signer as having triggered the next notification
    signers[idx].notifiedNext = true;

    // Check full completion: all signed AND all PDFs uploaded
    const allSignedAndUploaded = data.signers.every((s) => s.status === "signed" && s.pdfUploaded);
    if (allSignedAndUploaded) {
      data.completed = true;
      data.completedAt = new Date().toISOString();
      data.events.push({ at: new Date().toISOString(), type: "FLOW_COMPLETED", by: "system" });

      // Email initiator with link to final signed PDF
      if (data.initEmail) {
        const signedPdfLink = `${publicBaseUrl(req)}/flows/${encodeURIComponent(flowId)}/signed-pdf`;
        sendSignerEmail({
          to: data.initEmail,
          subject: `Document semnat complet: ${data.docName}`,
          html: `
            <p>Bună ${data.initName || ""},</p>
            <p>Documentul <strong>${data.docName}</strong> a fost semnat calificat de toți semnatarii.</p>
            <p>Poți descărca PDF-ul final semnat calificat accesând link-ul:</p>
            <p><a href="${signedPdfLink}">${signedPdfLink}</a></p>
            <br/>
            <p>— DocFlowAI</p>
          `,
        }).catch((e) => console.error("❌ Email completion failed (non-blocking):", e));
      }
    }

    await saveFlow(flowId, data);

    // Send email to next signer (NOW, after PDF upload) — only if not already notified
    const nextSigner = data.signers.find((s) => s.status === "current" && !s.emailSent);
    const nextLink = nextSigner ? buildSignerLink(req, flowId, nextSigner.token) : null;

    if (nextSigner?.email && nextLink) {
      nextSigner.emailSent = true;
      await saveFlow(flowId, data);
      const signedPdfLink = `${publicBaseUrl(req)}/flows/${encodeURIComponent(flowId)}/signed-pdf`;
      sendSignerEmail({
        to: nextSigner.email,
        subject: `Urmezi la semnare: ${data.docName}`,
        html: `
          <p>Bună ${nextSigner.name || ""},</p>
          <p>Este rândul tău să semnezi documentul:</p>
          <p><strong>${data.docName}</strong></p>
          <p>Documentul conține semnăturile electronice calificate ale semnatarilor anteriori.<br/>
          Descarcă documentul semnat anterior direct din interfața DocFlowAI după ce deschizi linkul de mai jos.</p>
          <p>Link semnare:</p>
          <p><a href="${nextLink}">${nextLink}</a></p>
          <br/>
          <p>— DocFlowAI</p>
        `,
      }).catch((e) => console.error("❌ Email send failed (non-blocking):", e));
    }

    console.log(`📎 Signed PDF uploaded for flow ${flowId} by ${signers[idx].email || signers[idx].name}`);
    return res.json({
      ok: true,
      flowId,
      completed: allSignedAndUploaded,
      uploadedAt: data.signedPdfUploadedAt,
      downloadUrl: `/flows/${flowId}/signed-pdf`,
      nextSigner: nextSigner || null,
    });
  } catch (e) {
    console.error("POST /flows/:flowId/upload-signed-pdf error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// -------------------- Graceful shutdown --------------------
let _server = null;

function shutdown(signal) {
  console.log(`🧯 ${signal} received. Shutting down...`);
  try {
    if (_server) {
      _server.close(() => {
        console.log("✅ HTTP server closed.");
        process.exit(0);
      });
      // force exit after 10s
      setTimeout(() => process.exit(0), 10_000).unref();
    } else {
      process.exit(0);
    }
  } catch (e) {
    console.error("Shutdown error:", e);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// -------------------- Start --------------------
const PORT = process.env.PORT;

if (!PORT) {
  console.error("❌ PORT missing. Railway didn't inject PORT. Check Service Type (must be Web Service).");
  process.exit(1);
}

_server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`🚀 SemDoc+ server running on port ${PORT}`);
  initDbWithRetry();
});