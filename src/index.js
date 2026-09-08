import "dotenv/config";
import cors from "cors";
import express from "express";
import {
  COLLECTIONS,
  PROJECT_ID,
  closeDb,
  connectDb,
  getDb,
  touchClient,
} from "./db.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

function allowedOrigins() {
  return String(process.env.FRONT_ORIGIN || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const extras = allowedOrigins();
  const local = [
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
  ];
  if (extras.includes(origin) || local.includes(origin)) return true;
  try {
    return new URL(origin).hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
  })
);
app.use(express.json({ limit: "256kb" }));

function clientIdFrom(req) {
  const raw = String(req.get("x-client-id") || "").trim();
  return raw.slice(0, 80);
}

function requireClient(req, res, next) {
  const clientId = clientIdFrom(req);
  if (!clientId) {
    res.status(400).json({ error: "Falta la cabecera X-Client-Id." });
    return;
  }
  req.clientId = clientId;
  next();
}

function sanitizeState(body = {}) {
  const categories = Array.isArray(body.categories)
    ? body.categories.slice(0, 24).map((cat) => ({
        id: String(cat.id || "").slice(0, 80),
        name: String(cat.name || "").slice(0, 80),
        type: ["fijo", "variable", "ahorro"].includes(cat.type) ? cat.type : "variable",
        amount: String(cat.amount ?? "").slice(0, 24),
      }))
    : [];

  return {
    income: String(body.income ?? "").slice(0, 24),
    extra: String(body.extra ?? "").slice(0, 24),
    categories,
  };
}

function sanitizeHistory(list = []) {
  return (Array.isArray(list) ? list : []).slice(0, 16).map((row) => ({
    id: String(row.id || "").slice(0, 80),
    folio: Number(row.folio) || 0,
    date: String(row.date || "").slice(0, 32),
    income: Number(row.income) || 0,
    expenses: Number(row.expenses) || 0,
    balance: Number(row.balance) || 0,
    snapshot: sanitizeState(row.snapshot || {}),
  }));
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    projectId: PROJECT_ID,
    collections: Object.values(COLLECTIONS),
  });
});

app.get("/api/ledger", requireClient, async (req, res) => {
  try {
    await touchClient(req.clientId);
    const db = getDb();
    const stateDoc = await db.collection(COLLECTIONS.states).findOne({
      projectId: PROJECT_ID,
      clientId: req.clientId,
    });
    const folios = await db
      .collection(COLLECTIONS.folios)
      .find({ projectId: PROJECT_ID, clientId: req.clientId })
      .sort({ sealedAt: -1 })
      .limit(16)
      .toArray();

    res.json({
      projectId: PROJECT_ID,
      clientId: req.clientId,
      folio: stateDoc?.folio ?? 4,
      state: stateDoc
        ? {
            income: stateDoc.income ?? "",
            extra: stateDoc.extra ?? "",
            categories: stateDoc.categories ?? [],
          }
        : null,
      history: folios.map((row) => ({
        id: row.entryId,
        folio: row.folio,
        date: row.date,
        income: row.income,
        expenses: row.expenses,
        balance: row.balance,
        snapshot: row.snapshot,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo leer el libro." });
  }
});

app.put("/api/ledger", requireClient, async (req, res) => {
  try {
    await touchClient(req.clientId);
    const db = getDb();
    const state = sanitizeState(req.body.state);
    const history = sanitizeHistory(req.body.history);
    const folio = Number(req.body.folio) || 4;
    const now = new Date();

    await db.collection(COLLECTIONS.states).updateOne(
      { projectId: PROJECT_ID, clientId: req.clientId },
      {
        $set: {
          projectId: PROJECT_ID,
          clientId: req.clientId,
          ...state,
          folio,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    await db.collection(COLLECTIONS.folios).deleteMany({
      projectId: PROJECT_ID,
      clientId: req.clientId,
    });

    if (history.length) {
      await db.collection(COLLECTIONS.folios).insertMany(
        history.map((row, index) => ({
          projectId: PROJECT_ID,
          clientId: req.clientId,
          entryId: row.id,
          folio: row.folio,
          date: row.date,
          income: row.income,
          expenses: row.expenses,
          balance: row.balance,
          snapshot: row.snapshot,
          sealedAt: new Date(now.getTime() - index),
        }))
      );
    }

    res.json({ ok: true, projectId: PROJECT_ID });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo guardar el libro." });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

const server = await connectDb();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mayor Back listo en el puerto ${PORT}`);
  console.log(`Base: ${server.databaseName} · projectId: ${PROJECT_ID}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  await closeDb();
  process.exit(0);
}
