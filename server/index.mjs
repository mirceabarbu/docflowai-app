import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ==============================
// DATABASE (optional)
// ==============================

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  pool.connect()
    .then(() => console.log("✅ Connected to PostgreSQL"))
    .catch(err => console.error("❌ PostgreSQL connection error:", err));
} else {
  console.log("⚠ No DATABASE_URL found. Running without DB.");
}

// ==============================
// HEALTH CHECK
// ==============================

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "SemDoc+" });
});

// ==============================
// TEST ROUTE
// ==============================

app.get("/health", (req, res) => {
  res.status(200).send("healthy");
});

// ==============================
// START SERVER (Railway safe)
// ==============================

const PORT = Number(process.env.PORT || 8787);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SemDoc+ server running on port ${PORT}`);
});