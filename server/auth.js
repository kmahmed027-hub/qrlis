/**
 * QR LIS — real per-user authentication.
 *
 * - Passwords are hashed with Node's built-in crypto.scrypt (salted, no
 *   external packages). Plaintext passwords are never stored.
 * - A logged-in browser gets an opaque random session token in an httpOnly
 *   cookie. The token itself is looked up in an in-memory map on the server
 *   (sessions live for as long as the server process runs — a restart just
 *   means everyone logs in again, same as most small internal apps).
 * - One legacy HTTP Basic Auth check (`listenerBasicAuth`) is kept ONLY for
 *   the HL7 listener endpoint, because that caller is a background Windows
 *   process on the lab PC, not a browser — it can't hold a session cookie.
 *   It keeps using QRLIS_USER/QRLIS_PASS exactly as before, so an already
 *   configured qrlis-hl7-listener.exe does not need to change.
 */
const crypto = require("crypto");

const SESSION_COOKIE = "qrlis_sid";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h sliding window, refreshed on each request
const sessions = new Map(); // token -> { userId, expires }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const attempt = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (attempt.length !== stored.length) return false;
  return crypto.timingSafeEqual(attempt, stored);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function getSessionUserId(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  s.expires = Date.now() + SESSION_TTL_MS; // sliding window: stay logged in while active
  return s.userId;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

/** Reads the session cookie (if any) and attaches req.user + req.sessionToken. Never blocks. */
function attachUser(db) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE] || null;
    const userId = token ? getSessionUserId(token) : null;
    req.sessionToken = token;
    req.user = userId ? db.getUserSafe(userId) : null;
    next();
  };
}

/** Blocks unless attachUser found a valid, active logged-in user. */
function requireAuth(req, res, next) {
  if (!req.user || req.user.active === false) return res.status(401).json({ error: "Login required" });
  next();
}

/** Blocks unless the logged-in user's role grants at least one of the given module permissions. */
function requireModule(...moduleKeys) {
  return (req, res, next) => {
    if (!req.user || req.user.active === false) return res.status(401).json({ error: "Login required" });
    const allowed = moduleKeys.some((m) => req.user.permissions.includes(m));
    if (!allowed) return res.status(403).json({ error: "You don't have access to this section." });
    next();
  };
}

/** Legacy machine-to-machine Basic Auth — used only by the HL7 listener endpoint. */
function listenerBasicAuth(req, res, next) {
  const USER = process.env.QRLIS_USER || "admin";
  const PASS = process.env.QRLIS_PASS || "changeme123";

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === USER && pass === PASS) return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="QR LIS listener"');
  return res.status(401).send("Authentication required.");
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireModule,
  listenerBasicAuth,
};
