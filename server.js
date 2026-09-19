/**
 * QR LIS — internet-deployment entry point.
 * Reads PORT from the hosting environment (required by most hosts: Render, Railway, etc.)
 * and turns on login (HTTP Basic Auth) since this instance is reachable from anywhere.
 *
 * IMPORTANT — set these in your hosting provider's "Environment Variables" screen,
 * do NOT hardcode them in code you push to GitHub:
 *   QRLIS_USER  (login username)
 *   QRLIS_PASS  (login password)
 */
const path = require("path");
const { createServer } = require("./server/api");

const PORT = process.env.PORT || 5077;
const dbFilePath = path.join(__dirname, "data", "qrlis-data.json");

const { app } = createServer({
  appDir: path.join(__dirname, "app"),
  dbFilePath,
  requireAuth: true,
});

app.listen(PORT, () => {
  console.log(`QR LIS listening on port ${PORT} (login required)`);
});
