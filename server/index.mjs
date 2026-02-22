import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ==============================
// ROUTES
// ==============================

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "SemDoc+" });
});

app.get("/health", (req, res) => {
  res.status(200).send("healthy");
});

// ==============================
// START SERVER (Railway safe)
// ==============================

const PORT = Number(process.env.PORT || 8080);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SemDoc+ server running on port ${PORT}`);
});