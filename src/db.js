import { setDefaultResultOrder } from "node:dns";
import { MongoClient } from "mongodb";

setDefaultResultOrder("ipv4first");

export const PROJECT_ID = process.env.PROJECT_ID || "CalculadoraDeFinanzasPersonales";
export const DB_NAME = process.env.MONGODB_DB || "CalculadoraDeFinanzasPersonales";

export const COLLECTIONS = {
  registry: "project_registry",
  clients: "ledger_clients",
  states: "ledger_states",
  folios: "ledger_folios",
};

let client;
let db;

export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri || uri.includes("USUARIO:CONTRASENA")) {
    throw new Error(
      "Falta MONGODB_URI. Copia .env.example a .env y pega la cadena de Atlas."
    );
  }

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 20000,
    family: 4,
  });
  await client.connect();
  db = client.db(DB_NAME);
  await ensureCollections(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error("La base de datos aún no está conectada.");
  return db;
}

async function ensureCollections(database) {
  const existing = new Set(
    (await database.listCollections().toArray()).map((item) => item.name)
  );

  for (const name of Object.values(COLLECTIONS)) {
    if (!existing.has(name)) {
      await database.createCollection(name);
    }
  }

  await database.collection(COLLECTIONS.registry).updateOne(
    { projectId: PROJECT_ID },
    {
      $set: {
        projectId: PROJECT_ID,
        name: "Mayor — Libro de finanzas personales",
        collections: Object.values(COLLECTIONS),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  await database
    .collection(COLLECTIONS.clients)
    .createIndex({ projectId: 1, clientId: 1 }, { unique: true });
  await database
    .collection(COLLECTIONS.states)
    .createIndex({ projectId: 1, clientId: 1 }, { unique: true });
  await database
    .collection(COLLECTIONS.folios)
    .createIndex({ projectId: 1, clientId: 1, sealedAt: -1 });
}

export async function touchClient(clientId) {
  const now = new Date();
  await getDb().collection(COLLECTIONS.clients).updateOne(
    { projectId: PROJECT_ID, clientId },
    {
      $set: { projectId: PROJECT_ID, clientId, lastSeenAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export async function closeDb() {
  await client?.close();
}
