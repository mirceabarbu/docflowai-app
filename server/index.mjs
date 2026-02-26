import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { sendSignerEmail } from "./mailer.mjs";

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

// Serve static assets (css/js/images)
app.use(express.static(PUBLIC_DIR));

// UI on root (no /app, no redirect)
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "semdoc-initiator.html"), (err) => {
    if (err) {
      console.error("Root sendFile error:", err);
      // Fallback 200 so Railway healthchecks won't kill the service
      res.status(200).send("ok");
    }
  });
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
  const { pdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64 };
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

async function getFlow(id) {
  const r = await pool.query(`SELECT data FROM flows WHERE id=$1`, [id]);
  return r.rows[0]?.data ?? null;
}

function buildSignerLink(req, flowId, token) {
  const base = publicBaseUrl(req);
  return `${base}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(
    token
  )}`;
}

// -------------------- Health --------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "SemDoc+",
    dbReady: DB_READY,
    dbLastError: DB_LAST_ERROR,
  });
});

// -------------------- FLOWS API --------------------
// Create flow
app.post("/flows", async (req, res) => {
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

    // Email first signer (NON-BLOCKING)
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
});

// Get flow
app.get("/flows/:flowId/pdf", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const data = await getFlow(req.params.flowId);
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

app.get("/flows/:flowId", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const data = await getFlow(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    return res.json(stripPdfB64(data));
  } catch (e) {
    console.error("GET /flows/:flowId error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// Update flow (replace)
app.put("/flows/:flowId", async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;
    const { flowId } = req.params;
    const existing = await getFlow(flowId);
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
app.post("/flows/:flowId/sign", async (req, res) => {
  try {
    if (requireDb(res)) return;

    const { flowId } = req.params;
    const { token, signature } = req.body || {};

    const sig = typeof signature === 'string' ? signature.trim() : '';
    if (!sig) return res.status(400).json({ error: 'signature_required' });

    const data = await getFlow(flowId);
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

    // find next pending
    const nextIdx = signers.findIndex((s) => s.status !== "signed");
    if (nextIdx !== -1) {
      signers.forEach((s, i) => {
        if (s.status !== "signed") s.status = i === nextIdx ? "current" : "pending";
      });
    }

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

    // Email next signer (NON-BLOCKING)
    if (next?.email && nextLink) {
      sendSignerEmail({
        to: next.email,
        subject: `Urmezi la semnare: ${data.docName}`,
        html: `
          <p>Bună ${next.name || ""},</p>
          <p>Este rândul tău să semnezi documentul:</p>
          <p><strong>${data.docName}</strong></p>
          <p>Link semnare:</p>
          <p><a href="${nextLink}">${nextLink}</a></p>
          <br/>
          <p>— DocFlowAI</p>
        `,
      }).catch((e) => console.error("❌ Email send failed (non-blocking):", e));
    }

    return res.json({
      ok: true,
      flowId,
      nextSigner: next || null,
      nextLink,
      flow: stripPdfB64(data),
    });
  } catch (e) {
    console.error("POST /flows/:flowId/sign error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// Admin: resend email to current signer
app.post("/flows/:flowId/resend", async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;

    const { flowId } = req.params;
    const data = await getFlow(flowId);
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

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`🚀 SemDoc+ server running on port ${PORT}`);
});

// 🔥 KEEP PROCESS ALIVE TEST
setInterval(() => {
  console.log("Heartbeat alive...");
}, 5000);
