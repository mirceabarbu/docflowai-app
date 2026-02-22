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
app.use(express.json({ limit: "30mb" }));

process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
process.on("uncaughtException",  (err) => console.error("❌ uncaughtException:",  err));

// ── Static ──────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "../public");
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "semdoc-initiator.html")));

// ── Helpers ─────────────────────────────────────────────────
function publicBaseUrl(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/$/, "");
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

function newFlowId() {
  return "FLOW_" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

function newToken() {
  // BUG FIX #2: tokenurile generate exclusiv pe server, nu în browser
  return crypto.randomBytes(20).toString("hex");
}

// ── PostgreSQL ───────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

let DB_READY = false;
let DB_LAST_ERROR = null;

async function initDbOnce() {
  if (!pool) throw new Error("DATABASE_URL lipsește");
  await pool.query("SELECT 1");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flows (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_flows_updated ON flows(updated_at DESC);
  `);
  DB_READY = true;
  DB_LAST_ERROR = null;
  console.log("✅ DB gata");
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
      console.error("❌ DB init eșuat:", e);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
  console.error("❌ DB init eșuat permanent. Serverul rămâne activ pentru debugging.");
}

function requireDb(res) {
  if (!DB_READY) {
    res.status(503).json({ error: "db_not_ready", dbLastError: DB_LAST_ERROR });
    return true;
  }
  return false;
}

async function saveFlow(id, data) {
  await pool.query(
    `INSERT INTO flows (id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [id, JSON.stringify(data)]
  );
}

async function getFlow(id) {
  const r = await pool.query("SELECT data FROM flows WHERE id=$1", [id]);
  return r.rows[0]?.data ?? null;
}

// ── Email helper ─────────────────────────────────────────────
async function notifyNextSigner(base, flow, signer, signerIdx) {
  if (!signer?.email) return;
  const link = `${base}/semdoc-signer.html?flow=${encodeURIComponent(flow.flowId)}&token=${encodeURIComponent(signer.token)}&idx=${encodeURIComponent(signerIdx)}`;
  try {
    await sendSignerEmail({
      to: signer.email,
      subject: `Semnare document: ${flow.docName}`,
      html: `
        <p>Bună ziua, ${signer.name || ""},</p>
        <p>Aveți un document de semnat: <strong>${flow.docName}</strong></p>
        <p>Accesați linkul de mai jos pentru a semna:</p>
        <p><a href="${link}" style="font-size:16px">${link}</a></p>
        <br/>
        <p style="color:#888;font-size:12px">— SemDoc Flow</p>
      `,
    });
  } catch (e) {
    console.error("❌ Email eșuat (non-blocking):", e.message);
  }
}

// ── Health ───────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ ok: true, service: "SemDoc+", dbReady: DB_READY, dbLastError: DB_LAST_ERROR })
);

// ── POST /flows — creare flux ────────────────────────────────
app.post("/flows", async (req, res) => {
  try {
    if (requireDb(res)) return;

    const body = req.body || {};
    const docName   = String(body.docName  || "").trim();
    const initName  = String(body.initName || "").trim();
    const initEmail = String(body.initEmail || "").trim();
    const signers   = Array.isArray(body.signers) ? body.signers : [];

    if (!docName || !initName || !initEmail)
      return res.status(400).json({ error: "docName / initName / initEmail lipsesc" });
    if (!signers.length)
      return res.status(400).json({ error: "signers lipsesc" });
    if (!body.pdfB64 || typeof body.pdfB64 !== "string")
      return res.status(400).json({ error: "pdfB64 lipsește" });

    const flowId = newFlowId();

    // BUG FIX #2: tokenurile sunt generate pe server, nu acceptăm cele din browser
    const normalizedSigners = signers.map((s, idx) => ({
      order:    idx + 1,
      atribut:  String(s.atribut  || s.rol || "").trim(),
      functie:  String(s.functie  || "").trim(),
      name:     String(s.name     || "").trim(),
      email:    String(s.email    || "").trim(),
      token:    newToken(),           // ← generat pe server
      status:   idx === 0 ? "current" : "pending",
      signedAt: null,
    }));

    const data = {
      flowId,
      docName,
      initName,
      initEmail,
      meta:      body.meta || {},
      pdfB64:    body.pdfB64,
      signers:   normalizedSigners,
      status:    "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events:    [{ at: new Date().toISOString(), type: "FLOW_CREATED", by: initEmail }],
    };

    await saveFlow(flowId, data);

    const first = normalizedSigners[0];
    const base  = publicBaseUrl(req);

    // Construim linkul cu tokenul generat pe server
    const signerLink = `${base}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(first.token)}&idx=0`;

    // Trimitem email primului semnatar
    await notifyNextSigner(base, data, first, 0);

    return res.json({ ok: true, flowId, signerLink, firstSignerEmail: first.email });
  } catch (e) {
    console.error("POST /flows error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── GET /flows/:flowId — dashboard inițiator ─────────────────
// Returnează fluxul fără tokenuri (pentru dashboard)
app.get("/flows/:flowId", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const data = await getFlow(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });

    // BUG FIX #3: nu expunem tokenurile în dashboard
    const safe = {
      ...data,
      pdfB64:  undefined,   // PDF-ul mare nu e necesar în dashboard
      signers: data.signers.map((s) => ({ ...s, token: undefined })),
    };

    return res.json(safe);
  } catch (e) {
    console.error("GET /flows/:flowId error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── GET /flows/:flowId/pdf — descărcare PDF pentru inițiator ─
app.get("/flows/:flowId/pdf", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const data = await getFlow(req.params.flowId);
    if (!data) return res.status(404).json({ error: "not_found" });
    if (!data.pdfB64) return res.status(404).json({ error: "pdf_not_found" });
    return res.json({ ok: true, pdfB64: data.pdfB64, docName: data.docName });
  } catch (e) {
    return res.status(500).json({ error: "server_error" });
  }
});

// ── GET /flows/:flowId/signer — pagina semnătarului ─────────
// BUG FIX #3: verificarea tokenului se face pe SERVER
app.get("/flows/:flowId/signer", async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const token = String(req.query.token || "");
    const idx   = Number(req.query.idx ?? "0");

    if (!token)           return res.status(400).json({ error: "token lipsește" });
    if (isNaN(idx))       return res.status(400).json({ error: "idx invalid" });

    const data = await getFlow(flowId);
    if (!data)            return res.status(404).json({ error: "not_found" });

    const signer = data.signers?.[idx];
    if (!signer)          return res.status(404).json({ error: "semnatar inexistent" });
    if (signer.token !== token) return res.status(403).json({ error: "token_invalid" });

    // Returnăm fluxul fără tokenurile celorlalți
    const safeFlow = {
      ...data,
      signers: data.signers.map((s, i) => ({
        ...s,
        token: i === idx ? s.token : undefined,  // doar tokenul celui curent
      })),
    };

    return res.json({ ok: true, flow: safeFlow });
  } catch (e) {
    console.error("GET /flows/:flowId/signer error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── POST /flows/:flowId/sign — submitere semnătură ───────────
// BUG FIX #1: acesta este singurul endpoint care salvează semnătura + trimite email
app.post("/flows/:flowId/sign", async (req, res) => {
  try {
    if (requireDb(res)) return;

    const { flowId } = req.params;
    const { token, idx: rawIdx, pdfB64 } = req.body || {};
    const idx = Number(rawIdx ?? "0");

    if (!token)        return res.status(400).json({ error: "token lipsește" });
    if (isNaN(idx))    return res.status(400).json({ error: "idx invalid" });
    if (!pdfB64)       return res.status(400).json({ error: "pdfB64 lipsește" });

    const data = await getFlow(flowId);
    if (!data)         return res.status(404).json({ error: "not_found" });

    const signer = data.signers?.[idx];
    if (!signer)                    return res.status(404).json({ error: "semnatar inexistent" });
    if (signer.token !== token)     return res.status(403).json({ error: "token_invalid" });
    if (signer.status === "signed") return res.status(409).json({ error: "deja_semnat" });

    // Actualizăm semnătarul curent
    const now = new Date().toISOString();
    data.signers[idx].status   = "signed";
    data.signers[idx].signedAt = now;
    data.pdfB64  = pdfB64;
    data.updatedAt = now;

    // Determinăm următorul semnatar
    const nextIdx = data.signers.findIndex((s, i) => i > idx && s.status !== "signed");
    if (nextIdx !== -1) {
      data.signers.forEach((s, i) => {
        if (s.status !== "signed") s.status = i === nextIdx ? "current" : "pending";
      });
      data.status = "active";
    } else {
      data.status      = "completed";
      data.completedAt = now;
    }

    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({
      at:    now,
      type:  "SIGNED",
      by:    signer.email || signer.name || "unknown",
      order: signer.order,
    });

    await saveFlow(flowId, data);

    // BUG FIX #4: trimitem email DUPĂ salvare
    const base = publicBaseUrl(req);
    if (nextIdx !== -1) {
      await notifyNextSigner(base, data, data.signers[nextIdx], nextIdx);
    } else {
      // Opțional: notifică inițiatorul că fluxul e complet
      if (data.initEmail) {
        try {
          await sendSignerEmail({
            to:      data.initEmail,
            subject: `✅ Document semnat complet: ${data.docName}`,
            html: `
              <p>Bună ziua, ${data.initName || ""},</p>
              <p>Documentul <strong>${data.docName}</strong> a fost semnat de toți semnatarii.</p>
              <p>Puteți descărca versiunea finală din dashboard-ul SemDoc Flow.</p>
              <br/>
              <p style="color:#888;font-size:12px">— SemDoc Flow</p>
            `,
          });
        } catch (e) {
          console.error("❌ Email inițiator eșuat:", e.message);
        }
      }
    }

    const nextSigner = nextIdx !== -1 ? data.signers[nextIdx] : null;
    const nextLink   = nextSigner
      ? `${base}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(nextSigner.token)}&idx=${nextIdx}`
      : null;

    return res.json({ ok: true, flowId, nextSigner: nextSigner ? { ...nextSigner, token: undefined } : null, nextLink });
  } catch (e) {
    console.error("POST /flows/:flowId/sign error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── Start ────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SemDoc+ pornit pe portul ${PORT}`);
  initDbWithRetry();
});
