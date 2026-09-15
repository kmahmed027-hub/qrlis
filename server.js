/**
 * QR LIS — internet-deployment entry point.
 * Reads PORT from the hosting environment (required by most hosts: Render, Railway, etc.)
 * and turns on login (HTTP Basic Auth) since this instance is reachable from anywhere.
 *
 * IMPORTANT — set these in your hosting provider's "Environment Variables" screen,
 * do NOT hardcode them in code you push to GitHub:
 *   QRLIS_USER      (initial admin login username, first run only)
 *   QRLIS_PASS      (initial admin login password, first run only)
 *   DATABASE_URL    (optional — a Postgres connection string. When set, data is
 *                    stored durably in Postgres instead of a local JSON file,
 *                    so it survives restarts/redeploys. Leave unset for local
 *                    testing — it falls back to the old JSON-file storage.)
 */
const path = require("path");
const { createServer } = require("./server/api");
const { JsonDb, PgDb } = require("./server/db");

const PORT = process.env.PORT || 5077;

async function main() {
  let db;
  if (process.env.DATABASE_URL) {
    console.log("QR LIS: DATABASE_URL found — using Postgres for storage.");
    db = await PgDb.create(process.env.DATABASE_URL);
  } else {
    console.log("QR LIS: no DATABASE_URL set — using local JSON file storage (data/qrlis-data.json).");
    const dbFilePath = path.join(__dirname, "data", "qrlis-data.json");
    db = new JsonDb(dbFilePath);
  }

  const { app } = createServer({
    appDir: path.join(__dirname, "app"),
    db,
    requireAuth: true,
  });

  app.listen(PORT, () => {
    console.log(`QR LIS listening on port ${PORT} (login required)`);
  });
}

main().catch((err) => {
  console.error("QR LIS failed to start:", err);
  process.exit(1);
});
