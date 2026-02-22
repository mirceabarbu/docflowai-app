import express from "express";
import cors from "cors";
import pg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ==============================
// Serve static files (public/)
// ==============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "../public");
app.use(express.static(PUBLIC_DIR));

// ==============================
// Postgres
// ==============================
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing. Add it in Railway Variables.");
  process.exit(1);
}

// Railway Postgres usually requires SSL in production
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
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

  console.log("✅ DB ready (flows table ensured)");
}

function newFlowId() {
  // scurt, ușor de citit în link
  return "FLOW_" + crypto.randomBytes(8).toString("hex").toUpperCase();
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

// ==============================
// Health + Root
// ==============================

// Root: serve initiator UI (keeps your app URL nice)
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "semdoc-initiator.html"));
});

app.get("/health", (req, res) => res.status(200).send("healthy"));

// ==============================
// FLOWS API (MVP)
// ==============================

// Create flow
app.post("/flows", async (req, res) => {
  try {
    const body = req.body || {};

    // Minim validări (nu stricăm frontend-ul, dar protejăm API-ul)
    const docName = String(body.docName || "").trim();
    const initName = String(body.initName || "").trim();
    const initEmail = String(body.initEmail || "").trim();
    const pdfB64 = body.pdfB64; // poate fi "" în unele flow-uri

    const signers = Array.isArray(body.signers) ? body.signers : [];

    if (!docName || !initName || !initEmail) {
      return res.status(400).json({ error: "docName/initName/initEmail missing" });
    }
    if (!signers.length) {
      return res.status(400).json({ error: "signers missing" });
    }

    // Normalize signers (rol, functie, name, email, token)
    const normalizedSigners = signers.map((s, idx) => ({
      order: Number(s.order || idx + 1),
      rol: String(s.rol || "").trim(),
      functie: String(s.functie || "").trim(),
      name: String(s.name || "").trim(),
      email: String(s.email || "").trim(),
      token: String(s.token || crypto.randomBytes(16).toString("hex")),
      status: idx === 0 ? "current" : String(s.status || "pending"),
      signedAt: s.signedAt || null,
    }));

    const flowId = body.flowId ? String(body.flowId) : newFlowId();

    const data = {
      flowId,
      docName,
      initName,
      initEmail,
      meta: body.meta || {},
      pdfB64: pdfB64 ?? null,
      signers: normalizedSigners,
      createdAt: body.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: Array.isArray(body.events) ? body.events : [
        { at: new Date().toISOString(), type: "FLOW_CREATED", by: initEmail },
      ],
    };

    await saveFlow(flowId, data);

    return res.json({ ok: true, flowId });
  } catch (e) {
    console.error("POST /flows error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// Get flow by id
app.get("/flows/:flowId", async (req, res) => {
  try {
    const { flowId } = req.params;
    const data = await getFlow(flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    return res.json(data);
  } catch (e) {
    console.error("GET /flows/:flowId error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// Update entire flow (simple overwrite)
app.put("/flows/:flowId", async (req, res) => {
  try {
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

// Mark current signer as signed and advance to next
app.post("/flows/:flowId/sign", async (req, res) => {
  try {
    const { flowId } = req.params;
    const { token } = req.body || {};

    const data = await getFlow(flowId);
    if (!data) return res.status(404).json({ error: "not_found" });

    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex((s) => s.token === token);
    if (idx === -1) return res.status(400).json({ error: "invalid_token" });

    signers[idx].status = "signed";
    signers[idx].signedAt = new Date().toISOString();

    // advance next signer
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

    return res.json({
      ok: true,
      flowId,
      nextSigner: signers.find((s) => s.status === "current") || null,
    });
  } catch (e) {
    console.error("POST /flows/:flowId/sign error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ==============================
// Start
// ==============================
const PORT = Number(process.env.PORT || 8080);

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 SemDoc+ server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  });
