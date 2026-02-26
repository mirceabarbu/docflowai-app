import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// -------------------- ENV --------------------
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;

let DB_READY = false;
let DB_LAST_ERROR = null;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// -------------------- DB INIT --------------------
async function initDbOnce() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
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

  console.error("❌ DB init failed after all retries.");
}

// -------------------- HEALTH --------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "SemDoc+",
    dbReady: DB_READY,
    dbLastError: DB_LAST_ERROR,
  });
});

// -------------------- STATIC ROOT UI --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "../public");

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "semdoc-initiator.html"), (err) => {
    if (err) {
      console.error("Root sendFile error:", err);
      res.status(200).send("ok");
    }
  });
});

// -------------------- START SERVER --------------------
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`🚀 SemDoc+ server running on port ${PORT}`);
  initDbWithRetry();
});
