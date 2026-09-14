/**
 * Session-based auth: each staff member logs in with their own username/password
 * (hashed with scrypt — see hashPassword/verifyPassword below, never stored plain).
 * A session token is issued as an httpOnly cookie and kept in memory on the server.
 *
 * ROLE_VIEWS is the server-side source of truth for which nav sections a role can
 * see — sent to the client after login so it can hide buttons, but every sensitive
 * API route also checks req.user.role itself (see server/api.js). Hiding a button
 * is a UX nicety; the role check on the route is the real security boundary.
 */
const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ROLE_VIEWS = {
  Admin: ["viewDashboard", "viewBooking", "viewPatient360", "viewReservations", "viewSamples", "viewPCR", "viewProcessing", "viewValidation", "viewApproval", "viewAdmin", "viewQC", "viewArchiving", "viewWarehouse", "viewReporting", "viewConnection", "viewSoon"],
  "Lab Technician": ["viewDashboard", "viewBooking", "viewPatient360", "viewReservations", "viewSamples", "viewPCR", "viewProcessing", "viewValidation", "viewApproval", "viewQC", "viewArchiving", "viewWarehouse", "viewReporting", "viewConnection", "viewSoon"],
  Receptionist: ["viewDashboard", "viewBooking", "viewPatient360", "viewReservations", "viewSamples", "viewSoon"],
};

const SESSIONS = new Map(); // token -> { sub, name, role, expires }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = "qrlis_session";

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  SESSIONS.set(token, { ...user, expires: Date.now() + SESSION_TTL_MS });
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
  return token;
}

function clearSessionCookie(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) SESSIONS.delete(token);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

/** Returns {sub, name, role} for the current request's session, or null. */
function readSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { SESSIONS.delete(token); return null; }
  return s;
}

/** Express middleware: 401s unless a valid session is present; attaches req.user. */
function sessionAuth(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  req.user = user;
  next();
}

module.exports = { hashPassword, verifyPassword, ROLE_VIEWS, setSessionCookie, clearSessionCookie, readSession, sessionAuth };
