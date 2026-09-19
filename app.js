/* =====================================================================
   QR Lab — Application logic
   ===================================================================== */

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();
// Offline persistence: lets the app keep working (reading cached data, queuing writes) through a
// dropped connection — everything syncs automatically once the network comes back. Fails silently
// in a second open tab (Firestore only allows one persistent tab) or in browsers that don't support it.
db.enablePersistence({ synchronizeTabs: true }).catch((err) => console.warn("offline persistence unavailable:", err.code));

/* ---------- Appearance (light/dark) ---------- */
function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  const btn = document.getElementById("btnThemeToggle");
  if (btn) btn.innerHTML = mode === "dark" ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("df_theme"); } catch (e) { /* storage unavailable */ }
  const mode = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(mode);
})();
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnThemeToggle");
  applyTheme(document.documentElement.getAttribute("data-theme") || "light");
  if (btn) btn.onclick = () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("df_theme", next); } catch (e) { /* storage unavailable */ }
  };
});

// Installable PWA + offline app-shell caching. Auto-reloads once when a new deploy's service
// worker takes over, so people always land on the latest app.js instead of a stale cached copy
// (the previous behavior — no reload on update — is why a fresh deploy could still "not show up"
// until a manual hard-refresh).
if ("serviceWorker" in navigator) {
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swRefreshing) return;
    swRefreshing = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((err) => console.warn("service worker not registered:", err));
  });
}

/* ---------- Toasts: small, non-blocking alerts instead of the browser's native alert() ---------- */
function toast(message, type) {
  const stack = document.getElementById("toastStack");
  if (!stack) { console.log(message); return; }
  const icon = type === "error" ? "fa-circle-exclamation" : type === "success" ? "fa-circle-check" : type === "warn" ? "fa-triangle-exclamation" : "fa-circle-info";
  const node = document.createElement("div");
  node.className = "toast" + (type ? " " + type : "");
  node.innerHTML = `<i class="fa-solid ${icon}"></i><span></span><button type="button" class="toast-close" aria-label="Close">&times;</button>`;
  node.querySelector("span").textContent = message;
  node.querySelector(".toast-close").onclick = () => node.remove();
  stack.appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

/* ---------- Idle auto sign-out: warns after 20 minutes of no activity, signs out after 25 —
   important on shared lab workstations so a session doesn't stay open indefinitely. ---------- */
(function setupIdleTimeout() {
  const WARN_AFTER_MS = 20 * 60 * 1000, LOGOUT_AFTER_MS = 25 * 60 * 1000;
  let warnTimer = null, logoutTimer = null, modalEl = null;
  function clearModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
  function showWarning() {
    if (modalEl) return;
    modalEl = document.createElement("div");
    modalEl.className = "idle-modal-backdrop";
    modalEl.innerHTML = `<div class="idle-modal"><i class="fa-solid fa-clock"></i><h3>Still there?</h3><p>You've been idle a while — you'll be signed out soon for security.</p><button type="button" class="btn primary" id="idleStayBtn">I'm still here</button></div>`;
    document.body.appendChild(modalEl);
    document.getElementById("idleStayBtn").onclick = resetIdleTimer;
  }
  function resetIdleTimer() {
    clearModal();
    if (warnTimer) clearTimeout(warnTimer);
    if (logoutTimer) clearTimeout(logoutTimer);
    if (!auth.currentUser) return;
    warnTimer = setTimeout(showWarning, WARN_AFTER_MS);
    logoutTimer = setTimeout(() => { if (auth.currentUser) auth.signOut(); }, LOGOUT_AFTER_MS);
  }
  ["mousemove", "keydown", "click", "touchstart", "scroll"].forEach((evt) => document.addEventListener(evt, resetIdleTimer, { passive: true }));
  auth.onAuthStateChanged((user) => { if (user) resetIdleTimer(); else { if (warnTimer) clearTimeout(warnTimer); if (logoutTimer) clearTimeout(logoutTimer); clearModal(); } });
})();

/* Pure calculation helpers (unit conversion, date math, rounding — normalizeUnitName, daysUntil,
   addMonths, statusOf, round4, toBaseQty, maxQtyInUnit, unitOptionsForItem, UNITS) now live in
   calc.cjs, loaded just before this file. Kept as a separate file so they're unit-testable in
   isolation (see /tests/calc.test.js) without dragging in Firebase/DOM — nothing about how they're
   called from here changed, they're still plain globals. */
const CATEGORIES = ["Reagents", "Calibrators", "Controls", "Blood samples", "Sera", "Culture media", "Chemicals", "Other"];

const STATUS_STYLES = {
  expired: { bg: "#fdeceb", border: "#e5484d", text: "#c62828", dot: "#e5484d", label: "Expired" },
  soon:    { bg: "#fef3e2", border: "#f5a524", text: "#a5680a", dot: "#f5a524", label: "Expiring soon" },
  watch:   { bg: "#eef0fb", border: "#3b6fe0", text: "#2451c9", dot: "#3b6fe0", label: "Watch" },
  ok:      { bg: "#eef6e3", border: "#7cb342", text: "#4e7a24", dot: "#7cb342", label: "OK" },
  none:    { bg: "#f1f2f6", border: "#c3c8d3", text: "#5b6472", dot: "#9aa3b0", label: "No date" },
};
const CHART_PALETTE = ["#3b6fe0", "#7cb342", "#f5a524", "#e5484d", "#8e5cd9", "#2f6fd1", "#00897b", "#c2185b"];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowStr = () => new Date().toISOString().slice(0, 16).replace("T", " ");
function formatBytes(n) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

function statusBadgeText(s) {
  const st = STATUS_STYLES[s.key];
  if (s.key === "none") return st.label;
  if (s.key === "expired") return `${st.label} · ${Math.abs(s.days)}d ago`;
  return `${st.label} · in ${s.days}d`;
}
function badgeHtml(s) {
  const st = STATUS_STYLES[s.key];
  return `<span class="badge" style="background:${st.bg};color:${st.text};border-color:${st.border}">${statusBadgeText(s)}</span>`;
}
/**
 * Suggests a "tests per unit" value by reading the number that precedes "TEST" in the item name
 * (e.g. "...Reagent KIT/ 100 TEST" -> 100, "...Reagent CART/300 TEST" -> 300). The two naming
 * conventions mean different things: a "KIT" name usually states the TOTAL tests for the whole
 * box (which may bundle more than one cartridge — divide by units-per-box to get the per-unit
 * figure), while a "CART" (cartridge) name already states the per-unit figure directly (multiply
 * by units-per-box to get the box total). Returns null if no number could be found in the name.
 * This is only ever a *suggestion* — the user can and should double check it.
 */
function suggestTestsPerUnit(name, unitsPerBox) {
  const m = /(\d+)\s*test\b/i.exec(name || "");
  if (!m) return null;
  const n = Number(m[1]);
  const upb = Number(unitsPerBox) || 1;
  if (/\bkit\b/i.test(name) && upb > 1) return Math.round(n / upb);
  return n;
}
/** Suggests a Unit from the item name: "CART" -> Cartridge (each unit is one cartridge),
 *  "Reagent"/"KIT" -> KIT. Returns null if nothing recognizable is found. */
function suggestUnit(name) {
  if (/\bcart\b/i.test(name || "")) return "Cartridge";
  if (/reagent|\bkit\b/i.test(name || "")) return "KIT";
  return null;
}
/** Suggests a Category from an internal Item Number prefix: CAL... -> Calibrators,
 *  CTRL... -> Controls, RGT... -> Reagents. Returns null if the prefix isn't recognized. */
function suggestCategoryFromItemNumber(itemNumber) {
  const s = String(itemNumber || "").trim().toUpperCase();
  if (s.startsWith("CAL")) return "Calibrators";
  if (s.startsWith("CTRL")) return "Controls";
  if (s.startsWith("RGT")) return "Reagents";
  return null;
}
/* ---------------------------------------------------------------------
   GS1 barcode parsing (DataMatrix / GS1-128 labels like Beckman reagent boxes)
   A scanned label like (01)15099590575229(11)250831(17)260831(10)572239
   arrives from the scanner as one continuous string. This pulls out the
   GTIN (01) — the constant "Item ID" for the product — plus the lot (10),
   expiry (17) and production date (11), so the same product is recognized
   across different lots/expiries instead of being treated as a new item.
--------------------------------------------------------------------- */
function parseGS1(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^[\x1D\x04]+/, ""); // strip leading FNC1/control chars some scanners prepend
  const GS = "\u001D";
  const FIXED = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2, "31": 10, "32": 10 };
  const result = {};
  let i = 0;
  while (i < s.length) {
    const ai = s.substr(i, 2);
    if (!/^[0-9]{2}$/.test(ai)) break;
    i += 2;
    if (FIXED[ai] !== undefined) {
      result[ai] = s.substr(i, FIXED[ai]);
      i += FIXED[ai];
    } else {
      let end = s.indexOf(GS, i);
      if (end === -1) end = s.length;
      result[ai] = s.substring(i, end);
      i = end + (s[end] === GS ? 1 : 0);
    }
  }
  if (!result["01"]) return null;
  const toDate = (yymmdd) => {
    if (!yymmdd || yymmdd.length !== 6) return "";
    const yy = yymmdd.slice(0, 2), mm = yymmdd.slice(2, 4), dd = yymmdd.slice(4, 6);
    const yyyy = (Number(yy) <= 49 ? "20" : "19") + yy;
    return `${yyyy}-${mm}-${dd}`;
  };
  return { gtin: result["01"], lot: result["10"] || "", expiry: toDate(result["17"]), prodDate: toDate(result["11"]) };
}
/** Info about a raw scan: which catalog item it matches (by GTIN or plain barcode) plus any lot/expiry it carries. */
function scanInfo(raw) {
  const c = (raw || "").trim();
  if (!c) return { code: "", gtin: "", lot: "", expiry: "", item: null };
  const parsed = parseGS1(c);
  const gtin = parsed ? parsed.gtin : c;
  const item = findByBarcode(c);
  return { code: c, gtin, lot: parsed ? parsed.lot : "", expiry: parsed ? parsed.expiry : "", item };
}
function downloadCSV(filename, headers, rows) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------
   State
--------------------------------------------------------------------- */
const el = (id) => document.getElementById(id);
const state = {
  user: null, role: null, myBranchId: null, managedBranchId: null,
  fridges: [], catalog: [], batches: [], logs: [], merges: [], allowed: [], branches: [], transfers: [], reconciliations: [], orderRequests: [], inventoryCounts: [], assignedTasks: [], instruments: [], lotVerifications: [], lotToLotTasks: [], epProjects: [], precisionRuns: [], accuracyRuns: [], comparisonRuns: [], multiComparisonRuns: [], qualPrecisionRuns: [], qualComparisonRuns: [], referenceIntervalRuns: [], linearityRuns: [], methodValidationSummaryRuns: [], sensitivityRuns: [], carryoverRuns: [], interferenceRuns: [], cvLimits: [], monthlyQcEntries: [], chats: [], dms: [], shiftEndorsements: [], auditLog: [], documents: [],
  ui: { view: "dashboard", activeFridge: "all", query: "", chatContact: null },
  unsub: [],
};

/* ---------------------------------------------------------------------
   Auth
--------------------------------------------------------------------- */
el("showSignup").onclick = () => { el("loginForm").hidden = true; el("signupForm").hidden = false; };
el("showLogin").onclick = () => { el("signupForm").hidden = true; el("loginForm").hidden = false; };

el("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("authError").hidden = true;
  try { await auth.signInWithEmailAndPassword(el("loginEmail").value.trim(), el("loginPassword").value); }
  catch (err) { el("authError").textContent = translateAuthError(err); el("authError").hidden = false; }
});
el("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("signupError").hidden = true;
  try { await auth.createUserWithEmailAndPassword(el("signupEmail").value.trim(), el("signupPassword").value); }
  catch (err) { el("signupError").textContent = translateAuthError(err); el("signupError").hidden = false; }
});
el("logoutFromPending").onclick = () => auth.signOut();
el("btnLogout").onclick = () => auth.signOut();

function translateAuthError(err) {
  const map = {
    "auth/invalid-email": "Invalid email format.",
    "auth/user-not-found": "No account exists with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "This email is already registered — log in instead.",
    "auth/weak-password": "Password is too weak (min. 6 characters).",
    "auth/requires-recent-login": "For security, please log out and log back in before changing your password.",
  };
  return map[err.code] || "An unexpected error occurred. Please try again.";
}

auth.onAuthStateChanged(async (user) => {
  cleanupListeners();
  if (!user) { showScreen("auth"); return; }
  state.user = user;
  if (user.email === MASTER_EMAIL) { state.role = "master"; startApp(); return; }
  try {
    const doc = await db.collection("allowedEmails").doc(user.email).get();
    if (doc.exists) {
      state.role = doc.data().role || "user";
      state.myBranchId = doc.data().branchId || null;
      startApp();
    } else {
      el("pendingEmail").textContent = user.email;
      showScreen("pending");
    }
  } catch (e) {
    el("pendingEmail").textContent = user.email;
    showScreen("pending");
  }
});

function showScreen(name) {
  el("authScreen").hidden = name !== "auth";
  el("notAuthorizedScreen").hidden = name !== "pending";
  el("appShell").hidden = name !== "app";
}

/* ---------------------------------------------------------------------
   Realtime listeners
--------------------------------------------------------------------- */
function cleanupListeners() {
  state.unsub.forEach((fn) => fn());
  state.unsub = [];
  if (state.notifTimer) { clearInterval(state.notifTimer); state.notifTimer = null; }
}

function startApp() {
  showScreen("app");
  el("userRoleBadge").textContent = state.role === "master" ? "Master" : "User";
  el("userRoleBadge").className = "role-badge" + (state.role === "master" ? " master" : "");
  el("btnUsers").hidden = state.role !== "master";
  el("btnBranches").hidden = state.role !== "master";
  el("navAuditLog").hidden = state.role !== "master";
  updateUserChip();

  const listen = (col, arrKey, after, applyQuery) => {
    const base = db.collection(col);
    const ref = applyQuery ? applyQuery(base) : base;
    const unsub = ref.onSnapshot((snap) => {
      state[arrKey] = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      if (after) after();
      renderView();
      renderFridgeSidebar();
      renderNotifBadge();
      renderChatNavBadge();
      renderTodoNavBadge();
    }, (err) => console.error(col, err));
    state.unsub.push(unsub);
  };
  const scope = myBranchScope();
  const scoped = (q) => (scope ? q.where("branchId", "==", scope) : q);
  listen("fridges", "fridges", null, scoped);
  listen("catalog", "catalog"); // shared across all branches on purpose — see myBranchScope()
  listen("batches", "batches", null, scoped);
  listen("logs", "logs", null, scoped);
  listen("merges", "merges", null, scoped);
  listen("transfers", "transfers");
  listen("reconciliations", "reconciliations", null, scoped);
  listen("orderRequests", "orderRequests", null, scoped);
  listen("inventoryCounts", "inventoryCounts", null, scoped);
  listen("assignedTasks", "assignedTasks");
  listen("instruments", "instruments", null, scoped);
  listen("lotVerifications", "lotVerifications", null, scoped);
  listen("lotToLotTasks", "lotToLotTasks", null, scoped);
  listen("epProjects", "epProjects", null, scoped);
  listen("precisionRuns", "precisionRuns", null, scoped);
  listen("accuracyRuns", "accuracyRuns", null, scoped);
  listen("comparisonRuns", "comparisonRuns", null, scoped);
  listen("multiComparisonRuns", "multiComparisonRuns", null, scoped);
  listen("qualPrecisionRuns", "qualPrecisionRuns", null, scoped);
  listen("qualComparisonRuns", "qualComparisonRuns", null, scoped);
  listen("referenceIntervalRuns", "referenceIntervalRuns", null, scoped);
  listen("linearityRuns", "linearityRuns", null, scoped);
  listen("methodValidationSummaryRuns", "methodValidationSummaryRuns", null, scoped);
  listen("sensitivityRuns", "sensitivityRuns", null, scoped);
  listen("carryoverRuns", "carryoverRuns", null, scoped);
  listen("interferenceRuns", "interferenceRuns", null, scoped);
  // Monthly QC / CV Monitoring: cvLimits is the shared "Acceptable CV%" reference table (an
  // Analyzer+Analyte lookup, same as the catalog) so every branch checks against the same
  // approved limits; monthlyQcEntries is each branch's actual monthly results and is scoped.
  listen("cvLimits", "cvLimits");
  listen("monthlyQcEntries", "monthlyQcEntries", null, scoped);
  // Branch Chat is deliberately NOT scoped server-side — a message can be a broadcast to every
  // branch or targeted at one specific branch, so visibility is filtered per-message inside
  // renderChatView() instead of by a single Firestore "branchId ==" query.
  listen("branchChats", "chats");
  // Direct messages (1-to-1, WhatsApp-style) between two employees. Firestore security only lets
  // each account read messages where it's the sender or the recipient (master reads all), so a
  // single unfiltered query won't work for regular users — we merge two queries instead.
  setupDmListeners();
  // Shift handover notes stay branch-scoped like the rest of the data (each branch only sees its
  // own shift log; master sees all of them).
  listen("shiftEndorsements", "shiftEndorsements", null, scoped);
  listen("branches", "branches", () => {
    const managed = state.branches.find((b) => b.managerEmail === state.user.email);
    state.managedBranchId = managed ? managed.id : null;
    updateUserChip();
  });
  // Every authorized account (not just master) needs this list now, so that "Performed By" /
  // "Reviewed By" on forms like Lot to Lot can offer real employee names to pick from.
  // firestore.rules already allows any authorized user to read allowedEmails.
  listen("allowedEmails", "allowed");
  // Immutable admin audit trail — only Master can read it (firestore.rules), so only fetch it
  // for Master; a regular account querying it would just get an empty, permission-denied read.
  if (state.role === "master") listen("auditLog", "auditLog", null, (q) => q.orderBy("clientAt", "desc").limit(500));

  el("btnNotifications").onclick = toggleNotifPanel;

  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.onclick = () => navigateTo(btn.dataset.view);
  });

  // Keep nagging every few minutes (sound + WhatsApp-style toast) while there's something
  // unseen — chat messages, shift-handover endorsements waiting on you, low stock, expiring
  // items, PM due, or incoming transfers — until the person actually opens the bell or the chat.
  if (state.notifTimer) clearInterval(state.notifTimer);
  state.notifTimer = setInterval(() => {
    const count = computeNotifCount();
    if (count > 0 && count > notifSeenCount()) { playNotifSound(); showNotifToast(count); }
    syncRevalidationTasks();
  }, 10 * 60 * 1000);
  setTimeout(syncRevalidationTasks, 5000); // once shortly after login, after snapshots have had time to populate

  renderView();
}

function setupDmListeners() {
  const email = state.user.email;
  const after = () => { renderView(); renderFridgeSidebar(); renderNotifBadge(); renderChatNavBadge(); renderTodoNavBadge(); };
  if (state.role === "master") {
    const unsub = db.collection("directMessages").onSnapshot((snap) => {
      state.dms = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      after();
    }, (err) => console.error("directMessages", err));
    state.unsub.push(unsub);
    return;
  }
  let fromMine = [], toMine = [];
  const merge = () => {
    const map = new Map();
    [...fromMine, ...toMine].forEach((m) => map.set(m.id, m));
    state.dms = [...map.values()];
    after();
  };
  const unsub1 = db.collection("directMessages").where("fromEmail", "==", email).onSnapshot((snap) => {
    fromMine = snap.docs.map((d) => ({ ...d.data(), id: d.id })); merge();
  }, (err) => console.error("directMessages(from)", err));
  const unsub2 = db.collection("directMessages").where("toEmail", "==", email).onSnapshot((snap) => {
    toMine = snap.docs.map((d) => ({ ...d.data(), id: d.id })); merge();
  }, (err) => console.error("directMessages(to)", err));
  state.unsub.push(unsub1, unsub2);
}

const QR_EVALUATOR_VIEWS = ["epHome", "epProject", "precision", "accuracy", "comparison", "multiComparison", "qualPrecision", "qualComparison", "referenceInterval", "linearity", "methodValidationSummary", "analyticalSensitivity", "carryover", "interference", "epTools", "inrCalc"];
function navigateTo(view) {
  state.ui.view = view;
  document.querySelectorAll(".nav-link").forEach((b) => {
    const isEpNav = b.dataset.view === "epHome";
    b.classList.toggle("active", isEpNav ? QR_EVALUATOR_VIEWS.includes(view) : b.dataset.view === view);
  });
  renderView();
}

function updateUserChip() {
  const branch = state.branches.find((b) => b.id === state.myBranchId);
  const managed = state.branches.find((b) => b.id === state.managedBranchId);
  const extra = managed ? ` · Manager of ${esc(managed.name)}` : (branch ? ` · ${esc(branch.name)}` : "");
  el("userEmailLabel").innerHTML = `${esc(state.user.email)}<span style="color:var(--text-faint)">${extra}</span>`;
}

/* ---------------------------------------------------------------------
   Lookups
--------------------------------------------------------------------- */
function catalogById(id) { return state.catalog.find((c) => c.id === id); }
/* unitOptionsForItem, toBaseQty, maxQtyInUnit, round4 now live in calc.cjs (loaded before this file) */
function fridgeName(id) { return state.fridges.find((f) => f.id === id)?.name || "—"; }
function fridgeBranchId(id) { return state.fridges.find((f) => f.id === id)?.branchId || null; }
/** Finds an existing batch that's identical in every way that matters (item, fridge, lot, expiry) so
 *  receiving more of the same thing adds to it instead of creating a duplicate row. */
function findMatchingBatch(catalogItemId, fridgeId, lot, expiry) {
  return state.batches.find((b) => b.catalogItemId === catalogItemId && b.fridgeId === fridgeId && (b.lot || "") === (lot || "") && (b.expiry || "") === (expiry || ""));
}
function branchName(id) { return state.branches.find((b) => b.id === id)?.name || "—"; }
/** Display name for whoever performed an action, looked up from the allowedEmails record for
 *  that address (set in Users → the "Name" field). Falls back to the raw email when no name is
 *  on file yet, so nothing is ever left blank. */
function nameForEmail(email) {
  if (!email) return "—";
  const u = (state.allowed || []).find((a) => (a.email || "").toLowerCase() === email.toLowerCase());
  return (u && u.name && u.name.trim()) ? u.name.trim() : email;
}
/** Which branch's fridges/batches this signed-in user should see. Master sees everything (returns null
 *  = "no filter"). Everyone else is scoped to their own assigned branch — this is what keeps each
 *  branch's fridge units and stock completely separate from every other branch's. The shared catalog
 *  (product definitions + barcodes) is intentionally NOT scoped by this, so a barcode already known to
 *  one branch is recognized in every other branch without recreating it. */
function myBranchScope() { return state.role === "master" ? null : (state.myBranchId || null); }
/** The branch this signed-in user should see incoming transfers for (their managed branch, or their assigned branch). Master sees everything, so this returns null for master (meaning "no filter"). */
function myReceivingBranchId() {
  if (state.role === "master") return null;
  return state.managedBranchId || state.myBranchId || null;
}
function pendingTransfersForMe() {
  const mine = myReceivingBranchId();
  return state.transfers.filter((t) => t.status === "pending" && (state.role === "master" || t.toBranchId === mine));
}
function soonExpiringBatches() {
  return state.batches.filter((b) => ["expired", "soon"].includes(statusOf(b.expiry).key));
}
/* ---- WhatsApp-style contacts: each is either the "All Branches" group, a branch channel, or a
   1-to-1 direct message with a specific colleague. Unread tracking is per-contact (per-thread),
   same as WhatsApp, not one global "seen" timestamp for the whole chat feature. ---- */
function threadKey(contact) { return contact.type + ":" + contact.id; }
function threadSeenAt(contact) { try { return localStorage.getItem("df_chat_seen_" + state.user.email + "_" + threadKey(contact)) || ""; } catch (e) { return ""; } }
function markThreadSeen(contact, at) { try { localStorage.setItem("df_chat_seen_" + state.user.email + "_" + threadKey(contact), at); } catch (e) { /* storage unavailable */ } }
/** Messages are ordered/stamped by the Firestore server clock (createdAt), not the sender's device
 *  clock — a phone or PC with the wrong time was the cause of messages showing up out of sequence
 *  or seeming to "arrive late". clientAt is only a same-tick fallback for the brief moment before
 *  the server confirms the write (serverTimestamp() reads back as null until then). */
function chatTimeIso(m) {
  if (m.createdAt && typeof m.createdAt.toDate === "function") return m.createdAt.toDate().toISOString();
  return m.clientAt || "";
}
function sortByChatTime(list) { return list.slice().sort((a, b) => chatTimeIso(a).localeCompare(chatTimeIso(b))); }

function groupMessages() { return sortByChatTime(state.chats.filter((m) => !m.toBranchId)); }
/** Messages exchanged specifically with one branch. A branch's own team (branchId === myBranch)
 *  also picks up anything Master targeted straight at that branch, since Master has no branch. */
function branchThreadMessages(branchId) {
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const isMaster = state.role === "master";
  return sortByChatTime(state.chats.filter((m) => {
    if (!m.toBranchId) return false; // broadcasts live in the group thread only
    if (isMaster) return m.fromBranchId === branchId || m.toBranchId === branchId;
    if (branchId === myBranch) return m.toBranchId === myBranch && (m.fromBranchId === myBranch || m.fromBranchId == null);
    return (m.fromBranchId === myBranch && m.toBranchId === branchId) || (m.fromBranchId === branchId && m.toBranchId === myBranch);
  }));
}
function dmThreadMessages(otherEmail) {
  const me = state.user.email;
  return sortByChatTime(state.dms.filter((m) => (m.fromEmail === me && m.toEmail === otherEmail) || (m.fromEmail === otherEmail && m.toEmail === me)));
}
function messagesForContact(contact) {
  if (contact.type === "group") return groupMessages();
  if (contact.type === "branch") return branchThreadMessages(contact.id);
  if (contact.type === "dm") return dmThreadMessages(contact.id);
  return [];
}
function threadUnread(contact) {
  const seen = threadSeenAt(contact);
  return messagesForContact(contact).filter((m) => m.fromEmail !== state.user.email && chatTimeIso(m) > seen);
}
function initials(name) {
  const parts = (name || "?").trim().split(/\s+/);
  return (((parts[0] || "")[0] || "") + ((parts[1] || "")[0] || "")).toUpperCase() || "?";
}
function avatarColor(seed) {
  const palette = ["#3b6fe0", "#7cb342", "#f5a524", "#e5484d", "#2451c9", "#00897b", "#8e24aa", "#546e7a", "#c62828", "#00acc1"];
  let h = 0; for (let i = 0; i < (seed || "").length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function fmtChatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return iso.slice(11, 16);
  return iso.slice(5, 10);
}
/** Every "contact" a person can open a conversation with: the All-Branches group first, then every
 *  branch channel, then every colleague for direct messages — sorted (after the pinned group) by
 *  most recent activity, same ordering WhatsApp uses. */
function buildChatContacts() {
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const isMaster = state.role === "master";
  const myEmail = state.user.email;
  const contacts = [{ type: "group", id: "group", name: "All Branches", subtitle: "Broadcast to everyone" }];
  state.branches.forEach((b) => {
    const isMine = !isMaster && b.id === myBranch;
    contacts.push({ type: "branch", id: b.id, name: isMine ? b.name + " (Your team)" : b.name, subtitle: isMine ? "Internal team channel" : "Branch channel" });
  });
  state.allowed.filter((u) => u.id !== myEmail).forEach((u) => {
    contacts.push({ type: "dm", id: u.id, name: (u.name && u.name.trim()) ? u.name.trim() : u.id, subtitle: u.id });
  });
  if (!isMaster && myEmail !== MASTER_EMAIL && !state.allowed.some((u) => u.id === MASTER_EMAIL)) {
    contacts.push({ type: "dm", id: MASTER_EMAIL, name: "Master", subtitle: MASTER_EMAIL });
  }
  const [group, ...rest] = contacts;
  rest.sort((a, b) => {
    const la = messagesForContact(a), lb = messagesForContact(b);
    const ta = la.length ? chatTimeIso(la[la.length - 1]) : "", tb = lb.length ? chatTimeIso(lb[lb.length - 1]) : "";
    return tb.localeCompare(ta);
  });
  return [group, ...rest];
}
/** Flat list of every unread message across every thread (group + branch channels + DMs) — used
 *  for the notification bell count/list and the nav badge, same as before but thread-aware now. */
function unreadChatMessages() {
  return buildChatContacts().flatMap((c) => threadUnread(c));
}
function renderChatNavBadge() {
  const badge = el("chatNavBadge");
  if (!badge) return;
  const count = unreadChatMessages().length;
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
}
/** Badge on the "To Do" nav link — count of pending tasks (currently just Lot-to-Lot verification
 *  tasks auto-created on a reagent lot switch, but written to hold future task types too). */
function renderTodoNavBadge() {
  const badge = el("todoNavBadge");
  if (!badge) return;
  const count = pendingLotToLotTasks().length + tasksVisibleToMe().filter((t) => !isAssignedTaskDoneForMe(t)).length;
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
}
function computeNotifCount() {
  return pendingTransfersForMe().length + soonExpiringBatches().length + itemsBelowSafetyLimit().length
    + instrumentsPmDueSoon().length + unreadChatMessages().length + unacknowledgedEndorsementsForMe().length + pendingLotToLotTasks().length
    + tasksVisibleToMe().filter((t) => !isAssignedTaskDoneForMe(t)).length;
}
function notifSeenCount() { return Number(localStorage.getItem("df_notif_seen") || 0); }
function markNotifSeen(count) { try { localStorage.setItem("df_notif_seen", String(count)); } catch (e) { /* storage unavailable */ } }
/** Plays a short, distinctive rising three-tone chime for new alerts — louder and more present than
 *  a plain beep so it's actually noticeable over background noise, and recognizable as "Delta
 *  Fridge" without needing an audio file. */
function playNotifSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!state.audioCtx) state.audioCtx = new Ctx();
    const ctx = state.audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
    [[660, 0, 0.16, 0.5, "triangle"], [880, 0.13, 0.16, 0.55, "triangle"], [1180, 0.26, 0.32, 0.5, "sine"]].forEach(([freq, delay, dur, vol, type]) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = type; osc.frequency.value = freq;
      const start = now + delay;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(gain); gain.connect(master);
      osc.start(start); osc.stop(start + dur + 0.02);
    });
  } catch (e) { /* audio not available — silently ignore */ }
}
/** WhatsApp-style floating alert bubble, bottom-right, that appears on its own (not just when the
 *  bell is clicked) and keeps re-appearing every few minutes until the person actually opens the
 *  notification panel — see the periodic check wired up in init(). */
function showNotifToast(count) {
  const existing = document.getElementById("notifToast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "notifToast";
  toast.className = "notif-toast";
  toast.innerHTML = `<div class="notif-toast-icon"><i class="fa-solid fa-bell"></i></div>
    <div><div class="notif-toast-title">${count} alert${count === 1 ? "" : "s"} need your attention</div>
    <div class="notif-toast-sub">Low stock, expiring items, PM due, or incoming transfers — tap to view</div></div>
    <button type="button" class="notif-toast-close" aria-label="Dismiss">&times;</button>`;
  document.body.appendChild(toast);
  toast.onclick = (e) => {
    if (e.target.closest(".notif-toast-close")) { toast.remove(); return; }
    toast.remove();
    if (!document.getElementById("notifPanel")) toggleNotifPanel();
  };
  setTimeout(() => { if (document.getElementById("notifToast") === toast) toast.remove(); }, 9000);
}
function renderNotifBadge() {
  const badge = el("notifBadge");
  const count = computeNotifCount();
  // Once the panel's been opened for the current count, the red badge clears too — same
  // "seen" threshold already used to stop the toast/sound nagging (see markNotifSeen).
  // It reappears only once something genuinely new pushes the count past what was last seen.
  const unseen = count > notifSeenCount() ? count : 0;
  if (badge) { badge.hidden = unseen === 0; badge.textContent = unseen > 99 ? "99+" : String(unseen); }
  if (count > 0 && count > notifSeenCount() && count !== state.ui.lastAnnouncedCount) {
    playNotifSound();
    showNotifToast(count);
  }
  state.ui.lastAnnouncedCount = count;
}
function toggleNotifPanel() {
  const existing = document.getElementById("notifPanel");
  if (existing) { existing.remove(); return; }
  const transfers = pendingTransfersForMe();
  const expiring = soonExpiringBatches();
  const panel = document.createElement("div");
  panel.id = "notifPanel";
  panel.className = "notif-panel";
  const items = [];
  unreadChatMessages().forEach((m) => items.push(`<button class="notif-item" data-goto="chat"><i class="fa-solid fa-comment-dots"></i> ${esc(m.fromEmail)}: ${esc((m.text || "").slice(0, 60))}${(m.text || "").length > 60 ? "…" : ""}</button>`));
  unacknowledgedEndorsementsForMe().forEach((s) => items.push(`<button class="notif-item" data-goto="shiftHandover"><i class="fa-solid fa-right-left"></i> Shift handover from ${esc(s.fromEmployee || "—")} needs your acknowledgement</button>`));
  transfers.forEach((t) => items.push(`<button class="notif-item" data-goto="transfers"><i class="fa-solid fa-truck-fast"></i> Incoming: ${esc(t.itemName)} (${t.quantity}) from ${esc(t.fromBranchName || "—")}</button>`));
  expiring.forEach((b) => {
    const cat = catalogById(b.catalogItemId);
    const s = statusOf(b.expiry);
    items.push(`<button class="notif-item" data-goto="inventory"><i class="fa-solid fa-hourglass-half"></i> ${esc(cat ? cat.name : "(deleted item)")} — ${statusBadgeText(s)}</button>`);
  });
  itemsBelowSafetyLimit().forEach((c) => {
    items.push(`<button class="notif-item" data-goto="reorder"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(c.name)} — below safety limit (${totalStockFor(c.id)} / ${c.safetyLimit} ${esc(c.unit)})</button>`);
  });
  instrumentsPmDueSoon().forEach((i) => {
    const s = pmStatusOf(i.nextPmDate);
    items.push(`<button class="notif-item" data-goto="instruments"><i class="fa-solid fa-microscope"></i> ${esc(i.name)} — PM ${s.key === "expired" ? "overdue by " + Math.abs(s.days) + "d" : "due in " + s.days + "d"}</button>`);
  });
  pendingLotToLotTasks().forEach((t) => {
    if (t.kind === "revalidation") {
      items.push(`<button class="notif-item" data-goto="todo"><i class="fa-solid fa-calendar-check"></i> ${esc(t.itemName)} — annual revalidation ${daysUntil(t.dueDate) < 0 ? "overdue" : "due"} (${esc(t.dueDate)})</button>`);
    } else {
      items.push(`<button class="notif-item" data-goto="todo"><i class="fa-solid fa-flask-vial"></i> ${esc(t.itemName)} — lot changed ${esc(t.oldLot)} → ${esc(t.newLot)}, Lot-to-Lot verification required</button>`);
    }
  });
  tasksVisibleToMe().filter((t) => !isAssignedTaskDoneForMe(t)).forEach((t) => {
    const rec = taskRecurrence(t);
    const tag = rec === "daily" ? " (daily)" : rec === "monthly" ? " (monthly)" : "";
    const overdueTag = taskIsOverdue(t) ? " — overdue" : "";
    items.push(`<button class="notif-item" data-goto="todo"><i class="fa-solid fa-list-check"></i> Task: ${esc(t.title)}${tag}${overdueTag} — from ${esc(nameForEmail(t.createdBy))}</button>`);
  });
  panel.innerHTML = items.length ? items.join("") + `<div class="notif-item" style="cursor:default;text-align:center;color:var(--text-dim);font-size:11px">✓ Seen — won't ping again until something new comes up</div>` : `<div class="notif-item" style="cursor:default">No notifications right now.</div>`;
  document.body.appendChild(panel);
  const toast = document.getElementById("notifToast"); if (toast) toast.remove();
  markNotifSeen(computeNotifCount()); // opening the panel counts as "viewed it" — stops the nagging until a new alert appears
  renderNotifBadge(); // clear the red badge right away too, instead of waiting for the next unrelated re-render
  panel.querySelectorAll("[data-goto]").forEach((b) => b.onclick = () => { navigateTo(b.dataset.goto); panel.remove(); });
  setTimeout(() => {
    document.addEventListener("click", function onDocClick(e) {
      if (!panel.contains(e.target) && e.target.id !== "btnNotifications" && !e.target.closest("#btnNotifications")) { panel.remove(); document.removeEventListener("click", onDocClick); }
    });
  }, 0);
}
function findByBarcode(code) {
  const c = (code || "").trim();
  if (!c) return null;
  // 1) exact match (covers plain GTIN scans, or manually typed codes)
  let m = state.catalog.find((x) => x.barcode && x.barcode === c);
  if (m) return m;
  // 2) GS1-formatted scan (full DataMatrix incl. lot/expiry) — match on the GTIN (01) only
  const parsed = parseGS1(c);
  if (parsed && parsed.gtin) {
    m = state.catalog.find((x) => x.barcode && x.barcode === parsed.gtin);
    if (m) return m;
  }
  return null;
}
/** Finds a stock batch by its own generated label barcode (see getOrCreateBatchBarcode) — used only
 *  during Dispense, so the internal "LOT" code printed on a re-labeled container pulls from that exact
 *  lot instead of just the product. It is separate from findByBarcode/catalog barcodes on purpose:
 *  scanning it during Addition must NOT be mistaken for a manufacturer barcode. */
function findBatchByBarcode(code) {
  const c = (code || "").trim();
  if (!c) return null;
  return state.batches.find((b) => b.barcode && b.barcode === c) || null;
}
function itemsInStock() {
  const ids = new Set(state.batches.map((b) => b.catalogItemId));
  return state.catalog.filter((c) => ids.has(c.id));
}
/** Total quantity currently on hand for one catalog item, summed across every batch/lot/fridge
 *  (already stored in the item's base unit — see toBaseQty). Used by the Safety Limit indicator
 *  and the Reorder List. */
function totalStockFor(catalogItemId) {
  return round4(state.batches.filter((b) => b.catalogItemId === catalogItemId).reduce((sum, b) => sum + (Number(b.quantity) || 0), 0));
}
/** Same as totalStockFor but scoped to one branch's own batches — lets each branch see whether
 *  its own on-hand stock (not the org-wide total) has fallen below the item's Safety Limit. */
function totalStockForBranch(catalogItemId, branchId) {
  if (!branchId) return totalStockFor(catalogItemId);
  return round4(state.batches.filter((b) => b.catalogItemId === catalogItemId && b.branchId === branchId).reduce((sum, b) => sum + (Number(b.quantity) || 0), 0));
}
/** Most recent "in" (received) log for this item — used as the Reorder List's automatic
 *  "Last order" reference instead of a manually-typed field. */
function lastReceivedFor(catalogItemId, branchId) {
  const rows = state.logs.filter((e) => e.catalogItemId === catalogItemId && e.type === "in" && (!branchId || e.branchId === branchId))
    .sort((a, b) => (a.date || "") < (b.date || "") ? 1 : -1);
  return rows[0] || null;
}
/** Catalog items that have a Safety Limit configured and whose current total stock has fallen
 *  below it — the data behind both the Reorder List view and the notification bell. Pass a
 *  branchId to check that one branch's own stock instead of the org-wide total. */
function itemsBelowSafetyLimit(branchId) {
  const stockOf = (id) => branchId ? totalStockForBranch(id, branchId) : totalStockFor(id);
  return state.catalog
    .filter((c) => Number(c.safetyLimit) > 0 && stockOf(c.id) < Number(c.safetyLimit))
    .sort((a, b) => (stockOf(a.id) - Number(a.safetyLimit)) - (stockOf(b.id) - Number(b.safetyLimit)));
}
function batchLabel(b) {
  const cat = catalogById(b.catalogItemId);
  const branch = state.role === "master" ? ` · ${branchName(b.branchId)}` : "";
  return `Lot ${b.lot || "—"} · ${b.quantity} ${cat ? cat.unit : ""} · Exp ${b.expiry || "—"} · ${fridgeName(b.fridgeId)}${branch}`;
}
/** Looks up a lot number against everything already entered into inventory (Addition/Transfers)
 *  and returns its expiry + product name — since it's already known, no need to type it again.
 *  Picks the most recently added batch when the same lot number appears more than once. */
function expiryForLot(lot, branchId) {
  const l = (lot || "").trim();
  if (!l) return null;
  const matches = state.batches.filter((b) => (b.lot || "").trim() === l && (!branchId || b.branchId === branchId));
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.addedAt || "") < (b.addedAt || "") ? 1 : -1);
  const b = matches[0];
  const cat = catalogById(b.catalogItemId);
  return { expiry: b.expiry || "", itemName: cat ? cat.name : "" };
}
/** Total Allowable Error lookup for the Lot-to-Lot form, sourced from window.LOT_REFERENCE
 *  (extracted from the lab's Lot_to_lot.xlsx reference sheet). Matches the FIRST row whose
 *  Analyte equals the typed assay name — same behavior as the original spreadsheet's VLOOKUP. */
function lookupTAE(assayName) {
  const name = (assayName || "").trim().toLowerCase();
  if (!name || !window.LOT_REFERENCE) return null;
  const row = window.LOT_REFERENCE.find((r) => (r[0] || "").trim().toLowerCase() === name);
  if (!row) return null;
  return { fluid: row[1], source: row[2], ref: row[3], threshold: row[4] };
}
/** % Difference + Pass/Reject for one Lot-to-Lot row, same formulas as the spreadsheet:
 *  %Diff = |New−Old| / ((New+Old)/2); Pass when the analyte's threshold fraction > %Diff. */
function lotRowResult(row) {
  const tae = lookupTAE(row.assayLong);
  const n = Number(row.newResult), o = Number(row.oldResult);
  const hasResults = row.newResult !== "" && row.oldResult !== "" && !isNaN(n) && !isNaN(o);
  const pctDiff = hasResults && (n + o) !== 0 ? Math.abs(n - o) / ((n + o) / 2) : null;
  let passed = "";
  if (tae && typeof tae.threshold === "number" && pctDiff !== null) passed = tae.threshold > pctDiff ? "Pass" : "Reject";
  return { tae, pctDiff, passed };
}

/* ---------------------------------------------------------------------
   View dispatcher
--------------------------------------------------------------------- */
function renderView() {
  el("statusLine").textContent = `${state.batches.length} stock batches · ${state.catalog.length} catalog items`;
  const view = state.ui.view;
  if (view === "dashboard") return renderDashboardView();
  if (view === "todo") return renderToDoView();
  if (view === "inventory") return renderInventoryView();
  if (view === "inventoryCount") return renderInventoryCountView();
  if (view === "dispense") return renderDispenseView();
  if (view === "addition") return renderAdditionView();
  if (view === "merge") return renderMergeView();
  if (view === "transfers") return renderTransfersView();
  if (view === "reorder") return renderReorderView();
  if (view === "reconciliation") return renderReconciliationView();
  if (view === "instruments") return renderInstrumentsView();
  if (view === "lotToLot") return renderLotToLotView();
  if (view === "monthlyQc") return renderMonthlyQcView();
  if (view === "epHome") return renderEPHomeView();
  if (view === "epProject") return renderEPProjectView();
  if (view === "epTools") return renderEPToolsView();
  if (view === "inrCalc") return renderInrCalcView();
  if (view === "precision") return renderPrecisionView();
  if (view === "accuracy") return renderAccuracyView();
  if (view === "comparison") return renderComparisonView();
  if (view === "multiComparison") return renderMultiComparisonView();
  if (view === "qualPrecision") return renderQualPrecisionView();
  if (view === "qualComparison") return renderQualComparisonView();
  if (view === "referenceInterval") return renderReferenceIntervalView();
  if (view === "linearity") return renderLinearityView();
  if (view === "methodValidationSummary") return renderMethodValidationSummaryView();
  if (view === "analyticalSensitivity") return renderSensitivityView();
  if (view === "carryover") return renderCarryoverView();
  if (view === "interference") return renderInterferenceView();
  if (view === "catalog") return renderCatalogView();
  if (view === "expired") return renderExpiredView();
  if (view === "damaged") return renderDamagedView();
  if (view === "activity") return renderActivityView();
  if (view === "documents") return renderDocumentsView();
  if (view === "reports") return renderReportsView();
  if (view === "auditLog") return renderAuditLogView();
  if (view === "shiftHandover") return renderShiftHandoverView();
  if (view === "chat") return renderChatView();
}

function renderFridgeSidebar() {
  let html = `<button class="fridge-row ${state.ui.activeFridge === "all" ? "active" : ""}" data-fridge="all">
      <span style="flex:1;text-align:left">All units</span><span class="fridge-count mono">${state.batches.length}</span>
    </button>`;
  state.fridges.forEach((f) => {
    const count = state.batches.filter((b) => b.fridgeId === f.id).length;
    const alert = state.batches.some((b) => b.fridgeId === f.id && ["expired", "soon"].includes(statusOf(b.expiry).key));
    html += `<div>
      <button class="fridge-row ${state.ui.activeFridge === f.id ? "active" : ""}" data-fridge="${f.id}">
        <span style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${alert ? "color:#a5680a" : ""}">${esc(f.name)}</span>
        <span class="fridge-count mono">${count}</span>
      </button>
      <div class="fridge-meta"><span><span class="mono">${esc(f.tempRange || "")}</span> ${f.location ? "· " + esc(f.location) : ""}${state.role === "master" && f.branchId ? " · " + esc(branchName(f.branchId)) : ""}</span>
        <span><button class="tiny-delete" data-edit-fridge="${f.id}" style="color:var(--text-dim)">Edit</button> <button class="tiny-delete" data-del-fridge="${f.id}">Delete</button></span></div>
    </div>`;
  });
  el("fridgeList").innerHTML = html;
  el("fridgeList").querySelectorAll("[data-fridge]").forEach((b) => b.onclick = () => { state.ui.activeFridge = b.dataset.fridge; renderView(); renderFridgeSidebar(); });
  el("fridgeList").querySelectorAll("[data-del-fridge]").forEach((b) => b.onclick = () => deleteFridge(b.dataset.delFridge));
  el("fridgeList").querySelectorAll("[data-edit-fridge]").forEach((b) => b.onclick = () => openFridgeModal(state.fridges.find((f) => f.id === b.dataset.editFridge)));
}

/* ---------------------------------------------------------------------
   DASHBOARD
--------------------------------------------------------------------- */
function renderDashboardView() {
  const counts = { expired: 0, soon: 0, watch: 0, ok: 0 };
  state.batches.forEach((b) => { const k = statusOf(b.expiry).key; if (counts[k] !== undefined) counts[k]++; });

  const kpis = `<div class="kpi-grid">
    <div class="kpi-card kpi-purple" data-nav="inventory"><div class="kpi-icon"><i class="fa-solid fa-boxes-stacked"></i></div><div class="kpi-num">${state.batches.length}</div><div class="kpi-label">Stock batches</div></div>
    <div class="kpi-card kpi-blue" data-nav="inventory"><div class="kpi-icon"><i class="fa-solid fa-snowflake"></i></div><div class="kpi-num">${state.fridges.length}</div><div class="kpi-label">Fridge units</div></div>
    <div class="kpi-card kpi-amber" data-nav="inventory"><div class="kpi-icon"><i class="fa-solid fa-hourglass-half"></i></div><div class="kpi-num">${counts.soon}</div><div class="kpi-label">Expiring within 7 days</div></div>
    <div class="kpi-card kpi-red" data-nav="expired"><div class="kpi-icon"><i class="fa-solid fa-triangle-exclamation"></i></div><div class="kpi-num">${counts.expired}</div><div class="kpi-label">Expired</div></div>
  </div>`;

  const byCat = {};
  state.batches.forEach((b) => { const cat = catalogById(b.catalogItemId); const name = cat ? cat.category || "Other" : "Other"; byCat[name] = (byCat[name] || 0) + 1; });
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const totalCat = catEntries.reduce((s, [, v]) => s + v, 0);
  let donutHtml, legendHtml;
  if (totalCat === 0) {
    donutHtml = `<div style="width:140px;height:140px;border-radius:50%;background:var(--neutral-soft);flex-shrink:0"></div>`;
    legendHtml = `<div class="pick-empty">No stock yet</div>`;
  } else {
    let acc = 0;
    const stops = catEntries.map(([, v], i) => { const pct = (v / totalCat) * 100; const start = acc; acc += pct; return `${CHART_PALETTE[i % CHART_PALETTE.length]} ${start}% ${acc}%`; }).join(", ");
    donutHtml = `<div style="width:140px;height:140px;border-radius:50%;flex-shrink:0;background:conic-gradient(${stops});display:flex;align-items:center;justify-content:center">
      <div style="width:82px;height:82px;border-radius:50%;background:var(--panel);display:flex;flex-direction:column;align-items:center;justify-content:center">
        <div style="font-size:18px;font-weight:700">${totalCat}</div><div style="font-size:10px;color:var(--text-faint)">batches</div></div></div>`;
    legendHtml = catEntries.map(([name, v], i) => `<div class="legend-row"><span class="legend-dot" style="background:${CHART_PALETTE[i % CHART_PALETTE.length]}"></span><span class="legend-name">${esc(name)}</span><span class="legend-val">${v}</span></div>`).join("");
  }

  const maxFridgeCount = Math.max(1, ...state.fridges.map((f) => state.batches.filter((b) => b.fridgeId === f.id).length), 1);
  const barsHtml = state.fridges.length === 0 ? `<div class="pick-empty">No fridge units yet</div>` : state.fridges.map((f) => {
    const c = state.batches.filter((b) => b.fridgeId === f.id).length;
    const pct = Math.round((c / maxFridgeCount) * 100);
    return `<div class="bar-row"><span class="bar-name">${esc(f.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-num mono">${c}</span></div>`;
  }).join("");

  const recent = [...state.logs].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
  const activityHtml = recent.length === 0 ? `<div class="pick-empty">No activity recorded yet</div>` : recent.map((entry) => {
    const cat = catalogById(entry.catalogItemId);
    const isIn = entry.type === "in";
    const isDamage = entry.type === "damage";
    const icon = isIn ? "fa-arrow-down" : isDamage ? "fa-trash-can" : "fa-arrow-up";
    const color = isIn ? "ok" : isDamage ? "expired" : "watch";
    const st = STATUS_STYLES[color];
    return `<div class="activity-row"><div class="activity-icon" style="background:${st.bg};color:${st.text}"><i class="fa-solid ${icon}"></i></div>
      <div class="activity-text"><strong>${isIn ? "Received" : isDamage ? "Damaged" : "Dispensed"}</strong> ${entry.quantity} × ${esc(cat ? cat.name : "(deleted item)")}</div>
      <div class="activity-time mono">${esc(entry.date)}</div></div>`;
  }).join("");

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Dashboard Overview</h2><span class="subtitle">System status &amp; quick inventory statistics</span></div></div>
    <div class="dashboard">
      ${kpis}
      <div class="charts-row">
        <div class="panel-card"><div class="panel-title">Stock by category</div><div class="panel-sub">Distribution of active batches</div>
          <div class="donut-wrap">${donutHtml}<div class="donut-legend">${legendHtml}</div></div></div>
        <div class="panel-card"><div class="panel-title">Stock by fridge unit</div><div class="panel-sub">Number of batches per unit</div>
          <div class="bar-list">${barsHtml}</div></div>
      </div>
      <div class="activity-panel"><div class="panel-title">Recent activity</div><div class="panel-sub">Latest receive, dispense &amp; damage transactions</div>
        <div class="activity-list">${activityHtml}</div></div>
    </div>`;
  el("mainContent").querySelectorAll("[data-nav]").forEach((c) => c.onclick = () => navigateTo(c.dataset.nav));
}

/* ---------------------------------------------------------------------
   INVENTORY LIST
--------------------------------------------------------------------- */
function renderInventoryView() {
  let list = state.batches.map((b) => ({ ...b, cat: catalogById(b.catalogItemId) || { name: "(deleted item)", category: "", unit: "", barcode: "" } }));
  if (state.ui.activeFridge !== "all") list = list.filter((b) => b.fridgeId === state.ui.activeFridge);
  if (state.ui.query.trim()) {
    const q = state.ui.query.trim().toLowerCase();
    list = list.filter((b) => [b.cat.name, b.lot, b.cat.category, b.shelf, b.cat.barcode, b.barcode].some((v) => (v || "").toLowerCase().includes(q)));
  }
  const expiryFilter = state.ui.expiryFilter || "all";
  const expiryCustomDate = state.ui.expiryCustomDate || "";
  if (expiryFilter === "custom") {
    if (expiryCustomDate) list = list.filter((b) => b.expiry && b.expiry.slice(0, 10) <= expiryCustomDate);
  } else if (expiryFilter !== "all") {
    list = list.filter((b) => {
      const d = daysUntil(b.expiry);
      if (d === null) return false;
      if (expiryFilter === "expired") return d < 0;
      return d >= 0 && d <= Number(expiryFilter);
    });
  }
  const deptFilter = state.ui.invDept || "";
  if (state.role === "master" && deptFilter) list = list.filter((b) => b.branchId === deptFilter);
  // Group every lot of the same item together (sorted by soonest expiry within that group),
  // instead of scattering lots of the same item across the whole list.
  list.sort((a, b) => {
    const nameCmp = (a.cat.name || "").localeCompare(b.cat.name || "");
    if (nameCmp !== 0) return nameCmp;
    const da = daysUntil(a.expiry), db = daysUntil(b.expiry);
    if (da === null) return 1; if (db === null) return -1; return da - db;
  });

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Inventory List</h2><span class="subtitle">Current available reagents and stock levels</span></div>
      <button class="btn export" id="exportInv"><i class="fa-solid fa-file-excel"></i> Export to Excel</button></div>
    <div class="filter-bar" style="display:flex;gap:10px;flex-wrap:wrap">
      <input id="invSearch" style="flex:1;min-width:220px" placeholder="Search by item name, barcode, lot number or shelf…" value="${esc(state.ui.query)}" />
      <select id="invExpiryFilter" style="width:auto">
        <option value="all" ${expiryFilter === "all" ? "selected" : ""}>All expiry dates</option>
        <option value="expired" ${expiryFilter === "expired" ? "selected" : ""}>Already expired</option>
        <option value="7" ${expiryFilter === "7" ? "selected" : ""}>Expiring within 7 days</option>
        <option value="30" ${expiryFilter === "30" ? "selected" : ""}>Expiring within 30 days</option>
        <option value="90" ${expiryFilter === "90" ? "selected" : ""}>Expiring within 90 days</option>
        <option value="custom" ${expiryFilter === "custom" ? "selected" : ""}>Expiring by date…</option>
      </select>
      ${expiryFilter === "custom" ? `<input type="date" id="invExpiryCustomDate" style="width:auto" value="${esc(expiryCustomDate)}" />` : ""}
      ${state.role === "master" ? `<select id="invDept" style="width:auto"><option value="">All departments</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === deptFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>` : ""}
    </div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item Name</th><th>Item Number</th><th>Category</th>${state.role === "master" && !deptFilter ? "<th>Department</th>" : ""}<th>Lot Number</th><th>Quantity</th><th>Total Tests</th><th>Expiry Date</th><th>Receipt Date</th><th>Location</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${list.length === 0 ? `<tr><td colspan="${state.role === "master" && !deptFilter ? 12 : 11}" class="table-empty">No stock found</td></tr>` : list.map((b) => {
          const s = statusOf(b.expiry);
          const totalTests = b.cat.testsPerUnit ? Number(b.cat.testsPerUnit) * (Number(b.quantity) || 0) : null;
          return `<tr>
            <td>${esc(b.cat.name)}</td>
            <td class="mono">${esc(b.cat.itemNumber || "—")}</td>
            <td>${esc(b.cat.category)}</td>
            ${state.role === "master" && !deptFilter ? `<td>${esc(branchName(b.branchId))}</td>` : ""}
            <td class="mono">${esc(b.lot || "—")}${b.inUse ? ` <span class="badge" style="background:${STATUS_STYLES.ok.bg};color:${STATUS_STYLES.ok.text};border-color:${STATUS_STYLES.ok.border}" title="Opened/dispensed from${b.lastDispensedAt ? " · last on " + esc(b.lastDispensedAt) : ""}">● In use</span>` : ""}</td>
            <td class="mono">${b.quantity} ${esc(b.cat.unit)}</td>
            <td class="mono">${totalTests === null ? "—" : totalTests}</td>
            <td class="mono">${esc(b.expiry || "—")}</td>
            <td class="mono">${esc(b.addedAt || "—")}</td>
            <td>${esc(fridgeName(b.fridgeId))}${b.shelf ? " · " + esc(b.shelf) : ""}</td>
            <td>${badgeHtml(s)}</td>
            <td><button class="icon-btn-sm" data-print-batch="${b.id}" title="Print barcode"><i class="fa-solid fa-print"></i></button>
                <button class="icon-btn-sm" data-edit-batch="${b.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn-sm" data-del-batch="${b.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>`;

  el("invSearch").oninput = (e) => {
    state.ui.query = e.target.value;
    renderInventoryView();
    const refocused = el("invSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("invExpiryFilter").onchange = (e) => { state.ui.expiryFilter = e.target.value; renderInventoryView(); };
  const invExpiryDateEl = el("invExpiryCustomDate");
  if (invExpiryDateEl) invExpiryDateEl.onchange = (e) => { state.ui.expiryCustomDate = e.target.value; renderInventoryView(); };
  const invDeptEl = el("invDept"); if (invDeptEl) invDeptEl.onchange = (e) => { state.ui.invDept = e.target.value; renderInventoryView(); };
  el("exportInv").onclick = () => exportInventoryToExcel(list);
  el("mainContent").querySelectorAll("[data-edit-batch]").forEach((b) => b.onclick = () => openBatchEdit(b.dataset.editBatch));
  el("mainContent").querySelectorAll("[data-del-batch]").forEach((b) => b.onclick = () => { if (confirm("Delete this batch?")) deleteBatch(b.dataset.delBatch); });
  el("mainContent").querySelectorAll("[data-print-batch]").forEach((b) => b.onclick = () => printBatchLabel(b.dataset.printBatch));
}

/* ---------------------------------------------------------------------
   INVENTORY COUNT (physical stocktake)
--------------------------------------------------------------------- */
const INVENTORY_COUNT_INSTRUCTIONS = [
  { title: "إيقاف الحركة المخزنية", body: "إيقاف عمليات الصرف والاستلام مؤقتاً خلال فترة الجرد لمنع التضارب في الأرقام." },
  { title: "تنظيم وترتيب المخزون", body: "إعادة ترتيب المواد والمحاليل والمستلزمات، وتجميع العبوات المتشابهة، والتأكد من وضوح الملصقات (Labels)." },
  { title: "الالتزام بالوحدات في شيت الجرد", body: "تأكد أن كل كمية مكتوبة بنفس وحدة القياس الموضحة أمام الصنف حتى لا يحصل خلط بين الوحدات." },
];

// Column-name variants seen across this lab's different department count-sheet layouts —
// matching is case-insensitive so "Item Number", "Product ID", etc. all resolve to the same field.
const COUNT_COLUMN_ALIASES = {
  itemNumber: ["item number", "product id", "item no", "itemnumber"],
  name: ["product name", "item name"],
  lot: ["lot number", "batch number", "lot no", "lot"],
  expiry: ["expiry", "expiry date", "expiration"],
  unit: ["unit of measure", "inventory unit", "unit"],
};
function detectCountColumns(headerRow) {
  const map = {};
  (headerRow || []).forEach((h, idx) => {
    const key = String(h || "").trim().toLowerCase();
    if (!key) return;
    for (const field of Object.keys(COUNT_COLUMN_ALIASES)) {
      if (map[field] !== undefined) continue; // first matching column wins for that field
      if (COUNT_COLUMN_ALIASES[field].includes(key)) map[field] = idx;
    }
  });
  return map;
}
/** Parses one sheet of an uploaded count workbook into draft rows. Keeps the item-identity fields
 *  used for matching (item number / name / lot / expiry / unit) AND the full original row exactly
 *  as uploaded (every column, under its own original header) so nothing typed into that sheet is
 *  lost — exporting later reconstructs those same original columns instead of a reduced set.
 *  Quantity-like columns in the file are kept in `original` for reference but never used to
 *  pre-fill Counted: a re-used template can carry last period's numbers, and those shouldn't
 *  silently become this period's count. Counted always starts blank. */
function parseCountSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
  if (rows.length < 2) return { headers: [], rows: [] };
  const headerRow = (rows[0] || []).map((h) => String(h || "").trim());
  const cols = detectCountColumns(headerRow);
  if (cols.itemNumber === undefined && cols.name === undefined) return { headers: [], rows: [] }; // not a recognizable count sheet
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = cols.name !== undefined ? String(r[cols.name] || "").trim() : "";
    const itemNumber = cols.itemNumber !== undefined ? String(r[cols.itemNumber] || "").trim() : "";
    if (!name && !itemNumber) continue; // skip blank/spacer rows
    const original = {};
    headerRow.forEach((h, idx) => { if (h) original[h] = r[idx] !== undefined ? r[idx] : ""; });
    out.push({
      itemNumber,
      name,
      lot: cols.lot !== undefined ? String(r[cols.lot] || "").trim() : "",
      expiry: cols.expiry !== undefined ? String(r[cols.expiry] || "").trim() : "",
      unit: cols.unit !== undefined ? String(r[cols.unit] || "").trim() : "",
      counted: "",
      original,
    });
  }
  return { headers: headerRow.filter(Boolean), rows: out };
}
/** Reads every sheet of the uploaded workbook and keeps one "page" per sheet that actually
 *  looks like a count sheet — mirrors the tabs of the Excel file instead of merging everything
 *  into one flat list, so Chemistry / DXI / General Consumables etc. stay exactly as separate
 *  pages the way they are in the workbook. Sheets with an implausible number of rows for a
 *  physical count (e.g. a raw lot/batch lookup table with thousands of rows) are skipped rather
 *  than dumped in as a giant, unusable page — the caller is told what got skipped and why. */
const COUNT_SHEET_MAX_ROWS = 500;
function parseCountWorkbook(wb) {
  const pages = [];
  const skipped = [];
  wb.SheetNames.forEach((name) => {
    const { headers, rows } = parseCountSheet(wb.Sheets[name]);
    if (rows.length === 0) return;
    if (rows.length > COUNT_SHEET_MAX_ROWS) { skipped.push({ name, count: rows.length }); return; }
    pages.push({ name, headers, rows });
  });
  return { pages, skipped };
}
/** Whitespace/case-insensitive lot comparison — a real lot number shouldn't fail to match just
 *  because of a stray double space or trailing tab picked up from a spreadsheet cell. */
function normLot(v) { return String(v == null ? "" : v).replace(/\s+/g, "").toLowerCase(); }
/** Links a count row to what the app currently believes is on the shelf for that exact lot —
 *  matched by item number first, then by name, same item-linking the person asked for. Returns
 *  three distinct states so a "0" can always be explained: catalogMatched=false means this item
 *  isn't recognized at all (link it manually); catalogMatched=true + lotFound=false means the item
 *  is known but this exact lot isn't currently in Inventory List (already used up, or found during
 *  the physical walk but never logged) — that gap IS the point of a physical count, not a bug. */
function systemQtyForCountRow(row) {
  const branchId = state.managedBranchId || state.myBranchId || null;
  const cat = (row.itemNumber && state.catalog.find((c) => (c.itemNumber || "").toLowerCase() === row.itemNumber.toLowerCase()))
    || (row.name && state.catalog.find((c) => c.name.toLowerCase() === row.name.toLowerCase()));
  if (!cat) return { systemQty: 0, catalogMatched: false, lotFound: false, catalogItemId: null, countingNote: "" };
  const pool = state.batches.filter((b) => b.catalogItemId === cat.id && (!branchId || b.branchId === branchId));
  if (!row.lot) return { systemQty: pool.reduce((s, b) => s + (Number(b.quantity) || 0), 0), catalogMatched: true, lotFound: true, catalogItemId: cat.id, countingNote: cat.countingNote || "" };
  const batch = pool.find((b) => normLot(b.lot) === normLot(row.lot));
  return { systemQty: batch ? Number(batch.quantity) || 0 : 0, catalogMatched: true, lotFound: !!batch, catalogItemId: cat.id, countingNote: cat.countingNote || "" };
}

function renderInventoryCountView() {
  const draft = state.ui.countDraft; // { title, pages: [{ name, rows }] } or null when no session is open
  const savedCounts = [...state.inventoryCounts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const instructionsHtml = `
    <div class="panel-card" style="margin-bottom:20px">
      <div class="page-header" style="margin-bottom:10px"><div><h3 style="margin:0">تعليمات الجرد</h3></div></div>
      ${INVENTORY_COUNT_INSTRUCTIONS.map((s, i) => `
        <div style="display:flex;gap:10px;padding:10px 0;${i ? "border-top:1px solid var(--border)" : ""}" dir="rtl">
          <div style="flex:1"><strong>${i + 1}. ${esc(s.title)}</strong><div style="color:var(--text-dim);font-size:13px;margin-top:4px">${esc(s.body)}</div></div>
        </div>`).join("")}
    </div>`;

  if (!draft) {
    el("mainContent").innerHTML = `
      <div class="page-header"><div><h2>Inventory Count</h2><span class="subtitle">Physical stocktake — upload a count sheet, compare against Inventory List, and record what was actually counted</span></div></div>
      ${instructionsHtml}
      <div class="panel-card" style="margin-bottom:20px">
        <div class="page-header" style="margin-bottom:12px"><div><h3 style="margin:0">Start a count</h3><span class="subtitle">Upload the lab's Excel count sheet — every tab in the file (Chemistry, DXI, etc.) is kept as its own page here, exactly like the workbook. Quantities always start blank for you to fill in.</span></div></div>
        <label class="field" style="margin-bottom:10px"><span class="field-label">Count title</span><input id="countTitle" placeholder="e.g. LB010 — September 2026" value="${esc(state.ui.countTitleDraft || "")}" /></label>
        <label class="field"><span class="field-label">Upload count sheet (.xlsx)</span><input type="file" id="countFileInput" accept=".xlsx,.xls" /></label>
        <p class="auth-hint" style="text-align:left;margin-top:10px">Or skip the upload and <button type="button" class="btn link" id="btnStartBlankCount" style="padding:0;font-size:inherit">start a blank count</button> and add items from the catalog instead.</p>
      </div>
      <div class="panel-card">
        <div class="page-header" style="margin-bottom:10px"><div><h3 style="margin:0">Saved Counts</h3></div></div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Date</th><th>Title</th><th>Pages</th><th>Items</th><th>Created by</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${savedCounts.length === 0 ? `<tr><td colspan="7" class="table-empty">No saved counts yet.</td></tr>` : savedCounts.map((c) => `
            <tr>
              <td class="mono">${esc((c.createdAt || "").slice(0, 16))}</td>
              <td>${esc(c.title || "—")}</td>
              <td>${(c.pages || []).length}</td>
              <td>${(c.pages || []).reduce((s, p) => s + (p.rows || []).length, 0)}</td>
              <td>${esc(nameForEmail(c.createdBy))}</td>
              <td>${c.status === "closed" ? `<span class="badge" style="background:${STATUS_STYLES.ok.bg};color:${STATUS_STYLES.ok.text};border-color:${STATUS_STYLES.ok.border}">Closed</span>` : `<span class="badge" style="background:${STATUS_STYLES.watch.bg};color:${STATUS_STYLES.watch.text};border-color:${STATUS_STYLES.watch.border}">Open</span>`}</td>
              <td>
                <button class="icon-btn-sm" data-reopen-count="${c.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn-sm" data-export-count="${c.id}" title="Export"><i class="fa-solid fa-file-excel"></i></button>
                <button class="icon-btn-sm" data-del-count="${c.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
              </td>
            </tr>`).join("")}
          </tbody>
        </table></div>
      </div>`;

    el("countTitle").oninput = (e) => { state.ui.countTitleDraft = e.target.value; };
    el("btnStartBlankCount").onclick = () => {
      state.ui.countDraft = { title: state.ui.countTitleDraft || "Untitled count", pages: [{ name: "Manual", headers: [], rows: [] }] };
      state.ui.countActivePage = 0;
      renderInventoryCountView();
    };
    el("countFileInput").onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const wb = XLSX.read(ev.target.result, { type: "array" });
        const { pages, skipped } = parseCountWorkbook(wb);
        if (pages.length === 0) { toast("Couldn't find recognizable item/lot columns on any sheet in that file.", "warn"); return; }
        if (skipped.length > 0) {
          toast(`Skipped ${skipped.map((s) => `"${s.name}" (${s.count} rows)`).join(", ")} — too many rows to be a real count page, looks like a raw lookup sheet.`, "warn");
        }
        state.ui.countDraft = { title: state.ui.countTitleDraft || file.name.replace(/\.xlsx?$/i, ""), pages };
        state.ui.countActivePage = 0;
        renderInventoryCountView();
      };
      reader.readAsArrayBuffer(file);
    };
    el("mainContent").querySelectorAll("[data-reopen-count]").forEach((b) => b.onclick = () => {
      const c = savedCounts.find((x) => x.id === b.dataset.reopenCount);
      if (c) {
        state.ui.countDraft = { id: c.id, title: c.title, pages: (c.pages || []).map((p) => ({ name: p.name, headers: p.headers || [], rows: (p.rows || []).map((r) => ({ ...r })) })) };
        state.ui.countActivePage = 0;
        renderInventoryCountView();
      }
    });
    el("mainContent").querySelectorAll("[data-export-count]").forEach((b) => b.onclick = () => {
      const c = savedCounts.find((x) => x.id === b.dataset.exportCount);
      if (c) exportCountPagesToExcel(c.pages || [], `count_${(c.createdAt || "").slice(0, 10)}.xlsx`);
    });
    el("mainContent").querySelectorAll("[data-del-count]").forEach((b) => b.onclick = () => { if (confirm("Delete this saved count?")) deleteInventoryCount(b.dataset.delCount); });
    return;
  }

  // ---- Active count session ----
  const pageIdx = Math.min(state.ui.countActivePage || 0, draft.pages.length - 1);
  const page = draft.pages[pageIdx];
  const rows = page.rows;
  const totalItems = draft.pages.reduce((s, p) => s + p.rows.length, 0);

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>${esc(draft.title)}</h2><span class="subtitle">${totalItems} item${totalItems === 1 ? "" : "s"} across ${draft.pages.length} page${draft.pages.length === 1 ? "" : "s"} · System qty is read live from Inventory List; enter what you physically counted</span></div>
      <button type="button" class="btn ghost" id="btnCloseDraft"><i class="fa-solid fa-arrow-left"></i> Back to counts</button></div>

    <div class="tab-bar" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
      ${draft.pages.map((p, i) => `<button type="button" class="btn ${i === pageIdx ? "secondary active" : "ghost"}" data-page-tab="${i}" style="padding:8px 14px">${esc(p.name)} <span style="opacity:.6">(${p.rows.length})</span></button>`).join("")}
    </div>

    <div class="form-row" style="align-items:end;margin-bottom:14px">
      <label class="field"><span class="field-label">Add item from catalog (to "${esc(page.name)}")</span>
        <input id="countCatalogSearch" autocomplete="off" placeholder="Type to search…" value="${esc(state.ui.countCatalogSearch || "")}" />
      </label>
    </div>
    <div class="pick-list" id="countPickResults" style="margin-bottom:18px">${countCatalogPickHtml()}</div>

    <div class="table-wrap" style="margin-bottom:16px">
      <table class="data-table">
        <thead><tr><th>Item</th><th>Lot</th><th>Expiry</th><th>Unit</th><th>System Qty</th><th>Counted</th><th>Diff</th><th></th></tr></thead>
        <tbody>${rows.length === 0 ? `<tr><td colspan="8" class="table-empty">No items on this page yet — add items from the catalog above.</td></tr>` : rows.map((r, idx) => {
          const { systemQty, catalogMatched, lotFound, countingNote } = systemQtyForCountRow(r);
          const counted = r.counted === "" ? null : Number(r.counted);
          const diff = counted === null ? null : round4(counted - systemQty);
          const linking = state.ui.countLinkingRowIdx === idx;
          const noteBadge = countingNote ? ` <i class="fa-solid fa-circle-info" data-count-note-idx="${idx}" title="${esc(countingNote)}" style="color:var(--accent);cursor:help"></i>` : "";
          const matchBadge = !catalogMatched
            ? ` <button type="button" class="btn link" data-link-row-idx="${idx}" style="padding:0;font-size:11px;color:var(--danger-text)" title="Not found in the catalog — click to link it to the right item">(not in catalog · link)</button>`
            : (r.lot && !lotFound ? ` <span style="font-size:11px;color:var(--warn-text,#a5680a)" title="This item is in the catalog, but this exact lot number isn't currently in Inventory List">(lot not on shelf)</span>` : "");
          const itemCell = linking
            ? `<input id="countLinkSearch" autocomplete="off" placeholder="Search catalog…" value="${esc(state.ui.countLinkSearch || "")}" style="margin-bottom:6px" /><div class="pick-list" id="countLinkResults" style="max-height:160px;overflow:auto">${countLinkPickHtml()}</div><button type="button" class="btn link" data-cancel-link style="padding:0;font-size:11px;margin-top:4px">Cancel</button>`
            : `${esc(r.name || r.itemNumber || "—")}${noteBadge}${matchBadge}`;
          // A counting note must be read and confirmed before the field for THAT row unlocks — the note
          // is exactly the moment it matters, not a passive hint the user might never notice.
          const ackKey = `${pageIdx}:${idx}`;
          const noteLocked = !!countingNote && !(state.ui.countNotesAck && state.ui.countNotesAck[ackKey]);
          const countedCell = noteLocked
            ? `<button type="button" class="btn secondary" data-confirm-note-idx="${idx}" style="font-size:11.5px;padding:5px 10px"><i class="fa-solid fa-triangle-exclamation"></i> Read note</button>`
            : `<input type="number" class="mono" style="width:80px" data-counted-idx="${idx}" data-system-qty="${systemQty}" value="${esc(r.counted)}" placeholder="—" />`;
          return `<tr>
            <td>${itemCell}</td>
            <td class="mono">${esc(r.lot || "—")}</td>
            <td class="mono">${esc(r.expiry || "—")}</td>
            <td>${esc(r.unit || "—")}</td>
            <td class="mono">${systemQty}</td>
            <td>${countedCell}</td>
            <td class="mono" style="${diff !== null && diff !== 0 ? "color:var(--danger-text);font-weight:700" : ""}">${diff === null ? "—" : diff}</td>
            <td><button class="icon-btn-sm" data-remove-count-idx="${idx}" title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
          </tr>`;
        }).join("")}
        </tbody>
      </table>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn export" id="btnExportCountDraft" ${totalItems ? "" : "disabled"}><i class="fa-solid fa-file-excel"></i> Export to Excel</button>
      <button class="btn primary" id="btnSaveCount" ${totalItems ? "" : "disabled"}><i class="fa-solid fa-floppy-disk"></i> Save count</button>
    </div>`;

  function countCatalogPickHtml() {
    const q = (state.ui.countCatalogSearch || "").trim().toLowerCase();
    if (!q) return `<div class="pick-empty">Type to search the catalog…</div>`;
    const items = state.catalog.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 30);
    if (items.length === 0) return `<div class="pick-empty">No matching catalog items</div>`;
    return items.map((c) => `<button type="button" class="pick-item" data-pick-count-item="${c.id}"><span>${esc(c.name)}</span><span style="color:var(--text-faint);font-size:11px">${esc(c.itemNumber || "")}</span></button>`).join("");
  }
  function countLinkPickHtml() {
    const q = (state.ui.countLinkSearch || "").trim().toLowerCase();
    if (!q) return `<div class="pick-empty">Type to search the catalog…</div>`;
    const items = state.catalog.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 20);
    if (items.length === 0) return `<div class="pick-empty">No matching catalog items</div>`;
    return items.map((c) => `<button type="button" class="pick-item" data-link-pick-item="${c.id}"><span>${esc(c.name)}</span><span style="color:var(--text-faint);font-size:11px">${esc(c.itemNumber || "")}</span></button>`).join("");
  }

  el("btnCloseDraft").onclick = () => { state.ui.countDraft = null; state.ui.countNotesAck = {}; renderInventoryCountView(); };
  el("mainContent").querySelectorAll("[data-page-tab]").forEach((b) => b.onclick = () => {
    state.ui.countActivePage = Number(b.dataset.pageTab);
    state.ui.countCatalogSearch = "";
    state.ui.countLinkingRowIdx = null;
    renderInventoryCountView();
  });
  const catSearchEl = el("countCatalogSearch");
  catSearchEl.oninput = (e) => {
    state.ui.countCatalogSearch = e.target.value;
    renderInventoryCountView();
    const refocused = el("countCatalogSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("mainContent").querySelectorAll("[data-pick-count-item]").forEach((b) => b.onclick = () => {
    const c = state.catalog.find((x) => x.id === b.dataset.pickCountItem);
    if (!c) return;
    // Duplicate-item guard, scoped to THIS page only — the same item can legitimately appear on a
    // different department's page, mirroring how the Excel tabs work.
    const existingIdx = rows.findIndex((r) => (c.itemNumber && r.itemNumber === c.itemNumber) || r.name.toLowerCase() === c.name.toLowerCase());
    if (existingIdx !== -1) {
      toast(`"${c.name}" is already on the "${page.name}" page (row ${existingIdx + 1}) — edit that row instead of adding a duplicate.`, "warn");
      return;
    }
    rows.push({ itemNumber: c.itemNumber || "", name: c.name, lot: "", expiry: "", unit: c.unit || "", counted: "" });
    state.ui.countCatalogSearch = "";
    renderInventoryCountView();
  });
  el("mainContent").querySelectorAll("[data-counted-idx]").forEach((inp) => {
    inp.onchange = (e) => {
      const idx = Number(inp.dataset.countedIdx);
      if (!rows[idx]) return;
      const raw = e.target.value;
      if (raw === "") { rows[idx].counted = ""; return; }
      const value = Number(raw);
      const sysQty = Number(inp.dataset.systemQty);
      // A physical count coming in HIGHER than what the app has on record is unusual enough (missed
      // Addition entry, wrong lot, a typo) that it shouldn't be accepted silently — require an
      // explicit confirmation, same as the counting-note gate below.
      if (value > sysQty) {
        const ok = confirm(`You entered ${value}, but Inventory List currently shows ${sysQty} for this lot.\n\nPress OK to confirm this count is correct.`);
        if (!ok) { e.target.value = rows[idx].counted; return; }
      }
      rows[idx].counted = String(value);
    };
  });
  el("mainContent").querySelectorAll("[data-confirm-note-idx]").forEach((b) => b.onclick = () => {
    const idx = Number(b.dataset.confirmNoteIdx);
    const { countingNote } = systemQtyForCountRow(rows[idx]);
    const ok = confirm(`${countingNote}\n\nPress OK once you've read this to enter the count for this item.`);
    if (!ok) return;
    state.ui.countNotesAck = state.ui.countNotesAck || {};
    state.ui.countNotesAck[`${pageIdx}:${idx}`] = true;
    renderInventoryCountView();
  });
  el("mainContent").querySelectorAll("[data-remove-count-idx]").forEach((b) => b.onclick = () => {
    rows.splice(Number(b.dataset.removeCountIdx), 1);
    renderInventoryCountView();
  });
  el("mainContent").querySelectorAll("[data-link-row-idx]").forEach((b) => b.onclick = () => {
    state.ui.countLinkingRowIdx = Number(b.dataset.linkRowIdx);
    state.ui.countLinkSearch = "";
    renderInventoryCountView();
  });
  const cancelLinkBtn = el("mainContent").querySelector("[data-cancel-link]");
  if (cancelLinkBtn) cancelLinkBtn.onclick = () => { state.ui.countLinkingRowIdx = null; renderInventoryCountView(); };
  const linkSearchEl = el("countLinkSearch");
  if (linkSearchEl) linkSearchEl.oninput = (e) => {
    state.ui.countLinkSearch = e.target.value;
    renderInventoryCountView();
    const refocused = el("countLinkSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("mainContent").querySelectorAll("[data-link-pick-item]").forEach((b) => b.onclick = () => {
    const c = state.catalog.find((x) => x.id === b.dataset.linkPickItem);
    const idx = state.ui.countLinkingRowIdx;
    if (!c || idx === null || !rows[idx]) return;
    // Keep the lot/expiry the person actually found on the shelf — only the item identity changes,
    // now pointing at a real catalog entry so it can be matched against Inventory List.
    rows[idx].itemNumber = c.itemNumber || "";
    rows[idx].name = c.name;
    if (!rows[idx].unit) rows[idx].unit = c.unit || "";
    state.ui.countLinkingRowIdx = null;
    renderInventoryCountView();
  });
  const exportDraftBtn = el("btnExportCountDraft");
  if (exportDraftBtn) exportDraftBtn.onclick = () => exportCountPagesToExcel(draft.pages, "inventory_count.xlsx");
  const saveBtn = el("btnSaveCount");
  if (saveBtn) saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await saveInventoryCount(draft);
      state.ui.countDraft = null;
      toast("Count saved.", "success");
      renderInventoryCountView();
    } catch (err) {
      toast("Failed to save count: " + (err && err.message ? err.message : err), "error");
      saveBtn.disabled = false;
    }
  };
}
async function saveInventoryCount(draft) {
  const branchId = state.managedBranchId || state.myBranchId || null;
  const payload = { branchId, branchName: branchName(branchId), title: draft.title, pages: draft.pages, status: "open", createdBy: state.user.email };
  if (draft.id) await db.collection("inventoryCounts").doc(draft.id).set({ ...payload, updatedAt: nowStr() }, { merge: true });
  else await db.collection("inventoryCounts").add({ ...payload, createdAt: nowStr() });
}
async function deleteInventoryCount(id) { await db.collection("inventoryCounts").doc(id).delete(); }
/** Exports one Excel sheet per page — the same shape the file came in as (every original column,
 *  in its original order), round-tripping the workbook's tab structure instead of flattening or
 *  reducing it. System Qty / Counted / Diff / Match are appended at the end; nothing original is
 *  overwritten. "Match" makes every 0 explainable at a glance: "Not in catalog" (couldn't link this
 *  item at all — link it), "Lot not on shelf" (item's known, this exact lot just isn't in Inventory
 *  List right now), or "OK". */
function exportCountPagesToExcel(pages, filename) {
  const extraHeaders = ["System Qty (App)", "Counted (App)", "Diff (App)", "Match (App)"];
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  function fieldForHeader(h) {
    const key = String(h || "").trim().toLowerCase();
    for (const field of Object.keys(COUNT_COLUMN_ALIASES)) {
      if (COUNT_COLUMN_ALIASES[field].includes(key)) return field;
    }
    return null;
  }
  pages.forEach((page) => {
    const baseHeaders = (page.headers && page.headers.length) ? page.headers : ["Item number", "Product name", "Lot Number", "Expiry", "Unit"];
    const allHeaders = [...baseHeaders, ...extraHeaders];
    const data = page.rows.map((r) => {
      const { systemQty, catalogMatched, lotFound } = systemQtyForCountRow(r);
      const counted = r.counted === "" ? "" : Number(r.counted);
      const diff = counted === "" ? "" : round4(counted - systemQty);
      const match = !catalogMatched ? "Not in catalog" : (r.lot && !lotFound ? "Lot not on shelf" : "OK");
      const baseVals = baseHeaders.map((h) => {
        if (r.original && Object.prototype.hasOwnProperty.call(r.original, h)) return r.original[h];
        const field = fieldForHeader(h);
        if (field === "itemNumber") return r.itemNumber || "";
        if (field === "name") return r.name || "";
        if (field === "lot") return r.lot || "";
        if (field === "expiry") return r.expiry || "";
        if (field === "unit") return r.unit || "";
        return "";
      });
      return [...baseVals, systemQty, counted, diff, match];
    });
    const ws = XLSX.utils.aoa_to_sheet([allHeaders, ...data]);
    // Excel sheet names: max 31 chars, no \ / ? * [ ] characters, and must be unique in the workbook.
    let name = String(page.name || "Sheet").replace(/[\\/?*[\]]/g, " ").slice(0, 31).trim() || "Sheet";
    let unique = name, n = 2;
    while (usedNames.has(unique.toLowerCase())) { unique = `${name.slice(0, 28)} ${n++}`; }
    usedNames.add(unique.toLowerCase());
    XLSX.utils.book_append_sheet(wb, ws, unique);
  });
  XLSX.writeFile(wb, filename || "inventory_count.xlsx");
}

/* ---------------------------------------------------------------------
   DISPENSE / WASTE
--------------------------------------------------------------------- */
function renderDispenseView() {
  const ds = { actionType: "consume", method: "manual", itemId: "", batchId: "", barcode: "", itemSearch: "", unit: "", quantity: "1" };

  function itemSearchResultsHtml() {
    const list = itemsInStock();
    const q = ds.itemSearch.trim().toLowerCase();
    const filtered = (q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list).slice(0, 30);
    if (filtered.length === 0) return `<div class="pick-empty">No matching items in stock</div>`;
    return filtered.map((c) => `<button type="button" class="pick-item" data-pick-dispense-item="${c.id}"><span>${esc(c.name)}</span><span style="color:var(--text-faint);font-size:11px">${esc(c.category)}</span></button>`).join("");
  }
  function lotOptions() {
    if (!ds.itemId) return `<option value="">Select item first…</option>`;
    const batches = state.batches.filter((b) => b.catalogItemId === ds.itemId);
    if (batches.length === 0) return `<option value="">No stock available</option>`;
    return `<option value="">Select lot…</option>` + batches.map((b) => `<option value="${b.id}" ${b.id === ds.batchId ? "selected" : ""}>${esc(batchLabel(b))}</option>`).join("");
  }
  let selectedBatch = null;

  function body() {
    return `
    <div class="page-header"><div><h2>Dispense / Waste</h2><span class="subtitle">Record routine usage or discard items</span></div></div>
    <div class="card-form">
      <form id="dispenseForm">
        <div class="form-row">
          <label class="field"><span class="field-label">Action Type</span>
            <select id="actionType"><option value="consume" ${ds.actionType === "consume" ? "selected" : ""}>Routine Consumption (Dispense)</option>
              <option value="damage" ${ds.actionType === "damage" ? "selected" : ""}>Report Waste / Damage</option></select></label>
          <label class="field"><span class="field-label">Performed By</span><input value="${esc(state.user.email)}" readonly /></label>
        </div>
        <div class="form-row">
          <label class="field"><span class="field-label">Entry Method</span>
            <select id="entryMethod"><option value="manual" ${ds.method === "manual" ? "selected" : ""}>Manual Selection</option>
              <option value="barcode" ${ds.method === "barcode" ? "selected" : ""}>Barcode Scanner</option></select></label>
          ${ds.method === "barcode" ? `<label class="field"><span class="field-label"><i class="fa-solid fa-barcode"></i> Scan Barcode</span>
            <div style="display:flex;gap:8px"><input id="barcodeInput" class="mono" autocomplete="off" placeholder="Scan or type the barcode…" value="${esc(ds.barcode)}" style="flex:1" /><button type="button" class="btn secondary icon-only" id="camScanBtn" title="Scan with camera"><i class="fa-solid fa-camera"></i></button></div></label>` : `<div class="field"></div>`}
        </div>
        ${ds.itemId ? `
        <div class="scan-result" style="border-color:#3b6fe0;margin-bottom:10px">
          <div class="scan-result-row"><span class="k">Selected item</span><span class="v">${esc(itemsInStock().find((c) => c.id === ds.itemId)?.name || "")}</span></div>
        </div>
        <button type="button" class="link-btn" id="dsChangeItem" style="margin-bottom:14px">← Change item</button>
        <div class="form-row">
          <div class="field"></div>
          <label class="field"><span class="field-label">Select Lot</span><select id="lotSelect">${lotOptions()}</select></label>
        </div>` : `
        <div class="form-row">
          <label class="field"><span class="field-label">Select Item</span><input id="dsItemSearch" autocomplete="off" placeholder="Type to search ${itemsInStock().length} items…" value="${esc(ds.itemSearch)}" /></label>
          <label class="field"><span class="field-label">Select Lot</span><select disabled><option>Select item first…</option></select></label>
        </div>
        <div class="pick-list" style="margin-bottom:14px">${itemSearchResultsHtml()}</div>`}
        <div class="form-row">
          <label class="field"><span class="field-label">Quantity ${selectedBatch ? `(max ${maxQtyInUnit(selectedBatch, catalogById(selectedBatch.catalogItemId), ds.unit)} ${esc(ds.unit)})` : ""}</span><input type="text" inputmode="decimal" dir="ltr" id="qtyInput" min="0.01" step="any" max="${selectedBatch ? maxQtyInUnit(selectedBatch, catalogById(selectedBatch.catalogItemId), ds.unit) : ""}" value="${esc(ds.quantity)}" required /></label>
          <label class="field"><span class="field-label">Unit</span><select id="qtyUnit" ${!selectedBatch ? "disabled" : ""}>${unitOptionsForItem(selectedBatch ? catalogById(selectedBatch.catalogItemId) : null).map((u) => `<option ${u === ds.unit ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
        </div>
        <div class="form-row">
          <div class="field"></div>
          <label class="field"><span class="field-label">Date</span><input type="date" id="dateInput" value="${todayStr()}" required /></label>
        </div>
        <label class="field" style="margin-bottom:14px"><span class="field-label">Expiration Date (auto)</span><input value="${selectedBatch ? esc(selectedBatch.expiry || "—") : ""}" readonly /></label>
        ${selectedBatch ? (() => { const c = catalogById(selectedBatch.catalogItemId); return `<div class="field-note" style="margin-bottom:14px">Available: ${selectedBatch.quantity} ${esc(c?.unit || "")}${c?.itemNumber ? ` · Item number ${esc(c.itemNumber)}` : ""}${c?.testsPerUnit ? ` · ${esc(c.testsPerUnit)} tests/unit` : ""}</div>`; })() : ""}
        ${(() => {
          if (!selectedBatch) return "";
          const earlier = state.batches
            .filter((b) => b.id !== selectedBatch.id && b.catalogItemId === selectedBatch.catalogItemId && daysUntil(b.expiry) !== null && daysUntil(selectedBatch.expiry) !== null && daysUntil(b.expiry) < daysUntil(selectedBatch.expiry))
            .sort((a, b) => daysUntil(a.expiry) - daysUntil(b.expiry))[0];
          if (!earlier) return "";
          return `<div class="scan-result" style="border-color:#f5a524;margin-bottom:14px"><div class="scan-result-row"><span class="v" style="color:#a5680a">⚠ A different lot of this item expires sooner — Lot ${esc(earlier.lot || "—")} (${esc(fridgeName(earlier.fridgeId))}) expires ${esc(earlier.expiry)}. Consider using that one first (FEFO).</span></div></div>`;
        })()}
        ${ds.actionType === "damage" ? `<label class="field" style="margin-bottom:14px"><span class="field-label">Damage / Waste Reason *</span><input id="reasonInput" required placeholder="e.g. Spilled, Contaminated, Expired" /></label>` : ""}
        <button type="submit" class="btn primary full">Submit Transaction</button>
      </form>
    </div>`;
  }

  function render(focusBarcode) {
    selectedBatch = state.batches.find((b) => b.id === ds.batchId);
    el("mainContent").innerHTML = body();
    el("actionType").onchange = (e) => { ds.actionType = e.target.value; render(); };
    el("entryMethod").onchange = (e) => { ds.method = e.target.value; render(true); };
    const bc = el("barcodeInput");
    if (bc) {
      if (focusBarcode) bc.focus(); // only on mount/method-switch — never on every render, or clicking
      // any other field (Select Item, Select Lot, Submit…) right after a scan would never register.
      const tryMatch = () => {
        // 1) An internal label barcode we generated for one specific batch (see getOrCreateBatchBarcode) —
        //    this pinpoints the exact lot to withdraw from, no further lot-matching needed.
        const batchHit = findBatchByBarcode(bc.value);
        if (batchHit) {
          ds.itemId = batchHit.catalogItemId;
          ds.batchId = batchHit.id;
          render();
          return;
        }
        // 2) The manufacturer's own barcode on the box — identifies the product; if it also carries
        //    GS1 lot data we can narrow to the matching lot automatically, same as before.
        const scan = scanInfo(bc.value);
        if (scan.item) {
          ds.itemId = scan.item.id;
          const batches = state.batches.filter((b) => b.catalogItemId === scan.item.id);
          const byLot = scan.lot ? batches.find((b) => (b.lot || "").trim() === scan.lot.trim()) : null;
          ds.batchId = byLot ? byLot.id : "";
          render();
        }
      };
      bc.oninput = (e) => { ds.barcode = e.target.value; };
      bc.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); tryMatch(); } };
      bc.onblur = tryMatch;
      const camBtn = el("camScanBtn");
      if (camBtn) camBtn.onclick = () => openCameraScanner((code) => { ds.barcode = code; bc.value = code; tryMatch(); });
    }
    if (ds.itemId) {
      el("dsChangeItem").onclick = () => { ds.itemId = ""; ds.batchId = ""; ds.itemSearch = ""; ds.unit = ""; render(); };
      const lotEl = el("lotSelect"); if (lotEl) lotEl.onchange = (e) => {
        ds.batchId = e.target.value;
        const b = state.batches.find((x) => x.id === ds.batchId);
        ds.unit = b ? unitOptionsForItem(catalogById(b.catalogItemId))[0] : "";
        render();
      };
    } else {
      const searchEl = el("dsItemSearch");
      if (searchEl) {
        searchEl.oninput = (e) => {
          ds.itemSearch = e.target.value;
          render();
          const refocused = el("dsItemSearch");
          if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
        };
      }
      el("mainContent").querySelectorAll("[data-pick-dispense-item]").forEach((b) => b.onclick = () => { ds.itemId = b.dataset.pickDispenseItem; ds.batchId = ""; ds.itemSearch = ""; ds.unit = ""; render(); });
    }
    const qtyEl = el("qtyInput"); if (qtyEl) qtyEl.oninput = (e) => ds.quantity = e.target.value;
    const unitEl = el("qtyUnit"); if (unitEl) unitEl.onchange = (e) => { ds.unit = e.target.value; render(); };

    el("dispenseForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!selectedBatch) { toast("Please select an item and lot.", "warn"); return; }
      const cat = catalogById(selectedBatch.catalogItemId);
      const unit = ds.unit || (cat ? cat.unit : "");
      const enteredQty = Number(el("qtyInput").value) || 0;
      const maxInUnit = maxQtyInUnit(selectedBatch, cat, unit);
      if (enteredQty <= 0) { toast("Enter a quantity greater than 0.", "warn"); return; }
      if (enteredQty > maxInUnit) {
        toast(`Only ${maxInUnit} ${unit} available in this lot — you entered ${enteredQty}.`, "error");
        return;
      }
      const qty = toBaseQty(cat, enteredQty, unit);
      const reason = ds.actionType === "damage" ? el("reasonInput").value.trim() : "";
      if (ds.actionType === "damage" && !reason) { toast("Please provide a reason.", "warn"); return; }
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.textContent = "Saving…";
      try {
        await dispenseFromBatch(selectedBatch.id, qty, {
          type: ds.actionType === "damage" ? "damage" : "out",
          method: ds.method === "barcode" ? "Barcode" : "Manual",
          reason, date: el("dateInput").value || todayStr(),
        });
        toast(`${ds.actionType === "damage" ? "Waste" : "Dispense"} recorded successfully.`, "success");
        ds.itemId = ""; ds.batchId = ""; ds.barcode = ""; render();
      } catch (err) {
        console.error("dispenseFromBatch failed:", err);
        toast("Failed to save: " + (err && err.message ? err.message : err), "error");
        submitBtn.disabled = false; submitBtn.textContent = "Submit Transaction";
      }
    };
  }
  render(true);
}

/* ---------------------------------------------------------------------
   ADDITION (Add Stock)
--------------------------------------------------------------------- */
function renderAdditionView() {
  const as = {
    method: "manual", itemId: "", barcode: "", isNew: false, newBarcode: "", itemSearch: "", existingBarcode: "",
    newDraft: { name: "", category: CATEGORIES[0], unit: UNITS[0], unitTouched: false, unitsPerBox: 1, testsPerUnit: "", testsPerUnitTouched: false },
    lot: "", quantity: 1, expiry: "", shelf: "",
    cart: [], // items queued for this batch: { id, source, catalogItemId?, draft?, displayName, displayCategory, lot, quantity, expiry, shelf }
    fridgeId: state.ui.activeFridge !== "all" ? state.ui.activeFridge : "", addedAt: todayStr(),
    lastAdded: "", lastAddedItem: null, lastScannedRaw: "",
  };

  function itemSearchResultsHtml() {
    const q = as.itemSearch.trim().toLowerCase();
    const filtered = (q ? state.catalog.filter((c) => c.name.toLowerCase().includes(q)) : state.catalog).slice(0, 30);
    if (filtered.length === 0) return `<div class="pick-empty">No matches — create a new item below</div>`;
    return filtered.map((c) => `<button type="button" class="pick-item" data-pick-item="${c.id}"><span>${esc(c.name)}</span><span style="color:var(--text-faint);font-size:11px">${esc(c.category)}</span></button>`).join("");
  }
  let scan = null, matched = null, selectedExisting = null;

  // Shared logic for queuing one item into the batch — used both by the manual "Add item to batch"
  // button and by an automatic scan match (so known items need zero clicks to queue).
  function addEntryToCart(baseEntry, lot, quantity, expiry, shelf) {
    if (baseEntry.source === "existing") {
      const dupe = as.cart.find((it) => it.source === "existing" && it.catalogItemId === baseEntry.catalogItemId && (it.lot || "") === (lot || "") && (it.expiry || "") === (expiry || ""));
      if (dupe) { dupe.quantity = (Number(dupe.quantity) || 0) + (Number(quantity) || 1); return dupe.displayName; }
    }
    const entry = { ...baseEntry, id: uid(), lot: lot || "", quantity: quantity || 1, expiry: expiry || "", shelf: shelf || "" };
    as.cart.push(entry);
    return entry.displayName;
  }

  function cartRowsHtml() {
    if (as.cart.length === 0) return `<div class="pick-empty">No items queued yet — add at least one below, then save the whole batch together.</div>`;
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item</th><th>Lot</th><th>Qty</th><th>Expiry</th><th>Shelf</th><th></th></tr></thead>
      <tbody>${as.cart.map((it) => `
        <tr><td>${esc(it.displayName)} <span style="color:var(--text-faint)">(${esc(it.displayCategory)})</span></td>
          <td class="mono">${esc(it.lot || "—")}</td><td class="mono">${it.quantity}</td>
          <td class="mono">${esc(it.expiry || "—")}</td><td class="mono">${esc(it.shelf || "—")}</td>
          <td><button type="button" class="icon-btn-sm" data-remove-cart="${it.id}"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}
      </tbody></table></div>`;
  }

  function body() {
    return `
    <div class="page-header"><div><h2>Addition (Add Stock)</h2><span class="subtitle">Receive new reagent / calibrator / QC material into inventory</span></div></div>
    <div class="card-form">
      <form id="additionForm">
        <p class="auth-hint" style="text-align:left;margin-bottom:14px">Scan or select as many items as you like into the batch below, then save them all together into one fridge in a single step.</p>
        <div class="form-row">
          <label class="field"><span class="field-label">Entry Method</span>
            <select id="entryMethod2"><option value="manual" ${as.method === "manual" ? "selected" : ""}>Manual Selection</option>
              <option value="barcode" ${as.method === "barcode" ? "selected" : ""}>Barcode Scanner</option></select></label>
          ${as.method === "barcode" ? `<label class="field"><span class="field-label"><i class="fa-solid fa-barcode"></i> Scan Barcode</span>
            <div style="display:flex;gap:8px"><input id="barcodeInput2" class="mono" autocomplete="off" placeholder="Scan or type the barcode…" value="${esc(as.barcode)}" style="flex:1" /><button type="button" class="btn secondary icon-only" id="camScanBtn2" title="Scan with camera"><i class="fa-solid fa-camera"></i></button></div></label>` : `<div class="field"></div>`}
        </div>

        ${as.lastAdded ? `<div class="scan-result" style="border-color:#7cb342;margin-bottom:14px"><div class="scan-result-row"><span class="v">✓ Added to batch: ${esc(as.lastAdded)}</span></div>
            ${as.lastAddedItem ? `
            ${as.lastAddedItem.itemNumber ? `<div class="scan-result-row"><span class="k">Item number</span><span class="v mono">${esc(as.lastAddedItem.itemNumber)}</span></div>` : ""}
            <div class="scan-result-row"><span class="k">Unit / Units per box</span><span class="v">${esc(as.lastAddedItem.unit || "—")} · ${esc(as.lastAddedItem.unitsPerBox || 1)}/box</span></div>
            ${as.lastAddedItem.testsPerUnit ? `<div class="scan-result-row"><span class="k">Tests per unit</span><span class="v mono">${esc(as.lastAddedItem.testsPerUnit)}</span></div>` : ""}
            ` : ""}
            ${as.lastScannedRaw ? `<div class="scan-result-row"><span class="k">Raw scanned code</span><span class="v mono">${esc(as.lastScannedRaw)}</span></div>` : ""}
            </div>` : ""}
        ${as.method === "barcode" && as.barcode && !matched ? `<div class="scan-result" style="border-color:#f5a524;margin-bottom:14px">
            <div class="scan-result-row"><span class="v" style="color:#a5680a">New item — Item ID <span class="mono">${esc(scan.gtin)}</span>. This item isn't in the catalog yet — a barcode alone can't tell us its name, so type it once below and it'll be recognized automatically on every future scan.</span></div>
            ${scan.lot ? `<div class="scan-result-row"><span class="k">Lot number (from scan)</span><span class="v mono">${esc(scan.lot)}</span></div>` : ""}
            ${scan.expiry ? `<div class="scan-result-row"><span class="k">Expiry date (from scan)</span><span class="v mono">${esc(scan.expiry)}</span></div>` : ""}
            </div>` : ""}

        ${as.method === "manual" ? (selectedExisting ? `
        <div class="scan-result" style="border-color:#3b6fe0;margin-bottom:10px">
          <div class="scan-result-row"><span class="k">Selected item</span><span class="v">${esc(selectedExisting.name)} (${esc(selectedExisting.category)})</span></div>
        </div>
        <button type="button" class="link-btn" id="changeItemBtn" style="margin-bottom:14px">← Change item</button>
        <div class="form-row">
          <label class="field"><span class="field-label"><i class="fa-solid fa-barcode"></i> Barcode</span><input class="mono" id="existingBarcode" value="${esc(as.existingBarcode)}" placeholder="Not set — add one" /></label>
          <div class="field"><span class="field-note">${selectedExisting.barcode ? "Update this item's barcode." : "This item has no barcode yet — add one so future scans recognize it."}</span></div>
        </div>` : `
        <div class="form-row">
          <label class="field"><span class="field-label">Item</span><input id="itemSearch" autocomplete="off" placeholder="Type to search ${state.catalog.length} items…" value="${esc(as.itemSearch)}" /></label>
          <div class="field"></div>
        </div>
        <div class="pick-list" style="margin-bottom:14px">${itemSearchResultsHtml()}</div>
        <button type="button" class="link-btn" id="createNewItemBtn" style="margin-bottom:14px">+ Create a new item instead</button>`) : ""}

        ${(as.method === "manual" && as.isNew) || (as.method === "barcode" && as.barcode && !matched) ? `
        <div class="form-row">
          <label class="field"><span class="field-label">Item Name *</span><input id="newName" required value="${esc(as.newDraft.name)}" placeholder="e.g. Anti-RH serum" /></label>
          <label class="field"><span class="field-label">Category</span><select id="newCat">${CATEGORIES.map((c) => `<option ${c === as.newDraft.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
        </div>
        <div class="form-row">
          <label class="field"><span class="field-label">Unit</span><select id="newUnit">${UNITS.map((u) => `<option ${u === as.newDraft.unit ? "selected" : ""}>${u}</option>`).join("")}</select></label>
          <div class="field"><span class="field-note">Unit auto-detects: "CART" in the name → Cartridge, "Reagent"/"KIT" → KIT.</span></div>
        </div>
        ${as.method === "manual" ? `<div class="form-row">
          <label class="field"><span class="field-label"><i class="fa-solid fa-barcode"></i> Barcode (optional)</span><input class="mono" id="newBarcode" value="${esc(as.newBarcode)}" placeholder="Scan or type it now…" /></label>
          <div class="field"><span class="field-note">Set this once so this item is recognized automatically by barcode next time.</span></div>
        </div>` : ""}
        <div class="form-row">
          <label class="field"><span class="field-label">Units per box (from one scan)</span><input type="text" inputmode="decimal" dir="ltr" min="1" id="newUnitsPerBox" value="${esc(as.newDraft.unitsPerBox || 1)}" /></label>
          <label class="field"><span class="field-label">Tests per unit (optional)</span><input type="text" inputmode="decimal" dir="ltr" min="0" id="newTestsPerUnit" value="${esc(as.newDraft.testsPerUnit || "")}" placeholder="e.g. 50" /></label>
        </div>
        <p class="field-note" style="margin:-8px 0 14px">If the box contains more than one cartridge/tube (e.g. a "100 TEST" kit = 2 cartridges of 50 tests), set units per box to 2 so future scans queue 2 at once. Tests per unit is auto-suggested from the number before "TEST" in the name — divided by units per box for "KIT" names (which usually state the box total), kept as-is for "CART" names (which usually state the per-cartridge count). Please double check it before saving.</p>` : ""}

        <div class="form-row">
          <label class="field"><span class="field-label">Lot Number</span><input id="lotInput" placeholder="e.g. 123456" value="${esc(as.lot)}" /></label>
          <label class="field"><span class="field-label">Quantity</span><input type="text" inputmode="decimal" dir="ltr" id="qtyInput2" min="1" value="${esc(as.quantity)}" /></label>
        </div>
        <div class="form-row">
          <label class="field"><span class="field-label">Expiration Date</span><input type="date" id="expiryInput" value="${esc(as.expiry)}" /></label>
          <label class="field"><span class="field-label">Shelf / Position</span><input id="shelfInput" placeholder="e.g. 2-A" value="${esc(as.shelf)}" /></label>
        </div>
        <button type="button" id="btnAddToCart" class="btn secondary full" style="margin-bottom:20px"><i class="fa-solid fa-plus"></i> Add item to batch</button>

        <h3 style="font-size:12.5px;margin:0 0 10px">Batch queue (${as.cart.length} item${as.cart.length === 1 ? "" : "s"})</h3>
        ${cartRowsHtml()}

        <div class="form-row" style="margin-top:16px">
          <label class="field"><span class="field-label">Fridge Unit * <span class="field-note">(applies to the whole batch)</span></span><select id="fridgeSelect" required>
            <option value="" disabled ${!as.fridgeId ? "selected" : ""}>Select…</option>
            ${state.fridges.map((f) => `<option value="${f.id}" ${f.id === as.fridgeId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
          </select></label>
          <label class="field"><span class="field-label">Addition Date</span><input type="date" id="dateInput2" value="${esc(as.addedAt)}" required /></label>
        </div>
        <button type="submit" class="btn primary full" ${as.cart.length === 0 ? "disabled" : ""}>Save ${as.cart.length || ""} item${as.cart.length === 1 ? "" : "s"} to Stock</button>
      </form>
    </div>`;
  }

  function render(focusBarcode) {
    scan = as.method === "barcode" ? scanInfo(as.barcode) : null;
    matched = scan ? scan.item : null;
    if (matched) { as.itemId = matched.id; as.isNew = false; }
    selectedExisting = (as.itemId && !as.isNew) ? state.catalog.find((c) => c.id === as.itemId) : null;
    el("mainContent").innerHTML = body();
    el("entryMethod2").onchange = (e) => { as.method = e.target.value; as.barcode = ""; as.lastAdded = ""; as.lastAddedItem = null; render(true); };
    const bc = el("barcodeInput2");
    if (bc) {
      if (focusBarcode) bc.focus(); // only steal focus right after opening this view, switching to barcode mode,
      // or right after queuing a scanned item (to keep scanning the next box) — never on every render.
      bc.oninput = (e) => { as.barcode = e.target.value; as.lastAdded = ""; as.lastAddedItem = null; }; // track only — re-rendering on every keystroke fights the scanner's fast typing
      const tryMatch = () => {
        const s = scanInfo(bc.value);
        as.lastScannedRaw = bc.value; // kept for display even after the field clears, so we can verify what was actually scanned
        if (s.item) {
          // Known item — queue it straight from the scan, no button press needed. Some boxes contain
          // more than one usable unit (e.g. a kit with 2 cartridges) — unitsPerBox on the catalog item
          // controls how many units one box-scan adds. Clear the field and keep focus for the next scan.
          as.lastAdded = addEntryToCart({ source: "existing", catalogItemId: s.item.id, displayName: s.item.name, displayCategory: s.item.category }, s.lot, s.item.unitsPerBox || 1, s.expiry, "");
          as.lastAddedItem = s.item; // so the scan-result can surface item number / unit / tests per unit
          as.barcode = "";
          render(true);
        } else if (bc.value.trim()) {
          // Not in the catalog yet — a barcode alone can't reveal the item's name, so pre-fill whatever
          // we *could* read (lot/expiry) and let the user type the name once before adding it.
          if (s.lot) as.lot = s.lot;
          if (s.expiry) as.expiry = s.expiry;
          render();
        }
      };
      bc.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); tryMatch(); } };
      bc.onblur = tryMatch;
      const camBtn2 = el("camScanBtn2");
      if (camBtn2) camBtn2.onclick = () => openCameraScanner((code) => { as.barcode = code; bc.value = code; tryMatch(); });
    }
    const itemSearchEl = el("itemSearch");
    if (itemSearchEl) {
      itemSearchEl.oninput = (e) => {
        as.itemSearch = e.target.value;
        render();
        const refocused = el("itemSearch");
        if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
      };
    }
    el("mainContent").querySelectorAll("[data-pick-item]").forEach((b) => b.onclick = () => {
      as.itemId = b.dataset.pickItem; as.isNew = false; as.itemSearch = "";
      const item = state.catalog.find((c) => c.id === as.itemId);
      as.existingBarcode = (item && item.barcode) || "";
      render();
    });
    const changeItemBtn = el("changeItemBtn");
    if (changeItemBtn) changeItemBtn.onclick = () => { as.itemId = ""; as.existingBarcode = ""; render(); };
    const createNewBtn = el("createNewItemBtn");
    if (createNewBtn) createNewBtn.onclick = () => { as.isNew = true; as.itemId = ""; render(); };
    const existingBarcodeEl = el("existingBarcode");
    if (existingBarcodeEl) existingBarcodeEl.oninput = (e) => as.existingBarcode = e.target.value.trim();
    const nameEl = el("newName");
    if (nameEl) nameEl.oninput = (e) => {
      as.newDraft.name = e.target.value;
      // Auto-detect the unit from the name ("CART" -> Cartridge, "Reagent"/"KIT" -> KIT) unless the user picked one themselves.
      if (!as.newDraft.unitTouched) {
        const unitSuggestion = suggestUnit(as.newDraft.name);
        if (unitSuggestion) {
          as.newDraft.unit = unitSuggestion;
          const unitSel = el("newUnit"); if (unitSel) unitSel.value = unitSuggestion;
        }
      }
      // Suggest tests-per-unit from the number preceding "TEST" in the name, unless manually overridden.
      if (!as.newDraft.testsPerUnitTouched) {
        const suggestion = suggestTestsPerUnit(as.newDraft.name, as.newDraft.unitsPerBox);
        if (suggestion !== null) {
          as.newDraft.testsPerUnit = suggestion;
          const tpuSel = el("newTestsPerUnit"); if (tpuSel) tpuSel.value = suggestion;
        }
      }
    };
    const catEl = el("newCat"); if (catEl) catEl.onchange = (e) => as.newDraft.category = e.target.value;
    const newBarcodeEl = el("newBarcode"); if (newBarcodeEl) newBarcodeEl.oninput = (e) => as.newBarcode = e.target.value.trim();
    const unitEl = el("newUnit"); if (unitEl) unitEl.onchange = (e) => { as.newDraft.unit = e.target.value; as.newDraft.unitTouched = true; };
    const upbEl = el("newUnitsPerBox");
    if (upbEl) upbEl.oninput = (e) => {
      as.newDraft.unitsPerBox = e.target.value;
      if (!as.newDraft.testsPerUnitTouched) {
        const suggestion = suggestTestsPerUnit(as.newDraft.name, as.newDraft.unitsPerBox);
        if (suggestion !== null) {
          as.newDraft.testsPerUnit = suggestion;
          const tpuSel = el("newTestsPerUnit"); if (tpuSel) tpuSel.value = suggestion;
        }
      }
    };
    const tpuEl = el("newTestsPerUnit"); if (tpuEl) tpuEl.oninput = (e) => { as.newDraft.testsPerUnit = e.target.value; as.newDraft.testsPerUnitTouched = true; };
    const lotEl = el("lotInput"); if (lotEl) lotEl.oninput = (e) => as.lot = e.target.value;
    const qtyEl = el("qtyInput2"); if (qtyEl) qtyEl.oninput = (e) => as.quantity = e.target.value;
    const expEl = el("expiryInput"); if (expEl) expEl.oninput = (e) => as.expiry = e.target.value;
    const shelfEl = el("shelfInput"); if (shelfEl) shelfEl.oninput = (e) => as.shelf = e.target.value;
    const fridgeEl = el("fridgeSelect"); if (fridgeEl) fridgeEl.onchange = (e) => as.fridgeId = e.target.value;
    const dateEl = el("dateInput2"); if (dateEl) dateEl.onchange = (e) => as.addedAt = e.target.value;

    el("mainContent").querySelectorAll("[data-remove-cart]").forEach((b) => b.onclick = () => { as.cart = as.cart.filter((it) => it.id !== b.dataset.removeCart); render(); });

    el("btnAddToCart").onclick = () => {
      let base;
      if (as.method === "barcode") {
        if (matched) base = { source: "existing", catalogItemId: matched.id, displayName: matched.name, displayCategory: matched.category };
        else {
          const name = el("newName").value.trim();
          if (!name) { toast("Please enter the item name.", "warn"); return; }
          const draft = { name, category: el("newCat").value, unit: el("newUnit").value, barcode: (scan && scan.gtin) || as.barcode.trim(), unitsPerBox: Number(el("newUnitsPerBox").value) || 1, testsPerUnit: el("newTestsPerUnit").value === "" ? "" : Number(el("newTestsPerUnit").value) || 0 };
          base = { source: "new", draft, displayName: name, displayCategory: draft.category };
        }
      } else {
        if (as.isNew) {
          const name = el("newName").value.trim();
          if (!name) { toast("Please enter the item name.", "warn"); return; }
          const draft = { name, category: el("newCat").value, unit: el("newUnit").value, barcode: as.newBarcode || "", unitsPerBox: Number(el("newUnitsPerBox").value) || 1, testsPerUnit: el("newTestsPerUnit").value === "" ? "" : Number(el("newTestsPerUnit").value) || 0 };
          base = { source: "new", draft, displayName: name, displayCategory: draft.category };
        } else {
          if (!as.itemId) { toast("Please select an item.", "warn"); return; }
          const item = state.catalog.find((c) => c.id === as.itemId);
          const newBarcodeVal = (as.existingBarcode || "").trim();
          if (newBarcodeVal && newBarcodeVal !== (item.barcode || "")) {
            const clash = state.catalog.find((c) => c.id !== item.id && c.barcode === newBarcodeVal);
            if (clash) { toast(`That barcode is already linked to "${clash.name}". Please use a different one.`, "warn"); return; }
            upsertCatalogItem({ id: item.id, barcode: newBarcodeVal }).catch((err) => console.error("barcode update failed:", err));
            item.barcode = newBarcodeVal; // reflect immediately, the listener will confirm shortly after
          }
          base = { source: "existing", catalogItemId: item.id, displayName: item.name, displayCategory: item.category };
        }
      }
      as.lastAdded = addEntryToCart(base, el("lotInput").value.trim(), el("qtyInput2").value, el("expiryInput").value, el("shelfInput").value.trim());
      // Reset the per-item fields so the next scan/selection starts clean, but keep the shared fridge/date.
      as.itemId = ""; as.barcode = ""; as.isNew = false; as.itemSearch = ""; as.existingBarcode = "";
      as.newDraft = { name: "", category: CATEGORIES[0], unit: UNITS[0], unitTouched: false, unitsPerBox: 1, testsPerUnit: "", testsPerUnitTouched: false }; as.newBarcode = "";
      as.lot = ""; as.quantity = 1; as.expiry = ""; as.shelf = "";
      render(as.method === "barcode");
    };

    el("additionForm").onsubmit = async (e) => {
      e.preventDefault();
      if (as.cart.length === 0) { toast("Add at least one item to the batch first.", "warn"); return; }
      const fridgeId = el("fridgeSelect").value;
      if (!fridgeId) { toast("Please select a fridge unit.", "warn"); return; }
      const addedAt = el("dateInput2").value || todayStr();
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.textContent = "Saving…";
      try {
        const saved = [];
        for (const it of as.cart) {
          const catalogItem = it.source === "existing" ? state.catalog.find((c) => c.id === it.catalogItemId) : it.draft;
          const batch = await receiveBatch({
            catalogItem, fridgeId, shelf: it.shelf,
            quantity: it.quantity, expiry: it.expiry, lot: it.lot, notes: "",
            method: as.method === "barcode" ? "Barcode" : "Manual",
            addedAt,
          });
          saved.push({ batchId: batch.id, name: it.displayName, lot: it.lot, hadBarcode: as.method === "barcode" && !!(catalogItem && catalogItem.barcode) });
        }
        as.cart = []; as.itemId = ""; as.barcode = ""; as.isNew = false; as.lastAdded = ""; as.itemSearch = ""; as.existingBarcode = "";
        as.newDraft = { name: "", category: CATEGORIES[0], unit: UNITS[0], unitTouched: false, unitsPerBox: 1, testsPerUnit: "", testsPerUnitTouched: false }; as.newBarcode = "";
        as.lot = ""; as.quantity = 1; as.expiry = ""; as.shelf = "";
        render();
        // Items received without their own manufacturer barcode scan get an inline offer to print a
        // batch-specific label right away — that label is what Dispense will recognize for this lot.
        const needsLabel = saved.filter((s) => !s.hadBarcode);
        if (needsLabel.length) {
          const box = document.createElement("div");
          box.className = "scan-result";
          box.style.cssText = "border-color:#7cb342;margin-bottom:14px";
          box.innerHTML = `<div class="scan-result-row"><span class="v">✓ ${esc(String(saved.length))} item${saved.length === 1 ? "" : "s"} added to stock. Print a lot label for the item(s) below so Dispense can recognize this exact batch:</span></div>` +
            needsLabel.map((s) => `<div class="scan-result-row"><span class="v">${esc(s.name)}${s.lot ? " · Lot " + esc(s.lot) : ""}</span><button type="button" class="btn secondary" data-print-new="${esc(s.batchId)}" style="margin-inline-start:10px">Print label</button></div>`).join("");
          el("mainContent").prepend(box);
          box.querySelectorAll("[data-print-new]").forEach((b) => b.onclick = () => printBatchLabel(b.dataset.printNew));
        } else {
          toast(`${saved.length} item${saved.length === 1 ? "" : "s"} added to stock successfully.`, "success");
        }
      } catch (err) {
        console.error("receiveBatch failed:", err);
        toast("Failed to save: " + (err && err.message ? err.message : err), "error");
        submitBtn.disabled = false; submitBtn.textContent = `Save ${as.cart.length} item${as.cart.length === 1 ? "" : "s"} to Stock`;
      }
    };
  }
  render(true);
}

/* ---------------------------------------------------------------------
   MERGE LOTS
--------------------------------------------------------------------- */
function renderMergeView() {
  const ms = { itemId: "", sourceId: "", targetId: "", unit: "" };
  const mergeableItems = state.catalog.filter((c) => state.batches.filter((b) => b.catalogItemId === c.id).length >= 2);

  function body() {
    const itemBatches = state.batches.filter((b) => b.catalogItemId === ms.itemId);
    const source = itemBatches.find((b) => b.id === ms.sourceId);
    const targets = itemBatches.filter((b) => b.id !== ms.sourceId);

    const sorted = [...state.merges].sort((a, b) => (a.date < b.date ? 1 : -1));

    return `
    <div class="page-header"><div><h2>Merge Lots</h2><span class="subtitle">Transfer remaining quantity between active lots of the same reagent</span></div></div>
    <div class="card-form">
      <form id="mergeForm">
        <label class="field" style="margin-bottom:14px"><span class="field-label">Select Item</span>
          <select id="mergeItem"><option value="">Select item…</option>${mergeableItems.map((c) => `<option value="${c.id}" ${c.id === ms.itemId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
          ${mergeableItems.length === 0 ? `<span class="field-note">No reagent currently has two or more separate lots to merge.</span>` : ""}
        </label>
        <div class="form-row">
          <label class="field"><span class="field-label">Source Lot (deduct from)</span><select id="mergeSource" ${!ms.itemId ? "disabled" : ""}>
            <option value="">Select…</option>${itemBatches.map((b) => `<option value="${b.id}" ${b.id === ms.sourceId ? "selected" : ""}>${esc(batchLabel(b))}</option>`).join("")}</select></label>
          <label class="field"><span class="field-label">Target Lot (add to)</span><select id="mergeTarget" ${!ms.sourceId ? "disabled" : ""}>
            <option value="">Select…</option>${targets.map((b) => `<option value="${b.id}" ${b.id === ms.targetId ? "selected" : ""}>${esc(batchLabel(b))}</option>`).join("")}</select></label>
        </div>
        <label class="field" style="margin-bottom:14px"><span class="field-label">Transfer Quantity ${source ? `(max ${maxQtyInUnit(source, catalogById(source.catalogItemId), ms.unit)} ${esc(ms.unit)})` : ""}</span>
          <input type="text" inputmode="decimal" dir="ltr" id="mergeQty" min="0.01" step="any" max="${source ? maxQtyInUnit(source, catalogById(source.catalogItemId), ms.unit) : ""}" value="1" required /></label>
        <div class="form-row" style="margin-bottom:14px">
          <label class="field"><span class="field-label">Unit</span><select id="mergeUnit" ${!source ? "disabled" : ""}>${unitOptionsForItem(source ? catalogById(source.catalogItemId) : null).map((u) => `<option ${u === ms.unit ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
          <div class="field"></div>
        </div>
        <button type="submit" class="btn primary full">Execute Merge</button>
      </form>
    </div>

    <h3 style="margin:26px 0 12px;font-size:14px">Merge History</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Item</th><th>Source Lot</th><th>Target Lot</th><th>Quantity</th><th>Merged By</th></tr></thead>
      <tbody>${sorted.length === 0 ? `<tr><td colspan="6" class="table-empty">No merges recorded yet</td></tr>` : sorted.map((m) => `
        <tr><td class="mono">${esc(m.date)}</td><td>${esc(m.itemName)}</td><td class="mono">${esc(m.sourceLot)}</td><td class="mono">${esc(m.targetLot)}</td><td class="mono">${m.quantity} ${esc(m.unit || "")}</td><td>${esc(nameForEmail(m.byEmail))}</td></tr>`).join("")}
      </tbody>
    </table></div>`;
  }

  function render() {
    el("mainContent").innerHTML = body();
    el("mergeItem").onchange = (e) => { ms.itemId = e.target.value; ms.sourceId = ""; ms.targetId = ""; ms.unit = ""; render(); };
    el("mergeSource").onchange = (e) => {
      ms.sourceId = e.target.value; ms.targetId = "";
      const source = state.batches.find((b) => b.id === ms.sourceId);
      ms.unit = source ? unitOptionsForItem(catalogById(source.catalogItemId))[0] : "";
      render();
    };
    const targetSel = el("mergeTarget"); if (targetSel) targetSel.onchange = (e) => { ms.targetId = e.target.value; render(); };
    const unitSel = el("mergeUnit"); if (unitSel) unitSel.onchange = (e) => { ms.unit = e.target.value; render(); };

    el("mergeForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!ms.sourceId || !ms.targetId) { toast("Please select both a source and a target lot.", "warn"); return; }
      const source = state.batches.find((b) => b.id === ms.sourceId);
      if (!source) return;
      const cat = catalogById(source.catalogItemId);
      const unit = ms.unit || (cat ? cat.unit : "");
      const qty = Number(el("mergeQty").value) || 0;
      if (qty <= 0 || qty > maxQtyInUnit(source, cat, unit)) { toast("Invalid transfer quantity.", "error"); return; }
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.textContent = "Saving…";
      try {
        await mergeLots(ms.sourceId, ms.targetId, qty, unit);
        toast("Merge completed successfully.", "success");
        ms.itemId = ""; ms.sourceId = ""; ms.targetId = ""; ms.unit = ""; render();
      } catch (err) {
        console.error("mergeLots failed:", err);
        toast("Failed to save: " + (err && err.message ? err.message : err), "error");
        submitBtn.disabled = false; submitBtn.textContent = "Execute Merge";
      }
    };
  }
  render();
}

/* ---------------------------------------------------------------------
   TRANSFERS (between branches)
--------------------------------------------------------------------- */
function renderTransfersView() {
  const ts = { itemId: "", batchId: "", quantity: 1, unit: "", toBranchId: "", itemSearch: "" };
  const myBranch = state.managedBranchId || state.myBranchId || null;

  function itemSearchResultsHtml() {
    const list = itemsInStock();
    const q = ts.itemSearch.trim().toLowerCase();
    const filtered = (q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list).slice(0, 30);
    if (filtered.length === 0) return `<div class="pick-empty">No matching items in stock</div>`;
    return filtered.map((c) => `<button type="button" class="pick-item" data-pick-transfer-item="${c.id}"><span>${esc(c.name)}</span><span style="color:var(--text-faint);font-size:11px">${esc(c.category)}</span></button>`).join("");
  }
  function lotOptions() {
    if (!ts.itemId) return `<option value="">Select item first…</option>`;
    const batches = state.batches.filter((b) => b.catalogItemId === ts.itemId);
    if (batches.length === 0) return `<option value="">No stock available</option>`;
    return `<option value="">Select lot…</option>` + batches.map((b) => `<option value="${b.id}" ${b.id === ts.batchId ? "selected" : ""}>${esc(batchLabel(b))}</option>`).join("");
  }
  let selectedBatch = null;

  function transferRow(t, kind) {
    const st = { pending: STATUS_STYLES.watch, received: STATUS_STYLES.ok, cancelled: STATUS_STYLES.none }[t.status] || STATUS_STYLES.none;
    const label = t.status === "pending" ? "Pending" : t.status === "received" ? "Received" : "Cancelled";
    return `<tr>
      <td>${esc(t.itemName)}</td><td class="mono">${esc(t.lot || "—")}</td><td class="mono">${t.quantity} ${esc(t.unit || "")}</td>
      <td>${esc(t.fromBranchName || "—")}</td><td>${esc(t.toBranchName || "—")}</td>
      <td><span class="badge" style="background:${st.bg};color:${st.text};border-color:${st.border}">${label}</span></td>
      <td class="mono">${esc((t.createdAt || "").slice(0, 16))}</td>
      <td>${kind === "incoming" && t.status === "pending" ? `<button type="button" class="btn secondary" style="padding:5px 10px;font-size:12px" data-receive="${t.id}">Receive</button>` : ""}
          ${kind === "outgoing" && t.status === "pending" ? `<button type="button" class="btn secondary" style="padding:5px 10px;font-size:12px" data-cancel-transfer="${t.id}">Cancel</button>` : ""}</td>
    </tr>`;
  }

  function body() {
    const incoming = pendingTransfersForMe();
    const outgoingAll = [...state.transfers].filter((t) => state.role === "master" || t.fromBranchId === myBranch || t.createdBy === state.user.email).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const incomingHistory = [...state.transfers].filter((t) => state.role === "master" || t.toBranchId === myBranch).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return `
    <div class="page-header"><div><h2>Transfers</h2><span class="subtitle">Send stock to another branch, or receive what's been sent to yours</span></div></div>
    <div class="card-form">
      <form id="transferForm">
        ${ts.itemId ? `
        <div class="scan-result" style="border-color:#3b6fe0;margin-bottom:10px">
          <div class="scan-result-row"><span class="k">Selected item</span><span class="v">${esc(itemsInStock().find((c) => c.id === ts.itemId)?.name || "")}</span></div>
        </div>
        <button type="button" class="link-btn" id="tsChangeItem" style="margin-bottom:14px">← Change item</button>
        <div class="form-row">
          <div class="field"></div>
          <label class="field"><span class="field-label">Select Lot</span><select id="tsLot">${lotOptions()}</select></label>
        </div>` : `
        <div class="form-row">
          <label class="field"><span class="field-label">Select Item</span><input id="tsItemSearch" autocomplete="off" placeholder="Type to search ${itemsInStock().length} items…" value="${esc(ts.itemSearch)}" /></label>
          <label class="field"><span class="field-label">Select Lot</span><select disabled><option>Select item first…</option></select></label>
        </div>
        <div class="pick-list" style="margin-bottom:14px">${itemSearchResultsHtml()}</div>`}
        <div class="form-row">
          <label class="field"><span class="field-label">Quantity ${selectedBatch ? `(max ${maxQtyInUnit(selectedBatch, catalogById(selectedBatch.catalogItemId), ts.unit)} ${esc(ts.unit)})` : ""}</span><input type="text" inputmode="decimal" dir="ltr" id="tsQty" min="0.01" step="any" max="${selectedBatch ? maxQtyInUnit(selectedBatch, catalogById(selectedBatch.catalogItemId), ts.unit) : ""}" value="${esc(ts.quantity)}" required /></label>
          <label class="field"><span class="field-label">Unit</span><select id="tsUnit" ${!selectedBatch ? "disabled" : ""}>${unitOptionsForItem(selectedBatch ? catalogById(selectedBatch.catalogItemId) : null).map((u) => `<option ${u === ts.unit ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
        </div>
        <div class="form-row">
          <label class="field"><span class="field-label">Send to Branch *</span><select id="tsBranch" required>
            <option value="" disabled ${!ts.toBranchId ? "selected" : ""}>Select…</option>
            ${state.branches.filter((b) => b.id !== myBranch).map((b) => `<option value="${b.id}" ${b.id === ts.toBranchId ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
          </select></label>
          <div class="field"></div>
        </div>
        ${state.branches.length === 0 ? `<p class="field-note">No branches set up yet — ask the Master to add one from "Branches".</p>` : ""}
        <button type="submit" class="btn primary full">Send Transfer</button>
      </form>
    </div>

    ${incoming.length > 0 ? `<h3 style="margin:26px 0 12px;font-size:14px">Incoming — needs receiving (${incoming.length})</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item</th><th>Lot</th><th>Qty</th><th>From</th><th>To</th><th>Status</th><th>Sent</th><th></th></tr></thead>
      <tbody>${incoming.map((t) => transferRow(t, "incoming")).join("")}</tbody>
    </table></div>` : ""}

    <h3 style="margin:26px 0 12px;font-size:14px">Outgoing transfers</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item</th><th>Lot</th><th>Qty</th><th>From</th><th>To</th><th>Status</th><th>Sent</th><th></th></tr></thead>
      <tbody>${outgoingAll.length === 0 ? `<tr><td colspan="8" class="table-empty">No transfers sent yet</td></tr>` : outgoingAll.map((t) => transferRow(t, "outgoing")).join("")}</tbody>
    </table></div>

    <h3 style="margin:26px 0 12px;font-size:14px">Incoming history</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item</th><th>Lot</th><th>Qty</th><th>From</th><th>To</th><th>Status</th><th>Sent</th><th></th></tr></thead>
      <tbody>${incomingHistory.length === 0 ? `<tr><td colspan="8" class="table-empty">No transfers received yet</td></tr>` : incomingHistory.map((t) => transferRow(t, "incoming")).join("")}</tbody>
    </table></div>`;
  }

  function render() {
    selectedBatch = state.batches.find((b) => b.id === ts.batchId);
    el("mainContent").innerHTML = body();
    if (ts.itemId) {
      el("tsChangeItem").onclick = () => { ts.itemId = ""; ts.batchId = ""; ts.unit = ""; ts.itemSearch = ""; render(); };
      const lotEl = el("tsLot"); if (lotEl) lotEl.onchange = (e) => {
        ts.batchId = e.target.value;
        const b = state.batches.find((x) => x.id === ts.batchId);
        ts.unit = b ? unitOptionsForItem(catalogById(b.catalogItemId))[0] : "";
        render();
      };
    } else {
      const searchEl = el("tsItemSearch");
      if (searchEl) {
        searchEl.oninput = (e) => {
          ts.itemSearch = e.target.value;
          render();
          const refocused = el("tsItemSearch");
          if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
        };
      }
      el("mainContent").querySelectorAll("[data-pick-transfer-item]").forEach((b) => b.onclick = () => { ts.itemId = b.dataset.pickTransferItem; ts.batchId = ""; ts.unit = ""; ts.itemSearch = ""; render(); });
    }
    const qtyEl = el("tsQty"); if (qtyEl) qtyEl.oninput = (e) => ts.quantity = e.target.value;
    const unitEl = el("tsUnit"); if (unitEl) unitEl.onchange = (e) => { ts.unit = e.target.value; render(); };
    const branchEl = el("tsBranch"); if (branchEl) branchEl.onchange = (e) => ts.toBranchId = e.target.value;

    el("mainContent").querySelectorAll("[data-receive]").forEach((b) => b.onclick = () => openReceiveModal(b.dataset.receive));
    el("mainContent").querySelectorAll("[data-cancel-transfer]").forEach((b) => b.onclick = async () => {
      if (!confirm("Cancel this transfer and restore the stock to its original fridge?")) return;
      try { await cancelTransfer(b.dataset.cancelTransfer); } catch (err) { toast("Failed to cancel: " + (err && err.message ? err.message : err), "error"); }
    });

    el("transferForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!selectedBatch) { toast("Please select an item and lot.", "warn"); return; }
      const cat = catalogById(selectedBatch.catalogItemId);
      const unit = ts.unit || (cat ? cat.unit : "");
      const enteredQty = Number(el("tsQty").value) || 0;
      const maxInUnit = maxQtyInUnit(selectedBatch, cat, unit);
      if (enteredQty <= 0) { toast("Enter a quantity greater than 0.", "warn"); return; }
      if (enteredQty > maxInUnit) {
        toast(`Only ${maxInUnit} ${unit} available in this lot — you entered ${enteredQty}.`, "error");
        return;
      }
      const qty = enteredQty;
      const toBranchId = el("tsBranch").value;
      if (!toBranchId) { toast("Please select a destination branch.", "warn"); return; }
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.textContent = "Sending…";
      try {
        await sendTransfer(selectedBatch.id, qty, unit, toBranchId);
        toast("Transfer sent — it will show as pending for the receiving branch.", "success");
        ts.itemId = ""; ts.batchId = ""; ts.quantity = 1; ts.unit = ""; ts.toBranchId = ""; render();
      } catch (err) {
        console.error("sendTransfer failed:", err);
        toast("Failed to send: " + (err && err.message ? err.message : err), "error");
        submitBtn.disabled = false; submitBtn.textContent = "Send Transfer";
      }
    };
  }
  render();
}
function openReceiveModal(transferId) {
  const t = state.transfers.find((x) => x.id === transferId);
  if (!t) return;
  openModal(`<div class="modal fade-in" style="max-width:380px" onclick="event.stopPropagation()">
      <div class="modal-head"><span class="modal-title">Receive transfer</span><button class="btn ghost icon-only" id="mClose">✕</button></div>
      <form id="receiveForm"><div class="modal-body">
          <div class="scan-result" style="border-color:var(--border)">
            <div class="scan-result-row"><span class="k">Item</span><span class="v">${esc(t.itemName)}</span></div>
            <div class="scan-result-row"><span class="k">Lot / Expiry</span><span class="v mono">${esc(t.lot || "—")} · ${esc(t.expiry || "—")}</span></div>
            <div class="scan-result-row"><span class="k">Quantity</span><span class="v mono">${t.quantity} ${esc(t.unit || "")}</span></div>
            <div class="scan-result-row"><span class="k">From</span><span class="v">${esc(t.fromBranchName || "—")}</span></div>
          </div>
          ${fieldHtml("Fridge unit *", `<select required id="rFridge"><option value="" disabled selected>Select…</option>${state.fridges.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}</select>`)}
          ${fieldHtml("Shelf / position", `<input id="rShelf" placeholder="e.g. 2-A" />`)}
        </div>
        <div class="modal-foot"><button type="button" class="btn secondary" id="mCancel">Cancel</button><button type="submit" class="btn primary">Confirm receipt</button></div>
      </form></div>`);
  el("mClose").onclick = closeModal; el("mCancel").onclick = closeModal;
  el("receiveForm").onsubmit = async (e) => {
    e.preventDefault();
    const fridgeId = el("rFridge").value;
    if (!fridgeId) { toast("Please select a fridge unit.", "warn"); return; }
    try { await receiveTransfer(transferId, fridgeId, el("rShelf").value.trim()); closeModal(); }
    catch (err) { toast("Failed to receive: " + (err && err.message ? err.message : err), "error"); }
  };
}

/* ---------------------------------------------------------------------
   EXPIRED ITEMS
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   REORDER LIST — catalog items whose total stock has fallen below the
   Safety Limit configured for them in the Catalog editor.
--------------------------------------------------------------------- */
function renderReorderView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const branchFilter = isMaster ? (state.ui.reorderBranch || "") : (myBranch || "");
  const list = itemsBelowSafetyLimit(branchFilter || null);
  const stockOf = (id) => branchFilter ? totalStockForBranch(id, branchFilter) : totalStockFor(id);
  const draft = state.ui.orderDraft || [];
  const savedOrders = [...state.orderRequests].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  function orderCatalogPickHtml() {
    const q = (state.ui.orderCatalogSearch || "").trim().toLowerCase();
    const items = (q ? state.catalog.filter((c) => c.name.toLowerCase().includes(q)) : state.catalog).slice(0, 30);
    if (!q) return `<div class="pick-empty">Type to search the catalog…</div>`;
    if (items.length === 0) return `<div class="pick-empty">No matching catalog items</div>`;
    return items.map((c) => `<button type="button" class="pick-item" data-pick-order-item="${c.id}"><span>${esc(c.name)}</span><span style="color:var(--text-faint);font-size:11px">${esc(c.category)}</span></button>`).join("");
  }
  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Reorder List</h2><span class="subtitle">Catalog items currently below their configured Safety Limit — biggest shortfall first</span></div>
      ${list.length ? `<button class="btn export" id="exportReorder"><i class="fa-solid fa-file-excel"></i> Export to Excel</button>` : ""}</div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <select id="reorderBranch" style="width:auto"><option value="">All branches (org-wide total)</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>
    </div>` : ""}
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item Name</th><th>Category</th><th>Current Stock</th><th>Safety Limit</th><th>Short By</th><th>Unit</th><th>Supplier</th><th>Last Order</th></tr></thead>
      <tbody>${list.length === 0 ? `<tr><td colspan="8" class="table-empty">Nothing to reorder — every tracked item is above its safety limit. Set a Safety Limit on an item from the Catalog to start tracking it here.</td></tr>` : list.map((c) => {
        const stock = stockOf(c.id);
        const short = round4(Number(c.safetyLimit) - stock);
        const lastOrder = lastReceivedFor(c.id, branchFilter || null);
        return `<tr>
          <td>${esc(c.name)}</td>
          <td>${esc(c.category)}</td>
          <td class="mono">${stock}</td>
          <td class="mono">${c.safetyLimit}</td>
          <td class="mono" style="color:var(--danger)">${short}</td>
          <td>${esc(c.unit)}</td>
          <td>${esc(c.supplier || "—")}</td>
          <td class="mono">${lastOrder ? `${esc(lastOrder.date || "").slice(0, 10)} · ${lastOrder.quantity} ${esc(c.unit)}` : "—"}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>

    <div class="panel-card" style="margin-top:24px">
      <div class="page-header" style="margin-bottom:14px">
        <div><h3 style="margin:0">Add Order</h3><span class="subtitle">Build a list of items to order — paste from Excel or pick from the catalog. No lot number or expiry needed yet.</span></div>
      </div>
      <label class="field" style="margin-bottom:10px">
        <span class="field-label">Paste items (one per line — "Item name" or "Item name, Quantity")</span>
        <textarea id="orderPasteBox" rows="4" placeholder="Beckman DXI Vitamin D Reagent KIT/ 100 TEST, 3&#10;Serum Separator Tubes, 10"></textarea>
      </label>
      <button type="button" class="btn secondary" id="btnParsePaste" style="margin-bottom:18px"><i class="fa-solid fa-paste"></i> Add pasted lines</button>

      <div class="form-row" style="align-items:end">
        <label class="field"><span class="field-label">Or pick from catalog</span>
          <input id="orderCatalogSearch" autocomplete="off" placeholder="Type to search ${state.catalog.length} items…" value="${esc(state.ui.orderCatalogSearch || "")}" />
        </label>
        <label class="field" style="max-width:120px"><span class="field-label">Quantity</span><input type="number" min="1" id="orderPickQty" value="${state.ui.orderPickQty || 1}" /></label>
      </div>
      <div class="pick-list" id="orderPickResults" style="margin-bottom:18px">${orderCatalogPickHtml()}</div>

      <div class="table-wrap" style="margin-bottom:16px">
        <table class="data-table">
          <thead><tr><th>Item</th><th>Item Number</th><th>Category</th><th>Quantity</th><th>Unit</th><th></th></tr></thead>
          <tbody>${draft.length === 0 ? `<tr><td colspan="6" class="table-empty">No items added yet.</td></tr>` : draft.map((it, idx) => `
            <tr>
              <td>${esc(it.name)}${it.catalogItemId ? "" : ` <span style="color:var(--text-faint);font-size:11px">(not in catalog)</span>`}</td>
              <td class="mono">${esc(it.itemNumber || "—")}</td>
              <td>${esc(it.category || "—")}</td>
              <td><input type="number" min="1" class="mono" style="width:70px" data-qty-idx="${idx}" value="${it.quantity}" /></td>
              <td>${esc(it.unit || "—")}</td>
              <td><button class="icon-btn-sm" data-remove-idx="${idx}" title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn export" id="btnExportDraft" ${draft.length ? "" : "disabled"}><i class="fa-solid fa-file-excel"></i> Export to Excel</button>
        <button class="btn primary" id="btnSaveOrder" ${draft.length ? "" : "disabled"}><i class="fa-solid fa-floppy-disk"></i> Save Order</button>
        ${draft.length ? `<button type="button" class="btn ghost" id="btnClearDraft">Clear all</button>` : ""}
      </div>
    </div>

    <div class="panel-card" style="margin-top:24px">
      <div class="page-header" style="margin-bottom:10px"><div><h3 style="margin:0">Saved Orders</h3><span class="subtitle">Order lists saved by anyone on your team</span></div></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date</th><th>Branch</th><th>Items</th><th>Created by</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${savedOrders.length === 0 ? `<tr><td colspan="6" class="table-empty">No saved orders yet.</td></tr>` : savedOrders.map((o) => `
          <tr>
            <td class="mono">${esc((o.createdAt || "").slice(0, 16))}</td>
            <td>${esc(o.branchName || "—")}</td>
            <td>${(o.items || []).length} item${(o.items || []).length === 1 ? "" : "s"}</td>
            <td>${esc(nameForEmail(o.createdBy))}</td>
            <td>${o.status === "ordered" ? `<span class="badge" style="background:${STATUS_STYLES.ok.bg};color:${STATUS_STYLES.ok.text};border-color:${STATUS_STYLES.ok.border}">Ordered</span>` : `<span class="badge" style="background:${STATUS_STYLES.watch.bg};color:${STATUS_STYLES.watch.text};border-color:${STATUS_STYLES.watch.border}">Open</span>`}</td>
            <td>
              <button class="icon-btn-sm" data-export-order="${o.id}" title="Export"><i class="fa-solid fa-file-excel"></i></button>
              ${o.status !== "ordered" ? `<button class="icon-btn-sm" data-mark-ordered="${o.id}" title="Mark as done"><i class="fa-solid fa-check"></i></button>` : ""}
              <button class="icon-btn-sm" data-del-order="${o.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>`;
  const branchEl = el("reorderBranch"); if (branchEl) branchEl.onchange = (e) => { state.ui.reorderBranch = e.target.value; renderReorderView(); };
  const exportBtn = el("exportReorder");
  if (exportBtn) exportBtn.onclick = () => {
    const headers = ["Item Name", "Category", "Current Stock", "Safety Limit", "Short By", "Unit", "Supplier", "Last Order Date", "Last Order Qty"];
    const data = list.map((c) => {
      const stock = stockOf(c.id);
      const lastOrder = lastReceivedFor(c.id, branchFilter || null);
      return [c.name, c.category, stock, c.safetyLimit, round4(Number(c.safetyLimit) - stock), c.unit, c.supplier || "", lastOrder ? (lastOrder.date || "").slice(0, 10) : "", lastOrder ? lastOrder.quantity : ""];
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reorder List");
    XLSX.writeFile(wb, "reorder_list.xlsx");
  };

  // ---- Add Order builder ----
  el("btnParsePaste").onclick = () => {
    const box = el("orderPasteBox");
    const parsed = parseOrderPaste(box.value);
    if (parsed.length === 0) { toast("Paste at least one item line first.", "warn"); return; }
    state.ui.orderDraft = [...draft, ...parsed];
    box.value = "";
    renderReorderView();
  };
  const catSearchEl = el("orderCatalogSearch");
  catSearchEl.oninput = (e) => {
    state.ui.orderCatalogSearch = e.target.value;
    renderReorderView();
    const refocused = el("orderCatalogSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("orderPickQty").onchange = (e) => { state.ui.orderPickQty = Number(e.target.value) || 1; };
  el("mainContent").querySelectorAll("[data-pick-order-item]").forEach((b) => b.onclick = () => {
    const c = state.catalog.find((x) => x.id === b.dataset.pickOrderItem);
    if (!c) return;
    const qty = Number(el("orderPickQty").value) || 1;
    state.ui.orderDraft = [...draft, { catalogItemId: c.id, name: c.name, itemNumber: c.itemNumber || "", unit: c.unit || "", category: c.category || "", supplier: c.supplier || "", quantity: qty }];
    state.ui.orderCatalogSearch = "";
    renderReorderView();
  });
  el("mainContent").querySelectorAll("[data-qty-idx]").forEach((inp) => inp.onchange = (e) => {
    const idx = Number(inp.dataset.qtyIdx);
    if (state.ui.orderDraft[idx]) state.ui.orderDraft[idx].quantity = Math.max(1, Number(e.target.value) || 1);
  });
  el("mainContent").querySelectorAll("[data-remove-idx]").forEach((b) => b.onclick = () => {
    state.ui.orderDraft = draft.filter((_, i) => i !== Number(b.dataset.removeIdx));
    renderReorderView();
  });
  const clearBtn = el("btnClearDraft");
  if (clearBtn) clearBtn.onclick = () => { state.ui.orderDraft = []; renderReorderView(); };
  const exportDraftBtn = el("btnExportDraft");
  if (exportDraftBtn) exportDraftBtn.onclick = () => { if (draft.length) exportOrderItemsToExcel(draft, "order_draft.xlsx"); };
  const saveOrderBtn = el("btnSaveOrder");
  if (saveOrderBtn) saveOrderBtn.onclick = async () => {
    if (draft.length === 0) return;
    saveOrderBtn.disabled = true;
    try {
      await saveOrderRequest(draft, branchFilter || myBranch || null);
      state.ui.orderDraft = [];
      toast("Order saved.", "success");
      renderReorderView();
    } catch (err) {
      toast("Failed to save order: " + (err && err.message ? err.message : err), "error");
      saveOrderBtn.disabled = false;
    }
  };

  // ---- Saved orders actions ----
  el("mainContent").querySelectorAll("[data-export-order]").forEach((b) => b.onclick = () => {
    const o = state.orderRequests.find((x) => x.id === b.dataset.exportOrder);
    if (o) exportOrderItemsToExcel(o.items || [], `order_${(o.createdAt || "").slice(0, 10)}.xlsx`);
  });
  el("mainContent").querySelectorAll("[data-mark-ordered]").forEach((b) => b.onclick = () => setOrderRequestStatus(b.dataset.markOrdered, "ordered"));
  el("mainContent").querySelectorAll("[data-del-order]").forEach((b) => b.onclick = () => { if (confirm("Delete this saved order?")) deleteOrderRequest(b.dataset.delOrder); });
}

/** Parses pasted, Excel-style lines into draft order rows: "Item name" or "Item name, Qty" per
 *  line (also accepts a tab or 2+ spaces as the separator, so a straight paste from a spreadsheet
 *  works too). Matches each name against the catalog when possible so item number/unit/category
 *  come along automatically; unmatched names are kept as free-text rows. */
function parseOrderPaste(text) {
  return (text || "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\t|,|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    let qty = 1, name = line;
    if (parts.length >= 2 && /^[\d.]+$/.test(parts[parts.length - 1])) {
      qty = Number(parts[parts.length - 1]);
      name = parts.slice(0, -1).join(" ");
    }
    const match = state.catalog.find((c) => c.name.toLowerCase() === name.toLowerCase())
      || state.catalog.find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
    return match
      ? { catalogItemId: match.id, name: match.name, itemNumber: match.itemNumber || "", unit: match.unit || "", category: match.category || "", supplier: match.supplier || "", quantity: qty }
      : { catalogItemId: null, name, itemNumber: "", unit: "", category: "", supplier: "", quantity: qty };
  });
}
/** Persists a built order list — deliberately has no lot/expiry fields, since nothing has
 *  arrived yet; that gets recorded normally through Addition once the order is received. */
async function saveOrderRequest(items, branchId) {
  await db.collection("orderRequests").add({
    branchId: branchId || null, branchName: branchName(branchId), items, status: "open",
    createdAt: nowStr(), createdBy: state.user.email,
  });
}
async function setOrderRequestStatus(id, status) { await db.collection("orderRequests").doc(id).set({ status }, { merge: true }); }
async function deleteOrderRequest(id) { await db.collection("orderRequests").doc(id).delete(); }
function exportOrderItemsToExcel(items, filename) {
  const headers = ["Item number", "Product name", "Quantity", "Unit", "Category", "Supplier"];
  const data = items.map((i) => [i.itemNumber || "", i.name, i.quantity, i.unit || "", i.category || "", i.supplier || ""]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Order");
  XLSX.writeFile(wb, filename || "order.xlsx");
}

function renderExpiredView() {
  const list = state.batches
    .map((b) => ({ ...b, cat: catalogById(b.catalogItemId) || { name: "(deleted item)", unit: "" } }))
    .filter((b) => statusOf(b.expiry).key === "expired")
    .sort((a, b) => (a.expiry < b.expiry ? -1 : 1));

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Expired Items</h2><span class="subtitle">Items that have passed their expiration date</span></div>
      <button class="btn export" id="exportExp"><i class="fa-solid fa-file-csv"></i> Export CSV</button></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item Name</th><th>Lot Number</th><th>Quantity</th><th>Expiration Date</th><th>Location</th><th>Actions</th></tr></thead>
      <tbody>${list.length === 0 ? `<tr><td colspan="6" class="table-empty">No expired items 🎉</td></tr>` : list.map((b) => `
        <tr><td>${esc(b.cat.name)}</td><td class="mono">${esc(b.lot || "—")}</td><td class="mono">${b.quantity} ${esc(b.cat.unit)}</td>
        <td class="mono" style="color:var(--danger-text)">${esc(b.expiry)}</td><td>${esc(fridgeName(b.fridgeId))}${b.shelf ? " · " + esc(b.shelf) : ""}</td>
        <td><button class="icon-btn-sm" data-del-batch="${b.id}" title="Remove"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}
      </tbody></table></div>`;

  el("exportExp").onclick = () => downloadCSV("expired_items.csv", ["Item Name", "Lot Number", "Quantity", "Expiry Date", "Fridge", "Shelf"],
    list.map((b) => [b.cat.name, b.lot, b.quantity, b.expiry, fridgeName(b.fridgeId), b.shelf]));
  el("mainContent").querySelectorAll("[data-del-batch]").forEach((b) => b.onclick = () => { if (confirm("Remove this expired batch from inventory?")) deleteBatch(b.dataset.delBatch); });
}

/* ---------------------------------------------------------------------
   DAMAGED ITEMS
--------------------------------------------------------------------- */
function renderDamagedView() {
  const list = [...state.logs].filter((e) => e.type === "damage").sort((a, b) => (a.date < b.date ? 1 : -1));
  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Damaged &amp; Wasted Items</h2><span class="subtitle">Record of discarded or compromised stock</span></div>
      <button class="btn export" id="exportDmg"><i class="fa-solid fa-file-csv"></i> Export CSV</button></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Item</th><th>Lot</th><th>Quantity</th><th>Reason</th><th>Reported By</th></tr></thead>
      <tbody>${list.length === 0 ? `<tr><td colspan="6" class="table-empty">No damaged/wasted items recorded</td></tr>` : list.map((entry) => {
        const cat = catalogById(entry.catalogItemId);
        return `<tr><td class="mono">${esc(entry.date)}</td><td>${esc(cat ? cat.name : "(deleted item)")}</td><td class="mono">${esc(entry.lot || "—")}</td>
          <td class="mono">${entry.quantity}</td><td>${esc(entry.reason || "—")}</td><td>${esc(nameForEmail(entry.byEmail))}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  el("exportDmg").onclick = () => downloadCSV("damaged_items.csv", ["Date", "Item", "Lot", "Quantity", "Reason", "Reported By"],
    list.map((e) => [e.date, catalogById(e.catalogItemId)?.name || "", e.lot, e.quantity, e.reason, nameForEmail(e.byEmail)]));
}

/* ---------------------------------------------------------------------
   ACTIVITY LOG
--------------------------------------------------------------------- */
function renderActivityView() {
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const rep = state.ui.report || { from: "", to: "", branchId: state.role === "master" ? "" : (myBranch || ""), pageSize: 100 };
  if (!rep.pageSize) rep.pageSize = 100;
  state.ui.report = rep;

  let sorted = [...state.logs].sort((a, b) => (a.date < b.date ? 1 : -1));
  // Non-master users only ever see their own branch's activity, regardless of any filter.
  if (state.role !== "master") sorted = sorted.filter((e) => (e.branchId || null) === myBranch);
  else if (rep.branchId) sorted = sorted.filter((e) => e.branchId === rep.branchId);
  if (rep.from) sorted = sorted.filter((e) => (e.date || "").slice(0, 10) >= rep.from);
  if (rep.to) sorted = sorted.filter((e) => (e.date || "").slice(0, 10) <= rep.to);
  // Table renders in pages of 100 rows — keeps a long activity history fast to scroll and render,
  // while "Export CSV" below still exports every filtered row, not just the ones on screen.
  const visible = sorted.slice(0, rep.pageSize);

  const consumption = {};
  sorted.filter((e) => e.type === "out").forEach((e) => { consumption[e.catalogItemId] = (consumption[e.catalogItemId] || 0) + (e.quantity || 0); });
  const topConsumed = Object.entries(consumption).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const summaryHtml = topConsumed.length === 0 ? "" : `
    <div class="panel-card" style="margin-bottom:16px"><div class="panel-title">Top consumption</div><div class="panel-sub">Most dispensed reagents (within the selected range)</div>
    <div class="bar-list">${topConsumed.map(([catId, qty]) => {
      const cat = catalogById(catId); const max = topConsumed[0][1] || 1; const pct = Math.round((qty / max) * 100);
      return `<div class="bar-row"><span class="bar-name">${esc(cat ? cat.name : "(deleted item)")}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--danger)"></div></div><span class="bar-num mono">${qty}</span></div>`;
    }).join("")}</div></div>`;

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Activity Log</h2><span class="subtitle">Traceability record of every receive, dispense &amp; waste transaction</span></div>
      <button class="btn export" id="exportLog"><i class="fa-solid fa-file-csv"></i> Export CSV</button></div>
    <div class="filter-bar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label style="font-size:12px;color:var(--text-dim)">From <input type="date" id="repFrom" value="${esc(rep.from)}" style="margin-left:4px" /></label>
      <label style="font-size:12px;color:var(--text-dim)">To <input type="date" id="repTo" value="${esc(rep.to)}" style="margin-left:4px" /></label>
      ${state.role === "master" ? `<label style="font-size:12px;color:var(--text-dim)">Branch
        <select id="repBranch" style="margin-left:4px"><option value="">All branches</option>${state.branches.map((b) => `<option value="${b.id}" ${b.id === rep.branchId ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>` : ""}
      ${rep.from || rep.to || rep.branchId ? `<button type="button" class="link-btn" id="repClear">Clear filters</button>` : ""}
    </div>
    ${summaryHtml}
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Type</th><th>Item</th><th>Lot</th><th>Expiry</th><th>Quantity</th><th>Method</th><th>Branch</th><th>By</th></tr></thead>
      <tbody>${sorted.length === 0 ? `<tr><td colspan="9" class="table-empty">No transactions found for this range</td></tr>` : visible.map((entry) => {
        const cat = catalogById(entry.catalogItemId);
        const typeLabel = entry.type === "in" ? "Received" : entry.type === "damage" ? "Damaged" : entry.type === "transfer_out" ? "Sent" : entry.type === "transfer_in" ? "Transfer received" : "Dispensed";
        const typeColor = entry.type === "in" || entry.type === "transfer_in" ? "ok" : entry.type === "damage" ? "expired" : "watch";
        const st = STATUS_STYLES[typeColor];
        return `<tr>
          <td class="mono">${esc(entry.date)}</td>
          <td><span class="badge" style="background:${st.bg};color:${st.text};border-color:${st.border}">${typeLabel}</span></td>
          <td>${esc(cat ? cat.name : "(deleted item)")}</td>
          <td class="mono">${esc(entry.lot || "—")}</td>
          <td class="mono">${esc(entry.expiry || "—")}</td>
          <td class="mono">${entry.quantity}</td>
          <td>${entry.method ? `<span class="method-pill ${entry.method === "Barcode" ? "barcode" : "manual"}">${entry.method}</span>` : "—"}</td>
          <td>${esc(entry.branchName || "—")}</td>
          <td>${esc(nameForEmail(entry.byEmail))}</td>
        </tr>`;
      }).join("")}</tbody></table></div>
    ${sorted.length > visible.length ? `<div style="display:flex;justify-content:center;padding:14px 0"><button type="button" class="btn ghost" id="repLoadMore">Load more (${visible.length} of ${sorted.length})</button></div>` : ""}`;

  el("exportLog").onclick = () => downloadCSV("activity_log.csv", ["Date", "Type", "Item", "Lot", "Expiry", "Quantity", "Method", "Branch", "By"],
    sorted.map((e) => [e.date, e.type, catalogById(e.catalogItemId)?.name || "", e.lot, e.expiry, e.quantity, e.method, e.branchName, nameForEmail(e.byEmail)]));
  el("repFrom").oninput = (e) => { rep.from = e.target.value; rep.pageSize = 100; renderActivityView(); };
  el("repTo").oninput = (e) => { rep.to = e.target.value; rep.pageSize = 100; renderActivityView(); };
  const branchEl = el("repBranch"); if (branchEl) branchEl.onchange = (e) => { rep.branchId = e.target.value; rep.pageSize = 100; renderActivityView(); };
  const clearEl = el("repClear"); if (clearEl) clearEl.onclick = () => { state.ui.report = { from: "", to: "", branchId: state.role === "master" ? "" : (myBranch || ""), pageSize: 100 }; renderActivityView(); };
  const loadMoreEl = el("repLoadMore"); if (loadMoreEl) loadMoreEl.onclick = () => { rep.pageSize += 100; renderActivityView(); };
}

/* ---------------------------------------------------------------------
   DOCUMENTS — reference PDFs (policies, manuals, certificates, SOPs...)
   plus a small "Ask" assistant that also knows the app's own live data.

   The assistant is a rule-based router, not a general AI model — it
   understands two things on purpose:
     1. A greeting ("hi" / "مرحبا" / ...) gets a friendly reply.
     2. A question naming a catalog item ("كم عندنا Albumin؟", "how much
        Glucose reagent is left") gets the live quantity computed from
        the same batches data the rest of the app uses (branch-scoped
        for a branch account, all branches + a per-branch breakdown for
        master), plus the nearest expiry among those batches.
   Anything else falls through to keyword/phrase search over every
   uploaded PDF's extracted text, now indexed per page so a match can
   jump straight to that page instead of just the file. No AI model,
   no external service — nothing leaves the browser except the PDF file
   itself going to Firebase Storage at upload time. The answer's
   language (Arabic vs Latin script) is detected from the question
   itself, so the reply text and the spoken voice follow it back.
--------------------------------------------------------------------- */
function detectDocAskLang(text) { return /[\u0600-\u06FF]/.test(text || "") ? "ar" : "en"; }
// Two small-talk categories, checked before any document search: a greeting gets a warm "how
// can I help you today" reply; a thanks/farewell gets a short "you're welcome" — neither should
// ever fall through to keyword search (short phrases like "hi" or "thanks" would otherwise match
// noise all over the PDFs).
const DOC_GREETING_RE = {
  ar: /^\s*(مرحبا|مرحباً|أهلا|اهلا|أهلين|اهلين|هلا|هلاو|يا\s*هلا|حياك|حياك\s*الله|السلام\s*عليكم|وعليكم\s*السلام|صباح\s*الخير|صباحو|مساء\s*الخير|مساك\s*الله\s*بالخير|هاي|هلو|كيف\s*الحال|كيفك|كيف\s*حالك|شلونك|شخبارك|ايش\s*اخبارك|إيش\s*أخبارك)\b/,
  en: /^\s*(hi+|hello+|hey+|yo|howdy|greetings|good\s*morning|good\s*evening|good\s*afternoon|good\s*day|how\s*are\s*you|what'?s\s*up|how'?s\s*it\s*going)\b/i,
};
const DOC_THANKS_RE = {
  ar: /^\s*(شكرا|شكراً|مشكور|يعطيك\s*العافية|تسلم|الله\s*يعافيك|تمام|اوكي|أوكي|ok|okay)\b/i,
  en: /^\s*(thanks|thank\s*you|thx|ty|great|awesome|perfect|got\s*it|cool|nice\s*one|ok|okay)\b/i,
};
function docAskIsGreeting(q) { return DOC_GREETING_RE.ar.test(q) || DOC_GREETING_RE.en.test(q); }
function docAskIsThanks(q) { return DOC_THANKS_RE.ar.test(q) || DOC_THANKS_RE.en.test(q); }
function docAskGreetingReply(lang) {
  return lang === "ar"
    ? "أهلاً وسهلاً! كيف أقدر أخدمك اليوم؟ 😊 تقدر تسألني عن كمية أي صنف بالمخزون، أو أي سؤال عن محتوى الملفات المرفوعة."
    : "Hello! How can I help you today? Ask me about the stock quantity of any item, or anything inside the uploaded documents.";
}
function docAskThanksReply(lang) {
  return lang === "ar" ? "العفو! تحت أمرك أي وقت تحتاج شي ثاني 🙏" : "You're welcome! Happy to help whenever you need anything else.";
}
/** Best catalog item whose name is "present" in the question — every significant word of the
 *  item's name must appear somewhere in the question (in any order, Arabic-spelling-variant
 *  aware), not as one exact contiguous phrase. This is what lets a casual question like
 *  "كم TSH رئيجنت عندنا؟" match a catalog item named "TSH Reagent Kit" even though that exact
 *  phrase never appears verbatim. When more than one item's tokens all match, the longest
 *  (most specific) name wins so a short generic item doesn't shadow a more specific one. */
function docAskFindCatalogItem(query) {
  const normQuery = normalizeForMatch(query || "");
  if (!normQuery.trim()) return null;
  let best = null, bestLen = 0;
  state.catalog.forEach((c) => {
    const rawName = (c.name || "").trim();
    if (rawName.length < 2) return;
    const tokens = rawName.split(/\s+/).map(normalizeForMatch).filter((t) => t.length >= 2);
    if (!tokens.length) return;
    const allTokensPresent = tokens.every((t) => docTermTestRegex(t).test(normQuery));
    if (allTokensPresent && rawName.length > bestLen) { best = c; bestLen = rawName.length; }
  });
  return best;
}
/** Today's date as YYYY-MM-DD, for flagging expired/near-expiry lots in the Ask answer. */
function docAskToday() { return new Date().toISOString().slice(0, 10); }
/** A live quantity answer for a catalog item named in the question — reuses the exact same
 *  batches data (and branch scoping) the Inventory pages are built from, so the number always
 *  matches what the rest of the app shows. When the item has more than one lot, every lot is
 *  listed individually with its own quantity and expiry (not just the total + nearest expiry),
 *  and lots that are expired or expiring soon (<=60 days) are flagged. Returns null when the
 *  question doesn't name a recognizable catalog item. */
function docAskAnswerQuantity(query, lang) {
  const item = docAskFindCatalogItem(query);
  if (!item) return null;
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const batches = state.batches.filter((b) => b.catalogItemId === item.id);
  const scoped = isMaster ? batches : batches.filter((b) => b.branchId === myBranch);
  const withQty = scoped.filter((b) => (Number(b.quantity) || 0) > 0);
  const total = round4(scoped.reduce((s, b) => s + (Number(b.quantity) || 0), 0));
  const unit = item.unit || "";
  let text;
  if (isMaster) {
    const byBranch = {};
    batches.forEach((b) => { byBranch[b.branchId] = (byBranch[b.branchId] || 0) + (Number(b.quantity) || 0); });
    const parts = Object.entries(byBranch).filter(([, q]) => q > 0).map(([bid, q]) => `${branchName(bid)}: ${fmtN(q, 2)}`).join(", ");
    text = lang === "ar"
      ? `إجمالي كمية "${item.name}" في كل الفروع: ${fmtN(total, 2)} ${unit}${parts ? ` (${parts})` : ""}.`
      : `Total quantity of "${item.name}" across all branches: ${fmtN(total, 2)} ${unit}${parts ? ` (${parts})` : ""}.`;
  } else {
    text = lang === "ar"
      ? `الكمية المتوفرة من "${item.name}" في فرعك: ${fmtN(total, 2)} ${unit}.`
      : `Available quantity of "${item.name}" in your branch: ${fmtN(total, 2)} ${unit}.`;
  }
  const today = docAskToday();
  if (withQty.length > 1) {
    // More than one lot — list each one with its own quantity/expiry instead of just a total.
    const sorted = [...withQty].sort((a, b) => (a.expiry || "9999") < (b.expiry || "9999") ? -1 : 1);
    const lines = sorted.map((b) => {
      const daysLeft = b.expiry ? Math.ceil((new Date(b.expiry) - new Date(today)) / 86400000) : null;
      const flag = daysLeft == null ? "" : daysLeft < 0
        ? (lang === "ar" ? " ⚠️ منتهي الصلاحية" : " ⚠️ expired")
        : daysLeft <= 60
        ? (lang === "ar" ? ` ⚠️ باقي ${daysLeft} يوم` : ` ⚠️ ${daysLeft} days left`)
        : "";
      const branchTag = isMaster ? ` — ${branchName(b.branchId)}` : "";
      return lang === "ar"
        ? `• لوت ${b.lot || "—"}${branchTag}: ${fmtN(Number(b.quantity) || 0, 2)} ${unit}${b.expiry ? `، ينتهي ${b.expiry}` : ""}${flag}`
        : `• Lot ${b.lot || "—"}${branchTag}: ${fmtN(Number(b.quantity) || 0, 2)} ${unit}${b.expiry ? `, expires ${b.expiry}` : ""}${flag}`;
    });
    text += (lang === "ar" ? `\nيوجد ${withQty.length} لوتات:\n` : `\nThere are ${withQty.length} lots:\n`) + lines.join("\n");
  } else {
    const withExpiry = [...scoped].filter((b) => b.expiry).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    if (withExpiry.length) {
      const nearest = withExpiry[0];
      const daysLeft = Math.ceil((new Date(nearest.expiry) - new Date(today)) / 86400000);
      const flag = daysLeft < 0 ? (lang === "ar" ? " ⚠️ منتهي الصلاحية" : " ⚠️ expired")
        : daysLeft <= 60 ? (lang === "ar" ? ` ⚠️ باقي ${daysLeft} يوم` : ` ⚠️ ${daysLeft} days left`) : "";
      text += lang === "ar"
        ? ` أقرب انتهاء صلاحية: ${nearest.expiry}${nearest.lot ? ` (لوت ${nearest.lot})` : ""}.${flag}`
        : ` Nearest expiry: ${nearest.expiry}${nearest.lot ? ` (lot ${nearest.lot})` : ""}.${flag}`;
    }
  }
  return text;
}
/** Routes one question to a greeting, a live app-data answer, or (falling through) the PDF
 *  document search — this is what both the on-screen results and the spoken answer are built from. */
function answerDocAsk(query, docs) {
  const lang = detectDocAskLang(query);
  if (docAskIsGreeting(query)) return { lang, type: "greeting", text: docAskGreetingReply(lang) };
  if (docAskIsThanks(query)) return { lang, type: "greeting", text: docAskThanksReply(lang) };
  const qtyText = docAskAnswerQuantity(query, lang);
  if (qtyText) return { lang, type: "appData", text: qtyText };
  const hits = searchDocuments(query, docs);
  return { lang, type: hits.length ? "docs" : "none", hits, noDocsUploaded: docs.length === 0 };
}
// Deliberately generous — a common word left in here is exactly what caused "we"/"have" to
// light up all over an unrelated document (matching inside "beTWEen", "HAVE read...", etc.).
// A short, generic word almost never helps find the right passage; better to drop it and let
// the actual distinctive term(s) in the question drive the match.
const DOC_STOPWORDS = new Set([
  "the", "is", "are", "a", "an", "of", "in", "on", "for", "to", "and", "or", "what", "which", "who",
  "whom", "how", "when", "where", "why", "do", "does", "did", "this", "that", "these", "those", "with",
  "from", "by", "be", "been", "being", "was", "were", "it", "its", "it's", "can", "could", "cant",
  "you", "your", "yours", "you're", "me", "my", "mine", "i", "i'm", "we", "we're", "we've", "our",
  "ours", "us", "he", "she", "they", "them", "their", "him", "her", "his", "hers", "please", "tell",
  "about", "have", "has", "had", "having", "will", "would", "shall", "should", "may", "might", "must",
  "am", "if", "as", "at", "up", "out", "so", "than", "then", "there", "here", "also", "just", "only",
  "very", "quite", "many", "much", "more", "most", "such", "each", "every", "some", "any", "all",
  "other", "another", "same", "own", "over", "under", "again", "once", "not", "no", "yes", "get",
  "got", "into", "onto", "off", "down", "too", "now",
  "ما", "ماذا", "هل", "من", "في", "على", "إلى", "الى", "عن", "مع", "هو", "هي", "هذا", "هذه", "ذلك",
  "تلك", "التي", "الذي", "الذين", "كيف", "متى", "أين", "اين", "و", "او", "أو", "ثم", "لكن", "بل",
  "ال", "لل", "كم", "اي", "أي", "أنت", "انت", "أنتم", "انتم", "أنا", "انا", "نحن", "هم", "هن", "انتي",
  "أنتي", "لدي", "لدينا", "عندي", "عندنا", "عند", "بعد", "قبل", "حتى", "بين", "كل", "بعض", "غير",
  "ايضا", "أيضا", "فقط", "جدا", "جداً", "قد", "لقد", "كان", "كانت", "يكون", "تكون", "لم", "لن", "لا",
  "نعم", "ياليت", "من فضلك", "لو سمحت", "ابغى", "ابي", "أبغى", "أبي", "ودي", "أريد", "اريد",
]);
function docExtractKeywords(query) {
  return (query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !DOC_STOPWORDS.has(w));
}
function docSplitSentences(text) {
  return (text || "").split(/(?<=[.!?؟\n])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8);
}
function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* --- Arabic-aware normalization + a small domain synonym list -----------------------------
   Everything below is still local, rule-based matching (no external AI model, no network
   call) — it just makes the existing keyword search noticeably smarter for free:
   1. normalizeForMatch() unifies common Arabic spelling variants (أ/إ/آ vs ا, ة vs ه, ى vs ي)
      and strips optional diacritics/tatweel, so "صيانة" and "صيانه" are treated as the same word.
   2. DOC_SYNONYM_GROUPS expands a query into related terms across languages, so "صيانة" also
      finds an English-only manual's "maintenance"/"servicing" section, and vice versa.
   3. searchDocuments() below then ranks matches by a simple corpus-wide rarity weight (idf-like)
      instead of a flat count, so a distinctive term matters more than a generic one that shows
      up in most pages of a document.
------------------------------------------------------------------------------------------- */
const AR_DIACRITICS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0640]/g;
function stripArDiacritics(s) { return (s || "").replace(AR_DIACRITICS_RE, ""); }
function normalizeForMatch(s) {
  return stripArDiacritics(s || "").toLowerCase().replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
}
// Character classes for building a "flexible" highlight regex that still matches the raw
// (un-normalized) sentence even when the query used a different spelling variant or the PDF
// text has stray diacritics between letters.
const AR_VARIANT_CLASS = { "ا": "[اأإآ]", "أ": "[اأإآ]", "إ": "[اأإآ]", "آ": "[اأإآ]", "ة": "[ةه]", "ه": "[ةه]", "ي": "[يى]", "ى": "[يى]" };
const AR_DIACRITIC_GAP = AR_DIACRITICS_RE.source + "*";
function buildFlexibleRegexSource(word) {
  return word.split("").map((ch) => ch === " " ? "\\s+" : (AR_VARIANT_CLASS[ch] || escRegex(ch))).join(AR_DIACRITIC_GAP);
}
// Domain synonym groups (Arabic + English). Edit/extend this list as new document types get
// uploaded — it's the cheapest lever for better recall without wiring an external AI model.
const DOC_SYNONYM_GROUPS = [
  ["maintenance", "servicing", "service interval", "صيانة", "صيانه", "خدمة دورية"],
  ["calibration", "calibrate", "recalibration", "معايرة", "معايره", "كاليبريشن"],
  ["storage temperature", "storage condition", "درجة حرارة التخزين", "درجة الحرارة", "ظروف التخزين"],
  ["expiry", "expiration", "expiry date", "shelf life", "انتهاء الصلاحية", "تاريخ الانتهاء", "الصلاحية"],
  ["cleaning", "clean", "disinfection", "تنظيف", "تعقيم"],
  ["troubleshooting", "error code", "malfunction", "fault", "اعطال", "أعطال", "مشاكل", "خلل"],
  ["warranty", "guarantee", "ضمان"],
  ["installation", "setup", "تركيب", "تنصيب"],
  ["quality control", "qc", "ضبط الجودة", "الجودة"],
  ["disposal", "waste", "التخلص", "نفايات"],
  ["safety", "hazard", "precaution", "سلامة", "مخاطر", "احتياطات"],
];
/** Every unique search term for a query: its own words (normalized) plus, when the query
 *  touches a known synonym group, every other term in that group. Multi-word phrases (like
 *  "storage temperature") are matched as substrings of the normalized query. */
function docExpandedSearchTerms(query) {
  const tokens = docExtractKeywords(query).map(normalizeForMatch);
  const normQuery = normalizeForMatch(query);
  const terms = new Set(tokens.filter(Boolean));
  DOC_SYNONYM_GROUPS.forEach((group) => {
    const normGroup = group.map(normalizeForMatch);
    if (normGroup.some((t) => normQuery.includes(t))) normGroup.forEach((t) => terms.add(t));
  });
  return [...terms].filter(Boolean);
}
// A letter/number on either side of the match means it's the middle of a bigger word, not a
// real hit — this is what stops a short term like "we" from lighting up inside "beTWEen".
const DOC_BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}])";
const DOC_BOUNDARY_AFTER = "(?![\\p{L}\\p{N}])";
/** Whole-word test regex for a normalized term — no 'g' flag, safe to build once and reuse
 *  .test() across many sentences without lastIndex statefulness. */
function docTermTestRegex(term) {
  return new RegExp(DOC_BOUNDARY_BEFORE + "(?:" + buildFlexibleRegexSource(term) + ")" + DOC_BOUNDARY_AFTER, "iu");
}
function docHighlight(sentence, terms) {
  let out = esc(sentence);
  terms.forEach((t) => {
    if (!t) return;
    try { out = out.replace(new RegExp(DOC_BOUNDARY_BEFORE + "(" + buildFlexibleRegexSource(t) + ")" + DOC_BOUNDARY_AFTER, "igu"), "<mark>$1</mark>"); } catch (e) { /* malformed pattern from odd input — skip */ }
  });
  return out;
}
// Returns [] when nothing matches (renders as "not currently available"); otherwise the best
// few documents, each with its best few matching sentences — each snippet tagged with the PDF
// page it came from, best match first. Older documents uploaded before page-level indexing was
// added only have a flat `text` blob (no `pages` array); those are treated as one unnumbered
// page so search still works, it just can't jump straight to a page for them.
function docPagesOf(d) { return d.pages && d.pages.length ? d.pages : (d.text ? [d.text] : []); }
function searchDocuments(query, docs) {
  const terms = docExpandedSearchTerms(query);
  if (terms.length === 0) return [];
  // Flatten every sentence once so a simple corpus-wide rarity weight (idf-like) can be
  // computed before scoring: a rare term matching is worth more than a common one, so a
  // distinctive word doesn't get drowned out by a generic one appearing on every page.
  const corpus = [];
  docs.forEach((d) => {
    const pages = docPagesOf(d);
    pages.forEach((pageText, idx) => {
      docSplitSentences(pageText).forEach((s) => corpus.push({ d, s, norm: normalizeForMatch(s), page: d.pages ? idx + 1 : null }));
    });
  });
  if (!corpus.length) return [];
  // Whole-word regexes, one per term, built once and reused (no 'g' flag → .test() is stateless
  // and safe to call repeatedly). This is what keeps a term from counting a match buried inside
  // an unrelated longer word.
  const termRes = terms.map((t) => ({ t, re: docTermTestRegex(t) }));
  const df = {};
  termRes.forEach(({ t, re }) => { df[t] = corpus.reduce((n, c) => n + (re.test(c.norm) ? 1 : 0), 0); });
  const N = corpus.length;
  const idf = {};
  termRes.forEach(({ t }) => { idf[t] = Math.log((N + 1) / (df[t] + 1)) + 1; });

  const byDoc = new Map();
  corpus.forEach((c) => {
    let score = 0;
    termRes.forEach(({ t, re }) => { if (re.test(c.norm)) score += idf[t]; });
    if (score <= 0) return;
    if (!byDoc.has(c.d.id)) byDoc.set(c.d.id, []);
    byDoc.get(c.d.id).push({ s: c.s, score, page: c.page });
  });

  const hits = [];
  byDoc.forEach((scored, docId) => {
    scored.sort((a, b) => b.score - a.score);
    const d = docs.find((x) => x.id === docId);
    if (!d) return;
    hits.push({
      docId, docName: d.name, best: scored[0].score, topPage: scored[0].page,
      snippets: scored.slice(0, 3).map((r) => ({ html: docHighlight(r.s, terms), page: r.page })),
    });
  });
  hits.sort((a, b) => b.best - a.best);
  return hits.slice(0, 4);
}
function renderDocSearchResults(answer) {
  if (answer == null) return `<div style="color:var(--text-dim);font-size:13px">Ask a question above — about stock quantities, or anything in the uploaded documents.</div>`;
  if (answer.type === "greeting" || answer.type === "appData") {
    return `<div style="background:#eaf6ec;color:#1f7a3d;padding:12px 14px;border-radius:8px;font-size:14.5px;line-height:1.6;white-space:pre-line"><i class="fa-solid fa-comment-dots"></i> ${esc(answer.text)}</div>`;
  }
  if (answer.type === "none") {
    const msg = answer.noDocsUploaded
      ? (answer.lang === "ar"
        ? "ما لقيت هالمعلومة. لاحظ إني أفهم اسم الصنف بالضبط (مثل \"Albumin\") مو كلمة عامة زي \"كاشف\"، ولسا ما فيه أي ملف PDF مرفوع أقدر أبحث فيه."
        : "This information is currently not available. Note I match an exact catalog item name (e.g. \"Albumin\"), not a general word — and no PDF documents have been uploaded yet to search either.")
      : (answer.lang === "ar"
        ? "ما لقيت هالمعلومة بالملفات المرفوعة حاليًا. جرّب اسم الصنف بالضبط زي ما هو مكتوب بالمخزون."
        : "This information is currently not available in the uploaded documents. Try the exact catalog item name as it appears in inventory.");
    return `<div style="background:#fdecea;color:#a12622;padding:10px 14px;border-radius:8px;display:inline-block;font-size:14px"><i class="fa-solid fa-circle-info"></i> ${esc(msg)}</div>`;
  }
  // Lead with the single best-matching snippet as a highlighted "answer" card (so the person
  // isn't left to scan a wall of raw highlighted text), then list every match underneath as
  // sources — same underlying data as before, just ranked and framed instead of dumped flat.
  const top = answer.hits[0];
  const topSnippet = top.snippets[0];
  const bestLabel = answer.lang === "ar" ? "أقرب إجابة لقيتها:" : "Best match found:";
  const sourcesLabel = answer.lang === "ar" ? "المصادر" : "Sources";
  const bestBlock = `<div style="background:#eaf3ff;border:1px solid #bcd8ff;color:#1a4a8a;padding:12px 14px;border-radius:8px;font-size:14.5px;line-height:1.65;margin-bottom:12px">
    <div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em;opacity:.75;margin-bottom:4px"><i class="fa-solid fa-wand-magic-sparkles"></i> ${bestLabel}</div>
    …${topSnippet.html}…
    <div style="margin-top:6px;font-size:12.5px;opacity:.85"><i class="fa-solid fa-file-pdf" style="color:#c0392b"></i> ${esc(top.docName)}${topSnippet.page ? ` — <button type="button" class="link-btn" data-open-page="${top.docId}:${topSnippet.page}" style="font-size:12.5px">p. ${topSnippet.page}</button>` : ""}</div>
  </div>`;
  const hasMore = answer.hits.length > 1 || top.snippets.length > 1;
  const sourcesBlock = !hasMore ? "" : `<div style="font-size:12px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.03em;margin:4px 0 8px">${sourcesLabel}</div>` +
    answer.hits.map((r) => `
      <div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px">
        <div style="font-weight:600;margin-bottom:6px"><i class="fa-solid fa-file-pdf" style="color:#c0392b;margin-right:6px"></i>${esc(r.docName)}</div>
        ${r.snippets.map((s) => `<div style="font-size:14px;line-height:1.65;margin-bottom:4px;color:var(--text)">…${s.html}…
          ${s.page ? ` <button type="button" class="link-btn" data-open-page="${r.docId}:${s.page}" style="font-size:12.5px">p. ${s.page}</button>` : ""}</div>`).join("")}
      </div>`).join("");
  return bestBlock + sourcesBlock;
}

async function extractPdfText(file, onProgress) {
  if (!window.pdfjsLib) throw new Error("PDF reader library did not load — check your internet connection and reload the page.");
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const MAX_CHARS = 350000; // keeps the Firestore doc well under its 1MB limit even for large manuals
  const pages = [];
  let total = 0, truncated = false;
  for (let i = 1; i <= pdf.numPages; i++) {
    if (onProgress) onProgress(`Reading PDF text… page ${i}/${pdf.numPages}`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(" ").trim();
    if (total + pageText.length > MAX_CHARS) { truncated = true; break; }
    pages.push(pageText);
    total += pageText.length;
  }
  return { pages, pageCount: pdf.numPages, truncated };
}

async function uploadDocument(file) {
  if (state.role !== "master") return;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) { toast(`${file.name}: only PDF files are supported`, "error"); return; }
  if (file.size > 100 * 1024 * 1024) { toast(`${file.name}: file is larger than 100MB`, "error"); return; }

  const progressId = "up_" + Math.random().toString(36).slice(2);
  const progHost = el("docUploadProgress");
  if (progHost) progHost.insertAdjacentHTML("beforeend", `<div id="${progressId}" class="panel-card" style="margin-bottom:12px">
    <div class="panel-title"><i class="fa-solid fa-file-pdf" style="color:#c0392b"></i> ${esc(file.name)}</div>
    <div class="panel-sub" data-status>Reading PDF text…</div>
    <div style="background:var(--line);border-radius:6px;height:6px;margin-top:8px;overflow:hidden"><div data-bar style="background:var(--primary,#2f6fed);height:100%;width:8%;transition:width .25s"></div></div>
  </div>`);
  const node = document.getElementById(progressId);
  const setStatus = (msg, pct) => { if (node) { const s = node.querySelector("[data-status]"); if (s) s.textContent = msg; const b = node.querySelector("[data-bar]"); if (b && pct != null) b.style.width = pct + "%"; } };

  try {
    const { pages, pageCount, truncated } = await extractPdfText(file, (msg) => {
      const m = /page (\d+)\/(\d+)/.exec(msg || "");
      setStatus(msg, m ? 10 + (Number(m[1]) / Number(m[2])) * 60 : null);
    });
    setStatus("Uploading file…", 75);
    const docRef = db.collection("documents").doc();
    // Uploaded to Cloudinary (unsigned preset) instead of Firebase Storage — avoids requiring the Blaze billing plan.
    const CLOUDINARY_CLOUD_NAME = "lr4ensle";
    const CLOUDINARY_UPLOAD_PRESET = "medinnovation_docs";
    const cloudForm = new FormData();
    cloudForm.append("file", file);
    cloudForm.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    cloudForm.append("public_id", docRef.id);
    const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`, { method: "POST", body: cloudForm });
    if (!cloudRes.ok) { const errText = await cloudRes.text().catch(() => ""); throw new Error(`Cloudinary upload failed (${cloudRes.status}): ${errText.slice(0, 200)}`); }
    const cloudData = await cloudRes.json();
    const fileUrl = cloudData.secure_url;
    const cloudPublicId = cloudData.public_id;
    setStatus("Saving…", 95);
    const payload = { name: file.name, sizeBytes: file.size, pageCount, fileUrl, cloudPublicId, pages, textTruncated: !!truncated, uploadedBy: state.user.email, uploadedAt: nowStr() };
    await docRef.set(payload);
    logAudit("upload_document", file.name, `${pageCount} pages`);
    state.documents.unshift({ id: docRef.id, ...payload });
    setStatus("Done", 100);
    if (node) setTimeout(() => node.remove(), 900);
    toast(`${file.name} uploaded`, "success");
    if (state.ui.view === "documents") renderDocumentsView();
  } catch (e) {
    console.error(e);
    setStatus("Failed: " + e.message, 100);
    if (node) node.querySelector("[data-bar]").style.background = "#c0392b";
    toast(`${file.name}: upload failed — ${e.message}`, "error");
  }
}

async function deleteDocument(id) {
  if (state.role !== "master") return;
  const d = state.documents.find((x) => x.id === id);
  try {
    // Note: the file itself stays on Cloudinary (unsigned uploads can't be deleted from the browser
    // without exposing the API secret). Only the Firestore record + search index is removed.
    await db.collection("documents").doc(id).delete();
    state.documents = state.documents.filter((x) => x.id !== id);
    logAudit("delete_document", d ? d.name : id, "");
    toast("Document deleted", "success");
    renderDocumentsView();
  } catch (e) { toast("Delete failed: " + e.message, "error"); }
}

async function openDocument(id, page) {
  const d = state.documents.find((x) => x.id === id);
  if (!d) return;
  if (d.fileUrl) { window.open(page ? `${d.fileUrl}#page=${page}` : d.fileUrl, "_blank"); return; }
  // Backward compatibility: documents uploaded before the Cloudinary switch only have storagePath.
  if (d.storagePath) {
    try {
      const url = await firebase.storage().ref(d.storagePath).getDownloadURL();
      window.open(page ? `${url}#page=${page}` : url, "_blank");
    } catch (e) { toast("Could not open file: " + e.message, "error"); }
  }
}

function stripHtml(html) { const d = document.createElement("div"); d.innerHTML = html; return d.textContent || ""; }
function speakDocAnswer(answer) {
  if (!window.speechSynthesis || answer == null) return;
  speechSynthesis.cancel(); // don't stack a new answer on top of one still being read
  let text = "";
  if (answer.type === "greeting" || answer.type === "appData") text = answer.text;
  else if (answer.type === "none") text = answer.lang === "ar" ? "ما لقيت هالمعلومة بالملفات المرفوعة حاليًا." : "This information is currently not available in the uploaded documents.";
  else if (answer.type === "docs" && answer.hits.length) text = (answer.lang === "ar" ? `من ${answer.hits[0].docName}: ` : `From ${answer.hits[0].docName}: `) + stripHtml(answer.hits[0].snippets[0].html);
  if (!text) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = answer.lang === "ar" ? "ar-SA" : "en-US";
  speechSynthesis.speak(utter);
}

let docRecognition = null;
function startDocVoiceInput(onFinalResult) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast("This browser doesn't support voice input — try Chrome or Edge.", "error"); return; }
  const micBtn = el("docAskMic");
  if (docRecognition) { docRecognition.stop(); return; } // second click = stop listening

  const rec = new SpeechRecognition();
  docRecognition = rec;
  const ui = state.ui.documents || {};
  rec.lang = ui.voiceLang === "en" ? "en-US" : ui.voiceLang === "ar" ? "ar-SA" : (navigator.language || "ar-SA"); // "Auto" follows the device/browser language
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  if (micBtn) { micBtn.classList.add("listening"); micBtn.innerHTML = `<i class="fa-solid fa-microphone-lines"></i>`; }

  rec.onresult = (e) => {
    const transcript = Array.from(e.results).map((r) => r[0].transcript).join(" ");
    const input = el("docAsk"); if (input) input.value = transcript;
    if (e.results[e.results.length - 1].isFinal) { rec.stop(); if (typeof onFinalResult === "function") onFinalResult(); }
  };
  rec.onerror = (e) => { toast("Voice input error: " + (e.error || "unknown"), "error"); };
  rec.onend = () => { docRecognition = null; if (micBtn) { micBtn.classList.remove("listening"); micBtn.innerHTML = `<i class="fa-solid fa-microphone"></i>`; } };
  try { rec.start(); } catch (e) { toast("Could not start voice input: " + e.message, "error"); docRecognition = null; }
}

function renderDocumentsView() {
  const ui = state.ui.documents || (state.ui.documents = { loaded: false, loading: false, query: "", results: null, autoOpen: true });

  if (!ui.loaded && !ui.loading) {
    ui.loading = true;
    db.collection("documents").orderBy("uploadedAt", "desc").get().then((snap) => {
      state.documents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      ui.loaded = true; ui.loading = false;
      if (state.ui.view === "documents") renderDocumentsView();
    }).catch((e) => { ui.loading = false; toast("Failed to load documents: " + e.message, "error"); });
  }

  const isMaster = state.role === "master";
  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Documents</h2><span class="subtitle">Reference PDFs — policies, manuals, certificates. Ask below — greet it, ask a stock quantity, or ask about anything inside them.</span></div></div>

    <div class="panel-card" style="margin-bottom:20px">
      <div class="panel-title">Ask</div>
      <div class="panel-sub">Say hi, ask "how much X is left", or ask anything from the uploaded PDFs — it answers (and can speak) in whichever language you ask in.</div>
      <div style="display:flex;gap:10px;margin-top:10px">
        <input type="text" id="docAsk" placeholder="e.g. مرحباً · كم كمية Albumin عندنا؟ · What is the storage temperature for reagent X?" value="${esc(ui.query)}" style="flex:1" />
        <select id="docVoiceLang" title="Voice input language" style="width:auto">
          <option value="auto" ${!ui.voiceLang || ui.voiceLang === "auto" ? "selected" : ""}>Auto</option>
          <option value="ar" ${ui.voiceLang === "ar" ? "selected" : ""}>عربي</option>
          <option value="en" ${ui.voiceLang === "en" ? "selected" : ""}>English</option>
        </select>
        <button type="button" class="btn secondary" id="docAskMic" title="Ask by voice"><i class="fa-solid fa-microphone"></i></button>
        <button type="button" class="btn secondary ${ui.speak !== false ? "active" : ""}" id="docAskSpeak" title="Read the answer aloud"><i class="fa-solid ${ui.speak !== false ? "fa-volume-high" : "fa-volume-xmark"}"></i></button>
        <button type="button" class="btn primary" id="docAskBtn"><i class="fa-solid fa-magnifying-glass"></i> Ask</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12.5px;color:var(--text-dim);cursor:pointer">
        <input type="checkbox" id="docAutoOpen" ${ui.autoOpen !== false ? "checked" : ""} /> Automatically open the matching PDF page when a document answer is found
      </label>
      <div id="docAskResults" style="margin-top:16px">${renderDocSearchResults(ui.results)}</div>
    </div>

    ${isMaster ? `
    <div class="panel-card" id="docDropzone" style="margin-bottom:20px;border:2px dashed var(--line);text-align:center;padding:26px;cursor:pointer">
      <i class="fa-solid fa-file-arrow-up" style="font-size:22px;color:var(--text-dim)"></i>
      <div style="margin-top:8px;font-weight:600">Drag &amp; drop PDFs here, or click to browse</div>
      <div style="font-size:12.5px;color:var(--text-dim);margin-top:4px">PDF only, up to 100MB each — you can select several at once</div>
      <input type="file" id="docUploadInput" accept="application/pdf" multiple hidden />
    </div>` : ""}
    <div id="docUploadProgress"></div>

    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Name</th><th>Pages</th><th>Size</th><th>Uploaded</th><th>By</th><th></th></tr></thead>
      <tbody>${!ui.loaded ? `<tr><td colspan="6" class="table-empty">Loading…</td></tr>` :
        state.documents.length === 0 ? `<tr><td colspan="6" class="table-empty">No documents uploaded yet${isMaster ? " — drag a PDF into the box above" : ""}</td></tr>` :
        state.documents.map((d) => `<tr>
          <td>${esc(d.name)}${d.textTruncated ? ` <span class="badge" style="background:#fff3cd;color:#8a6100;border-color:#f0d78c">partially indexed</span>` : ""}</td>
          <td class="mono">${d.pageCount || "—"}</td>
          <td class="mono">${formatBytes(d.sizeBytes)}</td>
          <td class="mono">${esc((d.uploadedAt || "").slice(0, 10))}</td>
          <td class="mono">${esc(d.uploadedBy || "")}</td>
          <td style="white-space:nowrap">
            <button type="button" class="link-btn" data-view-doc="${d.id}">Open</button>
            ${isMaster ? ` · <button type="button" class="link-btn" style="color:var(--danger,#c0392b)" data-del-doc="${d.id}">Delete</button>` : ""}
          </td>
        </tr>`).join("")}</tbody></table></div>`;

  const input = el("docUploadInput");
  if (input) input.onchange = (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; files.forEach(uploadDocument); };
  const dropzone = el("docDropzone");
  if (dropzone) {
    dropzone.onclick = () => input && input.click();
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.borderColor = "var(--primary,#2f6fed)"; };
    dropzone.ondragleave = () => { dropzone.style.borderColor = "var(--line)"; };
    dropzone.ondrop = (e) => {
      e.preventDefault(); dropzone.style.borderColor = "var(--line)";
      Array.from(e.dataTransfer.files || []).forEach(uploadDocument);
    };
  }

  function runDocAsk() {
    ui.query = el("docAsk").value;
    if (!ui.query.trim()) { toast("Type a question first", "error"); return; }
    ui.results = answerDocAsk(ui.query, state.documents);
    el("docAskResults").innerHTML = renderDocSearchResults(ui.results);
    el("mainContent").querySelectorAll("[data-open-page]").forEach((b) => b.onclick = () => {
      const [docId, page] = b.dataset.openPage.split(":"); openDocument(docId, Number(page));
    });
    if (ui.speak !== false) speakDocAnswer(ui.results);
    if (ui.autoOpen !== false && ui.results.type === "docs" && ui.results.hits.length) {
      openDocument(ui.results.hits[0].docId, ui.results.hits[0].topPage);
    }
  }
  el("docAskBtn").onclick = runDocAsk;
  el("docAsk").onkeydown = (e) => { if (e.key === "Enter") runDocAsk(); };
  el("docAskMic").onclick = () => startDocVoiceInput(runDocAsk);
  el("docAskSpeak").onclick = () => {
    ui.speak = ui.speak === false; // toggle
    if (ui.speak === false && window.speechSynthesis) speechSynthesis.cancel();
    renderDocumentsView();
  };
  el("docAutoOpen").onchange = (e) => { ui.autoOpen = e.target.checked; };
  el("docVoiceLang").onchange = (e) => { ui.voiceLang = e.target.value; };


  el("mainContent").querySelectorAll("[data-view-doc]").forEach((b) => b.onclick = () => openDocument(b.dataset.viewDoc));
  el("mainContent").querySelectorAll("[data-del-doc]").forEach((b) => b.onclick = () => { if (confirm("Delete this document? This cannot be undone.")) deleteDocument(b.dataset.delDoc); });
}

/* ---------------------------------------------------------------------
   CONSUMPTION CHECK (Reconciliation) — pick a date range + an item, and
   compare what the system recorded as received/dispensed against a
   manually-entered actual/calibration reading, plus any manually-known
   branch-transfer / merge / return adjustments, to surface the difference.
--------------------------------------------------------------------- */
function logsInRange(catalogItemId, types, from, to, branchId) {
  return state.logs.filter((e) => e.catalogItemId === catalogItemId && types.includes(e.type)
    && (!branchId || e.branchId === branchId)
    && (!from || (e.date || "").slice(0, 10) >= from) && (!to || (e.date || "").slice(0, 10) <= to));
}
function sumQty(entries) { return round4(entries.reduce((s, e) => s + (Number(e.quantity) || 0), 0)); }
function toTestsFor(cat, qty) { return cat && Number(cat.testsPerUnit) ? round4(Number(cat.testsPerUnit) * qty) : round4(qty); }
function mergedQtyInRange(catalogItemId, from, to, branchId) {
  const rows = state.merges.filter((m) => m.catalogItemId === catalogItemId
    && (!branchId || m.branchId === branchId)
    && (!from || (m.date || "").slice(0, 10) >= from) && (!to || (m.date || "").slice(0, 10) <= to));
  const cat = catalogById(catalogItemId);
  return round4(rows.reduce((s, m) => s + toBaseQty(cat, Number(m.quantity) || 0, m.unit), 0));
}
/** Full breakdown for one item + date range (+ optional branch), in "tests" if the item has
 *  Tests-per-unit configured, otherwise in the item's plain stock unit. Automatically combines
 *  every lot/batch of this item, since consumption is tracked per item, not per lot. */
function reconciliationBreakdown(catalogItemId, from, to, branchId) {
  const cat = catalogById(catalogItemId);
  const receivedQty = sumQty(logsInRange(catalogItemId, ["in"], from, to, branchId));
  const dispensedQty = sumQty(logsInRange(catalogItemId, ["out"], from, to, branchId));
  const transferOutQty = sumQty(logsInRange(catalogItemId, ["transfer_out"], from, to, branchId));
  const mergeQty = mergedQtyInRange(catalogItemId, from, to, branchId);
  return {
    cat,
    receivedTests: toTestsFor(cat, receivedQty),
    dispensedTests: toTestsFor(cat, dispensedQty),
    transferOutTests: toTestsFor(cat, transferOutQty),
    mergeTests: toTestsFor(cat, mergeQty),
    unitLabel: cat && Number(cat.testsPerUnit) ? "tests" : (cat ? cat.unit : ""),
  };
}
/** The most recent saved check for this item (+ branch) before `beforeDate` — its "Actual count"
 *  becomes this period's Opening balance automatically, so each check picks up where the last
 *  left off and nobody has to type it in by hand. */
function lastReconciliationBefore(catalogItemId, beforeDate, branchId) {
  const prior = state.reconciliations
    .filter((r) => r.catalogItemId === catalogItemId && (!branchId || r.branchId === branchId) && (!beforeDate || (r.to || r.from || "") < beforeDate))
    .sort((a, b) => (a.to || a.from || "") < (b.to || b.from || "") ? 1 : -1);
  return prior[0] || null;
}
function renderReconciliationView() {
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const rc = state.ui.recon || { from: "", to: "", itemId: "", actual: "", branchId: state.role === "master" ? "" : (myBranch || "") };
  state.ui.recon = rc;
  const branchFilter = rc.branchId || null;
  const sortedCatalog = [...state.catalog].sort((a, b) => a.name.localeCompare(b.name));
  const b = rc.itemId ? reconciliationBreakdown(rc.itemId, rc.from, rc.to, branchFilter) : null;
  // Opening balance is always computed automatically — never typed in by hand — from the
  // "Actual count" saved on the last check for this item (0 if there is no earlier check yet).
  let opening = 0;
  if (b) { const prior = lastReconciliationBefore(rc.itemId, rc.from, branchFilter); opening = prior ? Number(prior.actual) || 0 : 0; }
  // System-recorded Dispensed is subtracted automatically to give an "expected remaining" —
  // this is what should still be there if nothing was used outside of a logged dispense/waste.
  const expectedRemaining = b ? round4(opening + b.receivedTests - b.dispensedTests) : null;
  const actual = rc.actual === "" ? null : (Number(rc.actual) || 0);
  const consumed = b && actual !== null ? round4(opening + b.receivedTests - actual) : null;
  const unaccounted = expectedRemaining !== null && actual !== null ? round4(expectedRemaining - actual) : null;
  const currentStockAllLots = rc.itemId ? totalStockFor(rc.itemId) : 0;

  const saved = [...state.reconciliations]
    .filter((r) => (!rc.from || (r.to || "") >= rc.from) && (!rc.to || (r.from || "") <= rc.to) && (!branchFilter || r.branchId === branchFilter))
    .sort((a, b2) => (a.createdAt < b2.createdAt ? 1 : -1));

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Consumption Check</h2><span class="subtitle">Opening + Received − Dispensed (auto) = expected remaining · vs. your physical count = consumed</span></div>
      ${saved.length ? `<button class="btn export" id="exportRecon"><i class="fa-solid fa-file-excel"></i> Export to Excel</button>` : ""}</div>
    <div class="filter-bar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
      <label style="font-size:12px;color:var(--text-dim)">From <input type="date" id="rcFrom" value="${esc(rc.from)}" style="margin-left:4px" /></label>
      <label style="font-size:12px;color:var(--text-dim)">To <input type="date" id="rcTo" value="${esc(rc.to)}" style="margin-left:4px" /></label>
      ${state.role === "master" ? `<label style="font-size:12px;color:var(--text-dim)">Branch
        <select id="rcBranch" style="margin-left:4px"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === rc.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></label>` : ""}
      <label style="font-size:12px;color:var(--text-dim)">Item
        <select id="rcItem" style="margin-left:4px"><option value="">Select item…</option>${sortedCatalog.map((c) => `<option value="${c.id}" ${c.id === rc.itemId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
      <button type="button" class="btn secondary" id="rcClear">Clear</button>
    </div>
    ${!rc.itemId ? `<div class="pick-empty">Select an item above to start its consumption check.</div>` : `
    <div class="card-form">
      <div class="panel-title">${esc(b.cat.name)} — ${esc(rc.from || "start")} → ${esc(rc.to || "today")} (${esc(b.unitLabel)})</div>
      <div class="form-row" style="margin:14px 0">
        <div class="field"><span class="field-label">Opening balance (auto-calculated)</span><input class="mono" readonly value="${opening}" /></div>
        <div class="field"><span class="field-label">Received in this period (system)</span><input class="mono" readonly value="${b.receivedTests}" /></div>
        <div class="field"><span class="field-label">Dispensed in this period (system)</span><input class="mono" readonly value="${b.dispensedTests}" /></div>
      </div>
      <div class="field-note" style="margin-bottom:14px">Dispensed is subtracted automatically (Opening + Received − Dispensed) to give the <strong>expected remaining: ${expectedRemaining}</strong> — what should still be there if nothing left the fridge without being logged. Current total in stock right now across all lots combined: <strong>${currentStockAllLots} ${esc(b.cat.unit)}</strong>.</div>
      <label class="field" style="margin-bottom:14px"><span class="field-label">Actual count now — full physical stock take *</span><input type="text" inputmode="decimal" dir="ltr" step="any" required id="rcActual" value="${esc(rc.actual)}" placeholder="e.g. 84" /></label>
      <div class="scan-result" style="margin-bottom:14px">
        <div class="scan-result-row"><span class="k">Expected remaining (Opening + Received − Dispensed)</span><span class="v mono">${expectedRemaining}</span></div>
        <div class="scan-result-row"><span class="k">Unaccounted for (Expected remaining − Actual)</span><span class="v mono" style="font-weight:700">${unaccounted === null ? "— enter actual count above —" : unaccounted}</span></div>
        <div class="scan-result-row"><span class="k">Total consumed (Opening + Received − Actual)</span><span class="v mono" style="font-weight:700;color:${consumed === null ? "inherit" : "var(--accent-text)"}">${consumed === null ? "— enter actual count above —" : consumed}</span></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="rcNext">Save &amp; next item</button>
        <button type="button" class="btn primary" id="rcSave">Save</button>
      </div>
    </div>`}
    <h3 style="margin:26px 0 12px;font-size:14px">Saved checks ${rc.from || rc.to ? "in this range" : ""}</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item</th><th>From</th><th>To</th><th>Branch</th><th>Opening</th><th>Received</th><th>Dispensed</th><th>Actual</th><th>Unaccounted</th><th>Consumed</th><th>By</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="12" class="table-empty">No saved consumption checks yet</td></tr>` : saved.map((r) => `
        <tr><td>${esc(r.itemName)}</td><td class="mono">${esc(r.from || "—")}</td><td class="mono">${esc(r.to || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${r.opening}</td><td class="mono">${r.receivedTests}</td><td class="mono">${r.dispensedTests ?? 0}</td><td class="mono">${r.actual}</td>
          <td class="mono">${r.unaccounted ?? ""}</td><td class="mono" style="font-weight:700">${r.consumed}</td><td>${esc(nameForEmail(r.byEmail))}</td>
          <td><button class="icon-btn-sm" data-del-recon="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}
      </tbody></table></div>`;

  el("rcFrom").oninput = (e) => { rc.from = e.target.value; renderReconciliationView(); };
  el("rcTo").oninput = (e) => { rc.to = e.target.value; renderReconciliationView(); };
  el("rcItem").onchange = (e) => { rc.itemId = e.target.value; rc.actual = ""; renderReconciliationView(); };
  const rcBranchEl = el("rcBranch"); if (rcBranchEl) rcBranchEl.onchange = (e) => { rc.branchId = e.target.value; renderReconciliationView(); };
  el("rcClear").onclick = () => { state.ui.recon = { from: "", to: "", itemId: "", actual: "", branchId: state.role === "master" ? "" : (myBranch || "") }; renderReconciliationView(); };
  const exportBtn = el("exportRecon");
  if (exportBtn) exportBtn.onclick = () => exportReconciliationsToExcel(saved);
  const actualEl = el("rcActual"); if (actualEl) { actualEl.oninput = (e) => { rc.actual = e.target.value; }; actualEl.onblur = () => renderReconciliationView(); }
  el("mainContent").querySelectorAll("[data-del-recon]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved check?")) deleteReconciliation(btn.dataset.delRecon); });
  const doSave = async (goNext) => {
    if (actual === null) { toast("Please enter what's currently in the device now first.", "warn"); return; }
    await saveReconciliation({
      catalogItemId: rc.itemId, itemName: b.cat.name, from: rc.from, to: rc.to,
      opening, receivedTests: b.receivedTests, dispensedTests: b.dispensedTests, actual, unaccounted, consumed, branchId: rc.branchId || myBranch || null,
    });
    rc.itemId = ""; rc.actual = "";
    if (!goNext) { toast("Saved.", "success"); }
    renderReconciliationView();
  };
  const saveEl = el("rcSave"); if (saveEl) saveEl.onclick = () => doSave(false);
  const nextEl = el("rcNext"); if (nextEl) nextEl.onclick = () => doSave(true);
}
/** Print/export header for the Inventory List — kept as one fixed column order (Department,
 *  Item number, Product name, Lot number, Quantity, Quantity by test, Expiry, Unit, Safety
 *  limit, Status, Warehouse) so the exported file can also be used as a filter reference. */
function exportInventoryToExcel(list) {
  const headers = ["Department", "Item number", "Product name", "Lot number", "In use", "Quantity", "Quantity by test", "Expiry", "Unit", "Safety limit", "Status", "Warehouse"];
  const data = list.map((b) => {
    const qtyByTest = b.cat.testsPerUnit ? round4(Number(b.cat.testsPerUnit) * (Number(b.quantity) || 0)) : "";
    const warehouse = `${fridgeName(b.fridgeId)}${b.shelf ? " · " + b.shelf : ""}`;
    return [branchName(b.branchId), b.cat.itemNumber || "", b.cat.name, b.lot || "", b.inUse ? "Yes" : "No", b.quantity, qtyByTest, b.expiry || "", b.cat.unit || "", b.cat.safetyLimit || "", statusOf(b.expiry).key, warehouse];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventory List");
  XLSX.writeFile(wb, "inventory_list.xlsx");
}
function exportCatalogToExcel() {
  const headers = ["Item Name", "Category", "Unit", "Item Number", "Barcode", "Units per box", "Tests per unit", "Safety limit", "Supplier", "Current stock"];
  const data = [...state.catalog].sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => [c.name, c.category, c.unit, c.itemNumber || "", c.barcode || "", c.unitsPerBox || 1, c.testsPerUnit || "", c.safetyLimit || "", c.supplier || "", totalStockFor(c.id)]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Catalog");
  XLSX.writeFile(wb, "catalog.xlsx");
}
function exportReconciliationsToExcel(rows) {
  const headers = ["Item", "From", "To", "Branch", "Opening balance", "Received", "Dispensed (system)", "Actual count now", "Unaccounted for", "Consumed", "Saved by", "Saved at"];
  const data = rows.map((r) => [r.itemName, r.from || "", r.to || "", branchName(r.branchId), r.opening, r.receivedTests, r.dispensedTests ?? 0, r.actual, r.unaccounted ?? "", r.consumed, nameForEmail(r.byEmail), r.createdAt || ""]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Consumption Check");
  XLSX.writeFile(wb, "consumption_check.xlsx");
}
/** One row per analyte tested (a saved Lot-to-Lot session can have several), flattened for a
 *  spreadsheet — mirrors the columns on the printed form plus the session's Branch/Reviewed By. */
function exportLotToLotToExcel(sessions) {
  const headers = ["Session Date", "Branch", "Section", "Instrument", "Sample No.", "Assay", "New Lot #", "New Lot Exp.", "Old Lot #", "Old Lot Exp.", "New Result", "Old Result", "% Difference", "T.A.E.", "PASSED", "Comment", "Performed By", "Reviewed By", "Review Date"];
  const data = [];
  sessions.forEach((s) => {
    (s.rows || []).forEach((row) => {
      const { tae, pctDiff, passed } = lotRowResult(row);
      data.push([s.sessionDate || "", branchName(s.branchId), s.section || "", s.instrument || "", row.sampleNo || "", row.assayLong || "",
        row.newLot || "", row.newLotExp || "", row.oldLot || "", row.oldLotExp || "", row.newResult || "", row.oldResult || "",
        pctDiff === null ? "" : (pctDiff * 100).toFixed(2) + "%", tae ? tae.source : "", passed, row.comment || "", s.performedBy || "", s.reviewedBy || "", s.reviewDate || ""]);
    });
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Lot to Lot");
  XLSX.writeFile(wb, "lot_to_lot_logs.xlsx");
}

/* ---------------------------------------------------------------------
   REPORTS — one place to export every module's data, instead of hunting
   for the export button on each individual page.
--------------------------------------------------------------------- */
function renderReportsView() {
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const scoped = (list) => state.role === "master" ? list : list.filter((x) => (x.branchId || null) === myBranch);

  const invList = scoped(state.batches).map((b) => ({ ...b, cat: catalogById(b.catalogItemId) || { name: "(deleted item)", category: "", unit: "", barcode: "" } }));
  const expiredList = invList.filter((b) => statusOf(b.expiry).key === "expired").sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  const damagedList = scoped(state.logs.filter((e) => e.type === "damage"));
  const activityList = scoped(state.logs);
  const reconList = scoped(state.reconciliations || []);
  const lotList = scoped(state.lotVerifications || []);

  const cards = [
    { icon: "fa-boxes-stacked", title: "Full Inventory", sub: "Every batch currently in stock, with expiry & warehouse location", count: `${invList.length} batches`, action: "repInv" },
    { icon: "fa-triangle-exclamation", title: "Expired Items", sub: "Everything past its expiration date", count: `${expiredList.length} items`, action: "repExp" },
    { icon: "fa-trash-can", title: "Damaged / Wasted", sub: "Discarded or compromised stock, with reasons", count: `${damagedList.length} entries`, action: "repDmg" },
    { icon: "fa-clipboard-list", title: "Activity Log", sub: "Every receive, dispense, transfer & waste transaction", count: `${activityList.length} transactions`, action: "repAct" },
    { icon: "fa-calculator", title: "Consumption Checks", sub: "Saved reconciliation snapshots", count: `${reconList.length} checks`, action: "repRecon" },
    { icon: "fa-flask-vial", title: "Lot to Lot Logs", sub: "Every saved reagent lot verification, one row per analyte", count: `${lotList.length} sessions`, action: "repLot" },
    { icon: "fa-tags", title: "Catalog", sub: "The full reagent/control catalog with current totals", count: `${state.catalog.length} items`, action: "repCat" },
  ];

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Reports</h2><span class="subtitle">Export any module's data to Excel or CSV in one click</span></div></div>
    <div class="report-grid">
      ${cards.map((c) => `
        <div class="panel-card report-card">
          <div class="report-card-icon"><i class="fa-solid ${c.icon}"></i></div>
          <div class="panel-title">${c.title}</div>
          <div class="panel-sub">${c.sub}</div>
          <div class="report-card-count">${c.count}</div>
          <button type="button" class="btn export full" id="${c.action}"><i class="fa-solid fa-file-arrow-down"></i> Export</button>
        </div>`).join("")}
    </div>`;

  el("repInv").onclick = () => exportInventoryToExcel(invList);
  el("repExp").onclick = () => downloadCSV("expired_items.csv", ["Item Name", "Lot Number", "Quantity", "Expiry Date", "Fridge", "Shelf"],
    expiredList.map((b) => [b.cat.name, b.lot, b.quantity, b.expiry, fridgeName(b.fridgeId), b.shelf]));
  el("repDmg").onclick = () => downloadCSV("damaged_items.csv", ["Date", "Item", "Lot", "Quantity", "Reason", "Reported By"],
    damagedList.map((e) => [e.date, catalogById(e.catalogItemId)?.name || "", e.lot, e.quantity, e.reason, nameForEmail(e.byEmail)]));
  el("repAct").onclick = () => downloadCSV("activity_log.csv", ["Date", "Type", "Item", "Lot", "Expiry", "Quantity", "Method", "Branch", "By"],
    activityList.map((e) => [e.date, e.type, catalogById(e.catalogItemId)?.name || "", e.lot, e.expiry, e.quantity, e.method, e.branchName, nameForEmail(e.byEmail)]));
  el("repRecon").onclick = () => exportReconciliationsToExcel(reconList);
  el("repLot").onclick = () => exportLotToLotToExcel(lotList);
  el("repCat").onclick = () => exportCatalogToExcel();
}

const AUDIT_ACTION_LABELS = {
  delete_fridge: "Deleted fridge", delete_catalog_item: "Deleted catalog item", delete_branch: "Deleted branch",
  add_user: "Added user", remove_user: "Removed user", change_user_branch: "Changed user's branch",
  delete_batch: "Deleted stock batch", delete_reconciliation: "Deleted reconciliation", delete_instrument: "Deleted instrument",
  delete_shift_endorsement: "Deleted shift handover note", delete_lot_verification: "Deleted lot verification",
  delete_precision_run: "Deleted precision run", delete_accuracy_run: "Deleted accuracy run",
  delete_comparison_run: "Deleted comparison run", delete_qual_precision_run: "Deleted qualitative precision run",
  delete_qual_comparison_run: "Deleted qualitative comparison run",
  delete_reference_interval_run: "Deleted reference interval run", delete_linearity_run: "Deleted linearity run",
};
/** Master-only, read-only view of the immutable admin audit trail (auditLog collection) — separate
 *  from the day-to-day inventory Activity Log. Covers sensitive admin actions: deleting a fridge,
 *  catalog item, or branch, and adding/removing/reassigning a user. Nothing here can be edited or
 *  deleted, by design (firestore.rules blocks update/delete on this collection entirely). */
function renderAuditLogView() {
  const rows = [...state.auditLog].sort((a, b) => chatTimeIso(b).localeCompare(chatTimeIso(a)));
  el("mainContent").innerHTML = `
    <div class="page-header">
      <div><h2>Audit Log</h2><span class="subtitle">Immutable record of sensitive admin actions — who did what, and when (Master only)</span></div>
      <button type="button" class="btn export" id="auditExport"><i class="fa-solid fa-file-arrow-down"></i> Export</button>
    </div>
    <div class="panel-card">
      ${rows.length === 0 ? `<div class="table-empty">No admin actions recorded yet</div>` : `
      <table class="data-table">
        <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Details</th><th>By</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td class="mono">${esc(chatTimeIso(r).replace("T", " ").slice(0, 16))}</td>
            <td>${esc(AUDIT_ACTION_LABELS[r.action] || r.action)}</td>
            <td>${esc(r.targetLabel || "")}</td>
            <td>${esc(r.details || "")}</td>
            <td>${esc(nameForEmail(r.byEmail))}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    </div>`;
  el("auditExport").onclick = () => downloadCSV("audit_log.csv", ["When", "Action", "Target", "Details", "By"],
    rows.map((r) => [chatTimeIso(r).replace("T", " ").slice(0, 16), AUDIT_ACTION_LABELS[r.action] || r.action, r.targetLabel || "", r.details || "", nameForEmail(r.byEmail)]));
}

async function saveReconciliation(data) {
  await db.collection("reconciliations").add({ ...data, byEmail: state.user.email, createdAt: nowStr() });
}
async function deleteReconciliation(id) {
  const r = state.reconciliations.find((x) => x.id === id);
  await db.collection("reconciliations").doc(id).delete();
  logAudit("delete_reconciliation", r ? r.itemName : id, r ? `unaccounted ${r.unaccounted ?? "—"}` : "");
}

/* ---------------------------------------------------------------------
   INSTRUMENTS (analyzers/devices + Preventive Maintenance due dates)
--------------------------------------------------------------------- */
function pmStatusOf(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return { key: "none", days };
  if (days < 0) return { key: "expired", days }; // overdue
  if (days <= 14) return { key: "soon", days };
  if (days <= 45) return { key: "watch", days };
  return { key: "ok", days };
}
function instrumentsPmDueSoon() {
  return state.instruments.filter((i) => ["soon", "expired"].includes(pmStatusOf(i.nextPmDate).key));
}
async function saveInstrument(data) {
  if (data.id) { const { id, ...rest } = data; await db.collection("instruments").doc(id).set(rest, { merge: true }); }
  else await db.collection("instruments").add({ ...data, addedBy: state.user.email, addedAt: nowStr() });
}
async function deleteInstrument(id) {
  const inst = state.instruments.find((x) => x.id === id);
  await db.collection("instruments").doc(id).delete();
  logAudit("delete_instrument", inst ? inst.name : id, inst && inst.serial ? `serial ${inst.serial}` : "");
}

function renderInstrumentsView() {
  const isMaster = state.role === "master";
  const emptyForm = () => ({ name: "", model: "", serial: "", lastPmDate: "", nextPmDate: "", engineerName: "", engineerPhone: "", engineerEmail: "", branchId: isMaster ? "" : (state.myBranchId || "") });
  const is = { editing: null, form: emptyForm() };

  function body() {
    // Group each branch's instruments together, since every branch has its own dedicated devices.
    const sorted = [...state.instruments].sort((a, b) => {
      const bc = (branchName(a.branchId) || "").localeCompare(branchName(b.branchId) || "");
      if (bc !== 0) return bc;
      const da = daysUntil(a.nextPmDate), db2 = daysUntil(b.nextPmDate);
      if (da === null) return 1; if (db2 === null) return -1; return da - db2;
    });
    return `
    <div class="page-header"><div><h2>Instruments</h2><span class="subtitle">Analyzers &amp; devices with their Preventive Maintenance (PM) schedule</span></div></div>
    <div class="card-form">
      <form id="instForm">
        <div class="form-row">
          <label class="field"><span class="field-label">Instrument name *</span><input required id="iName" value="${esc(is.form.name)}" placeholder="e.g. Beckman DXI 800" /></label>
          <label class="field"><span class="field-label">Model / Serial</span><input id="iModel" value="${esc(is.form.model)}" placeholder="e.g. SN-104829" /></label>
        </div>
        <div class="form-row">
          ${isMaster ? fieldHtml("Branch *", `<select required id="iBranch"><option value="" disabled ${is.form.branchId ? "" : "selected"}>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === is.form.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
          ${isMaster && state.branches.length === 0 ? `<p class="field-note">No branches set up yet — add one from "Branches" first.</p>` : ""}
        </div>
        <div class="form-row">
          <label class="field"><span class="field-label">Last PM date</span><input type="date" id="iLastPm" value="${esc(is.form.lastPmDate)}" /></label>
          <label class="field"><span class="field-label">Next PM due date</span><input type="date" id="iNextPm" value="${esc(is.form.nextPmDate)}" readonly title="Auto-calculated: Last PM + 6 months" style="background:var(--panel-2);color:var(--text-dim)" /></label>
        </div>
        <p class="field-note" style="margin:-6px 0 6px">Next PM is calculated automatically — Last PM date + 6 months. PM cycle repeats every 6 months from whatever "Last PM" is entered.</p>
        <div class="form-row">
          <label class="field"><span class="field-label">PM engineer name</span><input id="iEngName" value="${esc(is.form.engineerName)}" placeholder="e.g. Faisal Al-Otaibi" /></label>
          <label class="field"><span class="field-label">Engineer mobile</span><input id="iEngPhone" value="${esc(is.form.engineerPhone)}" placeholder="05xxxxxxxx" /></label>
          <label class="field"><span class="field-label">Engineer email</span><input type="email" id="iEngEmail" value="${esc(is.form.engineerEmail)}" placeholder="engineer@vendor.com" /></label>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          ${is.editing ? `<button type="button" class="btn secondary" id="iCancel">Cancel</button>` : ""}
          <button type="submit" class="btn primary">${is.editing ? "Save changes" : "Add instrument"}</button>
        </div>
      </form>
    </div>
    <div class="table-wrap" style="margin-top:20px"><table class="data-table">
      <thead><tr><th>Instrument</th><th>Model / Serial</th><th>Branch</th><th>Last PM</th><th>Next PM Due</th><th>PM Engineer</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${sorted.length === 0 ? `<tr><td colspan="8" class="table-empty">No instruments added yet</td></tr>` : sorted.map((i) => {
        const s = pmStatusOf(i.nextPmDate);
        const engBits = [i.engineerName, i.engineerPhone, i.engineerEmail].filter(Boolean);
        return `<tr>
          <td>${esc(i.name)}</td><td class="mono">${esc(i.model || "—")}</td><td>${esc(branchName(i.branchId))}</td>
          <td class="mono">${esc(i.lastPmDate || "—")}</td><td class="mono">${esc(i.nextPmDate || "—")}</td>
          <td style="font-size:11.5px">${engBits.length === 0 ? "—" : engBits.map((b) => esc(b)).join("<br/>")}</td>
          <td>${badgeHtml(s)}</td>
          <td><button class="icon-btn-sm" data-edit-inst="${i.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
              <button class="icon-btn-sm" data-del-inst="${i.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  function render() {
    el("mainContent").innerHTML = body();
    el("iName").oninput = (e) => is.form.name = e.target.value;
    el("iModel").oninput = (e) => is.form.model = e.target.value;
    el("iLastPm").oninput = (e) => { is.form.lastPmDate = e.target.value; is.form.nextPmDate = addMonths(is.form.lastPmDate, 6); el("iNextPm").value = is.form.nextPmDate; };
    el("iEngName").oninput = (e) => is.form.engineerName = e.target.value;
    el("iEngPhone").oninput = (e) => is.form.engineerPhone = e.target.value;
    el("iEngEmail").oninput = (e) => is.form.engineerEmail = e.target.value;
    const branchEl = el("iBranch"); if (branchEl) branchEl.onchange = (e) => is.form.branchId = e.target.value;
    const cancelBtn = el("iCancel"); if (cancelBtn) cancelBtn.onclick = () => { is.editing = null; is.form = emptyForm(); render(); };
    el("mainContent").querySelectorAll("[data-edit-inst]").forEach((b) => b.onclick = () => {
      const item = state.instruments.find((x) => x.id === b.dataset.editInst);
      is.editing = item.id;
      is.form = { name: item.name, model: item.model || "", lastPmDate: item.lastPmDate || "", nextPmDate: item.nextPmDate || "", engineerName: item.engineerName || "", engineerPhone: item.engineerPhone || "", engineerEmail: item.engineerEmail || "", branchId: item.branchId || "" };
      render();
    });
    el("mainContent").querySelectorAll("[data-del-inst]").forEach((b) => b.onclick = () => { if (confirm("Delete this instrument?")) deleteInstrument(b.dataset.delInst); });
    el("instForm").onsubmit = async (e) => {
      e.preventDefault();
      const branchId = isMaster ? is.form.branchId : (state.myBranchId || null);
      if (isMaster && !branchId) { toast("Please select a branch.", "warn"); return; }
      try {
        await saveInstrument(is.editing ? { id: is.editing, ...is.form, branchId } : { ...is.form, branchId });
        is.editing = null; is.form = emptyForm();
        render();
      } catch (err) {
        console.error("saveInstrument failed:", err);
        toast("Failed to save: " + (err && err.message ? err.message : err), "error");
      }
    };
  }
  render();
}

/* ---------------------------------------------------------------------
   MONTHLY QC — CV MONITORING (Form LabGen 105)
   Mirrors the lab's own spreadsheet layout: one grid per instrument, months down the side
   (each split into QC levels like QC1/QC2 or Level 1/Level 2), every analyte the instrument
   tests for across the top with its Acceptable CV% fixed in the header row, and an out-of-range
   cell turning red — same as the Excel "DxC 700 AU" / "DxH" / etc. tabs.
   Two collections:
     - cvLimits: shared "Acceptable CV%" reference table (Analyzer + Analyte -> limit + column
       order), same across every branch — like the catalog, not branch-scoped.
     - monthlyQcEntries: one document per (branch, instrument, year, month, QC level) holding a
       CV% value per analyte (`values`), same as one row of the spreadsheet. If any analyte in
       that row exceeds its limit, a single Corrective Action for the whole row (Details / Comment
       / Additional comments / Filled precision investigation, from the lab's Investigation log)
       becomes required before it can be saved.
--------------------------------------------------------------------- */

// One-time import list, extracted directly from the lab's Monthly_CV_Monitoring.xlsx
// "Acceptable CV%" reference rows (15 analyzers, 164 analytes, in the same left-to-right column
// order as the spreadsheet). Used only by the "Load default reference limits" button below — it
// never runs automatically, and it skips any Analyzer+Analyte pair already in cvLimits.
const DEFAULT_CV_LIMITS = [
  // DxC 700
  { analyzer: "DxC 700", analyte: "Na", acceptableCv: 3.0, order: 0 },
  { analyzer: "DxC 700", analyte: "K", acceptableCv: 3.0, order: 1 },
  { analyzer: "DxC 700", analyte: "Cl", acceptableCv: 3.0, order: 2 },
  { analyzer: "DxC 700", analyte: "ALB", acceptableCv: 3.0, order: 3 },
  { analyzer: "DxC 700", analyte: "ALP", acceptableCv: 10.0, order: 4 },
  { analyzer: "DxC 700", analyte: "ALT", acceptableCv: 10.0, order: 5 },
  { analyzer: "DxC 700", analyte: "AST", acceptableCv: 10.0, order: 6 },
  { analyzer: "DxC 700", analyte: "PHOS", acceptableCv: 5.0, order: 7 },
  { analyzer: "DxC 700", analyte: "LIP", acceptableCv: 10.0, order: 8 },
  { analyzer: "DxC 700", analyte: "TRIG", acceptableCv: 5.0, order: 9 },
  { analyzer: "DxC 700", analyte: "UIBC", acceptableCv: 5.0, order: 10 },
  { analyzer: "DxC 700", analyte: "CREA", acceptableCv: 5.0, order: 11 },
  { analyzer: "DxC 700", analyte: "HDL", acceptableCv: 4.0, order: 12 },
  { analyzer: "DxC 700", analyte: "LDL", acceptableCv: 4.0, order: 13 },
  { analyzer: "DxC 700", analyte: "TP", acceptableCv: 4.0, order: 14 },
  { analyzer: "DxC 700", analyte: "TBIL", acceptableCv: 5.0, order: 15 },
  { analyzer: "DxC 700", analyte: "FE", acceptableCv: 5.0, order: 16 },
  { analyzer: "DxC 700", analyte: "DBIL", acceptableCv: 7.5, order: 17 },
  { analyzer: "DxC 700", analyte: "CA", acceptableCv: 1.25, order: 18 },
  { analyzer: "DxC 700", analyte: "GGT", acceptableCv: 10.0, order: 19 },
  { analyzer: "DxC 700", analyte: "LDH", acceptableCv: 10.0, order: 20 },
  { analyzer: "DxC 700", analyte: "GLU", acceptableCv: 3.0, order: 21 },
  { analyzer: "DxC 700", analyte: "CHOL", acceptableCv: 3.0, order: 22 },
  { analyzer: "DxC 700", analyte: "RF", acceptableCv: 8.0, order: 23 },
  { analyzer: "DxC 700", analyte: "UREA", acceptableCv: 5.0, order: 24 },
  { analyzer: "DxC 700", analyte: "UA", acceptableCv: 3.0, order: 25 },
  { analyzer: "DxC 700", analyte: "CRP", acceptableCv: 6.0, order: 26 },
  { analyzer: "DxC 700", analyte: "MG", acceptableCv: 5.0, order: 27 },
  { analyzer: "DxC 700", analyte: "CK", acceptableCv: 5.0, order: 28 },
  { analyzer: "DxC 700", analyte: "IgA", acceptableCv: 10.0, order: 29 },
  { analyzer: "DxC 700", analyte: "IgG", acceptableCv: 10.0, order: 30 },
  { analyzer: "DxC 700", analyte: "IgE", acceptableCv: 10.0, order: 31 },
  { analyzer: "DxC 700", analyte: "IgM", acceptableCv: 4.1, order: 32 },
  { analyzer: "DxC 700", analyte: "AMY", acceptableCv: 5.0, order: 33 },
  { analyzer: "DxC 700", analyte: "C3", acceptableCv: 5.0, order: 34 },
  { analyzer: "DxC 700", analyte: "C4", acceptableCv: 5.0, order: 35 },
  { analyzer: "DxC 700", analyte: "ASO", acceptableCv: 10.0, order: 36 },
  { analyzer: "DxC 700", analyte: "CK - T", acceptableCv: 10.0, order: 37 },
  { analyzer: "DxC 700", analyte: "D-Dimer", acceptableCv: 10.0, order: 38 },
  { analyzer: "DxC 700", analyte: "CRP - 47", acceptableCv: 5.0, order: 39 },
  { analyzer: "DxC 700", analyte: "CRP - N", acceptableCv: 5.0, order: 40 },
  { analyzer: "DxC 700", analyte: "zinc", acceptableCv: 10.0, order: 41 },
  { analyzer: "DxC 700", analyte: "CREA - U", acceptableCv: 5.0, order: 42 },
  { analyzer: "DxC 700", analyte: "GLU -U", acceptableCv: 3.0, order: 43 },
  { analyzer: "DxC 700", analyte: "CA - U", acceptableCv: 2.0, order: 44 },
  { analyzer: "DxC 700", analyte: "PROTEIN -U", acceptableCv: 10.0, order: 45 },
  { analyzer: "DxC 700", analyte: "UREA - U", acceptableCv: 5.0, order: 46 },
  { analyzer: "DxC 700", analyte: "MG - U", acceptableCv: 5.0, order: 47 },
  { analyzer: "DxC 700", analyte: "PHOS - U", acceptableCv: 5.0, order: 48 },
  { analyzer: "DxC 700", analyte: "K - U", acceptableCv: 3.0, order: 49 },
  { analyzer: "DxC 700", analyte: "Cl - U", acceptableCv: 3.0, order: 50 },
  { analyzer: "DxC 700", analyte: "Na - U", acceptableCv: 3.0, order: 51 },
  { analyzer: "DxC 700", analyte: "UA - U", acceptableCv: 3.0, order: 52 },
  { analyzer: "DxC 700", analyte: "URN CREA", acceptableCv: 5.0, order: 53 },
  { analyzer: "DxC 700", analyte: "URINE ALB", acceptableCv: 10.0, order: 54 },
  // DxH 560
  { analyzer: "DxH 560", analyte: "WBC", acceptableCv: 6.0, order: 0 },
  { analyzer: "DxH 560", analyte: "RBC", acceptableCv: 3.0, order: 1 },
  { analyzer: "DxH 560", analyte: "HGB", acceptableCv: 2.0, order: 2 },
  { analyzer: "DxH 560", analyte: "HCT", acceptableCv: 3.0, order: 3 },
  { analyzer: "DxH 560", analyte: "MCV", acceptableCv: 2.0, order: 4 },
  { analyzer: "DxH 560", analyte: "MCH", acceptableCv: 3.0, order: 5 },
  { analyzer: "DxH 560", analyte: "MCHC", acceptableCv: 4.0, order: 6 },
  { analyzer: "DxH 560", analyte: "RDW", acceptableCv: 4.0, order: 7 },
  { analyzer: "DxH 560", analyte: "PLT", acceptableCv: 10.0, order: 8 },
  // DxI 800
  { analyzer: "DxI 800", analyte: "AFP", acceptableCv: 12.0, order: 0 },
  { analyzer: "DxI 800", analyte: "AMH", acceptableCv: 10.0, order: 1 },
  { analyzer: "DxI 800", analyte: "BR 15-3", acceptableCv: 10.0, order: 2 },
  { analyzer: "DxI 800", analyte: "CEA", acceptableCv: 9.0, order: 3 },
  { analyzer: "DxI 800", analyte: "ESTRADIOL", acceptableCv: 12.0, order: 4 },
  { analyzer: "DxI 800", analyte: "FERRITIN", acceptableCv: 10.0, order: 5 },
  { analyzer: "DxI 800", analyte: "FOL", acceptableCv: 15.0, order: 6 },
  { analyzer: "DxI 800", analyte: "F.PSA", acceptableCv: 7.0, order: 7 },
  { analyzer: "DxI 800", analyte: "F. T4", acceptableCv: 10.0, order: 8 },
  { analyzer: "DxI 800", analyte: "F. T3", acceptableCv: 12.0, order: 9 },
  { analyzer: "DxI 800", analyte: "CA 19-9", acceptableCv: 10.0, order: 10 },
  { analyzer: "DxI 800", analyte: "B-HCG", acceptableCv: 10.0, order: 11 },
  { analyzer: "DxI 800", analyte: "INS", acceptableCv: 10.0, order: 12 },
  { analyzer: "DxI 800", analyte: "CA 125", acceptableCv: 10.0, order: 13 },
  { analyzer: "DxI 800", analyte: "PTH", acceptableCv: 8.0, order: 14 },
  { analyzer: "DxI 800", analyte: "PRL", acceptableCv: 10.0, order: 15 },
  { analyzer: "DxI 800", analyte: "T. PSA", acceptableCv: 7.0, order: 16 },
  { analyzer: "DxI 800", analyte: "TESTO", acceptableCv: 10.0, order: 17 },
  { analyzer: "DxI 800", analyte: "TSH", acceptableCv: 10.0, order: 18 },
  { analyzer: "DxI 800", analyte: "VIT B12", acceptableCv: 12.0, order: 19 },
  { analyzer: "DxI 800", analyte: "VIT D", acceptableCv: 10.0, order: 20 },
  { analyzer: "DxI 800", analyte: "CORTISOL", acceptableCv: 8.0, order: 21 },
  { analyzer: "DxI 800", analyte: "AMH2", acceptableCv: 10.0, order: 22 },
  { analyzer: "DxI 800", analyte: "TPO Abs", acceptableCv: 12.0, order: 23 },
  { analyzer: "DxI 800", analyte: "C-PEPTIDE", acceptableCv: 10.0, order: 24 },
  { analyzer: "DxI 800", analyte: "DHEA - S", acceptableCv: 10.0, order: 25 },
  { analyzer: "DxI 800", analyte: "GH", acceptableCv: 10.0, order: 26 },
  { analyzer: "DxI 800", analyte: "PROG", acceptableCv: 14.7, order: 27 },
  { analyzer: "DxI 800", analyte: "SHBG", acceptableCv: 10.0, order: 28 },
  { analyzer: "DxI 800", analyte: "SENSITIVE E2", acceptableCv: 10.0, order: 29 },
  { analyzer: "DxI 800", analyte: "TG Ag", acceptableCv: 10.0, order: 30 },
  { analyzer: "DxI 800", analyte: "TG Abs", acceptableCv: 10.0, order: 31 },
  // Mindray
  { analyzer: "Mindray", analyte: "G6PD", acceptableCv: 1.83, order: 0 },
  // Architect i1000
  { analyzer: "Architect i1000", analyte: "PHENO", acceptableCv: 10.0, order: 0 },
  { analyzer: "Architect i1000", analyte: "PHENY", acceptableCv: 10.0, order: 1 },
  { analyzer: "Architect i1000", analyte: "CARBA", acceptableCv: 7.0, order: 2 },
  { analyzer: "Architect i1000", analyte: "TACRO", acceptableCv: 10.0, order: 3 },
  { analyzer: "Architect i1000", analyte: "VALP", acceptableCv: 7.0, order: 4 },
  { analyzer: "Architect i1000", analyte: "VANCO", acceptableCv: 10.0, order: 5 },
  { analyzer: "Architect i1000", analyte: "DIG", acceptableCv: 10.0, order: 6 },
  // Alinity I
  { analyzer: "Alinity I", analyte: "TACRO", acceptableCv: 20.0, order: 0 },
  { analyzer: "Alinity I", analyte: "SYPH", acceptableCv: 6.4, order: 1 },
  { analyzer: "Alinity I", analyte: "HCY", acceptableCv: 20.0, order: 2 },
  { analyzer: "Alinity I", analyte: "ANTI-CCP*", acceptableCv: 20.0, order: 3 },
  { analyzer: "Alinity I", analyte: "CK - MB", acceptableCv: 20.0, order: 4 },
  { analyzer: "Alinity I", analyte: "BNP", acceptableCv: 20.0, order: 5 },
  { analyzer: "Alinity I", analyte: "PCT", acceptableCv: 5.1, order: 6 },
  { analyzer: "Alinity I", analyte: "CYCLO", acceptableCv: 20.0, order: 7 },
  { analyzer: "Alinity I", analyte: "TROP I", acceptableCv: 10.0, order: 8 },
  // Alinity II
  { analyzer: "Alinity II", analyte: "TACRO", acceptableCv: 20.0, order: 0 },
  { analyzer: "Alinity II", analyte: "SYPH", acceptableCv: 6.4, order: 1 },
  { analyzer: "Alinity II", analyte: "HCY", acceptableCv: 20.0, order: 2 },
  { analyzer: "Alinity II", analyte: "ANTI-CCP*", acceptableCv: 20.0, order: 3 },
  { analyzer: "Alinity II", analyte: "CK - MB", acceptableCv: 20.0, order: 4 },
  { analyzer: "Alinity II", analyte: "BNP", acceptableCv: 20.0, order: 5 },
  { analyzer: "Alinity II", analyte: "PCT", acceptableCv: 5.1, order: 6 },
  { analyzer: "Alinity II", analyte: "CYCLO", acceptableCv: 20.0, order: 7 },
  { analyzer: "Alinity II", analyte: "TROP I", acceptableCv: 10.0, order: 8 },
  // IDS iSYS
  { analyzer: "IDS iSYS", analyte: "RENIN", acceptableCv: 11.2, order: 0 },
  { analyzer: "IDS iSYS", analyte: "ALD", acceptableCv: 12.8, order: 1 },
  { analyzer: "IDS iSYS", analyte: "IGF - 1", acceptableCv: 7.2, order: 2 },
  { analyzer: "IDS iSYS", analyte: "17-OH", acceptableCv: 11.1, order: 3 },
  { analyzer: "IDS iSYS", analyte: "ACTH", acceptableCv: 14.3, order: 4 },
  // Stago Compact Max 3
  { analyzer: "Stago Compact Max 3", analyte: "PT", acceptableCv: 5.0, order: 0 },
  { analyzer: "Stago Compact Max 3", analyte: "aPTT", acceptableCv: 5.0, order: 1 },
  { analyzer: "Stago Compact Max 3", analyte: "LUPUS AC", acceptableCv: 5.0, order: 2 },
  { analyzer: "Stago Compact Max 3", analyte: "FACTOR VIII", acceptableCv: 20.0, order: 3 },
  { analyzer: "Stago Compact Max 3", analyte: "FACTOR IX", acceptableCv: 20.0, order: 4 },
  { analyzer: "Stago Compact Max 3", analyte: "AT III", acceptableCv: 20.0, order: 5 },
  { analyzer: "Stago Compact Max 3", analyte: "PROTEIN C", acceptableCv: 20.0, order: 6 },
  { analyzer: "Stago Compact Max 3", analyte: "PROTEIN S", acceptableCv: 20.0, order: 7 },
  { analyzer: "Stago Compact Max 3", analyte: "FBG", acceptableCv: 10.0, order: 8 },
  // D10
  { analyzer: "D10", analyte: "HbA1c", acceptableCv: 2.0, order: 0 },
  // Sysmex XN-1000
  { analyzer: "Sysmex XN-1000", analyte: "WBC", acceptableCv: 5.0, order: 0 },
  { analyzer: "Sysmex XN-1000", analyte: "RBC", acceptableCv: 4.5, order: 1 },
  { analyzer: "Sysmex XN-1000", analyte: "HGB", acceptableCv: 3.0, order: 2 },
  { analyzer: "Sysmex XN-1000", analyte: "HCT", acceptableCv: 4.5, order: 3 },
  { analyzer: "Sysmex XN-1000", analyte: "MCV", acceptableCv: 4.5, order: 4 },
  { analyzer: "Sysmex XN-1000", analyte: "MCH", acceptableCv: 4.5, order: 5 },
  { analyzer: "Sysmex XN-1000", analyte: "MCHC", acceptableCv: 6.0, order: 6 },
  { analyzer: "Sysmex XN-1000", analyte: "RDW", acceptableCv: 6.0, order: 7 },
  { analyzer: "Sysmex XN-1000", analyte: "PLT", acceptableCv: 13.0, order: 8 },
  // AAS
  { analyzer: "AAS", analyte: "ZINC", acceptableCv: 9.4, order: 0 },
  { analyzer: "AAS", analyte: "COPPER", acceptableCv: 13.6, order: 1 },
  { analyzer: "AAS", analyte: "LEAD", acceptableCv: 10.0, order: 2 },
  // ICPMS
  { analyzer: "ICPMS", analyte: "ZINC", acceptableCv: 9.4, order: 0 },
  { analyzer: "ICPMS", analyte: "COPPER", acceptableCv: 13.6, order: 1 },
  { analyzer: "ICPMS", analyte: "LEAD", acceptableCv: 10.0, order: 2 },
  // HPLC
  { analyzer: "HPLC", analyte: "VIT A", acceptableCv: 15.0, order: 0 },
  { analyzer: "HPLC", analyte: "VIT B1", acceptableCv: 12.0, order: 1 },
  { analyzer: "HPLC", analyte: "VIT B2", acceptableCv: 10.0, order: 2 },
  { analyzer: "HPLC", analyte: "VIT B6", acceptableCv: 14.0, order: 3 },
  { analyzer: "HPLC", analyte: "VIT C", acceptableCv: 20.0, order: 4 },
  { analyzer: "HPLC", analyte: "VIT E", acceptableCv: 20.0, order: 5 },
  // UPLC
  { analyzer: "UPLC", analyte: "VIT A", acceptableCv: 15.0, order: 0 },
  { analyzer: "UPLC", analyte: "VIT B1", acceptableCv: 12.0, order: 1 },
  { analyzer: "UPLC", analyte: "VIT B2", acceptableCv: 10.0, order: 2 },
  { analyzer: "UPLC", analyte: "VIT B6", acceptableCv: 14.0, order: 3 },
  { analyzer: "UPLC", analyte: "VIT C", acceptableCv: 20.0, order: 4 },
  { analyzer: "UPLC", analyte: "VIT E", acceptableCv: 20.0, order: 5 },
];

function findCvLimit(analyzer, analyte) {
  const a = (analyzer || "").trim().toLowerCase(), t = (analyte || "").trim().toLowerCase();
  if (!a || !t) return null;
  return state.cvLimits.find((l) => (l.analyzer || "").trim().toLowerCase() === a && (l.analyte || "").trim().toLowerCase() === t) || null;
}
/** Every analyte defined for one instrument, in spreadsheet column order (falls back to
 *  alphabetical for any hand-added limit that has no `order`). This is what draws the grid's
 *  header row and decides which input box is which. */
function analytesForInstrument(analyzer) {
  const a = (analyzer || "").trim().toLowerCase();
  return state.cvLimits.filter((l) => (l.analyzer || "").trim().toLowerCase() === a)
    .sort((x, y) => (x.order ?? 999) - (y.order ?? 999) || (x.analyte || "").localeCompare(y.analyte || ""));
}
function instrumentList() {
  return [...new Set(state.cvLimits.map((l) => (l.analyzer || "").trim()).filter(Boolean))].sort();
}
async function saveCvLimit(data) {
  const payload = { analyzer: (data.analyzer || "").trim(), analyte: (data.analyte || "").trim(), acceptableCv: Number(data.acceptableCv) };
  if (data.id) { await db.collection("cvLimits").doc(data.id).set(payload, { merge: true }); }
  else {
    const siblings = analytesForInstrument(payload.analyzer);
    const order = siblings.length ? Math.max(...siblings.map((s) => s.order ?? 0)) + 1 : 0;
    await db.collection("cvLimits").add({ ...payload, order, addedBy: state.user.email, addedAt: nowStr() });
  }
}
async function deleteCvLimit(id) {
  const lim = state.cvLimits.find((x) => x.id === id);
  await db.collection("cvLimits").doc(id).delete();
  logAudit("delete_cv_limit", lim ? `${lim.analyzer} / ${lim.analyte}` : id, lim ? `${lim.acceptableCv}%` : "");
}
/** Batch-adds every DEFAULT_CV_LIMITS row that isn't already present (matched by
 *  Analyzer+Analyte), so pressing the button twice never creates duplicates. */
async function importDefaultCvLimits() {
  const missing = DEFAULT_CV_LIMITS.filter((d) => !findCvLimit(d.analyzer, d.analyte));
  if (missing.length === 0) { toast("All default reference limits are already loaded.", "info"); return 0; }
  const batch = db.batch();
  missing.forEach((d) => {
    const ref = db.collection("cvLimits").doc();
    batch.set(ref, { analyzer: d.analyzer, analyte: d.analyte, acceptableCv: d.acceptableCv, order: d.order, addedBy: state.user.email, addedAt: nowStr(), source: "default_reference" });
  });
  await batch.commit();
  logAudit("import_default_cv_limits", `${missing.length} rows`, "");
  return missing.length;
}

const QC_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const QC_LEVEL_SUGGESTIONS = ["QC1", "QC2", "Level 1", "Level 2", "Low", "Normal", "High Abn A", "Normal A"];

/** Finds the existing spreadsheet row (if any) for this exact Branch+Instrument+Year+Month+Level,
 *  so re-entering the same cell always overwrites it in place instead of creating a duplicate row —
 *  same behavior as typing into the same Excel cell twice. */
function findMonthlyQcRow(branchId, analyzer, year, month, control) {
  const a = (analyzer || "").trim().toLowerCase(), c = (control || "").trim().toLowerCase();
  return state.monthlyQcEntries.find((e) => e.branchId === branchId && (e.analyzer || "").trim().toLowerCase() === a
    && Number(e.year) === Number(year) && e.month === month && (e.control || "").trim().toLowerCase() === c) || null;
}
/** Saves one full spreadsheet row (every analyte's CV% for one Branch+Instrument+Year+Month+Level
 *  at once) — always an upsert keyed on that combination, whether or not the caller already knows
 *  the doc id. `values` is {analyte: cvNumber}; analytes left blank are simply omitted. */
async function saveMonthlyQcRow(data) {
  const existing = data.id ? { id: data.id } : findMonthlyQcRow(data.branchId, data.analyzer, data.year, data.month, data.control);
  const payload = {
    branchId: data.branchId, analyzer: (data.analyzer || "").trim(), year: Number(data.year), month: data.month, control: (data.control || "").trim(),
    values: data.values, exceeded: data.exceeded, exceeds: data.exceeded.length > 0,
    correctiveAction: data.exceeded.length > 0 ? {
      details: (data.correctiveAction && data.correctiveAction.details || "").trim(),
      comment: (data.correctiveAction && data.correctiveAction.comment || "").trim(),
      additionalComments: (data.correctiveAction && data.correctiveAction.additionalComments || "").trim(),
      filledPrecisionInvestigation: !!(data.correctiveAction && data.correctiveAction.filledPrecisionInvestigation),
    } : null,
  };
  if (existing) { await db.collection("monthlyQcEntries").doc(existing.id).set(payload, { merge: false }); }
  else await db.collection("monthlyQcEntries").add({ ...payload, byEmail: state.user.email, createdAt: nowStr() });
}
async function deleteMonthlyQcRow(id) {
  const e = state.monthlyQcEntries.find((x) => x.id === id);
  await db.collection("monthlyQcEntries").doc(id).delete();
  logAudit("delete_monthly_qc_row", e ? `${e.analyzer} / ${e.month} ${e.year} / ${e.control}` : id, "");
}

function renderMonthlyQcView() {
  const isMaster = state.role === "master";
  const mq = {
    tab: "entries",
    instrument: null,
    year: new Date().getFullYear(),
    branchId: isMaster ? "" : (state.myBranchId || ""),
    editMonth: QC_MONTHS[new Date().getMonth()], editControl: "QC1",
    editValues: {}, editExceeded: [],
    correctiveAction: { details: "", comment: "", additionalComments: "", filledPrecisionInvestigation: false },
    editingRowId: null,
    limitForm: { analyzer: "", analyte: "", acceptableCv: "" }, editingLimit: null,
  };

  function loadRowIntoEditor(row) {
    mq.editMonth = row.month; mq.editControl = row.control; mq.editValues = { ...row.values };
    mq.editExceeded = [...(row.exceeded || [])];
    mq.correctiveAction = row.correctiveAction ? { ...row.correctiveAction } : { details: "", comment: "", additionalComments: "", filledPrecisionInvestigation: false };
    mq.editingRowId = row.id;
  }
  function resetEditor() {
    mq.editValues = {}; mq.editExceeded = [];
    mq.correctiveAction = { details: "", comment: "", additionalComments: "", filledPrecisionInvestigation: false };
    mq.editingRowId = null;
  }
  function recomputeExceeded(analytes) {
    mq.editExceeded = analytes.filter((a) => {
      const v = mq.editValues[a.analyte];
      return v !== undefined && v !== "" && !isNaN(Number(v)) && Number(v) > a.acceptableCv;
    }).map((a) => a.analyte);
  }

  function limitsTabHtml() {
    const sorted = [...state.cvLimits].sort((a, b) => (a.analyzer || "").localeCompare(b.analyzer || "") || (a.order ?? 999) - (b.order ?? 999));
    return `
    <div class="card-form">
      <form id="limitForm">
        <div class="form-row">
          <label class="field"><span class="field-label">Analyzer *</span><input required id="lAnalyzer" value="${esc(mq.limitForm.analyzer)}" placeholder="e.g. DxC 700" list="instrumentList" /></label>
          <label class="field"><span class="field-label">Analyte / Test *</span><input required id="lAnalyte" value="${esc(mq.limitForm.analyte)}" placeholder="e.g. Na" /></label>
          <label class="field"><span class="field-label">Acceptable CV % *</span><input required type="text" inputmode="decimal" dir="ltr" step="0.01" min="0" id="lCv" value="${esc(mq.limitForm.acceptableCv)}" placeholder="e.g. 3" /></label>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          ${mq.editingLimit ? `<button type="button" class="btn secondary" id="lCancel">Cancel</button>` : `<button type="button" class="btn ghost" id="lImportDefaults"><i class="fa-solid fa-download"></i> Load default reference limits</button>`}
          <button type="submit" class="btn primary">${mq.editingLimit ? "Save changes" : "Add limit"}</button>
        </div>
      </form>
    </div>
    <div class="table-wrap" style="margin-top:20px"><table class="data-table">
      <thead><tr><th>Analyzer</th><th>Analyte / Test</th><th>Acceptable CV %</th><th>Actions</th></tr></thead>
      <tbody>${sorted.length === 0 ? `<tr><td colspan="4" class="table-empty">No CV limits defined yet — add one above or load the default reference table.</td></tr>` : sorted.map((l) => `
        <tr>
          <td>${esc(l.analyzer)}</td><td>${esc(l.analyte)}</td><td class="mono">${esc(l.acceptableCv)}%</td>
          <td><button class="icon-btn-sm" data-edit-limit="${l.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
              <button class="icon-btn-sm" data-del-limit="${l.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`).join("")}</tbody>
    </table></div>`;
  }

  function entriesTabHtml() {
    const instruments = instrumentList();
    if (!mq.instrument || !instruments.includes(mq.instrument)) mq.instrument = instruments[0] || null;
    const analytes = mq.instrument ? analytesForInstrument(mq.instrument) : [];
    const branchRows = state.monthlyQcEntries.filter((e) => e.analyzer === mq.instrument && Number(e.year) === Number(mq.year) && (!mq.branchId || e.branchId === mq.branchId));
    // every QC level ever used for this instrument+branch+year, always including QC1/QC2 so the
    // grid has somewhere to start even with zero data yet — same starting shape as the blank sheet.
    const levels = [...new Set(["QC1", "QC2", ...branchRows.map((r) => r.control)])];
    recomputeExceeded(analytes);
    const editingRowExceeded = mq.editExceeded.length > 0;

    if (instruments.length === 0) {
      return `<div class="card-form"><p class="field-note">No instruments defined yet — switch to the "CV Limits" tab and either add analytes manually or press "Load default reference limits" to pull in the lab's reference table (DxC 700, DxH 560, DxI 800, D10, ACL Elite Pro, Mindray, Architect i1000, Alinity I/II, IDS iSYS, Stago, Sysmex XN-1000, AAS, ICPMS, HPLC, UPLC).</p></div>`;
    }

    return `
    <div class="qc-toolbar">
      <div class="qc-instrument-tabs">${instruments.map((i) => `<button type="button" class="qc-inst-tab ${i === mq.instrument ? "active" : ""}" data-set-inst="${esc(i)}">${esc(i)}</button>`).join("")}</div>
      <div class="qc-toolbar-right">
        ${isMaster ? `<select id="qcBranchFilter"><option value="" ${mq.branchId ? "" : "selected"}>All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === mq.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>` : ""}
        <input type="text" inputmode="decimal" dir="ltr" id="qcYear" class="mono" style="width:90px" value="${esc(mq.year)}" />
      </div>
    </div>

    <div class="card-form">
      <p class="field-note" style="margin-top:0">Pick the Month and QC level, then enter the CV% for every test — same as filling one row of the sheet. The Acceptable CV% for each test is shown right under its name.</p>
      <div class="form-row">
        <label class="field"><span class="field-label">Month *</span><select id="qcEditMonth">${QC_MONTHS.map((m) => `<option ${m === mq.editMonth ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="field"><span class="field-label">QC Level *</span><input id="qcEditControl" value="${esc(mq.editControl)}" list="qcLevelList" placeholder="e.g. QC1" /></label>
        ${isMaster && !mq.branchId ? `<p class="field-note">Select a branch above to enter data (a row belongs to one branch).</p>` : ""}
      </div>
      <datalist id="qcLevelList">${QC_LEVEL_SUGGESTIONS.map((l) => `<option value="${l}"></option>`).join("")}</datalist>
      <div class="qc-cell-grid">
        ${analytes.map((a) => {
          const v = mq.editValues[a.analyte] ?? "";
          const out = mq.editExceeded.includes(a.analyte);
          return `<div class="qc-cell-input ${out ? "out" : ""}">
            <div class="qc-cell-label">${esc(a.analyte)}</div>
            <div class="qc-cell-limit">${esc(a.acceptableCv)}%</div>
            <input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-analyte-input="${esc(a.analyte)}" value="${esc(v)}" />
          </div>`;
        }).join("")}
      </div>
      ${editingRowExceeded ? `
      <div class="qc-exceeds-panel">
        <div class="qc-exceeds-head"><i class="fa-solid fa-triangle-exclamation"></i> ${mq.editExceeded.map((a) => esc(a)).join(", ")} exceed${mq.editExceeded.length === 1 ? "s" : ""} the acceptable limit — a corrective action is required for this level before it can be saved.</div>
        <label class="field"><span class="field-label">Details *</span><textarea required id="caDetails" rows="2" placeholder="e.g. 1 - 4.67, -57%">${esc(mq.correctiveAction.details)}</textarea></label>
        <div class="form-row">
          <label class="field"><span class="field-label">Comment</span><input id="caComment" value="${esc(mq.correctiveAction.comment)}" placeholder="e.g. anomalous points removed and all within range" /></label>
          <label class="field"><span class="field-label">Additional comments</span><input id="caAdditional" value="${esc(mq.correctiveAction.additionalComments)}" /></label>
        </div>
        <label class="check-row"><input type="checkbox" id="caFilled" ${mq.correctiveAction.filledPrecisionInvestigation ? "checked" : ""} /> Filled precision investigation</label>
      </div>` : ""}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        ${mq.editingRowId ? `<button type="button" class="btn secondary" id="qcCancelEdit">Cancel edit</button>` : ""}
        <button type="button" class="btn primary" id="qcSaveRow" ${editingRowExceeded && !mq.correctiveAction.details.trim() ? "disabled title=\"Corrective action Details is required\"" : ""}>${mq.editingRowId ? "Save row" : "Save"}</button>
      </div>
    </div>

    <div class="table-wrap qc-grid-wrap" style="margin-top:20px"><table class="data-table qc-grid-table">
      <thead>
        <tr><th class="qc-corner">Acceptable CV %</th><th></th>${analytes.map((a) => `<th class="mono">${esc(a.acceptableCv)}%</th>`).join("")}</tr>
        <tr><th>Month</th><th>Level</th>${analytes.map((a) => `<th>${esc(a.analyte)}</th>`).join("")}</tr>
      </thead>
      <tbody>${QC_MONTHS.map((m) => {
        const monthLevels = levels.length ? levels : ["QC1", "QC2"];
        return monthLevels.map((lvl, li) => {
          const row = branchRows.find((r) => r.month === m && (r.control || "").trim().toLowerCase() === lvl.trim().toLowerCase());
          return `<tr class="${row && row.exceeds ? "qc-row-exceeds" : ""}">
            ${li === 0 ? `<td class="mono" rowspan="${monthLevels.length}">${esc(m)}</td>` : ""}
            <td>${esc(lvl)}</td>
            ${analytes.map((a) => {
              const val = row && row.values ? row.values[a.analyte] : undefined;
              const out = row && row.exceeded && row.exceeded.includes(a.analyte);
              return `<td class="mono ${out ? "qc-cell-out" : ""}">${val === undefined || val === null ? "" : esc(val)}</td>`;
            }).join("")}
            <td>${row ? `<button class="icon-btn-sm" data-edit-row="${row.id}" title="Edit"><i class="fa-solid fa-pen"></i></button><button class="icon-btn-sm" data-del-row="${row.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>${row.exceeds ? ` <i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)" title="${row.correctiveAction ? esc(row.correctiveAction.details) : 'Exceeds limit'}"></i>` : ""}` : ""}</td>
          </tr>`;
        }).join("");
      }).join("")}</tbody>
    </table></div>`;
  }

  function body() {
    return `
    <div class="page-header"><div><h2>Monthly QC (CV Monitoring)</h2><span class="subtitle">Coefficient of Variation vs. acceptable reference limits — Form LabGen 105</span></div></div>
    <div class="tab-bar" style="display:flex;gap:6px;margin-bottom:16px">
      <button type="button" class="btn ${mq.tab === "entries" ? "primary" : "ghost"}" id="mqTabEntries">Monthly Entries</button>
      <button type="button" class="btn ${mq.tab === "limits" ? "primary" : "ghost"}" id="mqTabLimits">CV Limits (reference table)</button>
    </div>
    <datalist id="instrumentList">${instrumentList().map((a) => `<option value="${esc(a)}"></option>`).join("")}</datalist>
    ${mq.tab === "entries" ? entriesTabHtml() : limitsTabHtml()}`;
  }

  function render() {
    el("mainContent").innerHTML = body();
    el("mqTabEntries").onclick = () => { mq.tab = "entries"; render(); };
    el("mqTabLimits").onclick = () => { mq.tab = "limits"; render(); };

    if (mq.tab === "limits") {
      el("lAnalyzer").oninput = (e) => mq.limitForm.analyzer = e.target.value;
      el("lAnalyte").oninput = (e) => mq.limitForm.analyte = e.target.value;
      el("lCv").oninput = (e) => mq.limitForm.acceptableCv = e.target.value;
      const cancelBtn = el("lCancel"); if (cancelBtn) cancelBtn.onclick = () => { mq.editingLimit = null; mq.limitForm = { analyzer: "", analyte: "", acceptableCv: "" }; render(); };
      const importBtn = el("lImportDefaults");
      if (importBtn) importBtn.onclick = async () => {
        importBtn.disabled = true;
        try { const n = await importDefaultCvLimits(); if (n > 0) toast(`Loaded ${n} default reference limits.`, "success"); }
        catch (err) { console.error("importDefaultCvLimits failed:", err); toast("Failed to load defaults: " + (err && err.message ? err.message : err), "error"); }
        finally { importBtn.disabled = false; }
      };
      el("mainContent").querySelectorAll("[data-edit-limit]").forEach((b) => b.onclick = () => {
        const l = state.cvLimits.find((x) => x.id === b.dataset.editLimit);
        mq.editingLimit = l.id; mq.limitForm = { analyzer: l.analyzer, analyte: l.analyte, acceptableCv: l.acceptableCv };
        render();
      });
      el("mainContent").querySelectorAll("[data-del-limit]").forEach((b) => b.onclick = () => { if (confirm("Delete this CV limit?")) deleteCvLimit(b.dataset.delLimit); });
      el("limitForm").onsubmit = async (e) => {
        e.preventDefault();
        try {
          await saveCvLimit(mq.editingLimit ? { id: mq.editingLimit, ...mq.limitForm } : mq.limitForm);
          mq.editingLimit = null; mq.limitForm = { analyzer: "", analyte: "", acceptableCv: "" };
          render();
        } catch (err) { console.error("saveCvLimit failed:", err); toast("Failed to save: " + (err && err.message ? err.message : err), "error"); }
      };
      return;
    }

    // entries tab
    if (!mq.instrument) return; // instrumentList() was empty — nothing else to wire up
    el("mainContent").querySelectorAll("[data-set-inst]").forEach((b) => b.onclick = () => { mq.instrument = b.dataset.setInst; resetEditor(); render(); });
    const branchFilterEl = el("qcBranchFilter"); if (branchFilterEl) branchFilterEl.onchange = (e) => { mq.branchId = e.target.value; render(); };
    el("qcYear").oninput = (e) => { mq.year = e.target.value; render(); };
    el("qcEditMonth").onchange = (e) => { mq.editMonth = e.target.value; loadExistingIfAny(); render(); };
    el("qcEditControl").oninput = (e) => { mq.editControl = e.target.value; };
    el("qcEditControl").onchange = () => { loadExistingIfAny(); render(); };
    function loadExistingIfAny() {
      // Switching Month/Level to one that already has a saved row loads it for editing (so you
      // never accidentally overwrite it blank); switching to an empty combination starts fresh.
      const existing = findMonthlyQcRow(mq.branchId || state.myBranchId, mq.instrument, mq.year, mq.editMonth, mq.editControl);
      if (existing) loadRowIntoEditor(existing); else resetEditor();
    }
    const analytes = analytesForInstrument(mq.instrument);
    el("mainContent").querySelectorAll("[data-analyte-input]").forEach((inp) => {
      inp.oninput = (e) => {
        mq.editValues[inp.dataset.analyteInput] = e.target.value;
        recomputeExceeded(analytes);
        const cell = inp.closest(".qc-cell-input");
        const lim = analytes.find((a) => a.analyte === inp.dataset.analyteInput);
        const out = e.target.value !== "" && lim && Number(e.target.value) > lim.acceptableCv;
        cell.classList.toggle("out", !!out);
        const saveBtn = el("qcSaveRow");
        if (saveBtn) saveBtn.disabled = mq.editExceeded.length > 0 && !mq.correctiveAction.details.trim();
        // Only re-render fully when the exceeds panel needs to appear/disappear — otherwise
        // keep typing smooth instead of re-rendering (and losing focus) on every keystroke.
        const panelShown = !!document.querySelector(".qc-exceeds-panel");
        if ((mq.editExceeded.length > 0) !== panelShown) render();
      };
    });
    const caDetails = el("caDetails"); if (caDetails) caDetails.oninput = (e) => { mq.correctiveAction.details = e.target.value; const b = el("qcSaveRow"); if (b) b.disabled = !e.target.value.trim(); };
    const caComment = el("caComment"); if (caComment) caComment.oninput = (e) => mq.correctiveAction.comment = e.target.value;
    const caAdditional = el("caAdditional"); if (caAdditional) caAdditional.oninput = (e) => mq.correctiveAction.additionalComments = e.target.value;
    const caFilled = el("caFilled"); if (caFilled) caFilled.onchange = (e) => mq.correctiveAction.filledPrecisionInvestigation = e.target.checked;
    const cancelEditBtn = el("qcCancelEdit"); if (cancelEditBtn) cancelEditBtn.onclick = () => { resetEditor(); render(); };
    el("mainContent").querySelectorAll("[data-edit-row]").forEach((b) => b.onclick = () => {
      const row = state.monthlyQcEntries.find((x) => x.id === b.dataset.editRow);
      loadRowIntoEditor(row);
      render();
    });
    el("mainContent").querySelectorAll("[data-del-row]").forEach((b) => b.onclick = () => { if (confirm("Delete this row (all tests for this Month/Level)?")) deleteMonthlyQcRow(b.dataset.delRow); });
    el("qcSaveRow").onclick = async () => {
      const branchId = isMaster ? mq.branchId : (state.myBranchId || null);
      if (!branchId) { toast("Please select a branch.", "warn"); return; }
      if (!mq.editControl.trim()) { toast("Please enter a QC level (e.g. QC1).", "warn"); return; }
      recomputeExceeded(analytes);
      if (mq.editExceeded.length > 0 && !mq.correctiveAction.details.trim()) { toast("Corrective action Details is required — this level has a test out of range.", "warn"); return; }
      const values = {};
      analytes.forEach((a) => { const v = mq.editValues[a.analyte]; if (v !== undefined && v !== "" && !isNaN(Number(v))) values[a.analyte] = Number(v); });
      if (Object.keys(values).length === 0) { toast("Enter at least one test result.", "warn"); return; }
      try {
        await saveMonthlyQcRow({ id: mq.editingRowId, branchId, analyzer: mq.instrument, year: mq.year, month: mq.editMonth, control: mq.editControl, values, exceeded: mq.editExceeded, correctiveAction: mq.correctiveAction });
        resetEditor();
        render();
        toast("Saved.", "success");
      } catch (err) { console.error("saveMonthlyQcRow failed:", err); toast("Failed to save: " + (err && err.message ? err.message : err), "error"); }
    };
  }
  render();
}

/* ---------------------------------------------------------------------
   SHIFT HANDOVER — the outgoing shift logs what the incoming shift needs
   to know (instrument status, pending samples, issues) and endorses it.
   Branch-scoped like the rest of the data — each branch only sees its own log.
--------------------------------------------------------------------- */
const SHIFTS = ["Morning", "Evening", "Night"];
async function saveShiftEndorsement(data) {
  await db.collection("shiftEndorsements").add({ ...data, byEmail: state.user.email, createdAt: nowStr() });
}
async function deleteShiftEndorsement(id) {
  const s = state.shiftEndorsements.find((x) => x.id === id);
  await db.collection("shiftEndorsements").doc(id).delete();
  logAudit("delete_shift_endorsement", s ? `${s.shift || ""} ${s.date || ""}`.trim() : id, s ? (s.notes || "").slice(0, 80) : "");
}
/** "Endorsed to" is a free-typed name (from the employee datalist), not necessarily the exact
 *  login email, so matching against "is this endorsement for me" checks both the current user's
 *  saved display name and their raw email. */
function myDisplayName() {
  const rec = state.allowed.find((u) => u.id === state.user.email);
  return (rec && rec.name && rec.name.trim()) ? rec.name.trim() : state.user.email;
}
function isEndorsementForMe(s) {
  const target = (s.toEmployee || "").trim().toLowerCase();
  if (!target || !state.user) return false;
  return target === state.user.email.toLowerCase() || target === myDisplayName().toLowerCase();
}
/** The incoming shift must explicitly confirm they've seen the handover note — it's not enough
 *  for it to just sit in the log. Only the addressed person (or master) can acknowledge it, and
 *  it can only ever be acknowledged as yourself (enforced in firestore.rules too). */
async function acknowledgeShiftEndorsement(id) {
  await db.collection("shiftEndorsements").doc(id).set({ acknowledgedBy: state.user.email, acknowledgedByName: myDisplayName(), acknowledgedAt: nowStr() }, { merge: true });
}
function unacknowledgedEndorsementsForMe() {
  return state.shiftEndorsements.filter((s) => !s.acknowledgedAt && isEndorsementForMe(s));
}

function renderShiftHandoverView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const employeeNames = employeeDisplayNames();
  const sh = state.ui.shiftForm || { date: todayStr(), shift: "Morning", fromEmployee: state.user.email, toEmployee: "", notes: "" };
  state.ui.shiftForm = sh;

  const branchFilter = isMaster ? (state.ui.shiftBranchFilter || "") : myBranch;
  const list = [...state.shiftEndorsements]
    .filter((s) => !branchFilter || s.branchId === branchFilter)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Shift Handover</h2><span class="subtitle">Endorse the instrument &amp; workload status from one shift to the next</span></div></div>
    <div class="card-form">
      <form id="shForm">
        <datalist id="shEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        <div class="form-row">
          <label class="field"><span class="field-label">Date</span><input type="date" id="shDate" value="${esc(sh.date)}" /></label>
          <label class="field"><span class="field-label">Shift</span><select id="shShift">${SHIFTS.map((s) => `<option value="${s}" ${s === sh.shift ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          ${isMaster ? fieldHtml("Branch *", `<select required id="shBranch"><option value="" disabled ${sh.branchId ? "" : "selected"}>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === sh.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        </div>
        <div class="form-row">
          <label class="field"><span class="field-label">Endorsed by (outgoing)</span><input list="shEmployees" id="shFrom" value="${esc(sh.fromEmployee)}" /></label>
          <label class="field"><span class="field-label">Endorsed to (incoming)</span><input list="shEmployees" id="shTo" value="${esc(sh.toEmployee)}" placeholder="Pick from employee list…" /></label>
        </div>
        <label class="field"><span class="field-label">Notes for the next shift</span>
          <textarea id="shNotes" rows="3" placeholder="Instrument status, pending samples, QC issues, anything the next shift needs to know…">${esc(sh.notes)}</textarea>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
          <button type="submit" class="btn primary"><i class="fa-solid fa-right-left"></i> Save endorsement</button>
        </div>
      </form>
    </div>
    <h3 style="margin:26px 0 12px;font-size:14px">Shift log</h3>
    ${isMaster ? `<div class="filter-bar" style="margin-bottom:14px"><label style="font-size:12px;color:var(--text-dim)">Branch
      <select id="shBranchFilter" style="margin-left:4px"><option value="">All branches</option>${state.branches.map((b) => `<option value="${b.id}" ${b.id === branchFilter ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label></div>` : ""}
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Shift</th><th>Branch</th><th>From</th><th>To</th><th>Notes</th><th>Acknowledged</th><th></th></tr></thead>
      <tbody>${list.length === 0 ? `<tr><td colspan="8" class="table-empty">No shift endorsements logged yet</td></tr>` : list.map((s) => `
        <tr><td class="mono">${esc(s.date)}</td><td>${esc(s.shift)}</td><td>${esc(branchName(s.branchId))}</td>
        <td>${esc(s.fromEmployee || "—")}</td><td>${esc(s.toEmployee || "—")}</td>
        <td style="white-space:pre-wrap;max-width:360px">${esc(s.notes || "—")}</td>
        <td>${s.acknowledgedAt
          ? `<span class="badge" style="background:${STATUS_STYLES.ok.bg};color:${STATUS_STYLES.ok.text};border-color:${STATUS_STYLES.ok.border}">✓ ${esc(s.acknowledgedByName || s.acknowledgedBy || "")}</span>`
          : (isEndorsementForMe(s) ? `<button type="button" class="btn secondary" data-ack-sh="${s.id}" style="padding:4px 10px;font-size:11.5px">Acknowledge</button>` : `<span class="badge" style="background:${STATUS_STYLES.soon.bg};color:${STATUS_STYLES.soon.text};border-color:${STATUS_STYLES.soon.border}">Pending</span>`)}</td>
        <td>${(isMaster || s.byEmail === state.user.email) ? `<button class="icon-btn-sm" data-del-sh="${s.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>`;

  el("shDate").oninput = (e) => sh.date = e.target.value;
  el("shShift").onchange = (e) => sh.shift = e.target.value;
  el("shFrom").oninput = (e) => sh.fromEmployee = e.target.value;
  el("shTo").oninput = (e) => sh.toEmployee = e.target.value;
  el("shNotes").oninput = (e) => sh.notes = e.target.value;
  const branchEl = el("shBranch"); if (branchEl) branchEl.onchange = (e) => sh.branchId = e.target.value;
  const filterEl = el("shBranchFilter"); if (filterEl) filterEl.onchange = (e) => { state.ui.shiftBranchFilter = e.target.value; renderShiftHandoverView(); };
  el("mainContent").querySelectorAll("[data-del-sh]").forEach((b) => b.onclick = () => { if (confirm("Delete this shift endorsement?")) deleteShiftEndorsement(b.dataset.delSh); });
  el("mainContent").querySelectorAll("[data-ack-sh]").forEach((b) => b.onclick = () => acknowledgeShiftEndorsement(b.dataset.ackSh));
  el("shForm").onsubmit = async (e) => {
    e.preventDefault();
    const branchId = isMaster ? sh.branchId : myBranch;
    if (isMaster && !branchId) { toast("Please select a branch.", "warn"); return; }
    if (!sh.notes || !sh.notes.trim()) { toast("Please add a note for the next shift.", "warn"); return; }
    await saveShiftEndorsement({ date: sh.date, shift: sh.shift, fromEmployee: sh.fromEmployee, toEmployee: sh.toEmployee, notes: sh.notes.trim(), branchId });
    state.ui.shiftForm = { date: todayStr(), shift: sh.shift, fromEmployee: state.user.email, toEmployee: "", notes: "" };
    renderShiftHandoverView();
  };
}

/* ---------------------------------------------------------------------
   BRANCH CHAT — a message can be broadcast to every branch, or targeted
   at one specific branch. Not branch-scoped at the query level on purpose
   (see the `listen("branchChats", ...)` call) — visibility for a targeted
   message is: the sender, the target branch, and master.
--------------------------------------------------------------------- */
async function sendBranchChat(text, toBranchId) {
  await db.collection("branchChats").add({
    text: text || "", toBranchId: toBranchId || null,
    fromEmail: state.user.email, fromBranchId: state.managedBranchId || state.myBranchId || null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), clientAt: new Date().toISOString(),
  });
}
async function deleteBranchChat(id) { await db.collection("branchChats").doc(id).delete(); }
async function editBranchChat(id, text) { await db.collection("branchChats").doc(id).set({ text, editedAt: new Date().toISOString() }, { merge: true }); }
async function sendDirectMessage(text, toEmail) {
  await db.collection("directMessages").add({
    text: text || "", fromEmail: state.user.email, toEmail,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), clientAt: new Date().toISOString(),
  });
}
async function deleteDirectMessage(id) { await db.collection("directMessages").doc(id).delete(); }
async function editDirectMessage(id, text) { await db.collection("directMessages").doc(id).set({ text, editedAt: new Date().toISOString() }, { merge: true }); }

/** WhatsApp-style Branch Chat: a contacts list on the left (the "All Branches" group, every branch
 *  channel, and every colleague for direct messages), each opening its own separate conversation
 *  thread on the right — instead of one single mixed feed. */
function renderChatView() {
  const isMaster = state.role === "master";
  const contacts = buildChatContacts();
  let selected = state.ui.chatContact && contacts.find((c) => c.type === state.ui.chatContact.type && String(c.id) === String(state.ui.chatContact.id));
  selected = selected || null;
  state.ui.chatContact = selected ? { type: selected.type, id: selected.id } : null;

  if (selected) { markThreadSeen(selected, new Date().toISOString()); }
  renderChatNavBadge();

  const messages = selected ? messagesForContact(selected) : [];
  let lastDay = "";

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Branch Chat</h2><span class="subtitle">Message a branch, the whole company, or a colleague directly — WhatsApp-style</span></div></div>
    <div class="chat-shell ${selected ? "chat-open" : ""}">
      <div class="chat-sidebar">
        <div class="chat-sidebar-head"><i class="fa-solid fa-magnifying-glass"></i><input id="chatSearch" placeholder="Search…" autocomplete="off" /></div>
        <div class="chat-contacts">
          ${contacts.map((c) => {
            const unread = threadUnread(c).length;
            const msgs = messagesForContact(c);
            const last = msgs[msgs.length - 1];
            const active = selected && selected.type === c.type && String(selected.id) === String(c.id);
            const lastText = last ? (last.text || "") : "";
            const preview = last ? esc((last.fromEmail === state.user.email ? "You: " : "") + lastText.slice(0, 44)) : esc(c.subtitle || "No messages yet");
            return `<button type="button" class="chat-contact ${active ? "active" : ""}" data-contact-type="${c.type}" data-contact-id="${esc(String(c.id))}">
              <div class="chat-avatar" style="background:${avatarColor(c.name)}">${c.type === "group" ? '<i class="fa-solid fa-users"></i>' : esc(initials(c.name))}</div>
              <div class="chat-contact-body">
                <div class="chat-contact-row"><span class="chat-contact-name">${esc(c.name)}</span>${last ? `<span class="chat-contact-time">${esc(fmtChatTime(chatTimeIso(last)))}</span>` : ""}</div>
                <div class="chat-contact-row"><span class="chat-contact-preview">${preview}</span>${unread > 0 ? `<span class="chat-unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}</div>
              </div>
            </button>`;
          }).join("")}
        </div>
      </div>
      <div class="chat-main">
        ${!selected ? `<div class="chat-empty"><i class="fa-solid fa-comments"></i><p>Pick a conversation to start chatting</p></div>` : `
        <div class="chat-main-head">
          <button type="button" class="chat-back" id="chatBack" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
          <div class="chat-avatar sm" style="background:${avatarColor(selected.name)}">${selected.type === "group" ? '<i class="fa-solid fa-users"></i>' : esc(initials(selected.name))}</div>
          <div><div class="chat-main-name">${esc(selected.name)}</div><div class="chat-main-sub">${esc(selected.subtitle || "")}</div></div>
        </div>
        <div class="chat-feed" id="chatFeed">
          ${messages.length === 0 ? `<div class="table-empty">No messages yet — say hello 👋</div>` : messages.map((m) => {
            const iso = chatTimeIso(m);
            const day = iso.slice(0, 10);
            const divider = day && day !== lastDay ? (() => { lastDay = day; return `<div class="chat-day-divider">${esc(day)}</div>`; })() : "";
            const mine = m.fromEmail === state.user.email;
            const senderLabel = selected.type !== "dm" ? `${esc(m.fromEmail)}${m.fromBranchId ? " · " + esc(branchName(m.fromBranchId)) : ""}` : "";
            return `${divider}
            <div class="chat-msg ${mine ? "mine" : ""}" data-msg-id="${m.id}">
              ${senderLabel ? `<div class="chat-msg-head"><span class="chat-msg-from">${senderLabel}</span></div>` : ""}
              ${m.text ? `<div class="chat-msg-text" data-msg-text>${esc(m.text)}</div>` : ""}
              <div class="chat-msg-foot">
                <span class="chat-msg-time">${esc(iso.replace("T", " ").slice(11, 16))}${m.editedAt ? " · edited" : ""}</span>
                ${mine ? `<button class="link-btn" data-edit-chat="${m.id}" data-edit-type="${selected.type === "dm" ? "dm" : "branch"}">Edit</button>` : ""}
                ${(isMaster || mine) ? `<button class="link-btn" data-del-chat="${m.id}" data-del-type="${selected.type === "dm" ? "dm" : "branch"}">Delete</button>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>
        <form id="chatForm" class="chat-composer">
          <input id="chatText" placeholder="Write a message…" autocomplete="off" />
          <button type="submit" class="btn primary" id="chatSendBtn"><i class="fa-solid fa-paper-plane"></i></button>
        </form>`}
      </div>
    </div>`;

  const feed = el("chatFeed"); if (feed) feed.scrollTop = feed.scrollHeight;
  el("mainContent").querySelectorAll("[data-contact-type]").forEach((b) => b.onclick = () => {
    state.ui.chatContact = { type: b.dataset.contactType, id: b.dataset.contactId };
    renderChatView();
  });
  const backBtn = el("chatBack"); if (backBtn) backBtn.onclick = () => { state.ui.chatContact = null; renderChatView(); };
  const searchInput = el("chatSearch");
  if (searchInput) searchInput.oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    el("mainContent").querySelectorAll(".chat-contact").forEach((btn) => {
      const name = (btn.querySelector(".chat-contact-name")?.textContent || "").toLowerCase();
      btn.hidden = !!q && !name.includes(q);
    });
  };
  el("mainContent").querySelectorAll("[data-del-chat]").forEach((b) => b.onclick = () => {
    if (!confirm("Delete this message?")) return;
    if (b.dataset.delType === "dm") deleteDirectMessage(b.dataset.delChat); else deleteBranchChat(b.dataset.delChat);
  });
  el("mainContent").querySelectorAll("[data-edit-chat]").forEach((b) => b.onclick = () => {
    const bubble = el("mainContent").querySelector(`.chat-msg[data-msg-id="${b.dataset.editChat}"] [data-msg-text]`);
    if (!bubble) return;
    const current = bubble.textContent;
    const input = document.createElement("input");
    input.className = "chat-edit-input"; input.value = current;
    bubble.replaceWith(input); input.focus(); input.select();
    const save = async () => {
      const val = input.value.trim();
      if (val && val !== current) {
        if (b.dataset.editType === "dm") await editDirectMessage(b.dataset.editChat, val);
        else await editBranchChat(b.dataset.editChat, val);
      } else { renderChatView(); }
    };
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") renderChatView(); };
    input.onblur = save;
  });

  const form = el("chatForm");
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const text = el("chatText").value.trim();
    if (!text || !selected) return;
    const sendBtn = el("chatSendBtn");
    el("chatText").value = "";
    try {
      if (sendBtn) sendBtn.disabled = true;
      if (selected.type === "group") await sendBranchChat(text, null);
      else if (selected.type === "branch") await sendBranchChat(text, selected.id);
      else if (selected.type === "dm") await sendDirectMessage(text, selected.id);
    } catch (err) {
      toast("Could not send: " + (err && err.message ? err.message : err), "error");
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  };
}

/* ---------------------------------------------------------------------
   Lot to Lot verification (Evaluation of New Reagent Lot Number)
--------------------------------------------------------------------- */
const LOT_ROW_BLANK = () => ({ date: todayStr(), sampleNo: "", assayLong: "", newLot: "", newLotExp: "", oldLot: "", oldLotExp: "", newResult: "", oldResult: "", comment: "" });

async function saveLotVerification(data) {
  if (data.id) { const { id, ...rest } = data; await db.collection("lotVerifications").doc(id).set(rest, { merge: true }); }
  else { const { id, ...rest } = data; await db.collection("lotVerifications").add({ ...rest, createdBy: state.user.email, createdAt: nowStr() }); }
}
async function deleteLotVerification(id) {
  const lv = state.lotVerifications.find((x) => x.id === id);
  await db.collection("lotVerifications").doc(id).delete();
  logAudit("delete_lot_verification", lv ? (lv.instrument || id) : id, lv ? `session ${lv.sessionDate || ""}` : "");
}

/** Renders the same layout as the lab's original "Form LabGen 030" reference sheet (logo, Section /
 *  Instrument, merged "Results" header, the % Difference formula, and a single Reviewed By / Date
 *  line) into an off-screen element, rasterizes it with html2canvas, and returns a ready-to-download
 *  jsPDF document — used so the saved file looks like the original printed form, pixel for pixel,
 *  regardless of what's on screen at the time. */
async function renderLotVerificationPdf(session) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-9999px;top:0;width:1400px;background:#fff;padding:26px 30px;font-family:Arial,Helvetica,sans-serif;color:#111";
  const rows = session.rows.map((row) => { const { tae, pctDiff, passed } = lotRowResult(row); return { ...row, tae, pctDiff, passed }; });
  const blue = "#4472c4";
  const cell = "padding:4px 6px;border:1px solid " + blue + ";";
  const branch = branchName(session.branchId);
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;margin-bottom:4px"><tr>
      <td style="width:230px;vertical-align:top"><img src="assets/logo-delta-legacy.png" style="height:46px" /></td>
      <td style="text-align:center;vertical-align:middle"><div style="font-size:17px;font-weight:700">Evaluation of New Reagent Lot Number (Quantitative)</div></td>
      <td style="width:230px;vertical-align:top;text-align:right;font-size:9.5px;color:#888">${branch ? "Branch: " + esc(branch) : ""}</td>
    </tr></table>
    <table style="border-collapse:collapse;font-size:11px;margin:10px 0 14px">
      <tr><td style="padding:1px 8px 1px 0;white-space:nowrap">Section:</td><td style="padding:1px 0;min-width:130px;border-bottom:1px solid #111">${esc(session.section || "")}</td></tr>
      <tr><td style="padding:1px 8px 1px 0;white-space:nowrap">Instrument:</td><td style="padding:1px 0;min-width:130px;border-bottom:1px solid #111">${esc(session.instrument || "")}</td></tr>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead>
        <tr>
          <td style="border:1px solid ${blue}" colspan="3"></td>
          <td style="${cell}text-align:center;font-weight:700" colspan="10">Results</td>
        </tr>
        <tr style="font-weight:700">
          <th style="${cell}">Date</th><th style="${cell}">Sample No.</th><th style="${cell}">Assay long</th>
          <th style="${cell}">New Lot #</th><th style="${cell}">Exp. Date</th><th style="${cell}">Old Lot #</th><th style="${cell}">Exp. Date2</th>
          <th style="${cell}">New Lot</th><th style="${cell}">Old Lot</th><th style="${cell}">% Difference</th><th style="${cell}">T.A.E.</th><th style="${cell}">PASSED</th><th style="${cell}">Comment</th>
        </tr>
      </thead>
      <tbody>${rows.map((r) => `<tr>
        <td style="${cell}text-align:center">${esc(r.date || "")}</td><td style="${cell}text-align:center">${esc(r.sampleNo || "")}</td><td style="${cell}">${esc(r.assayLong || "")}</td>
        <td style="${cell}text-align:center">${esc(r.newLot || "")}</td><td style="${cell}text-align:center">${esc(r.newLotExp || "")}</td><td style="${cell}text-align:center">${esc(r.oldLot || "")}</td><td style="${cell}text-align:center">${esc(r.oldLotExp || "")}</td>
        <td style="${cell}text-align:center">${esc(r.newResult || "")}</td><td style="${cell}text-align:center">${esc(r.oldResult || "")}</td>
        <td style="${cell}text-align:center">${r.pctDiff === null ? "" : (r.pctDiff * 100).toFixed(2) + "%"}</td>
        <td style="${cell}font-size:10px">${esc(r.tae ? r.tae.source : "")}</td>
        <td style="${cell}text-align:center;font-weight:${r.passed === "Reject" ? "700" : "400"};color:${r.passed === "Reject" ? "#b91c1c" : "#111"}">${esc(r.passed)}</td>
        <td style="${cell}">${esc(r.comment || "")}</td>
      </tr>`).join("")}</tbody>
    </table>
    <div style="font-family:'Times New Roman',Times,serif;font-size:12px;margin-top:22px">* Attach both results, from new lot number and old lot number</div>
    <table style="font-family:'Times New Roman',Times,serif;font-size:12px;margin-top:26px"><tr>
      <td style="padding-right:10px;white-space:nowrap">Calculation of % Difference =</td>
      <td style="text-align:center;padding:0 14px">
        <div>(New Result -&nbsp; Old Result)</div>
        <div style="border-top:1px solid #111;margin-top:1px">Old Result</div>
      </td>
      <td style="padding-left:26px;white-space:nowrap;vertical-align:middle">X 100 = &lt; Total Allowable Error (T.A.E.)</td>
    </tr></table>
    <table style="font-family:'Times New Roman',Times,serif;font-size:12px;margin-top:46px"><tr>
      <td style="padding-right:14px">Reviewed By&nbsp;:</td><td>${esc(session.reviewedBy || "")}</td>
    </tr><tr>
      <td>Date:</td><td style="padding-left:34px">${esc(session.reviewDate || "")}</td>
    </tr></table>
    <div style="margin-top:30px;border-top:1px solid #ccc;padding-top:6px;font-size:10.5px;color:#444">Form LabGen 030 Evaluation of New Reagent Lot Number (Quantitative)</div>`;
  document.body.appendChild(wrap);
  try {
    const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    const { jsPDF } = window.jspdf;
    // Fixed A4 landscape page (not sized to the canvas) so the export always prints as a proper
    // full A4 sheet — the content image is then scaled to fill it, instead of being pasted at its
    // native pixel size and leaving the rest of the page blank.
    const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const ratio = canvas.height / canvas.width;
    let drawW = maxW, drawH = drawW * ratio;
    if (drawH > maxH) { drawH = maxH; drawW = drawH / ratio; }
    const x = (pageW - drawW) / 2;
    const y = margin + (maxH - drawH) / 2;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", x, y, drawW, drawH);
    return pdf;
  } finally {
    document.body.removeChild(wrap);
  }
}
function lotPdfFilename(session) {
  return `lot-to-lot_${branchName(session.branchId).replace(/[^a-z0-9]+/gi, "-")}_${session.sessionDate || todayStr()}.pdf`;
}

function renderLotToLotView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptySession = () => ({
    id: null, instrument: "", section: "", performedBy: state.user.email, reviewedBy: "",
    sessionDate: todayStr(), reviewDate: "", branchId: myBranch || "",
    rows: [LOT_ROW_BLANK()],
  });
  const lt = state.ui.lotToLot || emptySession();
  state.ui.lotToLot = lt;
  const branchFilter = isMaster ? (state.ui.lotToLotBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !lt.branchId || i.branchId === lt.branchId).map((i) => i.name))];
  const analyteNames = window.LOT_REFERENCE ? [...new Set(window.LOT_REFERENCE.map((r) => r[0]))] : [];
  const employeeNames = employeeDisplayNames();

  const q = (state.ui.lotToLotSearch || "").trim().toLowerCase();
  const saved = [...state.lotVerifications]
    .filter((s) => !branchFilter || s.branchId === branchFilter)
    .filter((s) => !q || [s.section, s.instrument, s.performedBy, s.reviewedBy, branchName(s.branchId), s.sessionDate, ...(s.rows || []).map((r) => r.assayLong)]
      .some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function rowHtml(row, idx) {
    const { tae, pctDiff, passed } = lotRowResult(row);
    return `<tr data-row="${idx}">
      <td><input type="date" class="mono" data-f="date" data-i="${idx}" value="${esc(row.date)}" style="width:130px" /></td>
      <td><input data-f="sampleNo" data-i="${idx}" value="${esc(row.sampleNo)}" style="width:100px" /></td>
      <td><input list="ltAnalytes" data-f="assayLong" data-i="${idx}" value="${esc(row.assayLong)}" style="width:200px" placeholder="e.g. Zinc" /></td>
      <td><input class="mono" data-f="newLot" data-i="${idx}" value="${esc(row.newLot)}" style="width:90px" placeholder="Lot #" /></td>
      <td><input type="date" class="mono" data-f="newLotExp" data-i="${idx}" value="${esc(row.newLotExp)}" style="width:130px" /></td>
      <td><input class="mono" data-f="oldLot" data-i="${idx}" value="${esc(row.oldLot)}" style="width:90px" placeholder="Lot #" /></td>
      <td><input type="date" class="mono" data-f="oldLotExp" data-i="${idx}" value="${esc(row.oldLotExp)}" style="width:130px" /></td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-f="newResult" data-i="${idx}" value="${esc(row.newResult)}" style="width:80px" /></td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-f="oldResult" data-i="${idx}" value="${esc(row.oldResult)}" style="width:80px" /></td>
      <td class="mono" style="white-space:nowrap">${pctDiff === null ? "—" : (pctDiff * 100).toFixed(2) + "%"}</td>
      <td style="font-size:11px;max-width:160px">${tae ? esc(tae.source) : `<span style="color:var(--text-dim)">no reference match</span>`}</td>
      <td>${passed ? `<span class="badge" style="background:${passed === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${passed === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text};border-color:${passed === "Pass" ? STATUS_STYLES.ok.border : STATUS_STYLES.expired.border}">${esc(passed)}</span>` : "—"}</td>
      <td><input data-f="comment" data-i="${idx}" value="${esc(row.comment)}" style="width:120px" /></td>
      <td><button type="button" class="icon-btn-sm" data-rm-row="${idx}" title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>Lot to Lot</h2><span class="subtitle">Evaluation of New Reagent Lot Number (Quantitative) — same logic as the lab's reference sheet</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:16px"><select id="ltBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="ltBranch"><option value="" ${lt.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === lt.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Section", `<input id="ltSection" value="${esc(lt.section)}" placeholder="e.g. chemistry" />`)}
        ${fieldHtml("Instrument", `<input id="ltInstrument" list="ltInstruments" value="${esc(lt.instrument)}" placeholder="e.g. DXc 700" />`)}
      </div>
      <datalist id="ltInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <datalist id="ltAnalytes">${analyteNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Tip: copy a block of rows from Excel (same column order as the table) and paste into the first cell of a row — it fills the whole block down.</div>
      <div class="table-wrap" style="margin:14px 0"><table class="data-table">
        <thead><tr><th>Date</th><th>Sample No.</th><th>Assay long</th><th>New Lot #</th><th>Exp. Date</th><th>Old Lot #</th><th>Exp. Date2</th><th>New Lot</th><th>Old Lot</th><th>% Diff</th><th>T.A.E.</th><th>PASSED</th><th>Comment</th><th></th></tr></thead>
        <tbody>${lt.rows.map((r, i) => rowHtml(r, i)).join("")}</tbody>
      </table></div>
      <button type="button" class="btn secondary" id="ltAddRow" style="margin-bottom:16px"><i class="fa-solid fa-plus"></i> Add row</button>
      <datalist id="ltEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        <div class="field"><span class="field-label">Performed By</span><input id="ltPerformedBy" list="ltEmployees" value="${esc(lt.performedBy)}" placeholder="Pick from employee list…" /></div>
        <div class="field"><span class="field-label">Reviewed By</span><input id="ltReviewedBy" list="ltEmployees" value="${esc(lt.reviewedBy)}" placeholder="Pick from employee list…" /></div>
      </div>
      <div class="form-row">
        <div class="field"><span class="field-label">Date</span><input type="date" id="ltSessionDate" value="${esc(lt.sessionDate)}" /></div>
        <div class="field"><span class="field-label">Review Date</span><input type="date" id="ltReviewDate" value="${esc(lt.reviewDate)}" /></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="ltReset">Clear form</button>
        <button type="button" class="btn primary" id="ltSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>
    <h3 style="margin:26px 0 12px;font-size:14px">Saved lot-to-lot logs</h3>
    <div class="search-box" style="margin-bottom:14px"><i class="fa-solid fa-magnifying-glass"></i><input id="ltSearch" value="${esc(state.ui.lotToLotSearch || "")}" placeholder="Search by section, instrument, assay, branch, or employee…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Section / Instrument</th><th>Branch</th><th>Rows</th><th>Performed By</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="7" class="table-empty">${q ? "No logs match your search" : "No saved logs yet"}</td></tr>` : saved.map((s) => `
        <tr><td class="mono">${esc(s.sessionDate || "—")}</td><td>${esc(s.section || "—")} / ${esc(s.instrument || "—")}</td><td>${esc(branchName(s.branchId))}</td>
          <td class="mono">${(s.rows || []).length}</td><td>${esc(s.performedBy || "")}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-lt="${s.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button class="icon-btn-sm" data-del-lt="${s.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("ltBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.lotToLotBranch = e.target.value; renderLotToLotView(); };
  const ltBranchEl = el("ltBranch"); if (ltBranchEl) ltBranchEl.onchange = (e) => { lt.branchId = e.target.value; renderLotToLotView(); };
  el("ltSection").oninput = (e) => lt.section = e.target.value;
  el("ltInstrument").oninput = (e) => lt.instrument = e.target.value;
  el("ltPerformedBy").oninput = (e) => lt.performedBy = e.target.value;
  el("ltReviewedBy").oninput = (e) => lt.reviewedBy = e.target.value;
  el("ltSessionDate").oninput = (e) => lt.sessionDate = e.target.value;
  el("ltReviewDate").oninput = (e) => lt.reviewDate = e.target.value;
  el("ltAddRow").onclick = () => { lt.rows.push(LOT_ROW_BLANK()); renderLotToLotView(); };
  attachExcelPasteObjects(el("mainContent"), "input[data-f]", lt.rows, ["date", "sampleNo", "assayLong", "newLot", "newLotExp", "oldLot", "oldLotExp", "newResult", "oldResult", "comment"], LOT_ROW_BLANK, renderLotToLotView);
  el("mainContent").querySelectorAll("[data-rm-row]").forEach((btn) => btn.onclick = () => {
    lt.rows.splice(Number(btn.dataset.rmRow), 1);
    if (lt.rows.length === 0) lt.rows.push(LOT_ROW_BLANK());
    renderLotToLotView();
  });
  el("mainContent").querySelectorAll("input[data-f]").forEach((input) => {
    const i = Number(input.dataset.i), f = input.dataset.f;
    input.oninput = (e) => { lt.rows[i][f] = e.target.value; };
    // Lot number fields auto-fill their expiry from what's already in inventory, then refresh
    // the computed cells (%Difference / T.A.E. / PASSED) for this row on blur.
    input.onblur = () => {
      if (f === "newLot") { const m = expiryForLot(lt.rows[i].newLot, lt.branchId || null); if (m && m.expiry) lt.rows[i].newLotExp = m.expiry; }
      if (f === "oldLot") { const m = expiryForLot(lt.rows[i].oldLot, lt.branchId || null); if (m && m.expiry) lt.rows[i].oldLotExp = m.expiry; }
      renderLotToLotView();
    };
    // Easier data entry: pressing Enter in the Comment box of the last row jumps straight to a
    // fresh row instead of making you reach for "Add row" every time.
    if (f === "comment") input.onkeydown = (e) => {
      if (e.key === "Enter" && i === lt.rows.length - 1) { e.preventDefault(); lt.rows.push(LOT_ROW_BLANK()); renderLotToLotView(); }
    };
  });
  el("ltSearch").oninput = (e) => {
    state.ui.lotToLotSearch = e.target.value;
    renderLotToLotView();
    const refocused = el("ltSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("ltReset").onclick = () => { state.ui.lotToLot = emptySession(); renderLotToLotView(); };
  el("mainContent").querySelectorAll("[data-del-lt]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved log?")) deleteLotVerification(btn.dataset.delLt); });
  el("mainContent").querySelectorAll("[data-dl-lt]").forEach((btn) => btn.onclick = async () => {
    const session = state.lotVerifications.find((s) => s.id === btn.dataset.dlLt);
    if (!session) return;
    btn.disabled = true;
    try {
      const pdf = await renderLotVerificationPdf(session);
      pdf.save(lotPdfFilename(session));
    } catch (err) {
      console.error("Lot-to-lot PDF regeneration failed:", err);
      toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false;
    }
  });

  el("ltSavePdf").onclick = async (e) => {
    if (isMaster && !lt.branchId) { toast("Please select a branch.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const session = {
        instrument: lt.instrument, section: lt.section, performedBy: lt.performedBy, reviewedBy: lt.reviewedBy,
        sessionDate: lt.sessionDate, reviewDate: lt.reviewDate, branchId: lt.branchId || myBranch || null, rows: lt.rows,
      };
      const pdf = await renderLotVerificationPdf(session);
      pdf.save(lotPdfFilename(session));
      await saveLotVerification(session);
      state.ui.lotToLot = emptySession();
      renderLotToLotView();
    } catch (err) {
      console.error("Lot-to-lot save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   QR Evaluator — Projects
   Mirrors the real QR Evaluator workflow: open (or create) a Project,
   then add one or more Experiments to it (Precision, Accuracy, Method
   Comparison, Sensitivity, Reference Interval, …). Every experiment
   record below already existed per-module (precisionRuns, accuracyRuns,
   …) — a Project is just a lightweight container that groups them via
   a `projectId` field, tied to a branch like everything else here.
--------------------------------------------------------------------- */
const EP_RUN_TYPES = [
  { key: "precisionRuns", uiKey: "precisionRun", label: "Precision", icon: "fa-ruler-combined", view: "precision", pdfFn: () => renderPrecisionPdf, pdfName: () => precisionPdfFilename, deleteFn: () => deletePrecisionRun },
  { key: "accuracyRuns", uiKey: "accuracyRun", label: "Accuracy", icon: "fa-bullseye", view: "accuracy", pdfFn: () => renderAccuracyPdf, pdfName: () => accuracyPdfFilename, deleteFn: () => deleteAccuracyRun },
  { key: "linearityRuns", uiKey: "linearityRun", label: "Linearity", icon: "fa-chart-line", view: "linearity", pdfFn: () => renderLinearityPdf, pdfName: () => linearityPdfFilename, deleteFn: () => deleteLinearityRun },
  { key: "comparisonRuns", uiKey: "comparisonRun", label: "Method Comparison", icon: "fa-arrow-right-arrow-left", view: "comparison", pdfFn: () => renderComparisonPdf, pdfName: () => comparisonPdfFilename, deleteFn: () => deleteComparisonRun },
  { key: "multiComparisonRuns", uiKey: "multiComparisonRun", label: "Multiple Instrument Comparison", icon: "fa-shuffle", view: "multiComparison", pdfFn: () => renderMultiComparisonPdf, pdfName: () => multiComparisonPdfFilename, deleteFn: () => deleteMultiComparisonRun },
  { key: "qualComparisonRuns", uiKey: "qualComparisonRun", label: "Qualitative Comparison", icon: "fa-table-cells", view: "qualComparison", pdfFn: () => renderQualComparisonPdf, pdfName: () => qualComparisonPdfFilename, deleteFn: () => deleteQualComparisonRun },
  { key: "qualPrecisionRuns", uiKey: "qualPrecisionRun", label: "Sensitivity (Qual. Precision)", icon: "fa-list-check", view: "qualPrecision", pdfFn: () => renderQualPrecisionPdf, pdfName: () => qualPrecisionPdfFilename, deleteFn: () => deleteQualPrecisionRun },
  { key: "referenceIntervalRuns", uiKey: "referenceIntervalRun", label: "Reference Interval", icon: "fa-chart-column", view: "referenceInterval", pdfFn: () => renderReferenceIntervalPdf, pdfName: () => referenceIntervalPdfFilename, deleteFn: () => deleteReferenceIntervalRun },
  { key: "methodValidationSummaryRuns", uiKey: "methodValidationSummaryRun", label: "Method Validation Summary", icon: "fa-file-circle-check", view: "methodValidationSummary", pdfFn: () => renderMethodValidationSummaryPdf, pdfName: () => methodValidationSummaryPdfFilename, deleteFn: () => deleteMethodValidationSummaryRun },
  { key: "sensitivityRuns", uiKey: "sensitivityRun", label: "Analytical Sensitivity (LoB/LoD/LoQ)", icon: "fa-magnifying-glass-chart", view: "analyticalSensitivity", pdfFn: () => renderSensitivityPdf, pdfName: () => sensitivityPdfFilename, deleteFn: () => deleteSensitivityRun },
  { key: "carryoverRuns", uiKey: "carryoverRun", label: "Carryover", icon: "fa-arrow-right-to-bracket", view: "carryover", pdfFn: () => renderCarryoverPdf, pdfName: () => carryoverPdfFilename, deleteFn: () => deleteCarryoverRun },
  { key: "interferenceRuns", uiKey: "interferenceRun", label: "Interference / Specificity", icon: "fa-droplet-slash", view: "interference", pdfFn: () => renderInterferencePdf, pdfName: () => interferencePdfFilename, deleteFn: () => deleteInterferenceRun },
];
/** Stashes a preset (analyte/units/TEa) onto the right state.ui.*Preset slot so the target
 *  module's blank-form initializer can pick it up once — used by Coag/Glucose POC/Hematology
 *  submenu shortcuts to pre-fill a generic module (Precision, Comparison) instead of duplicating it. */
function applyEpPreset(view, dataset) {
  if (!dataset.presetAnalyte && !dataset.presetUnits && !dataset.presetTea) return;
  if (view === "precision") state.ui.precisionPreset = { analyte: dataset.presetAnalyte || "", units: dataset.presetUnits || "" };
  else if (view === "comparison") state.ui.comparisonPreset = { analyte: dataset.presetAnalyte || "", units: dataset.presetUnits || "", tea: dataset.presetTea || "" };
}
const EP_MODULES = [
  { key: "methodValidationSummary", label: "Method Validation Summary", icon: "fa-file-circle-check", view: "methodValidationSummary" },
  { key: "precision", label: "Precision", icon: "fa-ruler-combined", view: "precision" },
  { key: "accuracyLinearity", label: "Accuracy and Linearity", icon: "fa-bullseye", submenu: [
      { label: "Linearity and Calibration Verification (EP6)", view: "linearity" },
      { label: "Simple Accuracy / Trueness", view: "accuracy" },
    ] },
  { key: "methodComparison", label: "Method Comparison", icon: "fa-arrow-right-arrow-left", submenu: [
      { label: "Quantitative — Two Instrument Comparison", view: "comparison" },
      { label: "Multiple Instrument Comparison (3+)", view: "multiComparison" },
      { label: "Glucose POC Instrument Evaluation", view: "comparison", presetAnalyte: "Glucose (POC)", presetUnits: "mg/dL", presetTea: "8" },
      { label: "Hematology — Hemoglobin", view: "comparison", presetAnalyte: "Hemoglobin", presetUnits: "g/dL", presetTea: "4" },
      { label: "Hematology — Hematocrit", view: "comparison", presetAnalyte: "Hematocrit", presetUnits: "%", presetTea: "4" },
      { label: "Hematology — WBC", view: "comparison", presetAnalyte: "WBC", presetUnits: "x10^3/µL", presetTea: "10" },
      { label: "Hematology — Platelet Count", view: "comparison", presetAnalyte: "Platelet Count", presetUnits: "x10^3/µL", presetTea: "25" },
      { label: "Qualitative — Sensitivity / Specificity / Kappa", view: "qualComparison" },
    ] },
  { key: "sensitivity", label: "Sensitivity", icon: "fa-list-check", view: "qualPrecision" },
  { key: "analyticalSensitivity", label: "Analytical Sensitivity (LoB/LoD/LoQ)", icon: "fa-magnifying-glass-chart", view: "analyticalSensitivity" },
  { key: "carryover", label: "Carryover", icon: "fa-arrow-right-to-bracket", view: "carryover" },
  { key: "interference", label: "Interference / Specificity", icon: "fa-droplet-slash", view: "interference" },
  { key: "referenceInterval", label: "Reference Interval", icon: "fa-chart-column", view: "referenceInterval" },
  { key: "coag", label: "Coag", icon: "fa-droplet", submenu: [
      { label: "PT / INR Precision", view: "precision", presetAnalyte: "PT", presetUnits: "sec" },
      { label: "PTT (aPTT) Precision", view: "precision", presetAnalyte: "PTT", presetUnits: "sec" },
      { label: "Fibrinogen Precision", view: "precision", presetAnalyte: "Fibrinogen", presetUnits: "mg/dL" },
      { label: "INR Calculator (ISI / MNPT)", view: "inrCalc" },
    ] },
  { key: "other", label: "Other", icon: "fa-ellipsis", disabled: true },
];

async function saveEPProject(data) {
  if (data.id) {
    const { id, ...rest } = data;
    await db.collection("epProjects").doc(id).set(rest, { merge: true });
    logAudit("edit_ep_project", data.name || id, "");
    return id;
  }
  const ref = await db.collection("epProjects").add({ ...data, createdBy: state.user.email, createdAt: nowStr() });
  logAudit("create_ep_project", data.name || ref.id, "");
  return ref.id;
}
async function deleteEPProject(id) {
  const p = state.epProjects.find((x) => x.id === id);
  const hasExperiments = EP_RUN_TYPES.some((t) => state[t.key].some((r) => r.projectId === id));
  if (hasExperiments) { toast("This project still has saved experiments — delete those first (or leave them; they'll stay as unlinked records).", "warn"); return false; }
  await db.collection("epProjects").doc(id).delete();
  logAudit("delete_ep_project", p ? p.name : id, "");
  return true;
}
/** Danger-zone action: permanently deletes every saved QR Evaluator record — every run in every
 *  module (precisionRuns, accuracyRuns, linearityRuns, comparisonRuns, qualComparisonRuns,
 *  qualPrecisionRuns, referenceIntervalRuns) plus every project — across all branches. There is no
 *  server-stored PDF file to remove: PDFs are generated on the fly from this data when downloaded,
 *  so deleting the records is equivalent to deleting "all the PDFs". Master-only, batched in groups
 *  of 500 (Firestore's per-batch limit), matching the pattern used by the catalog importer.
 *  Returns the total number of documents removed. */
async function deleteAllEPData() {
  const allDocIds = [];
  let skipped = 0;
  EP_RUN_TYPES.forEach((t) => state[t.key].forEach((r) => { if (r.id) allDocIds.push({ col: t.key, id: r.id }); else skipped++; }));
  state.epProjects.forEach((p) => { if (p.id) allDocIds.push({ col: "epProjects", id: p.id }); else skipped++; });
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const { col, id } of allDocIds) {
    batch.delete(db.collection(col).doc(id));
    ops++;
    if (ops >= 450) await flush();
  }
  await flush();
  logAudit("delete_all_ep_data", `${allDocIds.length} record(s)${skipped ? `, ${skipped} skipped (no id)` : ""}`, "");
  return { removed: allDocIds.length, skipped };
}
/** All experiments (across every run type) that belong to one project, newest first — used by
 *  both the project workspace list and the project-level summary counts. */
function experimentsForProject(projectId) {
  const out = [];
  EP_RUN_TYPES.forEach((t) => {
    state[t.key].forEach((r) => { if (r.projectId === projectId) out.push({ ...r, __type: t }); });
  });
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
function projectExperimentCounts(projectId) {
  const list = experimentsForProject(projectId);
  const byType = {};
  list.forEach((r) => { byType[r.__type.key] = (byType[r.__type.key] || 0) + 1; });
  return { total: list.length, byType };
}

/* -------- Project Browser ("Open Project") -------- */
function renderEPHomeView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const ui = state.ui.epBrowser || { branchFilter: isMaster ? "" : (myBranch || ""), search: "", creating: false, form: null, editingId: null, editForm: null };
  state.ui.epBrowser = ui;

  const q = (ui.search || "").trim().toLowerCase();
  const projects = [...state.epProjects]
    .filter((p) => isMaster ? (!ui.branchFilter || p.branchId === ui.branchFilter) : (p.branchId || null) === myBranch)
    .filter((p) => !q || [p.name, p.analyte, p.instrument, branchName(p.branchId)].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const newProjectFormHtml = () => {
    const f = ui.form;
    return `<div class="card-form" style="margin-bottom:24px">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="epNewBranch"><option value="" ${f.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === f.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Project Name *", `<input id="epNewName" value="${esc(f.name)}" placeholder="e.g. ALP DxC 700 Verification 2026" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Analyte / Test", `<input id="epNewAnalyte" value="${esc(f.analyte)}" placeholder="e.g. ALP" />`)}
        ${fieldHtml("Instrument", `<input id="epNewInstrument" value="${esc(f.instrument)}" placeholder="e.g. Beckman DxC 700 Au" />`)}
        ${fieldHtml("Units", `<input id="epNewUnits" list="labUnitsList" value="${esc(f.units)}" placeholder="e.g. U/L" style="width:100px" />${labUnitsDatalistHtml()}`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="epNewCancel">Cancel</button>
        <button type="button" class="btn primary" id="epNewCreate"><i class="fa-solid fa-folder-plus"></i> Create Project</button>
      </div>
    </div>`;
  };

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>QR Evaluator — Projects</h2><span class="subtitle">Open a project to add experiments (Precision, Comparison, Linearity…), or start a new one</span></div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn secondary" id="epToolsBtn"><i class="fa-solid fa-toolbox"></i> Tools</button>
        ${!ui.creating ? `<button type="button" class="btn primary" id="epNewProjectBtn"><i class="fa-solid fa-folder-plus"></i> New Project</button>` : ""}
      </div></div>
    ${ui.creating ? newProjectFormHtml() : ""}
    <div class="filter-bar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      ${isMaster ? `<select id="epBranchFilter" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === ui.branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>` : ""}
      <div class="search-box" style="flex:1;min-width:200px"><i class="fa-solid fa-magnifying-glass"></i><input id="epSearch" value="${esc(ui.search || "")}" placeholder="Search projects by name, analyte, instrument, branch…" /></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
      ${projects.length === 0 ? `<div class="table-empty" style="grid-column:1/-1">${q || ui.branchFilter ? "No projects match your filters" : "No projects yet — create one to get started"}</div>` : projects.map((p) => {
        const counts = projectExperimentCounts(p.id);
        if (ui.editingId === p.id) {
          const ef = ui.editForm || { name: p.name || "", analyte: p.analyte || "", instrument: p.instrument || "" };
          ui.editForm = ef;
          return `<div class="panel-card" style="border:1px solid var(--accent)">
            <div class="field" style="margin-bottom:8px"><span class="field-label">Project Name</span><input data-edit-field="name" value="${esc(ef.name)}" /></div>
            <div class="field" style="margin-bottom:8px"><span class="field-label">Analyte / Test</span><input data-edit-field="analyte" value="${esc(ef.analyte)}" /></div>
            <div class="field" style="margin-bottom:12px"><span class="field-label">Instrument</span><input data-edit-field="instrument" value="${esc(ef.instrument)}" /></div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button type="button" class="btn secondary" data-cancel-edit="${p.id}">Cancel</button>
              <button type="button" class="btn primary" data-save-edit="${p.id}">Save</button>
            </div>
          </div>`;
        }
        return `<div class="panel-card" style="position:relative">
          <button type="button" class="icon-btn-sm" data-edit-project="${p.id}" title="Edit project" style="position:absolute;top:14px;inset-inline-end:14px"><i class="fa-solid fa-pen"></i></button>
          <button type="button" data-open-project="${p.id}" style="text-align:left;cursor:pointer;background:none;border:none;padding:0;width:100%;color:inherit;font:inherit">
            <div class="panel-title" style="padding-inline-end:26px"><i class="fa-solid fa-folder-open"></i> ${esc(p.name || "(unnamed project)")}</div>
            <div class="panel-sub">${esc(p.analyte || "—")}${p.instrument ? " · " + esc(p.instrument) : ""}</div>
            <div style="font-size:11.5px;color:var(--text-dim);margin-top:6px">${esc(branchName(p.branchId))} · ${counts.total} experiment${counts.total === 1 ? "" : "s"} · opened ${esc(p.createdAt ? p.createdAt.slice(0, 10) : "")}</div>
          </button>
        </div>`;
      }).join("")}
    </div>
    <details style="margin-top:26px">
      <summary style="cursor:pointer;font-size:12.5px;color:var(--text-dim)">Advanced: browse experiments without a project (includes anything saved before Projects existed)</summary>
      <div class="ep-launcher" style="margin-top:12px">
        ${EP_MODULES.map((m) => `
          <div class="ep-module ${m.disabled ? "disabled" : ""}">
            <button type="button" class="ep-module-btn" data-ep-legacy-key="${m.key}" ${m.disabled ? "disabled" : ""}>
              <i class="fa-solid ${m.icon}"></i><span>${esc(m.label)}</span>
              ${m.submenu ? `<i class="fa-solid fa-chevron-down ep-chevron ${state.ui.epLegacyOpenSubmenu === m.key ? "open" : ""}"></i>` : m.disabled ? `<span class="ep-soon">Coming soon</span>` : ""}
            </button>
            ${m.submenu && state.ui.epLegacyOpenSubmenu === m.key ? `<div class="ep-submenu">${m.submenu.map((s) => `<button type="button" class="ep-submenu-btn" data-ep-legacy-view="${s.view}" ${s.presetAnalyte ? `data-preset-analyte="${esc(s.presetAnalyte)}"` : ""} ${s.presetUnits ? `data-preset-units="${esc(s.presetUnits)}"` : ""} ${s.presetTea ? `data-preset-tea="${esc(s.presetTea)}"` : ""}>${esc(s.label)}</button>`).join("")}</div>` : ""}
          </div>`).join("")}
      </div>
    </details>
    ${isMaster ? `
    <div class="panel-card" style="margin-top:22px;border:1px solid var(--danger-text,#c0392b)">
      <div style="font-weight:700;font-size:13.5px;color:var(--danger-text,#c0392b);margin-bottom:4px"><i class="fa-solid fa-triangle-exclamation"></i> Danger zone</div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">Permanently deletes every saved QR Evaluator experiment (Precision, Accuracy, Linearity, Method Comparison, Sensitivity, Qualitative Comparison, Reference Interval, Method Validation Summary, Analytical Sensitivity/LoB-LoD-LoQ, Carryover, Interference/Specificity) and every project, across all branches. PDFs are generated from these records on demand — there is nothing else to remove separately. This cannot be undone.</div>
      <div class="form-row" style="align-items:flex-end">
        ${fieldHtml(`Type "DELETE ALL" to confirm`, `<input id="epDangerConfirm" placeholder="DELETE ALL" autocomplete="off" />`)}
        <button type="button" class="btn danger-outline" id="epDangerDeleteAll" disabled><i class="fa-solid fa-trash"></i> Delete all QR Evaluator data</button>
      </div>
    </div>` : ""}`;

  el("epToolsBtn").onclick = () => navigateTo("epTools");
  const epBranchFilterEl = el("epBranchFilter"); if (epBranchFilterEl) epBranchFilterEl.onchange = (e) => { ui.branchFilter = e.target.value; renderEPHomeView(); };
  el("epSearch").oninput = (e) => {
    ui.search = e.target.value; renderEPHomeView();
    const r = el("epSearch"); if (r) { r.focus(); r.setSelectionRange(r.value.length, r.value.length); }
  };
  const dangerConfirmEl = el("epDangerConfirm");
  if (dangerConfirmEl) {
    dangerConfirmEl.oninput = (e) => { el("epDangerDeleteAll").disabled = e.target.value.trim() !== "DELETE ALL"; };
    el("epDangerDeleteAll").onclick = async () => {
      if (dangerConfirmEl.value.trim() !== "DELETE ALL") return;
      const totalCount = EP_RUN_TYPES.reduce((sum, t) => sum + state[t.key].length, 0) + state.epProjects.length;
      if (!confirm(`This will permanently delete ${totalCount} QR Evaluator record(s) across all branches. This cannot be undone. Continue?`)) return;
      const btn = el("epDangerDeleteAll");
      btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Deleting…`;
      try {
        const { removed, skipped } = await deleteAllEPData();
        toast(`Deleted ${removed} QR Evaluator record(s).${skipped ? ` (${skipped} malformed record(s) with no id were skipped.)` : ""}`, "success");
        renderEPHomeView();
      } catch (err) {
        toast("Failed to delete all data: " + (err.message || err), "error");
        btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-trash"></i> Delete all QR Evaluator data`;
      }
    };
  }
  el("mainContent").querySelectorAll("[data-open-project]").forEach((btn) => btn.onclick = () => {
    const p = state.epProjects.find((x) => x.id === btn.dataset.openProject);
    if (p) { state.ui.epProject = p; navigateTo("epProject"); }
  });
  el("mainContent").querySelectorAll("[data-edit-project]").forEach((btn) => btn.onclick = () => {
    const p = state.epProjects.find((x) => x.id === btn.dataset.editProject);
    if (!p) return;
    ui.editingId = p.id;
    ui.editForm = { name: p.name || "", analyte: p.analyte || "", instrument: p.instrument || "" };
    renderEPHomeView();
  });
  el("mainContent").querySelectorAll("[data-cancel-edit]").forEach((btn) => btn.onclick = () => {
    ui.editingId = null; ui.editForm = null; renderEPHomeView();
  });
  el("mainContent").querySelectorAll("[data-edit-field]").forEach((input) => input.oninput = (e) => {
    ui.editForm[input.dataset.editField] = e.target.value;
  });
  el("mainContent").querySelectorAll("[data-save-edit]").forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.saveEdit;
    const p = state.epProjects.find((x) => x.id === id);
    if (!p) return;
    const f = ui.editForm;
    if (!f.name.trim()) { toast("Please enter a project name.", "warn"); return; }
    await saveEPProject({ id, name: f.name.trim(), analyte: f.analyte, instrument: f.instrument, units: p.units, branchId: p.branchId, status: p.status, performedBy: p.performedBy, reviewedBy: p.reviewedBy, notes: p.notes });
    ui.editingId = null; ui.editForm = null;
    renderEPHomeView();
  });
  el("mainContent").querySelectorAll("[data-ep-legacy-key]").forEach((btn) => btn.onclick = () => {
    const mod = EP_MODULES.find((m) => m.key === btn.dataset.epLegacyKey);
    if (!mod || mod.disabled) return;
    if (mod.submenu) { state.ui.epLegacyOpenSubmenu = state.ui.epLegacyOpenSubmenu === mod.key ? null : mod.key; renderEPHomeView(); return; }
    state.ui.epProject = null;
    const t = EP_RUN_TYPES.find((x) => x.view === mod.view);
    if (t) state.ui[t.uiKey] = null;
    navigateTo(mod.view);
  });
  el("mainContent").querySelectorAll("[data-ep-legacy-view]").forEach((btn) => btn.onclick = () => {
    state.ui.epProject = null;
    const t = EP_RUN_TYPES.find((x) => x.view === btn.dataset.epLegacyView);
    if (t) state.ui[t.uiKey] = null;
    applyEpPreset(btn.dataset.epLegacyView, btn.dataset);
    navigateTo(btn.dataset.epLegacyView);
  });
  const newBtn = el("epNewProjectBtn"); if (newBtn) newBtn.onclick = () => {
    ui.creating = true; ui.form = { branchId: isMaster ? "" : (myBranch || ""), name: "", analyte: "", instrument: "", units: "" };
    renderEPHomeView();
  };
  const cancelBtn = el("epNewCancel"); if (cancelBtn) cancelBtn.onclick = () => { ui.creating = false; ui.form = null; renderEPHomeView(); };
  const epNewBranchEl = el("epNewBranch"); if (epNewBranchEl) epNewBranchEl.onchange = (e) => { ui.form.branchId = e.target.value; };
  const epNewNameEl = el("epNewName"); if (epNewNameEl) epNewNameEl.oninput = (e) => { ui.form.name = e.target.value; };
  const epNewAnalyteEl = el("epNewAnalyte"); if (epNewAnalyteEl) epNewAnalyteEl.oninput = (e) => { ui.form.analyte = e.target.value; };
  const epNewInstrumentEl = el("epNewInstrument"); if (epNewInstrumentEl) epNewInstrumentEl.oninput = (e) => { ui.form.instrument = e.target.value; };
  const epNewUnitsEl = el("epNewUnits"); if (epNewUnitsEl) epNewUnitsEl.oninput = (e) => { ui.form.units = e.target.value; };
  const createBtn = el("epNewCreate"); if (createBtn) createBtn.onclick = async () => {
    const f = ui.form;
    if (isMaster && !f.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!f.name.trim()) { toast("Please enter a project name.", "warn"); return; }
    const data = { name: f.name.trim(), analyte: f.analyte, instrument: f.instrument, units: f.units, branchId: f.branchId || myBranch || null, status: "Open", performedBy: state.user.email, reviewedBy: "", notes: "" };
    const id = await saveEPProject(data);
    ui.creating = false; ui.form = null;
    const created = { id, ...data };
    state.ui.epProject = created;
    navigateTo("epProject");
  };
}

/* -------- Reference Tools: Glossary, CLIA PT Acceptance Limits, Units Conversion -------- */
function renderEPToolsView() {
  const ui = state.ui.epTools || { tab: "glossary", search: "" };
  state.ui.epTools = ui;
  const q = (ui.search || "").trim().toLowerCase();

  const tabs = [
    { key: "glossary", label: "Glossary", icon: "fa-book" },
    { key: "cliaPt", label: "CLIA PT Acceptance Limits", icon: "fa-clipboard-check" },
    { key: "unitsConv", label: "Units Conversion Factors", icon: "fa-right-left" },
    { key: "labUnits", label: "Common Lab Units", icon: "fa-ruler" },
  ];

  const glossaryHtml = () => {
    const rows = EP_GLOSSARY.filter((g) => !q || g.term.toLowerCase().includes(q) || g.def.toLowerCase().includes(q));
    if (!rows.length) return `<div class="table-empty">No terms match your search</div>`;
    return `<div style="display:flex;flex-direction:column;gap:10px">${rows.map((g) => `
      <div class="panel-card" style="padding:14px 16px">
        <div style="font-weight:700;font-size:13.5px;margin-bottom:4px">${esc(g.term)}</div>
        <div style="font-size:12.5px;color:var(--text-dim);line-height:1.5">${esc(g.def)}</div>
      </div>`).join("")}</div>`;
  };

  const cliaPtHtml = () => {
    const rows = CLIA_PT_LIMITS.filter((r) => !q || r.analyte.toLowerCase().includes(q) || r.category.toLowerCase().includes(q));
    const byCategory = {};
    rows.forEach((r) => { (byCategory[r.category] = byCategory[r.category] || []).push(r); });
    const cats = Object.keys(byCategory);
    if (!cats.length) return `<div class="table-empty">No analytes match your search</div>`;
    return `<div style="font-size:11.5px;color:var(--text-dim);margin-bottom:14px">${esc(CLIA_PT_LIMITS_SOURCE)}</div>` +
      cats.map((cat) => `
      <div style="margin-bottom:22px">
        <div style="font-weight:700;font-size:13.5px;margin-bottom:8px">${esc(cat)}</div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Analyte / Test</th><th>Current Acceptable Performance (2025)</th><th>Previous (pre-2025)</th></tr></thead>
          <tbody>${byCategory[cat].map((r) => `<tr><td>${esc(r.analyte)}</td><td>${esc(r.newAp)}</td><td style="color:var(--text-dim)">${esc(r.oldAp)}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>`).join("");
  };

  const unitsConvHtml = () => {
    const rows = UNITS_CONVERSION_FACTORS.filter((r) => !q || r.analyte.toLowerCase().includes(q));
    if (!rows.length) return `<div class="table-empty">No analytes match your search</div>`;
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Analyte</th><th>From</th><th>To</th><th>Multiply by</th><th>Quick convert</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td>${esc(r.analyte)}</td><td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${r.factor}</td>
        <td style="white-space:nowrap"><input type="text" inputmode="decimal" dir="ltr" step="any" data-unit-conv="${i}" placeholder="value in ${esc(r.from)}" style="width:110px;display:inline-block" /> <span id="unitConvResult${i}" style="font-weight:600"></span></td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  };

  const labUnitsHtml = () => {
    const rows = LAB_UNITS_REFERENCE.filter((r) => !q || r.unit.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) || r.usedFor.toLowerCase().includes(q));
    const byCategory = {};
    rows.forEach((r) => { (byCategory[r.category] = byCategory[r.category] || []).push(r); });
    const cats = Object.keys(byCategory);
    if (!cats.length) return `<div class="table-empty">No units match your search</div>`;
    return `<div style="font-size:11.5px;color:var(--text-dim);margin-bottom:14px">Reporting units seen across departments — a plain reference, not a converter. Where both a conventional and an SI unit are common, both are listed; use Units Conversion Factors to convert between them where a factor exists.</div>` +
      cats.map((cat) => `
      <div style="margin-bottom:22px">
        <div style="font-weight:700;font-size:13.5px;margin-bottom:8px">${esc(cat)}</div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Unit</th><th>Used for</th></tr></thead>
          <tbody>${byCategory[cat].map((r) => `<tr><td class="mono">${esc(r.unit)}</td><td style="color:var(--text-dim)">${esc(r.usedFor)}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>`).join("");
  };

  el("mainContent").innerHTML = `
    <div class="page-header"><div>
      <div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epToolsBack"><i class="fa-solid fa-arrow-left"></i> QR Evaluator</button></div>
      <h2>Reference Tools</h2><span class="subtitle">Glossary, CLIA proficiency-testing acceptance limits, common unit conversions, and common lab reporting units — for reference, not automated calculations</span>
    </div></div>
    <div class="filter-bar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <div style="display:flex;gap:6px;flex-wrap:wrap">${tabs.map((t) => `<button type="button" class="btn ${ui.tab === t.key ? "primary" : "secondary"}" data-ep-tools-tab="${t.key}"><i class="fa-solid ${t.icon}"></i> ${esc(t.label)}</button>`).join("")}</div>
      <div class="search-box" style="flex:1;min-width:200px"><i class="fa-solid fa-magnifying-glass"></i><input id="epToolsSearch" value="${esc(ui.search || "")}" placeholder="Search…" /></div>
    </div>
    <div>${ui.tab === "glossary" ? glossaryHtml() : ui.tab === "cliaPt" ? cliaPtHtml() : ui.tab === "unitsConv" ? unitsConvHtml() : labUnitsHtml()}</div>
  `;

  el("epToolsBack").onclick = () => navigateTo("epHome");
  el("mainContent").querySelectorAll("[data-ep-tools-tab]").forEach((btn) => btn.onclick = () => { ui.tab = btn.dataset.epToolsTab; renderEPToolsView(); });
  el("epToolsSearch").oninput = (e) => {
    ui.search = e.target.value; renderEPToolsView();
    const r = el("epToolsSearch"); if (r) { r.focus(); r.setSelectionRange(r.value.length, r.value.length); }
  };
  el("mainContent").querySelectorAll("[data-unit-conv]").forEach((input) => {
    input.oninput = (e) => {
      const idx = Number(e.target.dataset.unitConv);
      const row = UNITS_CONVERSION_FACTORS[idx];
      const val = parseFloat(e.target.value);
      const out = el("unitConvResult" + idx);
      out.textContent = Number.isFinite(val) ? `= ${round4(val * row.factor)} ${row.to}` : "";
    };
  });
}

/* -------- INR Calculator (ISI / MNPT) — standalone, not a saved experiment -------- */
function inrCalcCompute(ui) {
  const pt = parseFloat(ui.patientPt), isi = parseFloat(ui.isi), mnpt = parseFloat(ui.mnpt);
  const valid = Number.isFinite(pt) && Number.isFinite(isi) && Number.isFinite(mnpt) && mnpt > 0 && pt > 0;
  return { valid, inr: valid ? Math.pow(pt / mnpt, isi) : null };
}
function renderInrCalcView() {
  const ui = state.ui.inrCalc || { patientPt: "", isi: "", mnpt: "" };
  state.ui.inrCalc = ui;
  const { valid, inr } = inrCalcCompute(ui);
  const ptLimit = CLIA_PT_LIMITS.find((r) => r.analyte.toLowerCase().includes("prothrombin time (pt)"));

  el("mainContent").innerHTML = `
    <div class="page-header"><div>
      <div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="inrBack"><i class="fa-solid fa-arrow-left"></i> QR Evaluator</button></div>
      <h2>INR Calculator</h2><span class="subtitle">Computes INR = (Patient PT ÷ MNPT) ^ ISI — standard WHO formula relating a patient's prothrombin time to the reagent/instrument's local mean normal PT and International Sensitivity Index</span>
    </div></div>
    <div class="panel-card" style="max-width:520px">
      <div class="field" style="margin-bottom:12px"><span class="field-label">Patient PT (seconds) *</span><input type="text" inputmode="decimal" dir="ltr" step="any" id="inrPt" value="${esc(ui.patientPt)}" placeholder="e.g. 14.2" /></div>
      <div class="field" style="margin-bottom:12px"><span class="field-label">Local MNPT — Mean Normal PT (seconds) *</span><input type="text" inputmode="decimal" dir="ltr" step="any" id="inrMnpt" value="${esc(ui.mnpt)}" placeholder="e.g. 12.0" /></div>
      <div class="field" style="margin-bottom:16px"><span class="field-label">ISI — International Sensitivity Index (from reagent insert) *</span><input type="text" inputmode="decimal" dir="ltr" step="any" id="inrIsi" value="${esc(ui.isi)}" placeholder="e.g. 1.05" /></div>
      <div id="inrOutputBox" style="background:${valid ? "#eaf6ec" : "var(--surface-2,#f3f3f3)"};border-radius:8px;padding:14px 16px;text-align:center">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">INR</div>
        <div id="inrOutputValue" style="font-size:32px;font-weight:800;${valid ? "color:#1f7a3d" : ""}">${valid ? inr.toFixed(2) : "—"}</div>
      </div>
      ${ptLimit ? `<div style="font-size:11.5px;color:var(--text-dim);margin-top:14px"><i class="fa-solid fa-circle-info"></i> CLIA PT acceptance limit for reference: ${esc(ptLimit.newAp)}. See Tools → CLIA PT Acceptance Limits for the full table.</div>` : ""}
      <div style="font-size:11px;color:var(--text-dim);margin-top:10px">MNPT and ISI are specific to your instrument/reagent lot combination (from the reagent package insert or your own local normal-donor verification) — don't reuse values across different lots or analyzers.</div>
    </div>
  `;
  el("inrBack").onclick = () => navigateTo("epHome");
  // IMPORTANT: on every keystroke we only patch the small INR output box in place — we never
  // re-render (destroy/recreate) the <input> elements themselves while the user is actively
  // typing into them. Rebuilding an input's DOM node mid-keystroke (as the old code did, via a
  // full innerHTML re-render + manual refocus/setSelectionRange) can race with a phone's software
  // keyboard/IME composition state and is what was producing garbled/reordered digits on some
  // devices — this pattern avoids that entirely.
  const updateInrOutput = () => {
    const { valid, inr } = inrCalcCompute(ui);
    const box = el("inrOutputBox"), val = el("inrOutputValue");
    if (!box || !val) return;
    box.style.background = valid ? "#eaf6ec" : "var(--surface-2,#f3f3f3)";
    val.style.color = valid ? "#1f7a3d" : "";
    val.textContent = valid ? inr.toFixed(2) : "—";
  };
  el("inrPt").oninput = (e) => { ui.patientPt = e.target.value; updateInrOutput(); };
  el("inrMnpt").oninput = (e) => { ui.mnpt = e.target.value; updateInrOutput(); };
  el("inrIsi").oninput = (e) => { ui.isi = e.target.value; updateInrOutput(); };
}

/* -------- Project Workspace: header + module grid + unified experiment list -------- */
function renderEPProjectView() {
  const project = state.ui.epProject;
  if (!project) { navigateTo("epHome"); return; }
  // Keep the header in sync with the live copy from Firestore (name/branch could've changed).
  const live = state.epProjects.find((p) => p.id === project.id);
  if (live) state.ui.epProject = live;
  const p = state.ui.epProject;
  const isMaster = state.role === "master";
  const openKey = state.ui.epOpenSubmenu || null;
  const experiments = experimentsForProject(p.id);
  const editingHeader = !!state.ui.epProjectEditing;

  const headerFieldsHtml = editingHeader ? `<div class="card-form" style="margin-bottom:20px">
      <div class="form-row">
        ${fieldHtml("Project Name *", `<input id="epHName" value="${esc(p.name)}" />`)}
        ${fieldHtml("Analyte / Test", `<input id="epHAnalyte" value="${esc(p.analyte)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Instrument", `<input id="epHInstrument" value="${esc(p.instrument)}" />`)}
        ${fieldHtml("Units", `<input id="epHUnits" list="labUnitsList" value="${esc(p.units)}" style="width:100px" />${labUnitsDatalistHtml()}`)}
        ${fieldHtml("Status", `<select id="epHStatus"><option value="Open" ${p.status !== "Closed" ? "selected" : ""}>Open</option><option value="Closed" ${p.status === "Closed" ? "selected" : ""}>Closed</option></select>`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Performed By", `<input id="epHPerformedBy" value="${esc(p.performedBy)}" />`)}
        ${fieldHtml("Reviewed By", `<input id="epHReviewedBy" value="${esc(p.reviewedBy)}" />`)}
      </div>
      <div class="form-row"><div class="field" style="flex:1"><span class="field-label">Notes</span><input id="epHNotes" value="${esc(p.notes)}" /></div></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn secondary" id="epHCancel">Cancel</button><button type="button" class="btn primary" id="epHSave">Save project info</button></div>
    </div>` : `<div class="panel-card" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="font-size:13px;line-height:1.9">
          <div><b>Analyte:</b> ${esc(p.analyte || "—")} &nbsp;·&nbsp; <b>Instrument:</b> ${esc(p.instrument || "—")} &nbsp;·&nbsp; <b>Units:</b> ${esc(p.units || "—")}</div>
          <div><b>Branch:</b> ${esc(branchName(p.branchId))} &nbsp;·&nbsp; <b>Status:</b> ${esc(p.status || "Open")} &nbsp;·&nbsp; <b>Performed By:</b> ${esc(p.performedBy || "—")} &nbsp;·&nbsp; <b>Reviewed By:</b> ${esc(p.reviewedBy || "—")}</div>
          ${p.notes ? `<div><b>Notes:</b> ${esc(p.notes)}</div>` : ""}
        </div>
        <button type="button" class="icon-btn-sm" id="epHEdit" title="Edit project info"><i class="fa-solid fa-pen"></i></button>
      </div>
    </div>`;

  el("mainContent").innerHTML = `
    <div class="page-header"><div>
        <button type="button" class="link-btn" id="epBackToProjects" style="margin-bottom:6px"><i class="fa-solid fa-arrow-left"></i> All Projects</button>
        <h2><i class="fa-solid fa-folder-open"></i> ${esc(p.name || "(unnamed project)")}</h2>
        <span class="subtitle">${experiments.length} experiment${experiments.length === 1 ? "" : "s"} in this project</span>
      </div>
      <button type="button" class="btn secondary" id="epDeleteProject"><i class="fa-solid fa-trash"></i> Delete project</button></div>
    ${headerFieldsHtml}
    <h3 style="margin:20px 0 12px;font-size:15px">Add an experiment</h3>
    <div class="ep-launcher">
      ${EP_MODULES.map((m) => `
        <div class="ep-module ${m.disabled ? "disabled" : ""}">
          <button type="button" class="ep-module-btn" data-ep-key="${m.key}" ${m.disabled ? "disabled" : ""}>
            <i class="fa-solid ${m.icon}"></i><span>${esc(m.label)}</span>
            ${m.submenu ? `<i class="fa-solid fa-chevron-down ep-chevron ${openKey === m.key ? "open" : ""}"></i>` : m.disabled ? `<span class="ep-soon">Coming soon</span>` : ""}
          </button>
          ${m.submenu && openKey === m.key ? `<div class="ep-submenu">${m.submenu.map((s) => `<button type="button" class="ep-submenu-btn" data-ep-view="${s.view}" ${s.presetAnalyte ? `data-preset-analyte="${esc(s.presetAnalyte)}"` : ""} ${s.presetUnits ? `data-preset-units="${esc(s.presetUnits)}"` : ""} ${s.presetTea ? `data-preset-tea="${esc(s.presetTea)}"` : ""}>${esc(s.label)}</button>`).join("")}</div>` : ""}
        </div>`).join("")}
    </div>
    <h3 style="margin:26px 0 12px;font-size:15px">Saved experiments in this project</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Type</th><th>Date</th><th>Analyte</th><th>By</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${experiments.length === 0 ? `<tr><td colspan="6" class="table-empty">No experiments added yet — pick a module above to add the first one</td></tr>` : experiments.map((r) => `
        <tr><td><i class="fa-solid ${r.__type.icon}"></i> ${esc(r.__type.label)}</td><td class="mono">${esc(r.expDate || r.createdAt ? (r.expDate || r.createdAt.slice(0, 10)) : "—")}</td>
          <td>${esc(r.analyte || "—")}</td><td class="mono">${esc(r.analyst || r.createdBy || "")}</td>
          <td><button type="button" class="icon-btn-sm" data-open-exp="${r.__type.key}|${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-edit-exp="${r.__type.key}|${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button type="button" class="icon-btn-sm" data-del-exp="${r.__type.key}|${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}
      </tbody></table></div>`;

  el("epBackToProjects").onclick = () => { state.ui.epProject = null; navigateTo("epHome"); };
  el("epDeleteProject").onclick = async () => {
    if (!confirm(`Delete project "${p.name}"?`)) return;
    const ok = await deleteEPProject(p.id);
    if (ok) { state.ui.epProject = null; navigateTo("epHome"); }
  };
  const editBtn = el("epHEdit"); if (editBtn) editBtn.onclick = () => { state.ui.epProjectEditing = true; renderEPProjectView(); };
  const cancelBtn = el("epHCancel"); if (cancelBtn) cancelBtn.onclick = () => { state.ui.epProjectEditing = false; renderEPProjectView(); };
  const saveBtn = el("epHSave"); if (saveBtn) saveBtn.onclick = async () => {
    const updated = {
      id: p.id, name: el("epHName").value.trim() || p.name, analyte: el("epHAnalyte").value, instrument: el("epHInstrument").value,
      units: el("epHUnits").value, status: el("epHStatus").value, performedBy: el("epHPerformedBy").value, reviewedBy: el("epHReviewedBy").value,
      notes: el("epHNotes").value, branchId: p.branchId,
    };
    await saveEPProject(updated);
    state.ui.epProject = { ...p, ...updated };
    state.ui.epProjectEditing = false;
    renderEPProjectView();
  };

  el("mainContent").querySelectorAll("[data-ep-key]").forEach((btn) => btn.onclick = () => {
    const mod = EP_MODULES.find((m) => m.key === btn.dataset.epKey);
    if (!mod || mod.disabled) return;
    if (mod.submenu) { state.ui.epOpenSubmenu = state.ui.epOpenSubmenu === mod.key ? null : mod.key; renderEPProjectView(); return; }
    const t = EP_RUN_TYPES.find((x) => x.view === mod.view);
    if (t) state.ui[t.uiKey] = null; // start a fresh, project-prefilled entry instead of reusing a stale in-progress one
    navigateTo(mod.view);
  });
  el("mainContent").querySelectorAll("[data-ep-view]").forEach((btn) => btn.onclick = () => {
    const t = EP_RUN_TYPES.find((x) => x.view === btn.dataset.epView);
    if (t) state.ui[t.uiKey] = null;
    applyEpPreset(btn.dataset.epView, btn.dataset);
    navigateTo(btn.dataset.epView);
  });
  el("mainContent").querySelectorAll("[data-open-exp]").forEach((btn) => btn.onclick = async () => {
    const [typeKey, id] = btn.dataset.openExp.split("|");
    const t = EP_RUN_TYPES.find((x) => x.key === typeKey);
    const run = state[typeKey].find((r) => r.id === id);
    if (!t || !run) return;
    btn.disabled = true;
    try { const pdf = await t.pdfFn()(run); pdf.save(t.pdfName()(run)); }
    catch (err) { console.error("PDF failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });
  el("mainContent").querySelectorAll("[data-edit-exp]").forEach((btn) => btn.onclick = () => {
    const [typeKey, id] = btn.dataset.editExp.split("|");
    const t = EP_RUN_TYPES.find((x) => x.key === typeKey);
    const run = state[typeKey].find((r) => r.id === id);
    if (!t || !run) return;
    state.ui[t.uiKey] = JSON.parse(JSON.stringify(run));
    navigateTo(t.view);
  });
  el("mainContent").querySelectorAll("[data-del-exp]").forEach((btn) => btn.onclick = async () => {
    const [typeKey, id] = btn.dataset.delExp.split("|");
    const t = EP_RUN_TYPES.find((x) => x.key === typeKey);
    if (!t) return;
    if (!confirm(`Delete this saved ${t.label} experiment? This cannot be undone.`)) return;
    btn.disabled = true;
    try { await t.deleteFn()(id); renderEPProjectView(); }
    catch (err) { console.error("Delete failed:", err); toast("Failed to delete: " + (err && err.message ? err.message : err), "error"); btn.disabled = false; }
  });
}

/* ---------------------------------------------------------------------
   Precision verification (QR Evaluator — "Simple Precision" report)
--------------------------------------------------------------------- */
const PRECISION_RESULT_BLANK = () => ({ value: "", excluded: false });
const PRECISION_SPEC_DEFAULT = () => ({ teaMode: "percent", teaValue: "", randomErrorBudgetPct: "50", allowableREMode: "percent", allowableREValue: "" });

async function savePrecisionRun(data) { return saveEpRunGuarded("precisionRuns", data, "analyte"); }
async function deletePrecisionRun(id) {
  const pr = state.precisionRuns.find((x) => x.id === id);
  if (!canDeleteLockedEpRun(pr)) { toast("This report was already accepted and is locked — only the master account can delete it. Save an Amendment instead.", "warn"); return; }
  await db.collection("precisionRuns").doc(id).delete();
  logAudit("delete_precision_run", pr ? (pr.analyte || id) : id, pr ? `run ${pr.expDate || ""}` : "");
}

function precisionSpecForStats(run) {
  return {
    teaMode: run.teaMode, teaValue: run.teaValue, randomErrorBudgetPct: run.randomErrorBudgetPct,
    allowableRE: run.allowableREValue !== "" && run.allowableREValue != null ? { mode: run.allowableREMode, value: run.allowableREValue } : null,
  };
}
function precisionResultValues(run) { return (run.results || []).filter((r) => !r.excluded && r.value !== "" && r.value != null).map((r) => Number(r.value)); }
function precisionRunStats(run) { return precisionStats(precisionResultValues(run), precisionSpecForStats(run)); }

function fmtN(v, d) { return v === null || v === undefined || isNaN(v) ? "--" : Number(v).toFixed(d); }
/** Formats an allowable-error value the same dual-slot way QR Evaluator always prints it — e.g.
 *  "-- (conc) or 30.0%" when set as a percent, or "5.0 (conc) or --%" when set as a fixed
 *  concentration — since the report always shows both slots, with whichever one isn't set as "--". */
function teaLabel(value, mode, decimals) {
  if (value === "" || value == null || isNaN(Number(value))) return "--";
  const v = fmtN(Number(value), decimals == null ? 1 : decimals);
  return mode === "conc" ? `${v} (conc) or --%` : `-- (conc) or ${v}%`;
}
/** Lets someone paste a block copied straight from Excel into a results table instead of typing
 *  each value — splits the clipboard text into rows (newlines) and columns (tabs) and fills them
 *  into `arr` (an array of row-objects) starting at the cell that was pasted into, growing the
 *  array with `makeBlank()` as needed. `fields` lists the row-object keys in the same left-to-right
 *  order as the visible table columns, so pasting into any column starts at the right offset. A
 *  normal single-value paste (no newline/tab in the clipboard) is left alone. */
function attachExcelPasteObjects(containerEl, inputSelector, arr, fields, makeBlank, rerender) {
  containerEl.querySelectorAll(inputSelector).forEach((input) => {
    input.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (!text || !/[\n\t]/.test(text)) return;
      e.preventDefault();
      const startRow = Number(input.dataset.i);
      const startCol = Math.max(0, fields.indexOf(input.dataset.f));
      const rows = text.replace(/\r/g, "").split("\n");
      if (rows.length && rows[rows.length - 1] === "") rows.pop(); // trailing blank line from the copy
      rows.forEach((rowText, rOffset) => {
        const cols = rowText.split("\t");
        const rowIdx = startRow + rOffset;
        while (arr.length <= rowIdx) arr.push(makeBlank());
        cols.forEach((val, cOffset) => {
          const fieldName = fields[startCol + cOffset];
          if (fieldName) arr[rowIdx][fieldName] = val.trim();
        });
      });
      rerender();
    });
  });
}
/** Same idea as attachExcelPasteObjects, for a table backed by a flat array of plain values
 *  (e.g. Reference Interval's single Result column) rather than an array of row-objects. */
function attachExcelPasteFlat(containerEl, inputSelector, arr, getIndex, rerender) {
  containerEl.querySelectorAll(inputSelector).forEach((input) => {
    input.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (!text || !/[\n\t]/.test(text)) return;
      e.preventDefault();
      const startRow = getIndex(input);
      const vals = text.replace(/\r/g, "").split(/[\n\t]/).map((v) => v.trim());
      if (vals.length && vals[vals.length - 1] === "") vals.pop();
      vals.forEach((v, i) => { const idx = startRow + i; while (arr.length <= idx) arr.push(""); arr[idx] = v; });
      rerender();
    });
  });
}
function fmtRange(r, d) { return r ? `${fmtN(r.low, d)} to ${fmtN(r.high, d)}` : "--"; }

/* ---------------------------------------------------------------------
   Shared QR Evaluator-style PDF report layout
   Every "QR Evaluator" report (Precision, Comparison, Linearity,
   Reference Interval) is built the same way as the real program: a
   repeating header/title block, an ordered list of self-contained
   "sections" that are never split mid-block, and a footer with a page
   number — laid out across as many real A4 pages as the content needs
   instead of being shrunk to fit a single sheet. This is what keeps
   the report's font sizes matching the printed original regardless of
   how much data is in it (a 5-level run fits on one page; a 20-row
   result table spills onto a "Page 2", same as the attached samples).
--------------------------------------------------------------------- */
const REPORT_FONT = "font-family:Arial,Helvetica,sans-serif";

/** The logo + analyte identification block repeated at the top of every page of a report,
 *  matching "QR Evaluator® / <BRANCH> BRANCH -- DELTA MEDICAL LABORATORIES" on the left and the analyte/instrument/sample on
 *  the right in the attached PDF. `extraRight` adds report-specific lines (Sample Name, X/Y Method…). */
/** Wires bidirectional click-to-highlight between a live-entry chart's points (SVG elements
 *  carrying data-pt="<rowIndex>") and their matching data-entry table rows (tr[data-row="<rowIndex>"]),
 *  scoped to whatever container is passed in (normally the whole page, since only one experiment's
 *  chart + table are on screen at a time). Clicking a point highlights its row and vice versa, so a
 *  stray dot on the chart is one click away from the row that produced it. Pure DOM state — no
 *  re-render — so it never disturbs focus in an input the person is mid-edit on. */
function wireChartRowHighlight(container) {
  if (!container) return;
  const points = [...container.querySelectorAll("[data-pt]")];
  const rows = [...container.querySelectorAll("tr[data-row]")];
  if (!points.length || !rows.length) return;
  function clearAll() {
    points.forEach((p) => { p.setAttribute("fill", p.dataset.fill); p.setAttribute("r", p.dataset.r); });
    rows.forEach((r) => r.classList.remove("row-highlight"));
  }
  function highlight(idxStr) {
    const already = rows.some((r) => r.dataset.row === idxStr && r.classList.contains("row-highlight"));
    clearAll();
    if (already) return; // clicking the same point/row again just clears the highlight
    points.filter((p) => p.dataset.pt === idxStr).forEach((p) => {
      p.setAttribute("fill", "#e08a00");
      p.setAttribute("r", String(Number(p.dataset.r) + 2.5));
    });
    const row = rows.find((r) => r.dataset.row === idxStr);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (row) row.classList.add("row-highlight");
  }
  points.forEach((p) => { p.onclick = () => highlight(p.dataset.pt); });
  rows.forEach((r) => { r.onclick = (e) => { if (e.target.closest("button")) return; highlight(r.dataset.row); }; });
}

function reportBrandLine(run) {
  const branch = branchName(run.branchId);
  return run.labDept || (branch && branch !== "—" ? `${branch.toUpperCase()} BRANCH -- DELTA MEDICAL LABORATORIES` : "DELTA MEDICAL LABORATORIES");
}
/** Formats "now" the same way the real QR Evaluator footer prints it — "02 Jun 2022 16:47:00"
 *  (day, short month, year, then hh:mm:ss) — instead of the app's usual ISO timestamp. */
function reportTimestamp() {
  const d = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function reportPrintedLine(run) {
  const branch = branchName(run.branchId);
  return `${branch && branch !== "—" ? branch + " -" : ""}Delta Laboratory Printed: ${reportTimestamp()}`;
}
function reportHeaderHtml(run, titleText, extraRightLines, belowBrandHtml, titleStyle) {
  // titleStyle: "centered" (default — Simple Precision / Two Instrument Comparison, centered +
  // underlined) or "left" (Linearity's report title, which the real QR Evaluator prints
  // left-aligned, bold, and NOT underlined, directly under the brand line).
  const titleHtml = titleStyle === "left"
    ? `<div style="text-align:left;font-size:21px;font-weight:700;margin:12px 0 15.5px">${titleText}</div>`
    : titleStyle === "centered-plain"
    ? `<div style="text-align:center;font-size:23px;font-weight:700;margin:15.5px 0 18.5px">${titleText}</div>`
    : `<div style="text-align:center;font-size:23px;font-weight:700;text-decoration:underline;margin:15.5px 0 18.5px">${titleText}</div>`;
  return `
    <table style="width:100%;border-collapse:collapse;margin-bottom:3px"><tr>
      <td style="vertical-align:top"><div style="font-size:28.5px;font-weight:800;letter-spacing:-0.2px;${REPORT_FONT}">QR Evaluator</div>
        <div style="font-size:15.5px;color:#555;border-top:1px solid #333;padding-top:2.5px;margin-top:3px;display:inline-block">${esc(reportBrandLine(run))}</div></td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:32px;font-weight:800">${esc(run.analyte || "")}</div>
        ${(extraRightLines || []).map((l) => `<div style="font-size:18.5px">${l}</div>`).join("")}
      </td>
    </tr></table>
    ${belowBrandHtml || ""}
    ${titleHtml}`;
}

/** 3-level signature block (Prepared by / Analyst → Reviewed by → Accepted by / Lab Director),
 *  matching the CAP/ISO 15189 expectation that a study go through review before final sign-off —
 *  not just the single "Accepted by" line the original attached PDF had. */
function reportSignatureHtml(run) {
  return `<table style="width:100%;border-collapse:collapse;margin-top:31px"><tr>
      <td style="width:34%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.analyst || "")}</div>
        <div style="font-size:13.5px;color:#555;margin-top:3px">Prepared by / Analyst${run.expDate ? " · " + esc(run.expDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.reviewedBy || "")}</div>
        <div style="font-size:13.5px;color:#555;margin-top:3px">Reviewed by${run.reviewedDate ? " · " + esc(run.reviewedDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.acceptedBy || "")}</div>
        <div style="font-size:13.5px;color:#555;margin-top:3px">Accepted by / Lab Director${run.acceptedDate ? " · " + esc(run.acceptedDate) : ""}</div></td>
    </tr></table>`;
}

/** Lays out an ordered list of self-contained HTML "section" strings into one or more real A4
 *  pages: `headerHtml` repeats at the top of every page (logo + title, same as QR Evaluator
 *  itself repeating its header on continuation pages), each section is measured and rendered at
 *  its natural size — never shrunk — and never split across a page break, and `footerLabel`
 *  builds the "<version> ... Printed: ... Page N" footer with the page number filled in. Sections
 *  are packed greedily: as many as fit land on page 1, the rest spill onto further pages, which is
 *  what makes a short run fit on one page and a longer one span two or three, same as the sample. */
async function renderPaginatedPdf(headerHtml, sections, footerLabel) {
  const CONTENT_W = 900, PAD_X = 32, PAD_TOP = 28, PAD_BOTTOM = 28;
  const INNER_W = CONTENT_W - PAD_X * 2;
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
  const marginMM = 10;
  const contentWmm = pageW - marginMM * 2;
  const pxPerMm = CONTENT_W / contentWmm;
  const maxContentHeightPx = (pageH - marginMM * 2) * pxPerMm;

  // Sections may be a plain HTML string, or { html, breakBefore: true } to force a fresh page
  // before that section even if it would still technically fit — used sparingly, only where a
  // real QR Evaluator sample confirms that block always starts its own page regardless of size.
  const normSections = sections.map((s) => (typeof s === "string" ? { html: s, breakBefore: false } : s));

  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;left:-9999px;top:0;width:${INNER_W}px;background:#fff;${REPORT_FONT};color:#111`;
  document.body.appendChild(probe);
  probe.innerHTML = headerHtml;
  const headerH = probe.offsetHeight;
  probe.innerHTML = footerHtmlFor(footerLabel, 1);
  const footerH = probe.offsetHeight;
  // Measure sections cumulatively (appending each on top of the previous, header included as the
  // starting point) rather than in isolation. Isolated measurement double-counts collapsing
  // margins between adjacent blocks (e.g. a table's own bottom margin plus the next block's
  // top margin, which the browser actually collapses into one gap when they sit next to each
  // other on the real page) and so overstates how tall the content really is — which was causing
  // an early, unnecessary page break even when the page still had visible room left.
  probe.innerHTML = headerHtml;
  let prevHeight = probe.offsetHeight;
  const sectionHeights = normSections.map((s) => {
    const temp = document.createElement("div");
    temp.innerHTML = s.html;
    const frag = document.createDocumentFragment();
    while (temp.firstChild) frag.appendChild(temp.firstChild);
    probe.appendChild(frag);
    const newHeight = probe.offsetHeight;
    const h = newHeight - prevHeight;
    prevHeight = newHeight;
    return h;
  });
  document.body.removeChild(probe);

  const pageBudget = maxContentHeightPx - PAD_TOP - PAD_BOTTOM - headerH - footerH - 16;
  const pages = [];
  let current = [], used = 0;
  normSections.forEach((s, i) => {
    const h = sectionHeights[i];
    if (current.length && (s.breakBefore || used + h > pageBudget)) { pages.push(current); current = []; used = 0; }
    current.push(s.html);
    used += h;
  });
  pages.push(current);

  for (let p = 0; p < pages.length; p++) {
    const wrap = document.createElement("div");
    wrap.style.cssText = `position:fixed;left:-9999px;top:0;width:${CONTENT_W}px;background:#fff;padding:${PAD_TOP}px ${PAD_X}px ${PAD_BOTTOM}px;box-sizing:border-box;${REPORT_FONT};color:#111`;
    wrap.innerHTML = headerHtml + pages[p].join("") + footerHtmlFor(footerLabel, p + 1);
    document.body.appendChild(wrap);
    try {
      const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
      if (p > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", marginMM, marginMM, contentWmm, contentWmm * (canvas.height / canvas.width));
    } finally {
      document.body.removeChild(wrap);
    }
  }
  return pdf;
}
function footerHtmlFor(label, pageNum) {
  return `<div style="margin-top:34px;border-top:1px solid #ccc;padding-top:7px;font-size:15.5px;color:#666">
    <div style="display:flex;justify-content:space-between;gap:10px"><span>QR Evaluator&nbsp;&nbsp;${esc(label.version || "1.0")}</span><span>Copyright &copy; 2026 QR Lab</span></div>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:3px"><span>${esc(label.left || "")}</span><span>Page ${pageNum}</span></div>
  </div>`;
}

/** SVG recreation of the report's small "SD" chart: a solid red goal line (with units, matching
 *  "Goal: 16.651 U/L"), and a green box-and-whisker showing the observed SD with its 95% CI. */
function buildSDChartSVG(stats, units) {
  const goal = stats.goal, sd = stats.sd, ci = stats.ciSD;
  const top = Math.max(goal || 0, ci ? ci.high : 0, sd || 0, 1) * 1.15;
  const y = (v) => 178 - (v / top) * 160;
  const step = top > 40 ? Math.ceil(top / 4 / 5) * 5 : top > 8 ? Math.ceil(top / 4) : 1;
  let ticks = "";
  for (let t = 0; t <= top; t += step) ticks += `<line x1="34" y1="${y(t)}" x2="40" y2="${y(t)}" stroke="#1a1a1a" stroke-width="1.3" /><text x="30" y="${y(t) + 4}" font-size="13" text-anchor="end" fill="#1a1a1a">${t}</text>`;
  const goalHtml = goal !== null ? `<line x1="40" y1="${y(goal)}" x2="230" y2="${y(goal)}" stroke="#c0392b" stroke-width="1.6" /><text x="228" y="${y(goal) - 5}" font-size="13" text-anchor="end" fill="#c0392b">Goal: ${fmtN(goal, 3)}${units ? " " + esc(units) : ""}</text>` : "";
  let boxHtml = "";
  if (sd !== null) {
    const bx = 125, bw = 36;
    const boxLow = ci ? y(ci.low) : y(sd), boxHigh = ci ? y(ci.high) : y(sd);
    boxHtml = `
      <line x1="${bx}" y1="${boxHigh}" x2="${bx}" y2="${boxLow}" stroke="#1b5e20" stroke-width="1.5" />
      <line x1="${bx - 10}" y1="${boxHigh}" x2="${bx + 10}" y2="${boxHigh}" stroke="#1b5e20" stroke-width="1.5" />
      <line x1="${bx - 10}" y1="${boxLow}" x2="${bx + 10}" y2="${boxLow}" stroke="#1b5e20" stroke-width="1.5" />
      <rect x="${bx - bw / 2}" y="${y(sd) - 5}" width="${bw}" height="10" fill="#8bc34a" stroke="#2e7d32" stroke-width="1.2" />`;
  }
  return `<svg viewBox="0 0 260 200" width="299" height="230" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="40" y1="18" x2="40" y2="178" stroke="#1a1a1a" stroke-width="1.3" />
    <line x1="40" y1="178" x2="230" y2="178" stroke="#1a1a1a" stroke-width="1.3" />
    <text x="14" y="98" font-size="14" fill="#1a1a1a" transform="rotate(-90 14 98)" text-anchor="middle">SD</text>
    ${ticks}${goalHtml}${boxHtml}
  </svg>`;
}

/** SVG recreation of the report's "Precision Plot": each replicate's SD Index (z-score against
 *  the run's own mean/SD) plotted against its specimen order — the same view QR Evaluator uses
 *  to spot drift or outliers across a precision run. */
function buildPrecisionPlotSVG(run, stats) {
  const included = (run.results || []).map((r, i) => ({ i: i + 1, v: Number(r.value), excluded: r.excluded || r.value === "" || r.value == null || isNaN(Number(r.value)) }));
  const n = included.length || 1;
  const zVals = included.map((r) => r.excluded || stats.sd === null || stats.sd === 0 ? null : (r.v - stats.mean) / stats.sd);
  const maxAbs = Math.max(3, ...zVals.filter((v) => v !== null).map((v) => Math.abs(v)));
  const xw = 230, x0 = 40, y0 = 20, yh = 160;
  const xAt = (idx) => x0 + (xw - x0) * (idx / (n + 1));
  const yAt = (z) => y0 + yh / 2 - (z / maxAbs) * (yh / 2);
  let ticksY = "";
  for (let t = -3; t <= 3; t++) ticksY += `<line x1="34" y1="${yAt(t * (maxAbs / 3))}" x2="40" y2="${yAt(t * (maxAbs / 3))}" stroke="#1a1a1a" stroke-width="1.3" /><text x="30" y="${yAt(t * (maxAbs / 3)) + 4}" font-size="13" text-anchor="end" fill="#1a1a1a">${t}</text>`;
  let ticksX = "";
  for (let t = 0; t <= n + 1; t += Math.max(1, Math.ceil((n + 1) / 5))) ticksX += `<text x="${xAt(t)}" y="${y0 + yh + 16}" font-size="13" text-anchor="middle" fill="#1a1a1a">${t}</text>`;
  const points = included.map((r, k) => zVals[k] === null ? "" : `<circle data-pt="${k}" data-fill="#1a3d8f" data-r="3" cx="${xAt(r.i)}" cy="${yAt(zVals[k])}" r="3" fill="#1a3d8f" />`).join("");
  return `<svg viewBox="0 0 260 210" width="299" height="241" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.3" />
    <line x1="${x0}" y1="${yAt(0)}" x2="${xw}" y2="${yAt(0)}" stroke="#999" stroke-width="1" />
    <line x1="${x0}" y1="${y0 + yh}" x2="${xw}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.3" />
    <text x="14" y="${y0 + yh / 2}" font-size="14" fill="#1a1a1a" transform="rotate(-90 14 ${y0 + yh / 2})" text-anchor="middle">SD Index</text>
    <text x="${(x0 + xw) / 2}" y="${y0 + yh + 30}" font-size="14" fill="#1a1a1a" text-anchor="middle">Specimen Index</text>
    ${ticksY}${ticksX}${points}
  </svg>`;
}

/** SVG recreation of the report's "Histogram" panel: a normal-curve overlay with bars bucketing
 *  the included replicate values into ~8 bins, plus vertical "Target Mean" (red) and "Obs Mean"
 *  (blue) reference lines and a small legend — matching the attached QR Evaluator PDF. */
function buildPrecisionHistogramSVG(run, stats) {
  const vals = precisionResultValues(run);
  const x0 = 40, y0 = 14, xw = 220, yh = 140;
  if (!vals.length || stats.sd === null) return `<svg viewBox="0 0 260 210" width="299" height="241"></svg>`;
  const targetMean = run.targetMean !== "" && run.targetMean != null ? Number(run.targetMean) : stats.mean;
  const lo = Math.min(...vals, targetMean - stats.sd), hi = Math.max(...vals, targetMean + stats.sd);
  const pad = (hi - lo) * 0.15 || 1;
  const rangeLo = lo - pad, rangeHi = hi + pad;
  const bins = 8;
  const binW = (rangeHi - rangeLo) / bins;
  const counts = new Array(bins).fill(0);
  vals.forEach((v) => { let b = Math.floor((v - rangeLo) / binW); if (b < 0) b = 0; if (b >= bins) b = bins - 1; counts[b]++; });
  const maxPct = Math.max(...counts.map((c) => (c / vals.length) * 100), 5);
  const topPct = Math.ceil(maxPct / 5) * 5;
  const xAt = (v) => x0 + ((v - rangeLo) / (rangeHi - rangeLo)) * xw;
  const yAt = (pct) => y0 + yh - (pct / topPct) * yh;
  const bars = counts.map((c, i) => {
    const pct = (c / vals.length) * 100;
    const bx = xAt(rangeLo + i * binW), bw = xAt(rangeLo + (i + 1) * binW) - bx;
    return `<rect x="${bx + 1}" y="${yAt(pct)}" width="${Math.max(bw - 2, 1)}" height="${yh - (yAt(pct) - y0)}" fill="#3355a8" stroke="#1a1a1a" stroke-width="0.6" />`;
  }).join("");
  let ticksY = "";
  for (let t = 0; t <= topPct; t += topPct / 4) ticksY += `<line x1="34" y1="${yAt(t)}" x2="${x0}" y2="${yAt(t)}" stroke="#1a1a1a" stroke-width="1.1" /><text x="30" y="${yAt(t) + 4}" font-size="12.5" text-anchor="end" fill="#1a1a1a">${Math.round(t)}%</text>`;
  const bellPts = [];
  for (let i = 0; i <= 40; i++) {
    const v = rangeLo + (i / 40) * (rangeHi - rangeLo);
    const z = (v - stats.mean) / stats.sd;
    const density = Math.exp(-0.5 * z * z);
    bellPts.push(`${xAt(v)},${yAt(density * topPct * 0.92)}`);
  }
  const meanLine = (v, color) => `<line x1="${xAt(v)}" y1="${y0 - 4}" x2="${xAt(v)}" y2="${y0 + yh}" stroke="${color}" stroke-width="1.4" />`;
  return `<svg viewBox="0 0 260 210" width="299" height="241" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.3" />
    <line x1="${x0}" y1="${y0 + yh}" x2="${x0 + xw}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.3" />
    ${bars}
    <polyline points="${bellPts.join(" ")}" fill="none" stroke="#1a1a1a" stroke-width="1.3" />
    ${meanLine(targetMean, "#c0392b")}${meanLine(stats.mean, "#1a3d8f")}
    <text x="${(x0 + xw) / 2}" y="${y0 + yh + 18}" font-size="14" fill="#1a1a1a" text-anchor="middle">${esc(run.units || "")}</text>
    ${ticksY}
    <rect x="${x0}" y="${y0 + yh + 26}" width="8" height="8" fill="#c0392b" /><text x="${x0 + 12}" y="${y0 + yh + 33}" font-size="12.5" fill="#1a1a1a">Target Mean</text>
    <rect x="${x0 + 95}" y="${y0 + yh + 26}" width="8" height="8" fill="#1a3d8f" /><text x="${x0 + 107}" y="${y0 + yh + 33}" font-size="12.5" fill="#1a1a1a">Obs Mean</text>
  </svg>`;
}

/** Renders the "Simple Precision" report — header, SD chart, statistics table, precision plot,
 *  histogram, user specifications, supporting data, the results table and a signature line — as an
 *  off-screen element rasterized with html2canvas, laid out to match the attached QR Evaluator PDF. */
async function renderPrecisionPdf(run) {
  const stats = precisionRunStats(run);
  const cell = "padding:8px 12.5px;font-size:18.5px";
  const specTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333">Precision Verification Goal</td><td style="${cell};padding-right:0;text-align:right">TEa</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Allowable Total Error</td><td style="${cell};padding-right:0;text-align:right">${teaLabel(run.teaValue, run.teaMode)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Random Error Budget</td><td style="${cell};padding-right:0;text-align:right">${run.randomErrorBudgetPct !== "" ? esc(run.randomErrorBudgetPct) + "%" : "--"}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Allowable Random Error</td><td style="${cell};padding-right:0;text-align:right">${
      run.allowableREValue !== "" && run.allowableREValue != null
        ? teaLabel(run.allowableREValue, run.allowableREMode)
        : (run.teaValue !== "" && run.randomErrorBudgetPct !== "" ? teaLabel(Number(run.teaValue) * (Number(run.randomErrorBudgetPct) / 100), run.teaMode) : "--")
    }</td></tr>
  </table>`;
  const supportTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333">Analyst</td><td style="${cell};padding-right:0;text-align:right">${esc(run.analyst || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Expt Date</td><td style="${cell};padding-right:0;text-align:right">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Units</td><td style="${cell};padding-right:0;text-align:right">${esc(run.units || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Target Mean</td><td style="${cell};padding-right:0;text-align:right">${esc(run.targetMean || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Target CV</td><td style="${cell};padding-right:0;text-align:right">${esc(run.targetCV || "--")}</td></tr>
    ${run.controlLot ? `<tr><td style="${cell};padding-left:0;color:#333">Control Lot</td><td style="${cell};padding-right:0;text-align:right">${esc(run.controlLot)}</td></tr>` : ""}
    ${run.reagLot ? `<tr><td style="${cell};padding-left:0;color:#333">Reag Lot</td><td style="${cell};padding-right:0;text-align:right">${esc(run.reagLot)}</td></tr>` : ""}
    <tr><td style="${cell};padding-left:0;color:#333">Comment</td><td style="${cell};padding-right:0;text-align:right">${esc(run.comment || "--")}</td></tr>
  </table>`;
  const statsTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333">Obs Standard Dev (SD)</td><td style="${cell};padding-right:0;text-align:right">${fmtN(stats.sd, 3)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Pass/Fail/Uncertain</td><td style="${cell};padding-right:0;text-align:right">${esc(stats.passFail || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">95% Confidence for Obs SD</td><td style="${cell};padding-right:0;text-align:right">${fmtRange(stats.ciSD, 3)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Obs Coef of Variation (CV)</td><td style="${cell};padding-right:0;text-align:right">${fmtN(stats.cv, 1)}%</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Obs Mean</td><td style="${cell};padding-right:0;text-align:right">${fmtN(stats.mean, 3)} ${esc(run.units || "")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Number of Specimens (N)</td><td style="${cell};padding-right:0;text-align:right">${precisionResultValues(run).length} of ${(run.results || []).length}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">95% CI for Obs Mean</td><td style="${cell};padding-right:0;text-align:right">${fmtRange(stats.ciMean, 3)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Obs 2 SD Range</td><td style="${cell};padding-right:0;text-align:right">${fmtRange(stats.sd2Range, 3)}</td></tr>
  </table>`;
  const results = run.results || [];
  const cols = 4, perCol = Math.ceil(results.length / cols) || 1;
  let dataTableCols = "";
  for (let c = 0; c < cols; c++) {
    const slice = results.slice(c * perCol, c * perCol + perCol);
    if (!slice.length) { dataTableCols += `<td style="vertical-align:top"></td>`; continue; }
    dataTableCols += `<td style="vertical-align:top;padding-right:18.5px"><table style="border-collapse:collapse;font-size:18.5px;width:100%">
      <tr style="font-weight:700"><td style="padding:4.5px 15.5px 4.5px 0">Index</td><td style="padding:4.5px 0">Results</td></tr>
      ${slice.map((r, k) => `<tr><td style="padding:4.5px 15.5px 4.5px 0">${c * perCol + k + 1}</td><td style="padding:4.5px 0">${esc(r.value || "")}${r.excluded ? " (X)" : ""}</td></tr>`).join("")}
    </table></td>`;
  }
  const branch = branchName(run.branchId);
  const headerHtml = reportHeaderHtml(run, "Simple Precision", [
    `<strong>Instrument</strong> ${esc(run.instrument || "")}`,
    `<strong>Sample Name</strong> ${esc(run.sampleName || "")}`,
  ]);
  const sections = [
    `<table style="width:100%;border-collapse:collapse;border:1px solid #999"><tr>
      <td style="width:36%;text-align:center;padding:22px;border-right:1px solid #ccc"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Precision Statistics</div>${buildSDChartSVG(stats, run.units)}</td>
      <td style="padding:22px">${statsTable}</td>
    </tr></table>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:28px"><tr>
      <td style="width:50%;vertical-align:top;text-align:center"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Precision Plot</div>${buildPrecisionPlotSVG(run, stats)}</td>
      <td style="width:50%;vertical-align:top;text-align:center"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Histogram</div>${buildPrecisionHistogramSVG(run, stats)}</td>
    </tr></table>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:28px"><tr>
      <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Supporting Data</div>${supportTable}</td>
      <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">User's Specifications</div>${specTable}</td>
    </tr></table>`,
    reportSignatureHtml(run),
    `<div style="font-weight:700;font-size:19px;text-align:center;margin:34px 0 15.5px">Precision Data</div>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;padding:12.5px 0"><tr>${dataTableCols}</tr></table>
    <div style="font-size:15.5px;color:#666;margin-top:6.5px">X: excluded from calculations</div>`,
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run) });
}
function precisionPdfFilename(run) {
  return `precision_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderPrecisionView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: (state.ui.precisionPreset && state.ui.precisionPreset.analyte) || "", instrument: "", sampleName: "", labDept: "DELTA MEDICAL LABORATORIES",
    analyst: state.user.email, expDate: todayStr(), units: (state.ui.precisionPreset && state.ui.precisionPreset.units) || "", targetMean: "", targetCV: "", controlLot: "", reagLot: "", comment: "",
    ...PRECISION_SPEC_DEFAULT(), results: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.precisionRun || emptyRun();
  state.ui.precisionRun = run;
  state.ui.precisionPreset = null;
  const branchFilter = isMaster ? (state.ui.precisionBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !run.branchId || i.branchId === run.branchId).map((i) => i.name))];
  const employeeNames = employeeDisplayNames();
  const stats = precisionRunStats(run);

  const q = (state.ui.precisionSearch || "").trim().toLowerCase();
  const saved = [...state.precisionRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.sampleName, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function resultRowHtml(r, idx) {
    return `<tr data-row="${idx}">
      <td class="mono">${idx + 1}</td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-f="value" data-i="${idx}" value="${esc(r.value)}" style="width:100px" placeholder="Result" /></td>
      <td style="text-align:center"><input type="checkbox" data-f="excluded" data-i="${idx}" ${r.excluded ? "checked" : ""} title="Exclude from calculations" /></td>
      <td><button type="button" class="icon-btn-sm" data-rm-row="${idx}" title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkPr"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Precision (QR Evaluator)</h2><span class="subtitle">Simple Precision — replicate SD/CV verification against your lab's allowable error, same report layout as QR Evaluator</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:24.5px"><select id="prBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="prBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="prAnalyte" value="${esc(run.analyte)}" placeholder="e.g. ALP" />`)}
        ${fieldHtml("Instrument", `<input id="prInstrument" list="prInstruments" value="${esc(run.instrument)}" placeholder="e.g. Beckman DxC 700 Au" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Sample Name", `<input id="prSampleName" value="${esc(run.sampleName)}" placeholder="e.g. Qc sample 1" />`)}
        ${fieldHtml("Units", `<input id="prUnits" list="labUnitsList" value="${esc(run.units)}" placeholder="e.g. U/L" />${labUnitsDatalistHtml()}`)}
        ${fieldHtml("Lab Dept", `<input id="prLabDept" value="${esc(run.labDept)}" />`)}
      </div>
      <datalist id="prInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>

      <div style="display:flex;gap:24px;flex-wrap:wrap;margin:28px 0">
        <div style="flex:1;min-width:280px">
          <h4 style="margin:0 0 6.5px;font-size:19.5px">Results</h4>
          <div style="font-size:17px;color:var(--text-faint);margin-bottom:12.5px">Tip: copy a column of results from Excel and paste it into the first Result box — it fills the whole list down.</div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Index</th><th>Result</th><th>Excl.</th><th></th></tr></thead>
            <tbody>${run.results.map((r, i) => resultRowHtml(r, i)).join("")}</tbody>
          </table></div>
          <button type="button" class="btn secondary" id="prAddRow" style="margin-top:15.5px"><i class="fa-solid fa-plus"></i> Add result</button>
        </div>
        <div style="flex:1;min-width:280px">
          <h4 style="margin:0 0 12.5px;font-size:19.5px">User's Specifications</h4>
          <div class="form-row">
            ${fieldHtml("Allowable Total Error (TEa)", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="prTeaValue" value="${esc(run.teaValue)}" placeholder="e.g. 30" />`)}
            ${fieldHtml("TEa Basis", `<select id="prTeaMode"><option value="percent" ${run.teaMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.teaMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
          </div>
          <div class="form-row">
            ${fieldHtml("Random Error Budget", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="prReBudget" value="${esc(run.randomErrorBudgetPct)}" placeholder="e.g. 50" />`)}
            ${fieldHtml("Allowable Random Error (override, optional)", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="prReValue" value="${esc(run.allowableREValue)}" placeholder="auto = TEa × budget" />`)}
          </div>
          <div class="form-row">
            ${fieldHtml("Allowable RE Basis", `<select id="prReMode"><option value="percent" ${run.allowableREMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.allowableREMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
          </div>
          <h4 style="margin:24.5px 0 12.5px;font-size:19.5px">Supporting Data</h4>
          <div class="form-row">
            ${fieldHtml("Analyst", `<input id="prAnalyst" list="prEmployees" value="${esc(run.analyst)}" />`)}
            ${fieldHtml("Expt Date", `<input type="date" id="prExpDate" value="${esc(run.expDate)}" />`)}
          </div>
          <div class="form-row">
            ${fieldHtml("Target Mean", `<input id="prTargetMean" value="${esc(run.targetMean)}" />`)}
            ${fieldHtml("Target CV", `<input id="prTargetCV" value="${esc(run.targetCV)}" />`)}
          </div>
          <div class="form-row">
            ${fieldHtml("Control Lot", `<input id="prControlLot" value="${esc(run.controlLot)}" placeholder="e.g. Beckman Coulter 1045 exp 01 Oct 2023" />`)}
            ${fieldHtml("Reag Lot", `<input id="prReagLot" value="${esc(run.reagLot)}" placeholder="e.g. Beckman Coulter 2571 exp 07 Jan 2023" />`)}
          </div>
          ${fieldHtml("Comment", `<input id="prComment" value="${esc(run.comment)}" placeholder="e.g. TAE Source 4 AAB" />`)}
          <datalist id="prEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        </div>
      </div>

      <div class="panel-card" style="margin-bottom:28px">
        <div class="panel-title">Precision Statistics (live preview)</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:12.5px">
          <div><span class="field-label">Obs Mean</span><div class="mono">${fmtN(stats.mean, 3)} ${esc(run.units || "")}</div></div>
          <div><span class="field-label">Obs SD</span><div class="mono">${fmtN(stats.sd, 3)}</div></div>
          <div><span class="field-label">Obs CV</span><div class="mono">${fmtN(stats.cv, 1)}%</div></div>
          <div><span class="field-label">95% CI for SD</span><div class="mono">${fmtRange(stats.ciSD, 3)}</div></div>
          <div><span class="field-label">Goal (Allowable RE)</span><div class="mono">${stats.goal !== null ? fmtN(stats.goal, 3) : "--"}</div></div>
          <div><span class="field-label">Pass/Fail/Uncertain</span><div>${stats.passFail ? `<span class="badge" style="background:${stats.passFail === "Yes" ? STATUS_STYLES.ok.bg : stats.passFail === "No" ? STATUS_STYLES.expired.bg : STATUS_STYLES.watch.bg};color:${stats.passFail === "Yes" ? STATUS_STYLES.ok.text : stats.passFail === "No" ? STATUS_STYLES.expired.text : STATUS_STYLES.watch.text}">${esc(stats.passFail)}</span>` : "—"}</div></div>
        </div>
        <div class="live-chart-row">
          <div class="live-chart-box"><div class="live-chart-title">Precision Plot — spot an out-of-range replicate</div>${buildPrecisionPlotSVG(run, stats)}</div>
          <div class="live-chart-box"><div class="live-chart-title">Histogram</div>${buildPrecisionHistogramSVG(run, stats)}</div>
        </div>
      </div>

      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="prReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="prReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="prAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="prAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="prReset">Clear form</button>
        <button type="button" class="btn primary" id="prSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved precision runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="prSearch" value="${esc(state.ui.precisionSearch || "")}" placeholder="Search by analyte, instrument, sample, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Instrument / Sample</th><th>Branch</th><th>N</th><th>Obs SD</th><th>Result</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="9" class="table-empty">${q ? "No runs match your search" : "No saved precision runs yet"}</td></tr>` : saved.map((r) => {
        const s = precisionRunStats(r);
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.instrument || "—")} / ${esc(r.sampleName || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${precisionResultValues(r).length}</td><td class="mono">${fmtN(s.sd, 3)}</td>
          <td>${s.passFail ? `<span class="badge" style="background:${s.passFail === "Yes" ? STATUS_STYLES.ok.bg : s.passFail === "No" ? STATUS_STYLES.expired.bg : STATUS_STYLES.watch.bg};color:${s.passFail === "Yes" ? STATUS_STYLES.ok.text : s.passFail === "No" ? STATUS_STYLES.expired.text : STATUS_STYLES.watch.text}">${esc(s.passFail)}</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-pr="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-pr="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-pr="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("prBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.precisionBranch = e.target.value; renderPrecisionView(); };
  const prBranchEl = el("prBranch"); if (prBranchEl) prBranchEl.onchange = (e) => { run.branchId = e.target.value; renderPrecisionView(); };
  el("prAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("prInstrument").oninput = (e) => run.instrument = e.target.value;
  el("prSampleName").oninput = (e) => run.sampleName = e.target.value;
  el("prUnits").oninput = (e) => run.units = e.target.value;
  el("prLabDept").oninput = (e) => run.labDept = e.target.value;
  el("prTeaValue").oninput = (e) => { run.teaValue = e.target.value; renderPrecisionView(); };
  el("prTeaMode").onchange = (e) => { run.teaMode = e.target.value; renderPrecisionView(); };
  el("prReBudget").oninput = (e) => { run.randomErrorBudgetPct = e.target.value; renderPrecisionView(); };
  el("prReValue").oninput = (e) => { run.allowableREValue = e.target.value; renderPrecisionView(); };
  el("prReMode").onchange = (e) => { run.allowableREMode = e.target.value; renderPrecisionView(); };
  el("prAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("prExpDate").oninput = (e) => run.expDate = e.target.value;
  el("prTargetMean").oninput = (e) => run.targetMean = e.target.value;
  el("prTargetCV").oninput = (e) => run.targetCV = e.target.value;
  el("prControlLot").oninput = (e) => run.controlLot = e.target.value;
  el("prReagLot").oninput = (e) => run.reagLot = e.target.value;
  el("prComment").oninput = (e) => run.comment = e.target.value;
  el("prReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("prReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("prAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("prAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("prAddRow").onclick = () => { run.results.push(PRECISION_RESULT_BLANK()); renderPrecisionView(); };
  el("mainContent").querySelectorAll("[data-rm-row]").forEach((btn) => btn.onclick = () => {
    run.results.splice(Number(btn.dataset.rmRow), 1);
    if (run.results.length === 0) run.results.push(PRECISION_RESULT_BLANK());
    renderPrecisionView();
  });
  el("mainContent").querySelectorAll("input[data-f]").forEach((input) => {
    const i = Number(input.dataset.i), f = input.dataset.f;
    if (input.type === "checkbox") input.onchange = (e) => { run.results[i][f] = e.target.checked; renderPrecisionView(); };
    else { input.oninput = (e) => { run.results[i][f] = e.target.value; }; input.onblur = () => renderPrecisionView(); }
  });
  attachExcelPasteObjects(el("mainContent"), 'input[data-f="value"]', run.results, ["value"], PRECISION_RESULT_BLANK, renderPrecisionView);
  wireChartRowHighlight(el("mainContent"));
  el("prSearch").oninput = (e) => {
    state.ui.precisionSearch = e.target.value;
    renderPrecisionView();
    const refocused = el("prSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("prReset").onclick = () => { state.ui.precisionRun = emptyRun(); renderPrecisionView(); };
  const epBackLinkPrEl = el("epBackLinkPr"); if (epBackLinkPrEl) epBackLinkPrEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-pr]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.precisionRuns.find((r) => r.id === btn.dataset.openPr);
    if (savedRun) { state.ui.precisionRun = JSON.parse(JSON.stringify(savedRun)); renderPrecisionView(); }
  });
  el("mainContent").querySelectorAll("[data-del-pr]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved precision run?")) deletePrecisionRun(btn.dataset.delPr); });
  el("mainContent").querySelectorAll("[data-dl-pr]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.precisionRuns.find((r) => r.id === btn.dataset.dlPr);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderPrecisionPdf(savedRun); pdf.save(precisionPdfFilename(savedRun)); }
    catch (err) { console.error("Precision PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("prSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderPrecisionPdf(run);
      pdf.save(precisionPdfFilename(run));
      const saveResult = await savePrecisionRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.precisionRun = emptyRun();
      renderPrecisionView();
    } catch (err) {
      console.error("Precision save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Accuracy verification (QR Evaluator — Accuracy: Obs Mean vs Target)
--------------------------------------------------------------------- */
const ACCURACY_LEVEL_BLANK = () => ({ level: "", target: "", results: "" });

async function saveAccuracyRun(data) { return saveEpRunGuarded("accuracyRuns", data, "analyte"); }
async function deleteAccuracyRun(id) {
  const ar = state.accuracyRuns.find((x) => x.id === id);
  await db.collection("accuracyRuns").doc(id).delete();
  logAudit("delete_accuracy_run", ar ? (ar.analyte || id) : id, ar ? `run ${ar.expDate || ""}` : "");
}
function accuracySpecForStats(run) { return { teaMode: run.teaMode, teaValue: run.teaValue }; }
function accuracyRunResultStats(run) { return accuracyRunStats(run.levels, accuracySpecForStats(run)); }

/** SVG recreation of an QR Evaluator-style bias chart: one bar per level (its %Bias), with dashed
 *  ± Allowable Total Error band lines so an out-of-band bar is visually obvious, same purpose as
 *  the SD/Goal chart on the Precision report. */
function buildAccuracyBiasChartSVG(levelStats, teaValue) {
  const tea = teaValue !== "" && teaValue != null && !isNaN(Number(teaValue)) ? Number(teaValue) : null;
  const maxAbs = Math.max(5, tea || 0, ...levelStats.map((l) => (l.pctBias === null ? 0 : Math.abs(l.pctBias))));
  const x0 = 44, xw = 250, y0 = 14, yh = 170;
  const yAt = (v) => y0 + yh / 2 - (v / maxAbs) * (yh / 2);
  const n = levelStats.length || 1;
  const barW = Math.min(36, (xw - x0) / n - 14);
  let ticksY = "";
  const step = maxAbs > 20 ? Math.ceil(maxAbs / 4 / 5) * 5 : Math.ceil(maxAbs / 4);
  for (let t = -Math.floor(maxAbs / step) * step; t <= maxAbs; t += step) ticksY += `<line x1="38" y1="${yAt(t)}" x2="${x0}" y2="${yAt(t)}" stroke="#1a1a1a" stroke-width="1.3" /><text x="34" y="${yAt(t) + 4}" font-size="13" text-anchor="end" fill="#1a1a1a">${t}</text>`;
  const teaHtml = tea !== null ? `<line x1="${x0}" y1="${yAt(tea)}" x2="${xw}" y2="${yAt(tea)}" stroke="#c0392b" stroke-width="1.2" stroke-dasharray="5,3" /><line x1="${x0}" y1="${yAt(-tea)}" x2="${xw}" y2="${yAt(-tea)}" stroke="#c0392b" stroke-width="1.2" stroke-dasharray="5,3" /><text x="${xw - 2}" y="${yAt(tea) - 5}" font-size="12.5" text-anchor="end" fill="#c0392b">+TEa ${tea}%</text><text x="${xw - 2}" y="${yAt(-tea) + 13}" font-size="12.5" text-anchor="end" fill="#c0392b">-TEa ${tea}%</text>` : "";
  const bars = levelStats.map((l, i) => {
    if (l.pctBias === null) return "";
    const cx = x0 + (xw - x0) * ((i + 1) / (n + 1));
    const barTop = Math.min(yAt(0), yAt(l.pctBias)), barH = Math.abs(yAt(l.pctBias) - yAt(0));
    const color = l.passed === "Fail" ? "#c0392b" : "#2e7d32";
    return `<rect x="${cx - barW / 2}" y="${barTop}" width="${barW}" height="${Math.max(barH, 1)}" fill="${color}" opacity="0.75" />
      <text x="${cx}" y="${y0 + yh + 14}" font-size="12.5" text-anchor="middle" fill="#1a1a1a">${esc(l.level || i + 1)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 260 200" width="299" height="230" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.3" />
    <line x1="${x0}" y1="${yAt(0)}" x2="${xw}" y2="${yAt(0)}" stroke="#1a1a1a" stroke-width="1.3" />
    ${ticksY}${teaHtml}${bars}
  </svg>`;
}

async function renderAccuracyPdf(run) {
  const stats = accuracyRunResultStats(run);
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-9999px;top:0;width:900px;background:#fff;padding:46.5px 53px;font-family:Arial,Helvetica,sans-serif;color:#111";
  const cell = "padding:6.5px 9px;border:1px solid #999;font-size:17px";
  const levelsRows = stats.levels.map((l, i) => `<tr>
    <td style="${cell}">${esc(run.levels[i].level || `Level ${i + 1}`)}</td>
    <td style="${cell};text-align:center">${l.target === null ? "--" : fmtN(l.target, 3)}</td>
    <td style="${cell};text-align:center">${l.n}</td>
    <td style="${cell};text-align:center">${fmtN(l.mean, 3)}</td>
    <td style="${cell};text-align:center">${fmtN(l.bias, 3)}</td>
    <td style="${cell};text-align:center">${l.pctBias === null ? "--" : fmtN(l.pctBias, 2) + "%"}</td>
    <td style="${cell};text-align:center">${l.pctRecovery === null ? "--" : fmtN(l.pctRecovery, 1) + "%"}</td>
    <td style="${cell};text-align:center">${l.allowable === null ? "--" : fmtN(l.allowable, 2) + (l.allowableMode === "conc" ? "" : "%")}</td>
    <td style="${cell};text-align:center;font-weight:${l.passed === "Fail" ? "700" : "400"};color:${l.passed === "Fail" ? "#b91c1c" : "#111"}">${esc(l.passed || "--")}</td>
  </tr>`).join("");
  const supportTable = `<table style="width:100%;border-collapse:collapse;font-size:17px">
    <tr><td style="padding:3px 0;color:#333">Analyst</td><td style="padding:3px 0;text-align:right">${esc(run.analyst || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Expt Date</td><td style="padding:3px 0;text-align:right">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Units</td><td style="padding:3px 0;text-align:right">${esc(run.units || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Allowable Total Error</td><td style="padding:3px 0;text-align:right">${teaLabel(run.teaValue, run.teaMode)}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Comment</td><td style="padding:3px 0;text-align:right">${esc(run.comment || "--")}</td></tr>
  </table>`;
  const branch = branchName(run.branchId);
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;margin-bottom:6.5px"><tr>
      <td style="vertical-align:top"><div style="font-size:26.5px;font-weight:800;letter-spacing:-0.2px;font-family:Arial,Helvetica,sans-serif">QR Evaluator</div>
        <div style="font-size:14.5px;color:#555;border-top:1px solid #333;padding-top:2.5px;margin-top:3px;display:inline-block">${esc(reportBrandLine(run))}</div></td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:32px;font-weight:800">${esc(run.analyte || "")}</div>
        <div style="font-size:17px"><strong>Instrument</strong> ${esc(run.instrument || "")}</div>
      </td>
    </tr></table>
    <div style="text-align:center;font-size:23px;font-weight:700;text-decoration:underline;margin:22px 0 28px">Accuracy</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #999"><tr>
      <td style="width:36%;text-align:center;padding:18.5px;border-right:1px solid #ccc"><div style="font-weight:700;font-size:17px;margin-bottom:9px">% Bias by Level</div>${buildAccuracyBiasChartSVG(stats.levels, run.teaValue)}</td>
      <td style="padding:18.5px">${supportTable}
        <div style="margin-top:18.5px;font-size:18.5px"><strong>Overall Result:</strong>
          <span style="font-weight:700;color:${stats.overall === "Fail" ? "#b91c1c" : stats.overall === "Pass" ? "#1a7a1a" : "#666"}">${esc(stats.overall || "--")}</span></div>
      </td>
    </tr></table>
    <table style="width:100%;border-collapse:collapse;margin-top:28px">
      <thead><tr style="font-weight:700"><td style="${cell};background:#f2f2f2">Level</td><td style="${cell};background:#f2f2f2;text-align:center">Target</td><td style="${cell};background:#f2f2f2;text-align:center">N</td><td style="${cell};background:#f2f2f2;text-align:center">Obs Mean</td><td style="${cell};background:#f2f2f2;text-align:center">Bias</td><td style="${cell};background:#f2f2f2;text-align:center">%Bias</td><td style="${cell};background:#f2f2f2;text-align:center">%Recovery</td><td style="${cell};background:#f2f2f2;text-align:center">Allowable</td><td style="${cell};background:#f2f2f2;text-align:center">Pass/Fail</td></tr></thead>
      <tbody>${levelsRows}</tbody>
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:71.5px"><tr>
      <td style="width:34%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.analyst || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Prepared by / Analyst${run.expDate ? " · " + esc(run.expDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.reviewedBy || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Reviewed by${run.reviewedDate ? " · " + esc(run.reviewedDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.acceptedBy || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Accepted by / Lab Director${run.acceptedDate ? " · " + esc(run.acceptedDate) : ""}</div></td>
    </tr></table>
    <div style="margin-top:40px;border-top:1px solid #ccc;padding-top:7px;font-size:14.5px;color:#666">
      <div style="display:flex;justify-content:space-between"><span>QR Evaluator&nbsp;&nbsp;1.0</span><span>Copyright &copy; 2026 QR Lab</span></div>
      <div style="display:flex;justify-content:space-between;margin-top:3px"><span>${esc(reportPrintedLine(run))}</span><span>Page 1</span></div>
    </div>`;
  document.body.appendChild(wrap);
  try {
    const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const margin = 10, maxW = pageW - margin * 2, maxH = pageH - margin * 2;
    const ratio = canvas.height / canvas.width;
    let drawW = maxW, drawH = drawW * ratio;
    if (drawH > maxH) { drawH = maxH; drawW = drawH / ratio; }
    const x = (pageW - drawW) / 2, y = margin;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", x, y, drawW, drawH);
    return pdf;
  } finally {
    document.body.removeChild(wrap);
  }
}
function accuracyPdfFilename(run) {
  return `accuracy_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderAccuracyView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", instrument: "", labDept: "DELTA MEDICAL LABORATORIES",
    analyst: state.user.email, expDate: todayStr(), units: "", comment: "",
    teaMode: "percent", teaValue: "", levels: [ACCURACY_LEVEL_BLANK(), ACCURACY_LEVEL_BLANK(), ACCURACY_LEVEL_BLANK()],
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.accuracyRun || emptyRun();
  state.ui.accuracyRun = run;
  const branchFilter = isMaster ? (state.ui.accuracyBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !run.branchId || i.branchId === run.branchId).map((i) => i.name))];
  const employeeNames = employeeDisplayNames();
  const stats = accuracyRunResultStats(run);

  const q = (state.ui.accuracySearch || "").trim().toLowerCase();
  const saved = [...state.accuracyRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function levelRowHtml(lv, idx) {
    const s = stats.levels[idx] || {};
    return `<tr data-row="${idx}">
      <td><input data-f="level" data-i="${idx}" value="${esc(lv.level)}" style="width:100px" placeholder="e.g. Level 1" /></td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-f="target" data-i="${idx}" value="${esc(lv.target)}" style="width:90px" placeholder="Target" /></td>
      <td><input class="mono" data-f="results" data-i="${idx}" value="${esc(lv.results)}" style="width:100%;min-width:260px;font-size:14.5px;padding:10px 12px" placeholder="e.g. 98, 99, 101" /></td>
      <td class="mono" style="white-space:nowrap">${s.mean === undefined || s.mean === null ? "—" : fmtN(s.mean, 3)}</td>
      <td class="mono" style="white-space:nowrap">${s.pctBias === undefined || s.pctBias === null ? "—" : fmtN(s.pctBias, 2) + "%"}</td>
      <td class="mono" style="white-space:nowrap">${s.pctRecovery === undefined || s.pctRecovery === null ? "—" : fmtN(s.pctRecovery, 1) + "%"}</td>
      <td>${s.passed ? `<span class="badge" style="background:${s.passed === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${s.passed === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(s.passed)}</span>` : "—"}</td>
      <td><button type="button" class="icon-btn-sm" data-rm-row="${idx}" title="Remove level"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkAc"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Accuracy (QR Evaluator)</h2><span class="subtitle">Obs Mean vs Target per level — Bias%, %Recovery, checked against Allowable Total Error, same report layout as QR Evaluator</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:24.5px"><select id="acBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="acBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="acAnalyte" value="${esc(run.analyte)}" placeholder="e.g. Glucose" />`)}
        ${fieldHtml("Instrument", `<input id="acInstrument" list="acInstruments" value="${esc(run.instrument)}" placeholder="e.g. Beckman DxC 700 Au" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Units", `<input id="acUnits" list="labUnitsList" value="${esc(run.units)}" placeholder="e.g. mg/dL" />${labUnitsDatalistHtml()}`)}
        ${fieldHtml("Allowable Total Error (TEa)", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="acTeaValue" value="${esc(run.teaValue)}" placeholder="e.g. 10" />`)}
        ${fieldHtml("TEa Basis", `<select id="acTeaMode"><option value="percent" ${run.teaMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.teaMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
      </div>
      <datalist id="acInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>

      <h4 style="margin:24.5px 0 12.5px;font-size:19.5px">Levels</h4>
      <div style="font-size:17px;color:var(--text-faint);margin-bottom:12.5px">Tip: copy Level, Target, and Results columns from Excel and paste into the Level box — it fills all three down (Results pastes as a single comma-separated cell per row).</div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Level</th><th>Target</th><th>Results (comma-separated)</th><th>Obs Mean</th><th>%Bias</th><th>%Recovery</th><th>Pass/Fail</th><th></th></tr></thead>
        <tbody>${run.levels.map((lv, i) => levelRowHtml(lv, i)).join("")}</tbody>
      </table></div>
      <button type="button" class="btn secondary" id="acAddLevel" style="margin:15.5px 0 28px"><i class="fa-solid fa-plus"></i> Add level</button>

      <div class="panel-card" style="margin-bottom:28px">
        <div class="panel-title">Overall Result</div>
        <div style="margin-top:12.5px">${stats.overall ? `<span class="badge" style="background:${stats.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${stats.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(stats.overall)}</span>` : "<span class=\"pick-empty\">Enter targets, results, and TEa to compute</span>"}</div>
        <div class="live-chart-row">
          <div class="live-chart-box" style="flex-basis:100%"><div class="live-chart-title">% Bias by Level — spot which level is out of range</div>${buildAccuracyBiasChartSVG(stats.levels, run.teaValue)}</div>
        </div>
      </div>

      <datalist id="acEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="acAnalyst" list="acEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="acExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      ${fieldHtml("Comment", `<input id="acComment" value="${esc(run.comment)}" />`)}
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="acReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="acReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="acAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="acAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="acReset">Clear form</button>
        <button type="button" class="btn primary" id="acSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved accuracy runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="acSearch" value="${esc(state.ui.accuracySearch || "")}" placeholder="Search by analyte, instrument, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Instrument</th><th>Branch</th><th>Levels</th><th>Result</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="8" class="table-empty">${q ? "No runs match your search" : "No saved accuracy runs yet"}</td></tr>` : saved.map((r) => {
        const s = accuracyRunStats(r.levels, accuracySpecForStats(r));
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.instrument || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${(r.levels || []).length}</td>
          <td>${s.overall ? `<span class="badge" style="background:${s.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${s.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(s.overall)}</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-ac="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-ac="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-ac="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("acBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.accuracyBranch = e.target.value; renderAccuracyView(); };
  const acBranchEl = el("acBranch"); if (acBranchEl) acBranchEl.onchange = (e) => { run.branchId = e.target.value; renderAccuracyView(); };
  el("acAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("acInstrument").oninput = (e) => run.instrument = e.target.value;
  el("acUnits").oninput = (e) => run.units = e.target.value;
  el("acTeaValue").oninput = (e) => { run.teaValue = e.target.value; renderAccuracyView(); };
  el("acTeaMode").onchange = (e) => { run.teaMode = e.target.value; renderAccuracyView(); };
  el("acAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("acExpDate").oninput = (e) => run.expDate = e.target.value;
  el("acComment").oninput = (e) => run.comment = e.target.value;
  el("acReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("acReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("acAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("acAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("acAddLevel").onclick = () => { run.levels.push(ACCURACY_LEVEL_BLANK()); renderAccuracyView(); };
  attachExcelPasteObjects(el("mainContent"), "input[data-f]", run.levels, ["level", "target", "results"], ACCURACY_LEVEL_BLANK, renderAccuracyView);
  el("mainContent").querySelectorAll("[data-rm-row]").forEach((btn) => btn.onclick = () => {
    run.levels.splice(Number(btn.dataset.rmRow), 1);
    if (run.levels.length === 0) run.levels.push(ACCURACY_LEVEL_BLANK());
    renderAccuracyView();
  });
  el("mainContent").querySelectorAll("input[data-f]").forEach((input) => {
    const i = Number(input.dataset.i), f = input.dataset.f;
    input.oninput = (e) => { run.levels[i][f] = e.target.value; };
    input.onblur = () => renderAccuracyView();
  });
  el("acSearch").oninput = (e) => {
    state.ui.accuracySearch = e.target.value;
    renderAccuracyView();
    const refocused = el("acSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("acReset").onclick = () => { state.ui.accuracyRun = emptyRun(); renderAccuracyView(); };
  const epBackLinkAcEl = el("epBackLinkAc"); if (epBackLinkAcEl) epBackLinkAcEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-ac]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.accuracyRuns.find((r) => r.id === btn.dataset.openAc);
    if (savedRun) { state.ui.accuracyRun = JSON.parse(JSON.stringify(savedRun)); renderAccuracyView(); }
  });
  el("mainContent").querySelectorAll("[data-del-ac]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved accuracy run?")) deleteAccuracyRun(btn.dataset.delAc); });
  el("mainContent").querySelectorAll("[data-dl-ac]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.accuracyRuns.find((r) => r.id === btn.dataset.dlAc);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderAccuracyPdf(savedRun); pdf.save(accuracyPdfFilename(savedRun)); }
    catch (err) { console.error("Accuracy PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("acSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderAccuracyPdf(run);
      pdf.save(accuracyPdfFilename(run));
      const saveResult = await saveAccuracyRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.accuracyRun = emptyRun();
      renderAccuracyView();
    } catch (err) {
      console.error("Accuracy save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Comparison verification (QR Evaluator — "Two Instrument Comparison")
--------------------------------------------------------------------- */
const CMP_PAIR_BLANK = () => ({ id: "", x: "", y: "" });

async function saveComparisonRun(data) { return saveEpRunGuarded("comparisonRuns", data, "analyte"); }
async function deleteComparisonRun(id) {
  const cr = state.comparisonRuns.find((x) => x.id === id);
  await db.collection("comparisonRuns").doc(id).delete();
  logAudit("delete_comparison_run", cr ? (cr.analyte || id) : id, cr ? `run ${cr.expDate || ""}` : "");
}
function comparisonSpecForStats(run) { return { teaMode: run.teaMode, teaValue: run.teaValue }; }
function comparisonRunResultStats(run) { return comparisonRunStats(run.pairs, comparisonSpecForStats(run)); }

/** SVG recreation of the report's Scatter Plot: X vs Y for every pair, a dashed y=x reference line,
 *  and a shaded TEa band around it — the same "is Y within allowable error of X" view as the PDF. */
function buildScatterPlotSVG(stats, teaMode, teaValue, xLabel, yLabel) {
  const pts = (stats.pairs || []).filter((p) => !isNaN(p.x) && !isNaN(p.y));
  const maxVal = Math.max(10, ...pts.map((p) => p.x), ...pts.map((p) => p.y)) * 1.08;
  const x0 = 42, y0 = 12, size = 168;
  const sx = (v) => x0 + (v / maxVal) * size;
  const sy = (v) => y0 + size - (v / maxVal) * size;
  const tea = teaValue !== "" && teaValue != null && !isNaN(Number(teaValue)) ? Number(teaValue) : null;
  let band = "";
  if (tea !== null) {
    const upper = teaMode === "conc" ? [[0, tea], [maxVal, maxVal + tea]] : [[0, 0], [maxVal, maxVal * (1 + tea / 100)]];
    const lower = teaMode === "conc" ? [[0, -tea], [maxVal, maxVal - tea]] : [[0, 0], [maxVal, maxVal * (1 - tea / 100)]];
    band = `<polygon points="${sx(upper[0][0])},${sy(upper[0][1])} ${sx(upper[1][0])},${sy(upper[1][1])} ${sx(lower[1][0])},${sy(lower[1][1])} ${sx(lower[0][0])},${sy(lower[0][1])}" fill="#fff3b0" opacity="0.75" />`;
  }
  const diag = `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(maxVal)}" y2="${sy(maxVal)}" stroke="#555" stroke-width="1.2" stroke-dasharray="3,3" />`;
  const dots = pts.map((p) => `<circle data-pt="${p.origIdx}" data-fill="#1a3d8f" data-r="3" cx="${sx(p.x)}" cy="${sy(p.y)}" r="3" fill="#1a3d8f" />`).join("");
  let ticks = "";
  const step = Math.ceil(maxVal / 5 / 10) * 10 || Math.ceil(maxVal / 5) || 1;
  for (let t = 0; t <= maxVal; t += step) {
    ticks += `<line x1="${sx(t)}" y1="${y0 + size}" x2="${sx(t)}" y2="${y0 + size + 4}" stroke="#1a1a1a" stroke-width="1.1" /><text x="${sx(t)}" y="${y0 + size + 15}" font-size="12" text-anchor="middle" fill="#1a1a1a">${t}</text>`;
    ticks += `<line x1="${x0 - 4}" y1="${sy(t)}" x2="${x0}" y2="${sy(t)}" stroke="#1a1a1a" stroke-width="1.1" /><text x="${x0 - 6}" y="${sy(t) + 3}" font-size="12" text-anchor="end" fill="#1a1a1a">${t}</text>`;
  }
  return `<svg viewBox="0 0 240 210" width="276" height="241" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + size}" stroke="#1a1a1a" stroke-width="1.1" /><line x1="${x0}" y1="${y0 + size}" x2="${x0 + size}" y2="${y0 + size}" stroke="#1a1a1a" stroke-width="1.1" />
    ${band}${diag}${ticks}${dots}
    <text x="${x0 + size / 2}" y="${y0 + size + 30}" font-size="13" text-anchor="middle" fill="#1a1a1a">${esc(xLabel || "X Method")}</text>
    <text x="10" y="${y0 + size / 2}" font-size="13" fill="#1a1a1a" transform="rotate(-90 10 ${y0 + size / 2})" text-anchor="middle">${esc(yLabel || "Y Method")}</text>
  </svg>`;
}

/** SVG recreation of the report's Error Index plot: each pair's (Y-X)/TEa against X, with an
 *  "Average" reference line and shaded "Unacceptable" bands beyond ±1 — same layout as the PDF. */
function buildErrorIndexPlotSVG(stats, xLabel) {
  const pts = (stats.pairs || []).filter((p) => p.errorIndex !== null && !isNaN(p.errorIndex));
  const maxX = Math.max(10, ...pts.map((p) => p.x)) * 1.08;
  const maxAbsEI = Math.max(1.5, ...pts.map((p) => Math.abs(p.errorIndex))) * 1.1;
  const x0 = 42, y0 = 12, xw = 190, yh = 168;
  const sx = (v) => x0 + (v / maxX) * xw;
  const sy = (v) => y0 + yh / 2 - (v / maxAbsEI) * (yh / 2);
  const unaccHtml = `<rect x="${x0}" y="${y0}" width="${xw}" height="${sy(1) - y0}" fill="#ffe0e0" opacity="0.6" />
    <rect x="${x0}" y="${sy(-1)}" width="${xw}" height="${y0 + yh - sy(-1)}" fill="#ffe0e0" opacity="0.6" />`;
  const avgLine = stats.avgEI !== null ? `<line x1="${x0}" y1="${sy(stats.avgEI)}" x2="${x0 + xw}" y2="${sy(stats.avgEI)}" stroke="#555" stroke-dasharray="4,2" />` : "";
  const oneLines = `<line x1="${x0}" y1="${sy(1)}" x2="${x0 + xw}" y2="${sy(1)}" stroke="#c0392b" stroke-width="1.5" />
    <line x1="${x0}" y1="${sy(-1)}" x2="${x0 + xw}" y2="${sy(-1)}" stroke="#c0392b" stroke-width="1.5" />
    <line x1="${x0}" y1="${sy(0)}" x2="${x0 + xw}" y2="${sy(0)}" stroke="#1a1a1a" stroke-width="1.3" />`;
  const dots = pts.map((p) => `<circle data-pt="${p.origIdx}" data-fill="${Math.abs(p.errorIndex) <= 1 ? "#1a3d8f" : "#c0392b"}" data-r="3" cx="${sx(p.x)}" cy="${sy(p.errorIndex)}" r="3" fill="${Math.abs(p.errorIndex) <= 1 ? "#1a3d8f" : "#c0392b"}" />`).join("");
  let ticksY = "";
  for (let t = -1.5; t <= 1.5; t += 0.5) ticksY += `<line x1="${x0 - 4}" y1="${sy(t)}" x2="${x0}" y2="${sy(t)}" stroke="#1a1a1a" stroke-width="1.1" /><text x="${x0 - 6}" y="${sy(t) + 3}" font-size="12" text-anchor="end" fill="#1a1a1a">${t}</text>`;
  return `<svg viewBox="0 0 240 210" width="276" height="241" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" /><line x1="${x0}" y1="${y0 + yh}" x2="${x0 + xw}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" />
    ${unaccHtml}${oneLines}${avgLine}${ticksY}${dots}
    <text x="${x0 + xw / 2}" y="${y0 + yh + 28}" font-size="13" text-anchor="middle" fill="#1a1a1a">${esc(xLabel || "X Method")}</text>
    <text x="10" y="${y0 + yh / 2}" font-size="13" fill="#1a1a1a" transform="rotate(-90 10 ${y0 + yh / 2})" text-anchor="middle">Error Index: (Y-X)/TEa</text>
  </svg>`;
}

async function renderComparisonPdf(run) {
  const stats = comparisonRunResultStats(run);
  const cell = "padding:8px 11px;border:1px solid #999;font-size:18.5px";
  const keyStatsTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="padding:4.5px 0;color:#333">Average Error Index</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.avgEI, 2)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Error Index Range</td><td style="padding:4.5px 0;text-align:right">${stats.minEI === null ? "--" : fmtN(stats.minEI, 2) + " to " + fmtN(stats.maxEI, 2)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Pairs within TEa</td><td style="padding:4.5px 0;text-align:right">${stats.passCount} of ${stats.n}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Coverage Ratio</td><td style="padding:4.5px 0;text-align:right">${stats.n ? fmtN((stats.passCount / stats.n) * 100, 0) + "%" : "--"}</td></tr>
  </table>`;
  const demingTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td colspan="2" style="padding:4.5px 0;color:#333;font-style:italic">Y = Slope × X + Intercept</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Correlation Coeff (R)</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.corr, 4)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Slope</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.slope, 3)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Intercept</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.intercept, 3)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Std Error Estimate</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.stdErrEst, 3)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">N</td><td style="padding:4.5px 0;text-align:right">${stats.n}</td></tr>
  </table>`;
  const expDescTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td></td><td style="text-align:center;font-weight:700">X Method</td><td style="text-align:center;font-weight:700">Y Method</td></tr>
    <tr><td style="color:#333">Expt Date</td><td style="text-align:center">${esc(run.expDate || "--")}</td><td style="text-align:center">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="color:#333">Mean +/- SD</td><td style="text-align:center">${fmtN(stats.meanX, 3)} +/- ${fmtN(stats.sdX, 3)}</td><td style="text-align:center">${fmtN(stats.meanY, 3)} +/- ${fmtN(stats.sdY, 3)}</td></tr>
    <tr><td style="color:#333">Units</td><td style="text-align:center">${esc(run.units || "--")}</td><td style="text-align:center">${esc(run.units || "--")}</td></tr>
    <tr><td style="color:#333">Analyst</td><td style="text-align:center">${esc(run.analyst || "--")}</td><td style="text-align:center">${esc(run.analyst || "--")}</td></tr>
  </table>`;
  const pairRows = (run.pairs || []).map((p, i) => {
    const s = stats.pairs.find((x, k) => k === i && x.x === Number(p.x) && x.y === Number(p.y)) || {};
    return `<td style="${cell}">${esc(p.id || i + 1)}</td><td style="${cell};text-align:center">${p.x === "" ? "--" : fmtN(Number(p.x), 2)}</td><td style="${cell};text-align:center">${p.y === "" ? "--" : fmtN(Number(p.y), 2)}</td><td style="${cell};text-align:center">${s.errorIndex == null ? "--" : fmtN(s.errorIndex, 2)}</td>`;
  });
  let resultsRows = "";
  for (let i = 0; i < pairRows.length; i += 3) {
    resultsRows += `<tr>${pairRows[i] || "<td></td><td></td><td></td><td></td>"}${pairRows[i + 1] ? `<td style="width:8px;border:none"></td>${pairRows[i + 1]}` : ""}${pairRows[i + 2] ? `<td style="width:8px;border:none"></td>${pairRows[i + 2]}` : ""}</tr>`;
  }
  const evalText = `${esc(run.analyte || "This analyte")} was analyzed by methods ${esc(run.xMethod || "X")} and ${esc(run.yMethod || "Y")} to determine whether the methods are equivalent within AllowableTotal Error of ${teaLabel(run.teaValue, run.teaMode)}. ${stats.n} specimens were compared. The test ${stats.overall === "Pass" ? "Passed" : stats.overall === "Fail" ? "Failed" : "result is inconclusive"}. The difference between the two methods was within allowable error for ${stats.passCount} of ${stats.n} specimens (${stats.n ? Math.round((stats.passCount / stats.n) * 100) : 0}%). The average Error Index (Y-X)/TEa was ${fmtN(stats.avgEI, 2)}, with a range of ${fmtN(stats.minEI, 2)} to ${fmtN(stats.maxEI, 2)}.`;
  const branch = branchName(run.branchId);
  const headerHtml = reportHeaderHtml(run, "Two Instrument Comparison", [], `
    <div style="display:flex;justify-content:space-between;font-size:18.5px;margin:3px 0 6.5px">
      <span><strong>X Method</strong>&nbsp; ${esc(run.xMethod || "")}</span>
      <span><strong>Y Method</strong>&nbsp; ${esc(run.yMethod || "")}</span>
    </div>`);
  const sections = [
    `<table style="width:100%;border-collapse:collapse"><tr>
      <td style="width:50%;text-align:center;padding:9px"><div style="font-weight:700;font-size:18.5px;margin-bottom:6.5px">Scatter Plot</div>${buildScatterPlotSVG(stats, run.teaMode, run.teaValue, `${run.xMethod || "X Method"} ${run.units || ""}`.trim(), `${run.yMethod || "Y Method"} ${run.units || ""}`.trim())}</td>
      <td style="width:50%;text-align:center;padding:9px"><div style="font-weight:700;font-size:18.5px;margin-bottom:6.5px">Error Index</div>${buildErrorIndexPlotSVG(stats, `${run.xMethod || "X Method"} ${run.units || ""}`.trim())}</td>
    </tr></table>
    <div style="font-weight:700;font-size:19px;margin:22px 0 6.5px">Evaluation of Results</div>
    <div style="font-size:18.5px;line-height:1.55">${evalText}</div>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:22px"><tr>
      <td style="width:50%;vertical-align:top;padding-right:14px">
        <div style="font-weight:700;font-size:18.5px;margin-bottom:6.5px">Key Statistics</div>${keyStatsTable}
        <div style="font-weight:700;font-size:18.5px;margin:18.5px 0 6.5px">Experiment Description</div>${expDescTable}
      </td>
      <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18.5px;margin-bottom:6.5px">Deming Regression Statistics</div>${demingTable}</td>
    </tr></table>
    ${reportSignatureHtml(run)}`,
    // Kept as its own (naturally-overflowing) section — a normal-sized run's stats/signature
    // above already fill most of page 1, so this table lands on page 2 on its own without
    // needing to be forced there.
    `<div style="font-weight:700;font-size:19px;text-align:center;margin:16px 0 15.5px">Experimental Results</div>
    <table style="width:100%;border-collapse:collapse"><thead><tr>
      <td style="${cell};background:#f2f2f2;font-weight:700">Specimen</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">X</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Y</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Error Index</td>
      <td style="width:8px;border:none"></td><td style="${cell};background:#f2f2f2;font-weight:700">Specimen</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">X</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Y</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Error Index</td>
      <td style="width:8px;border:none"></td><td style="${cell};background:#f2f2f2;font-weight:700">Specimen</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">X</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Y</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Error Index</td>
    </tr></thead><tbody>${resultsRows}</tbody></table>
    <div style="font-size:15.5px;color:#666;margin-top:6.5px">Values with an "X" were excluded from the calculations.</div>`,
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run) });
}
function comparisonPdfFilename(run) {
  return `comparison_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderComparisonView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: (state.ui.comparisonPreset && state.ui.comparisonPreset.analyte) || "", xMethod: "", yMethod: "", labDept: "DELTA MEDICAL LABORATORIES",
    analyst: state.user.email, expDate: todayStr(), units: (state.ui.comparisonPreset && state.ui.comparisonPreset.units) || "", comment: "",
    teaMode: "percent", teaValue: (state.ui.comparisonPreset && state.ui.comparisonPreset.tea) || "", pairs: [CMP_PAIR_BLANK(), CMP_PAIR_BLANK(), CMP_PAIR_BLANK(), CMP_PAIR_BLANK(), CMP_PAIR_BLANK()],
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.comparisonRun || emptyRun();
  state.ui.comparisonRun = run;
  state.ui.comparisonPreset = null;
  const branchFilter = isMaster ? (state.ui.comparisonBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !run.branchId || i.branchId === run.branchId).map((i) => i.name))];
  const employeeNames = employeeDisplayNames();
  const stats = comparisonRunResultStats(run);

  const q = (state.ui.comparisonSearch || "").trim().toLowerCase();
  const saved = [...state.comparisonRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.xMethod, r.yMethod, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function pairRowHtml(p, idx) {
    const s = stats.pairs.find((x) => x.origIdx === idx);
    return `<tr data-row="${idx}">
      <td><input data-f="id" data-i="${idx}" value="${esc(p.id)}" style="width:90px" placeholder="Specimen ID" /></td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-f="x" data-i="${idx}" value="${esc(p.x)}" style="width:90px" placeholder="X" /></td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-f="y" data-i="${idx}" value="${esc(p.y)}" style="width:90px" placeholder="Y" /></td>
      <td class="mono">${s && s.errorIndex != null ? fmtN(s.errorIndex, 2) : "—"}</td>
      <td><button type="button" class="icon-btn-sm" data-rm-row="${idx}" title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkCmp"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Comparison (QR Evaluator)</h2><span class="subtitle">Two Instrument Comparison — Deming regression &amp; Error Index between two methods, same report layout as QR Evaluator</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:24.5px"><select id="cmpBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="cmpBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="cmpAnalyte" value="${esc(run.analyte)}" placeholder="e.g. ALP" />`)}
        ${fieldHtml("Units", `<input id="cmpUnits" list="labUnitsList" value="${esc(run.units)}" placeholder="e.g. U/L" />${labUnitsDatalistHtml()}`)}
      </div>
      <div class="form-row">
        ${fieldHtml("X Method *", `<input id="cmpXMethod" list="cmpInstruments" value="${esc(run.xMethod)}" placeholder="e.g. Beckman DxC 700 Abha" />`)}
        ${fieldHtml("Y Method *", `<input id="cmpYMethod" list="cmpInstruments" value="${esc(run.yMethod)}" placeholder="e.g. Beckman DxC 700 Jazan" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Allowable Total Error (TEa)", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="cmpTeaValue" value="${esc(run.teaValue)}" placeholder="e.g. 30" />`)}
        ${fieldHtml("TEa Basis", `<select id="cmpTeaMode"><option value="percent" ${run.teaMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.teaMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
      </div>
      <datalist id="cmpInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>

      <h4 style="margin:24.5px 0 6.5px;font-size:19.5px">Paired Results</h4>
      <div style="font-size:17px;color:var(--text-faint);margin-bottom:9px">Tip: copy two columns (X, Y) from Excel and paste into the X box — it fills both columns down.</div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Specimen ID</th><th>X Result</th><th>Y Result</th><th>Error Index</th><th></th></tr></thead>
        <tbody>${run.pairs.map((p, i) => pairRowHtml(p, i)).join("")}</tbody>
      </table></div>
      <button type="button" class="btn secondary" id="cmpAddRow" style="margin:15.5px 0 28px"><i class="fa-solid fa-plus"></i> Add pair</button>

      <div class="panel-card" style="margin-bottom:28px">
        <div class="panel-title">Statistics (live preview)</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:12.5px">
          <div><span class="field-label">N</span><div class="mono">${stats.n}</div></div>
          <div><span class="field-label">Correlation (R)</span><div class="mono">${fmtN(stats.corr, 4)}</div></div>
          <div><span class="field-label">Slope</span><div class="mono">${fmtN(stats.slope, 3)}</div></div>
          <div><span class="field-label">Intercept</span><div class="mono">${fmtN(stats.intercept, 3)}</div></div>
          <div><span class="field-label">Avg Error Index</span><div class="mono">${fmtN(stats.avgEI, 2)}</div></div>
          <div><span class="field-label">Within TEa</span><div class="mono">${stats.passCount} of ${stats.n}</div></div>
          <div><span class="field-label">Result</span><div>${stats.overall ? `<span class="badge" style="background:${stats.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${stats.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(stats.overall)}</span>` : "—"}</div></div>
        </div>
        <div class="live-chart-row">
          <div class="live-chart-box"><div class="live-chart-title">Scatter Plot — spot a pair off the line</div>${buildScatterPlotSVG(stats, run.teaMode, run.teaValue, `${run.xMethod || "X Method"} ${run.units || ""}`.trim(), `${run.yMethod || "Y Method"} ${run.units || ""}`.trim())}</div>
          <div class="live-chart-box"><div class="live-chart-title">Error Index — spot a pair outside TEa</div>${buildErrorIndexPlotSVG(stats, `${run.xMethod || "X Method"} ${run.units || ""}`.trim())}</div>
        </div>
      </div>

      <datalist id="cmpEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="cmpAnalyst" list="cmpEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="cmpExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      ${fieldHtml("Comment", `<input id="cmpComment" value="${esc(run.comment)}" />`)}
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="cmpReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="cmpReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="cmpAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="cmpAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="cmpReset">Clear form</button>
        <button type="button" class="btn primary" id="cmpSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved comparison runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="cmpSearch" value="${esc(state.ui.comparisonSearch || "")}" placeholder="Search by analyte, method, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table data-table-compact">
      <thead><tr><th>Date</th><th>Analyte</th><th>X / Y Method</th><th>Branch</th><th>N / Avg EI</th><th>Result</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="8" class="table-empty">${q ? "No runs match your search" : "No saved comparison runs yet"}</td></tr>` : saved.map((r) => {
        const s = comparisonRunResultStats(r);
        const methodText = `${r.xMethod || "—"} / ${r.yMethod || "—"}`;
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td class="col-truncate" title="${esc(methodText)}">${esc(methodText)}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${s.n} / ${fmtN(s.avgEI, 2)}</td>
          <td>${s.overall ? `<span class="badge" style="background:${s.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${s.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(s.overall)}</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-cmp="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-cmp="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-cmp="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("cmpBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.comparisonBranch = e.target.value; renderComparisonView(); };
  const cmpBranchEl = el("cmpBranch"); if (cmpBranchEl) cmpBranchEl.onchange = (e) => { run.branchId = e.target.value; renderComparisonView(); };
  el("cmpAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("cmpUnits").oninput = (e) => run.units = e.target.value;
  el("cmpXMethod").oninput = (e) => run.xMethod = e.target.value;
  el("cmpYMethod").oninput = (e) => run.yMethod = e.target.value;
  el("cmpTeaValue").oninput = (e) => { run.teaValue = e.target.value; renderComparisonView(); };
  el("cmpTeaMode").onchange = (e) => { run.teaMode = e.target.value; renderComparisonView(); };
  el("cmpAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("cmpExpDate").oninput = (e) => run.expDate = e.target.value;
  el("cmpComment").oninput = (e) => run.comment = e.target.value;
  el("cmpReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("cmpReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("cmpAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("cmpAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("cmpAddRow").onclick = () => { run.pairs.push(CMP_PAIR_BLANK()); renderComparisonView(); };
  el("mainContent").querySelectorAll("[data-rm-row]").forEach((btn) => btn.onclick = () => {
    run.pairs.splice(Number(btn.dataset.rmRow), 1);
    if (run.pairs.length === 0) run.pairs.push(CMP_PAIR_BLANK());
    renderComparisonView();
  });
  el("mainContent").querySelectorAll("input[data-f]").forEach((input) => {
    const i = Number(input.dataset.i), f = input.dataset.f;
    input.oninput = (e) => { run.pairs[i][f] = e.target.value; };
    input.onblur = () => renderComparisonView();
  });
  attachExcelPasteObjects(el("mainContent"), "input[data-f]", run.pairs, ["id", "x", "y"], CMP_PAIR_BLANK, renderComparisonView);
  wireChartRowHighlight(el("mainContent"));
  el("cmpSearch").oninput = (e) => {
    state.ui.comparisonSearch = e.target.value;
    renderComparisonView();
    const refocused = el("cmpSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("cmpReset").onclick = () => { state.ui.comparisonRun = emptyRun(); renderComparisonView(); };
  const epBackLinkCmpEl = el("epBackLinkCmp"); if (epBackLinkCmpEl) epBackLinkCmpEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-cmp]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.comparisonRuns.find((r) => r.id === btn.dataset.openCmp);
    if (savedRun) { state.ui.comparisonRun = JSON.parse(JSON.stringify(savedRun)); renderComparisonView(); }
  });
  el("mainContent").querySelectorAll("[data-del-cmp]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved comparison run?")) deleteComparisonRun(btn.dataset.delCmp); });
  el("mainContent").querySelectorAll("[data-dl-cmp]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.comparisonRuns.find((r) => r.id === btn.dataset.dlCmp);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderComparisonPdf(savedRun); pdf.save(comparisonPdfFilename(savedRun)); }
    catch (err) { console.error("Comparison PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("cmpSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderComparisonPdf(run);
      pdf.save(comparisonPdfFilename(run));
      const saveResult = await saveComparisonRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.comparisonRun = emptyRun();
      renderComparisonView();
    } catch (err) {
      console.error("Comparison save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Multiple Instrument Comparison (3+ instruments against one reference)
   Reuses the same pairwise Deming/Error-Index engine as Two Instrument
   Comparison (comparisonRunStats) — one pairwise comparison per Y
   method against the shared X (reference) method, computed from the
   same specimen rows.
--------------------------------------------------------------------- */
const MULTI_ROW_BLANK = (yCount) => ({ id: "", x: "", ys: Array(yCount || 2).fill("") });

async function saveMultiComparisonRun(data) { return saveEpRunGuarded("multiComparisonRuns", data, "analyte"); }
async function deleteMultiComparisonRun(id) {
  const r = state.multiComparisonRuns.find((x) => x.id === id);
  await db.collection("multiComparisonRuns").doc(id).delete();
  logAudit("delete_multi_comparison_run", r ? (r.analyte || id) : id, r ? `run ${r.expDate || ""}` : "");
}
function multiComparisonSpecForStats(run) { return { teaMode: run.teaMode, teaValue: run.teaValue }; }
/** One comparisonRunStats() result per Y method, each computed against the shared X (reference)
 *  method from the same specimen rows — same engine as Two Instrument Comparison. */
function multiComparisonInstrumentStats(run) {
  const spec = multiComparisonSpecForStats(run);
  return (run.yMethods || []).map((method, k) => {
    const pairs = (run.rows || []).map((r) => ({ id: r.id, x: r.x, y: (r.ys || [])[k] !== undefined ? r.ys[k] : "" }));
    return { method, stats: comparisonRunStats(pairs, spec) };
  });
}

async function renderMultiComparisonPdf(run) {
  const perInstrument = multiComparisonInstrumentStats(run);
  const cell = "padding:8px 11px;border:1px solid #999;font-size:17px";
  const summaryRows = perInstrument.map(({ method, stats }) => `<tr>
    <td style="${cell}">${esc(method || "—")}</td>
    <td style="${cell};text-align:center">${stats.n}</td>
    <td style="${cell};text-align:center">${fmtN(stats.corr, 4)}</td>
    <td style="${cell};text-align:center">${fmtN(stats.slope, 3)}</td>
    <td style="${cell};text-align:center">${fmtN(stats.intercept, 3)}</td>
    <td style="${cell};text-align:center">${fmtN(stats.avgEI, 2)}</td>
    <td style="${cell};text-align:center">${stats.passCount} of ${stats.n}</td>
    <td style="${cell};text-align:center">${stats.overall ? `<span style="font-weight:700;color:${stats.overall === "Pass" ? "#1a7a3d" : "#c0392b"}">${esc(stats.overall)}</span>` : "—"}</td>
  </tr>`).join("");
  const summaryTable = `<table style="width:100%;border-collapse:collapse;font-size:17px"><thead><tr>
    <td style="${cell};background:#f2f2f2;font-weight:700">Y Method</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">N</td>
    <td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">R</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Slope</td>
    <td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Intercept</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Avg EI</td>
    <td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Within TEa</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Result</td>
  </tr></thead><tbody>${summaryRows}</tbody></table>`;
  const evalText = `${esc(run.analyte || "This analyte")} was analyzed on ${perInstrument.length + 1} instruments (reference: ${esc(run.xMethod || "X")}; compared: ${perInstrument.map((p) => esc(p.method || "—")).join(", ")}) to determine whether each instrument agrees with the reference within Allowable Total Error of ${teaLabel(run.teaValue, run.teaMode)}. ${perInstrument.filter((p) => p.stats.overall === "Pass").length} of ${perInstrument.length} instrument${perInstrument.length === 1 ? "" : "s"} passed against the reference method.`;
  const plotSections = perInstrument.map(({ method, stats }) => `<table style="width:100%;border-collapse:collapse;margin-top:18px"><tr>
    <td style="width:50%;text-align:center;padding:9px"><div style="font-weight:700;font-size:17px;margin-bottom:6.5px">Scatter Plot — ${esc(run.xMethod || "X")} vs ${esc(method || "Y")}</div>${buildScatterPlotSVG(stats, run.teaMode, run.teaValue, `${run.xMethod || "X Method"} ${run.units || ""}`.trim(), `${method || "Y Method"} ${run.units || ""}`.trim())}</td>
    <td style="width:50%;text-align:center;padding:9px"><div style="font-weight:700;font-size:17px;margin-bottom:6.5px">Error Index — ${esc(method || "Y")}</div>${buildErrorIndexPlotSVG(stats, `${run.xMethod || "X Method"} ${run.units || ""}`.trim())}</td>
  </tr></table>`).join("");
  const dataHeaderCells = `<td style="${cell};background:#f2f2f2;font-weight:700">Specimen</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">${esc(run.xMethod || "X")}</td>${(run.yMethods || []).map((m) => `<td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">${esc(m || "—")}</td>`).join("")}`;
  const dataRows = (run.rows || []).map((r) => `<tr><td style="${cell}">${esc(r.id || "")}</td><td style="${cell};text-align:center">${r.x === "" ? "--" : fmtN(Number(r.x), 2)}</td>${(r.ys || []).map((y) => `<td style="${cell};text-align:center">${y === "" || y == null ? "--" : fmtN(Number(y), 2)}</td>`).join("")}</tr>`).join("");
  const headerHtml = reportHeaderHtml(run, "Multiple Instrument Comparison", [], `
    <div style="font-size:17px;margin:3px 0 6.5px"><strong>Reference (X) Method</strong>&nbsp; ${esc(run.xMethod || "")}</div>`);
  const sections = [
    `<div style="font-weight:700;font-size:18px;margin-bottom:6.5px">Evaluation of Results</div>
    <div style="font-size:17px;line-height:1.55">${evalText}</div>
    <div style="font-weight:700;font-size:18px;margin:22px 0 6.5px">Summary — Each Instrument vs Reference</div>${summaryTable}
    ${reportSignatureHtml(run)}`,
    plotSections,
    `<div style="font-weight:700;font-size:18px;text-align:center;margin:16px 0 15.5px">Experimental Results</div>
    <table style="width:100%;border-collapse:collapse"><thead><tr>${dataHeaderCells}</tr></thead><tbody>${dataRows}</tbody></table>`,
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run) });
}
function multiComparisonPdfFilename(run) {
  return `multi-comparison_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderMultiComparisonView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: (state.ui.multiComparisonPreset && state.ui.multiComparisonPreset.analyte) || "", xMethod: "",
    yMethods: ["", ""], labDept: "DELTA MEDICAL LABORATORIES", analyst: state.user.email, expDate: todayStr(),
    units: (state.ui.multiComparisonPreset && state.ui.multiComparisonPreset.units) || "", comment: "",
    teaMode: "percent", teaValue: (state.ui.multiComparisonPreset && state.ui.multiComparisonPreset.tea) || "",
    rows: [MULTI_ROW_BLANK(2), MULTI_ROW_BLANK(2), MULTI_ROW_BLANK(2), MULTI_ROW_BLANK(2), MULTI_ROW_BLANK(2)],
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.multiComparisonRun || emptyRun();
  state.ui.multiComparisonRun = run;
  state.ui.multiComparisonPreset = null;
  const branchFilter = isMaster ? (state.ui.multiComparisonBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !run.branchId || i.branchId === run.branchId).map((i) => i.name))];
  const employeeNames = employeeDisplayNames();
  const perInstrument = multiComparisonInstrumentStats(run);

  const q = (state.ui.multiComparisonSearch || "").trim().toLowerCase();
  const saved = [...state.multiComparisonRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.xMethod, ...(r.yMethods || []), r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function rowHtml(r, idx) {
    return `<tr data-row="${idx}">
      <td><input data-mf="id" data-mi="${idx}" value="${esc(r.id)}" style="width:90px" placeholder="Specimen ID" /></td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-mf="x" data-mi="${idx}" value="${esc(r.x)}" style="width:85px" placeholder="X" /></td>
      ${(run.yMethods || []).map((_, k) => `<td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-mf="y" data-mi="${idx}" data-mk="${k}" value="${esc((r.ys || [])[k] ?? "")}" style="width:85px" placeholder="Y${k + 1}" /></td>`).join("")}
      <td><button type="button" class="icon-btn-sm" data-rm-mrow="${idx}" title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkMcmp"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Multiple Instrument Comparison (QR Evaluator)</h2><span class="subtitle">3+ instruments compared against one reference method — same Deming regression &amp; Error Index engine as Two Instrument Comparison, run pairwise</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:24.5px"><select id="mcmpBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="mcmpBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="mcmpAnalyte" value="${esc(run.analyte)}" placeholder="e.g. ALP" />`)}
        ${fieldHtml("Units", `<input id="mcmpUnits" list="labUnitsList" value="${esc(run.units)}" placeholder="e.g. U/L" />${labUnitsDatalistHtml()}`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Reference (X) Method *", `<input id="mcmpXMethod" list="mcmpInstruments" value="${esc(run.xMethod)}" placeholder="e.g. Beckman DxC 700 Abha" />`)}
        ${fieldHtml("Allowable Total Error (TEa)", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="mcmpTeaValue" value="${esc(run.teaValue)}" placeholder="e.g. 30" />`)}
        ${fieldHtml("TEa Basis", `<select id="mcmpTeaMode"><option value="percent" ${run.teaMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.teaMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
      </div>
      <datalist id="mcmpInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>

      <h4 style="margin:24.5px 0 6.5px;font-size:19.5px">Y Methods (instruments compared against the reference)</h4>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
        ${(run.yMethods || []).map((m, k) => `<div style="display:flex;gap:8px;align-items:center">
          <input data-ymethod="${k}" list="mcmpInstruments" value="${esc(m)}" placeholder="e.g. Beckman DxC 700 Jazan" style="max-width:320px" />
          ${(run.yMethods || []).length > 2 ? `<button type="button" class="icon-btn-sm" data-rm-ymethod="${k}" title="Remove instrument"><i class="fa-solid fa-xmark"></i></button>` : ""}
        </div>`).join("")}
      </div>
      <button type="button" class="btn secondary" id="mcmpAddYMethod" style="margin-bottom:24.5px" ${(run.yMethods || []).length >= 6 ? "disabled" : ""}><i class="fa-solid fa-plus"></i> Add instrument (max 6)</button>

      <h4 style="margin:0 0 6.5px;font-size:19.5px">Paired Results</h4>
      <div style="font-size:17px;color:var(--text-faint);margin-bottom:9px">Each specimen row: one reference (X) result, plus one result per compared instrument.</div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Specimen ID</th><th>${esc(run.xMethod || "X")}</th>${(run.yMethods || []).map((m, k) => `<th>${esc(m || `Y${k + 1}`)}</th>`).join("")}<th></th></tr></thead>
        <tbody>${run.rows.map((r, i) => rowHtml(r, i)).join("")}</tbody>
      </table></div>
      <button type="button" class="btn secondary" id="mcmpAddRow" style="margin:15.5px 0 28px"><i class="fa-solid fa-plus"></i> Add specimen</button>

      <div class="panel-card" style="margin-bottom:28px">
        <div class="panel-title">Summary — each instrument vs reference (live preview)</div>
        <div class="table-wrap" style="margin-top:12.5px"><table class="data-table data-table-compact">
          <thead><tr><th>Y Method</th><th>N</th><th>R</th><th>Slope</th><th>Intercept</th><th>Avg EI</th><th>Within TEa</th><th>Result</th></tr></thead>
          <tbody>${perInstrument.length === 0 ? `<tr><td colspan="8" class="table-empty">Add instruments and results above</td></tr>` : perInstrument.map(({ method, stats }) => `<tr>
            <td>${esc(method || "—")}</td><td class="mono">${stats.n}</td><td class="mono">${fmtN(stats.corr, 4)}</td><td class="mono">${fmtN(stats.slope, 3)}</td><td class="mono">${fmtN(stats.intercept, 3)}</td><td class="mono">${fmtN(stats.avgEI, 2)}</td><td class="mono">${stats.passCount} of ${stats.n}</td>
            <td>${stats.overall ? `<span class="badge" style="background:${stats.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${stats.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(stats.overall)}</span>` : "—"}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </div>

      <datalist id="mcmpEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="mcmpAnalyst" list="mcmpEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="mcmpExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      ${fieldHtml("Comment", `<input id="mcmpComment" value="${esc(run.comment)}" />`)}
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="mcmpReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="mcmpReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="mcmpAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="mcmpAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="mcmpReset">Clear form</button>
        <button type="button" class="btn primary" id="mcmpSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved multi-instrument comparison runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="mcmpSearch" value="${esc(state.ui.multiComparisonSearch || "")}" placeholder="Search by analyte, method, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table data-table-compact">
      <thead><tr><th>Date</th><th>Analyte</th><th>Reference / Compared</th><th>Branch</th><th>Instruments</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="7" class="table-empty">${q ? "No runs match your search" : "No saved multi-instrument comparison runs yet"}</td></tr>` : saved.map((r) => {
        const methodText = `${r.xMethod || "—"} vs ${(r.yMethods || []).filter(Boolean).join(", ") || "—"}`;
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td class="col-truncate" title="${esc(methodText)}">${esc(methodText)}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${(r.yMethods || []).filter(Boolean).length}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-mcmp="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-mcmp="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-mcmp="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("mcmpBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.multiComparisonBranch = e.target.value; renderMultiComparisonView(); };
  const mcmpBranchEl = el("mcmpBranch"); if (mcmpBranchEl) mcmpBranchEl.onchange = (e) => { run.branchId = e.target.value; renderMultiComparisonView(); };
  el("mcmpAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("mcmpUnits").oninput = (e) => run.units = e.target.value;
  el("mcmpXMethod").oninput = (e) => { run.xMethod = e.target.value; };
  el("mcmpXMethod").onblur = () => renderMultiComparisonView();
  el("mcmpTeaValue").oninput = (e) => { run.teaValue = e.target.value; renderMultiComparisonView(); };
  el("mcmpTeaMode").onchange = (e) => { run.teaMode = e.target.value; renderMultiComparisonView(); };
  el("mcmpAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("mcmpExpDate").oninput = (e) => run.expDate = e.target.value;
  el("mcmpComment").oninput = (e) => run.comment = e.target.value;
  el("mcmpReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("mcmpReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("mcmpAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("mcmpAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("mainContent").querySelectorAll("[data-ymethod]").forEach((input) => {
    const k = Number(input.dataset.ymethod);
    input.oninput = (e) => { run.yMethods[k] = e.target.value; };
    input.onblur = () => renderMultiComparisonView();
  });
  el("mcmpAddYMethod").onclick = () => {
    if (run.yMethods.length >= 6) return;
    run.yMethods.push("");
    run.rows.forEach((r) => { r.ys = r.ys || []; r.ys.push(""); });
    renderMultiComparisonView();
  };
  el("mainContent").querySelectorAll("[data-rm-ymethod]").forEach((btn) => btn.onclick = () => {
    const k = Number(btn.dataset.rmYmethod);
    run.yMethods.splice(k, 1);
    run.rows.forEach((r) => { if (r.ys) r.ys.splice(k, 1); });
    renderMultiComparisonView();
  });
  el("mcmpAddRow").onclick = () => { run.rows.push(MULTI_ROW_BLANK(run.yMethods.length)); renderMultiComparisonView(); };
  el("mainContent").querySelectorAll("[data-rm-mrow]").forEach((btn) => btn.onclick = () => {
    run.rows.splice(Number(btn.dataset.rmMrow), 1);
    if (run.rows.length === 0) run.rows.push(MULTI_ROW_BLANK(run.yMethods.length));
    renderMultiComparisonView();
  });
  el("mainContent").querySelectorAll("input[data-mf]").forEach((input) => {
    const i = Number(input.dataset.mi), f = input.dataset.mf;
    input.oninput = (e) => {
      if (f === "y") { const k = Number(input.dataset.mk); run.rows[i].ys = run.rows[i].ys || []; run.rows[i].ys[k] = e.target.value; }
      else run.rows[i][f] = e.target.value;
    };
    input.onblur = () => renderMultiComparisonView();
  });
  el("mcmpSearch").oninput = (e) => {
    state.ui.multiComparisonSearch = e.target.value;
    renderMultiComparisonView();
    const refocused = el("mcmpSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("mcmpReset").onclick = () => { state.ui.multiComparisonRun = emptyRun(); renderMultiComparisonView(); };
  const epBackLinkMcmpEl = el("epBackLinkMcmp"); if (epBackLinkMcmpEl) epBackLinkMcmpEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-mcmp]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.multiComparisonRuns.find((r) => r.id === btn.dataset.openMcmp);
    if (savedRun) { state.ui.multiComparisonRun = JSON.parse(JSON.stringify(savedRun)); renderMultiComparisonView(); }
  });
  el("mainContent").querySelectorAll("[data-del-mcmp]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved multi-instrument comparison run?")) deleteMultiComparisonRun(btn.dataset.delMcmp); });
  el("mainContent").querySelectorAll("[data-dl-mcmp]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.multiComparisonRuns.find((r) => r.id === btn.dataset.dlMcmp);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderMultiComparisonPdf(savedRun); pdf.save(multiComparisonPdfFilename(savedRun)); }
    catch (err) { console.error("Multi-comparison PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("mcmpSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if (!run.xMethod.trim()) { toast("Please enter the reference (X) method.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderMultiComparisonPdf(run);
      pdf.save(multiComparisonPdfFilename(run));
      const saveResult = await saveMultiComparisonRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.multiComparisonRun = emptyRun();
      renderMultiComparisonView();
    } catch (err) {
      console.error("Multi-comparison save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Qualitative Precision verification (QR Evaluator style — repeatability
   of Positive/Negative calls at each level against the expected call)
--------------------------------------------------------------------- */
const QUAL_PREC_LEVEL_BLANK = () => ({ level: "", expected: "Negative", results: "" });

async function saveQualPrecisionRun(data) { return saveEpRunGuarded("qualPrecisionRuns", data, "analyte"); }
async function deleteQualPrecisionRun(id) {
  const qp = state.qualPrecisionRuns.find((x) => x.id === id);
  await db.collection("qualPrecisionRuns").doc(id).delete();
  logAudit("delete_qual_precision_run", qp ? (qp.analyte || id) : id, qp ? `run ${qp.expDate || ""}` : "");
}
function qualPrecisionRunResultStats(run) { return qualPrecisionRunStats(run.levels, run.allowablePct); }

/** SVG recreation of an QR Evaluator-style bar chart: one bar per level's %Agreement, with a
 *  dashed allowable-minimum line, same visual role as the Precision report's Goal line. */
function buildQualAgreementChartSVG(levelStats, levels, allowablePct) {
  const allowable = allowablePct !== "" && allowablePct != null && !isNaN(Number(allowablePct)) ? Number(allowablePct) : null;
  const x0 = 40, xw = 250, y0 = 14, yh = 170;
  const yAt = (v) => y0 + yh - (v / 100) * yh;
  const n = levelStats.length || 1;
  const barW = Math.min(36, (xw - x0) / n - 14);
  let ticksY = "";
  for (let t = 0; t <= 100; t += 25) ticksY += `<line x1="34" y1="${yAt(t)}" x2="${x0}" y2="${yAt(t)}" stroke="#1a1a1a" stroke-width="1.1" /><text x="30" y="${yAt(t) + 4}" font-size="13" text-anchor="end" fill="#1a1a1a">${t}%</text>`;
  const allowHtml = allowable !== null ? `<line x1="${x0}" y1="${yAt(allowable)}" x2="${xw}" y2="${yAt(allowable)}" stroke="#c0392b" stroke-width="1.2" stroke-dasharray="5,3" /><text x="${xw - 2}" y="${yAt(allowable) - 5}" font-size="12.5" text-anchor="end" fill="#c0392b">Min ${allowable}%</text>` : "";
  const bars = levelStats.map((l, i) => {
    if (l.pctAgreement === null) return "";
    const cx = x0 + (xw - x0) * ((i + 1) / (n + 1));
    const color = l.passed === "Fail" ? "#c0392b" : "#2e7d32";
    return `<rect x="${cx - barW / 2}" y="${yAt(l.pctAgreement)}" width="${barW}" height="${Math.max(yAt(0) - yAt(l.pctAgreement), 1)}" fill="${color}" opacity="0.78" />
      <text x="${cx}" y="${y0 + yh + 14}" font-size="12.5" text-anchor="middle" fill="#1a1a1a">${esc((levels[i] && levels[i].level) || `L${i + 1}`)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 260 200" width="299" height="230" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" /><line x1="${x0}" y1="${y0 + yh}" x2="${xw}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" />
    ${ticksY}${allowHtml}${bars}
  </svg>`;
}

async function renderQualPrecisionPdf(run) {
  const stats = qualPrecisionRunResultStats(run);
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-9999px;top:0;width:900px;background:#fff;padding:46.5px 53px;font-family:Arial,Helvetica,sans-serif;color:#111";
  const cell = "padding:6.5px 9px;border:1px solid #999;font-size:17px";
  const levelsRows = stats.levels.map((l, i) => `<tr>
    <td style="${cell}">${esc(run.levels[i].level || `Level ${i + 1}`)}</td>
    <td style="${cell};text-align:center">${esc(run.levels[i].expected)}</td>
    <td style="${cell};text-align:center">${esc((run.levels[i].results || "").trim())}</td>
    <td style="${cell};text-align:center">${l.n}</td>
    <td style="${cell};text-align:center">${l.nAgree === null ? "--" : l.nAgree}</td>
    <td style="${cell};text-align:center">${l.pctAgreement === null ? "--" : fmtN(l.pctAgreement, 1) + "%"}</td>
    <td style="${cell};text-align:center;font-weight:${l.passed === "Fail" ? "700" : "400"};color:${l.passed === "Fail" ? "#b91c1c" : "#111"}">${esc(l.passed || "--")}</td>
  </tr>`).join("");
  const supportTable = `<table style="width:100%;border-collapse:collapse;font-size:17px">
    <tr><td style="padding:3px 0;color:#333">Analyst</td><td style="padding:3px 0;text-align:right">${esc(run.analyst || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Expt Date</td><td style="padding:3px 0;text-align:right">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Instrument</td><td style="padding:3px 0;text-align:right">${esc(run.instrument || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Minimum %Agreement</td><td style="padding:3px 0;text-align:right">${run.allowablePct !== "" ? esc(run.allowablePct) + "%" : "--"}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Comment</td><td style="padding:3px 0;text-align:right">${esc(run.comment || "--")}</td></tr>
  </table>`;
  const branch = branchName(run.branchId);
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;margin-bottom:6.5px"><tr>
      <td style="vertical-align:top"><div style="font-size:26.5px;font-weight:800;letter-spacing:-0.2px;font-family:Arial,Helvetica,sans-serif">QR Evaluator</div>
        <div style="font-size:14.5px;color:#555;border-top:1px solid #333;padding-top:2.5px;margin-top:3px;display:inline-block">${esc(reportBrandLine(run))}</div></td>
      <td style="vertical-align:top;text-align:right"><div style="font-size:32px;font-weight:800">${esc(run.analyte || "")}</div>
        <div style="font-size:17px"><strong>Instrument</strong> ${esc(run.instrument || "")}</div></td>
    </tr></table>
    <div style="text-align:center;font-size:23px;font-weight:700;text-decoration:underline;margin:22px 0 28px">Qualitative Precision</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #999"><tr>
      <td style="width:36%;text-align:center;padding:18.5px;border-right:1px solid #ccc"><div style="font-weight:700;font-size:17px;margin-bottom:9px">%Agreement by Level</div>${buildQualAgreementChartSVG(stats.levels, run.levels, run.allowablePct)}</td>
      <td style="padding:18.5px">${supportTable}
        <div style="margin-top:18.5px;font-size:18.5px"><strong>Overall Result:</strong>
          <span style="font-weight:700;color:${stats.overall === "Fail" ? "#b91c1c" : stats.overall === "Pass" ? "#1a7a1a" : "#666"}">${esc(stats.overall || "--")}</span></div>
      </td>
    </tr></table>
    <table style="width:100%;border-collapse:collapse;margin-top:28px">
      <thead><tr style="font-weight:700"><td style="${cell};background:#f2f2f2">Level</td><td style="${cell};background:#f2f2f2;text-align:center">Expected</td><td style="${cell};background:#f2f2f2;text-align:center">Replicate Calls</td><td style="${cell};background:#f2f2f2;text-align:center">N</td><td style="${cell};background:#f2f2f2;text-align:center">Agree</td><td style="${cell};background:#f2f2f2;text-align:center">%Agreement</td><td style="${cell};background:#f2f2f2;text-align:center">Pass/Fail</td></tr></thead>
      <tbody>${levelsRows}</tbody>
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:71.5px"><tr>
      <td style="width:34%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.analyst || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Prepared by / Analyst${run.expDate ? " · " + esc(run.expDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.reviewedBy || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Reviewed by${run.reviewedDate ? " · " + esc(run.reviewedDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.acceptedBy || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Accepted by / Lab Director${run.acceptedDate ? " · " + esc(run.acceptedDate) : ""}</div></td>
    </tr></table>
    <div style="margin-top:40px;border-top:1px solid #ccc;padding-top:7px;font-size:14.5px;color:#666">
      <div style="display:flex;justify-content:space-between"><span>QR Evaluator&nbsp;&nbsp;1.0</span><span>Copyright &copy; 2026 QR Lab</span></div>
      <div style="display:flex;justify-content:space-between;margin-top:3px"><span>${esc(reportPrintedLine(run))}</span><span>Page 1</span></div>
    </div>`;
  document.body.appendChild(wrap);
  try {
    const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const margin = 10, maxW = pageW - margin * 2, maxH = pageH - margin * 2;
    const ratio = canvas.height / canvas.width;
    let drawW = maxW, drawH = drawW * ratio;
    if (drawH > maxH) { drawH = maxH; drawW = drawH / ratio; }
    const x = (pageW - drawW) / 2, y = margin;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", x, y, drawW, drawH);
    return pdf;
  } finally {
    document.body.removeChild(wrap);
  }
}
function qualPrecisionPdfFilename(run) {
  return `qual-precision_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderQualPrecisionView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", instrument: "", labDept: "DELTA MEDICAL LABORATORIES",
    analyst: state.user.email, expDate: todayStr(), comment: "", allowablePct: "95",
    levels: [QUAL_PREC_LEVEL_BLANK(), { level: "Near Cutoff", expected: "Positive", results: "" }, { level: "", expected: "Positive", results: "" }],
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.qualPrecisionRun || emptyRun();
  state.ui.qualPrecisionRun = run;
  const branchFilter = isMaster ? (state.ui.qualPrecisionBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !run.branchId || i.branchId === run.branchId).map((i) => i.name))];
  const employeeNames = employeeDisplayNames();
  const stats = qualPrecisionRunResultStats(run);

  const q = (state.ui.qualPrecisionSearch || "").trim().toLowerCase();
  const saved = [...state.qualPrecisionRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function levelRowHtml(lv, idx) {
    const s = stats.levels[idx] || {};
    return `<tr data-row="${idx}">
      <td><input data-f="level" data-i="${idx}" value="${esc(lv.level)}" style="width:100px" placeholder="e.g. Negative control" /></td>
      <td><select data-f="expected" data-i="${idx}"><option value="Positive" ${lv.expected === "Positive" ? "selected" : ""}>Positive</option><option value="Negative" ${lv.expected === "Negative" ? "selected" : ""}>Negative</option></select></td>
      <td><input class="mono" data-f="results" data-i="${idx}" value="${esc(lv.results)}" style="width:100%;min-width:280px;font-size:14.5px;padding:10px 12px" placeholder="e.g. Pos, Pos, Neg, Pos, Pos" /></td>
      <td class="mono" style="white-space:nowrap">${s.n === undefined || !s.n ? "—" : `${s.nAgree}/${s.n}`}</td>
      <td class="mono" style="white-space:nowrap">${s.pctAgreement === undefined || s.pctAgreement === null ? "—" : fmtN(s.pctAgreement, 1) + "%"}</td>
      <td>${s.passed ? `<span class="badge" style="background:${s.passed === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${s.passed === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(s.passed)}</span>` : "—"}</td>
      <td><button type="button" class="icon-btn-sm" data-rm-row="${idx}" title="Remove level"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkQp"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Qualitative Precision (QR Evaluator)</h2><span class="subtitle">Repeatability of Positive/Negative calls at each level against the expected result</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:24.5px"><select id="qpBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="qpBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="qpAnalyte" value="${esc(run.analyte)}" placeholder="e.g. HBsAg Rapid Test" />`)}
        ${fieldHtml("Instrument / Kit", `<input id="qpInstrument" list="qpInstruments" value="${esc(run.instrument)}" />`)}
      </div>
      ${fieldHtml("Minimum %Agreement", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="qpAllowable" value="${esc(run.allowablePct)}" placeholder="e.g. 95" style="max-width:200px" />`)}
      <datalist id="qpInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>

      <h4 style="margin:24.5px 0 12.5px;font-size:19.5px">Levels — test each a few times and list the calls (comma-separated)</h4>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Level</th><th>Expected</th><th>Replicate Calls</th><th>Agree</th><th>%Agreement</th><th>Pass/Fail</th><th></th></tr></thead>
        <tbody>${run.levels.map((lv, i) => levelRowHtml(lv, i)).join("")}</tbody>
      </table></div>
      <button type="button" class="btn secondary" id="qpAddLevel" style="margin:15.5px 0 28px"><i class="fa-solid fa-plus"></i> Add level</button>

      <div class="panel-card" style="margin-bottom:28px">
        <div class="panel-title">Overall Result</div>
        <div style="margin-top:12.5px">${stats.overall ? `<span class="badge" style="background:${stats.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${stats.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(stats.overall)}</span>` : "<span class=\"pick-empty\">Enter expected calls, replicate results, and minimum %Agreement to compute</span>"}</div>
        <div class="live-chart-row">
          <div class="live-chart-box" style="flex-basis:100%"><div class="live-chart-title">%Agreement by Level — spot which level is under target</div>${buildQualAgreementChartSVG(stats.levels, run.levels, run.allowablePct)}</div>
        </div>
      </div>

      <datalist id="qpEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="qpAnalyst" list="qpEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="qpExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      ${fieldHtml("Comment", `<input id="qpComment" value="${esc(run.comment)}" />`)}
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="qpReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="qpReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="qpAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="qpAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="qpReset">Clear form</button>
        <button type="button" class="btn primary" id="qpSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved qualitative precision runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="qpSearch" value="${esc(state.ui.qualPrecisionSearch || "")}" placeholder="Search by analyte, instrument, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Instrument</th><th>Branch</th><th>Levels</th><th>Result</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="8" class="table-empty">${q ? "No runs match your search" : "No saved qualitative precision runs yet"}</td></tr>` : saved.map((r) => {
        const s = qualPrecisionRunStats(r.levels, r.allowablePct);
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.instrument || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${(r.levels || []).length}</td>
          <td>${s.overall ? `<span class="badge" style="background:${s.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${s.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(s.overall)}</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-qp="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-qp="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-qp="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("qpBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.qualPrecisionBranch = e.target.value; renderQualPrecisionView(); };
  const qpBranchEl = el("qpBranch"); if (qpBranchEl) qpBranchEl.onchange = (e) => { run.branchId = e.target.value; renderQualPrecisionView(); };
  el("qpAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("qpInstrument").oninput = (e) => run.instrument = e.target.value;
  el("qpAllowable").oninput = (e) => { run.allowablePct = e.target.value; renderQualPrecisionView(); };
  el("qpAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("qpExpDate").oninput = (e) => run.expDate = e.target.value;
  el("qpComment").oninput = (e) => run.comment = e.target.value;
  el("qpReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("qpReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("qpAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("qpAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("qpAddLevel").onclick = () => { run.levels.push(QUAL_PREC_LEVEL_BLANK()); renderQualPrecisionView(); };
  el("mainContent").querySelectorAll("[data-rm-row]").forEach((btn) => btn.onclick = () => {
    run.levels.splice(Number(btn.dataset.rmRow), 1);
    if (run.levels.length === 0) run.levels.push(QUAL_PREC_LEVEL_BLANK());
    renderQualPrecisionView();
  });
  el("mainContent").querySelectorAll("[data-f]").forEach((input) => {
    const i = Number(input.dataset.i), f = input.dataset.f;
    if (input.tagName === "SELECT") input.onchange = (e) => { run.levels[i][f] = e.target.value; renderQualPrecisionView(); };
    else { input.oninput = (e) => { run.levels[i][f] = e.target.value; }; input.onblur = () => renderQualPrecisionView(); }
  });
  attachExcelPasteObjects(el("mainContent"), 'input[data-f="level"], input[data-f="results"]', run.levels, ["level", "expected", "results"], QUAL_PREC_LEVEL_BLANK, renderQualPrecisionView);
  el("qpSearch").oninput = (e) => {
    state.ui.qualPrecisionSearch = e.target.value;
    renderQualPrecisionView();
    const refocused = el("qpSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("qpReset").onclick = () => { state.ui.qualPrecisionRun = emptyRun(); renderQualPrecisionView(); };
  const epBackLinkQpEl = el("epBackLinkQp"); if (epBackLinkQpEl) epBackLinkQpEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-qp]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.qualPrecisionRuns.find((r) => r.id === btn.dataset.openQp);
    if (savedRun) { state.ui.qualPrecisionRun = JSON.parse(JSON.stringify(savedRun)); renderQualPrecisionView(); }
  });
  el("mainContent").querySelectorAll("[data-del-qp]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved qualitative precision run?")) deleteQualPrecisionRun(btn.dataset.delQp); });
  el("mainContent").querySelectorAll("[data-dl-qp]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.qualPrecisionRuns.find((r) => r.id === btn.dataset.dlQp);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderQualPrecisionPdf(savedRun); pdf.save(qualPrecisionPdfFilename(savedRun)); }
    catch (err) { console.error("Qualitative Precision PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("qpSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderQualPrecisionPdf(run);
      pdf.save(qualPrecisionPdfFilename(run));
      const saveResult = await saveQualPrecisionRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.qualPrecisionRun = emptyRun();
      renderQualPrecisionView();
    } catch (err) {
      console.error("Qualitative Precision save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Qualitative Method Comparison (QR Evaluator style — Sensitivity,
   Specificity, Overall Percent Agreement, Kappa off a 2x2 table)
--------------------------------------------------------------------- */
const QUAL_CMP_PAIR_BLANK = () => ({ id: "", newResult: "Positive", refResult: "Positive" });

async function saveQualComparisonRun(data) { return saveEpRunGuarded("qualComparisonRuns", data, "analyte"); }
async function deleteQualComparisonRun(id) {
  const qc = state.qualComparisonRuns.find((x) => x.id === id);
  await db.collection("qualComparisonRuns").doc(id).delete();
  logAudit("delete_qual_comparison_run", qc ? (qc.analyte || id) : id, qc ? `run ${qc.expDate || ""}` : "");
}
function qualComparisonRunResultStats(run) { return qualComparisonStats(run.pairs, { minAgreementPct: run.minAgreementPct }); }

/** SVG recreation of an QR Evaluator-style bar chart comparing Sensitivity, Specificity, and
 *  Overall Percent Agreement against the minimum-agreement line — the qualitative equivalent of
 *  the quantitative report's Goal/TEa line. */
function buildQualComparisonChartSVG(stats, minAgreementPct) {
  const allowable = minAgreementPct !== "" && minAgreementPct != null && !isNaN(Number(minAgreementPct)) ? Number(minAgreementPct) : null;
  const bars = [
    { label: "Sensitivity", v: stats.sensitivity }, { label: "Specificity", v: stats.specificity }, { label: "OPA", v: stats.opa },
  ];
  const x0 = 40, xw = 250, y0 = 14, yh = 170;
  const yAt = (v) => y0 + yh - (v / 100) * yh;
  const barW = 40;
  let ticksY = "";
  for (let t = 0; t <= 100; t += 25) ticksY += `<line x1="34" y1="${yAt(t)}" x2="${x0}" y2="${yAt(t)}" stroke="#1a1a1a" stroke-width="1.1" /><text x="30" y="${yAt(t) + 4}" font-size="13" text-anchor="end" fill="#1a1a1a">${t}%</text>`;
  const allowHtml = allowable !== null ? `<line x1="${x0}" y1="${yAt(allowable)}" x2="${xw}" y2="${yAt(allowable)}" stroke="#c0392b" stroke-width="1.2" stroke-dasharray="5,3" /><text x="${xw - 2}" y="${yAt(allowable) - 5}" font-size="12.5" text-anchor="end" fill="#c0392b">Min ${allowable}%</text>` : "";
  const barsHtml = bars.map((b, i) => {
    if (b.v === null) return "";
    const cx = x0 + (xw - x0) * ((i + 1) / (bars.length + 1));
    const color = allowable !== null && b.v < allowable ? "#c0392b" : "#2e7d32";
    return `<rect x="${cx - barW / 2}" y="${yAt(b.v)}" width="${barW}" height="${Math.max(yAt(0) - yAt(b.v), 1)}" fill="${color}" opacity="0.78" />
      <text x="${cx}" y="${y0 + yh + 14}" font-size="12.5" text-anchor="middle" fill="#1a1a1a">${b.label}</text>`;
  }).join("");
  return `<svg viewBox="0 0 260 200" width="299" height="230" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" /><line x1="${x0}" y1="${y0 + yh}" x2="${xw}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" />
    ${ticksY}${allowHtml}${barsHtml}
  </svg>`;
}

async function renderQualComparisonPdf(run) {
  const stats = qualComparisonRunResultStats(run);
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-9999px;top:0;width:900px;background:#fff;padding:46.5px 53px;font-family:Arial,Helvetica,sans-serif;color:#111";
  const cell = "padding:6.5px 9px;border:1px solid #999;font-size:17px";
  const twoByTwo = `<table style="width:100%;border-collapse:collapse;font-size:17px;text-align:center">
    <tr><td></td><td style="font-weight:700;padding:6.5px">Ref +</td><td style="font-weight:700;padding:6.5px">Ref -</td></tr>
    <tr><td style="font-weight:700;padding:6.5px">New +</td><td style="${cell};background:#eaf6e3">${stats.a}</td><td style="${cell};background:#fdecea">${stats.b}</td></tr>
    <tr><td style="font-weight:700;padding:6.5px">New -</td><td style="${cell};background:#fdecea">${stats.c}</td><td style="${cell};background:#eaf6e3">${stats.d}</td></tr>
  </table>`;
  const keyStatsTable = `<table style="width:100%;border-collapse:collapse;font-size:17px">
    <tr><td style="padding:3px 0;color:#333">Sensitivity (PPA)</td><td style="padding:3px 0;text-align:right">${fmtN(stats.sensitivity, 1)}% ${stats.ciSens ? `(${fmtN(stats.ciSens.low, 1)}–${fmtN(stats.ciSens.high, 1)}%)` : ""}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Specificity (NPA)</td><td style="padding:3px 0;text-align:right">${fmtN(stats.specificity, 1)}% ${stats.ciSpec ? `(${fmtN(stats.ciSpec.low, 1)}–${fmtN(stats.ciSpec.high, 1)}%)` : ""}</td></tr>
    <tr><td style="padding:3px 0;color:#333">PPV</td><td style="padding:3px 0;text-align:right">${fmtN(stats.ppv, 1)}%</td></tr>
    <tr><td style="padding:3px 0;color:#333">NPV</td><td style="padding:3px 0;text-align:right">${fmtN(stats.npv, 1)}%</td></tr>
    <tr><td style="padding:3px 0;color:#333">Overall Percent Agreement</td><td style="padding:3px 0;text-align:right">${fmtN(stats.opa, 1)}% ${stats.ciOpa ? `(${fmtN(stats.ciOpa.low, 1)}–${fmtN(stats.ciOpa.high, 1)}%)` : ""}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Cohen's Kappa</td><td style="padding:3px 0;text-align:right">${fmtN(stats.kappa, 3)}</td></tr>
    <tr><td style="padding:3px 0;color:#333">N (Equivocal excluded)</td><td style="padding:3px 0;text-align:right">${stats.n}${stats.nExcluded ? ` (${stats.nExcluded} excluded)` : ""}</td></tr>
  </table>`;
  const evalText = `${esc(run.analyte || "This analyte")} was compared between ${esc(run.newMethod || "the new method")} and the reference method ${esc(run.refMethod || "")} on ${stats.n} specimens${stats.nExcluded ? ` (${stats.nExcluded} equivocal specimens excluded)` : ""}. Sensitivity was ${fmtN(stats.sensitivity, 1)}% and Specificity was ${fmtN(stats.specificity, 1)}%, for an Overall Percent Agreement of ${fmtN(stats.opa, 1)}% (Kappa ${fmtN(stats.kappa, 3)}). ${stats.overall ? `The test ${stats.overall === "Pass" ? "Passed" : "Failed"} against the minimum agreement specification of ${esc(run.minAgreementPct)}%.` : ""}`;
  const pairRows = (run.pairs || []).map((p, i) => `<td style="${cell}">${esc(p.id || i + 1)}</td><td style="${cell};text-align:center">${esc(p.newResult)}</td><td style="${cell};text-align:center">${esc(p.refResult)}</td>`);
  let resultsRows = "";
  for (let i = 0; i < pairRows.length; i += 3) {
    resultsRows += `<tr>${pairRows[i] || "<td></td><td></td><td></td>"}${pairRows[i + 1] ? `<td style="width:8px;border:none"></td>${pairRows[i + 1]}` : ""}${pairRows[i + 2] ? `<td style="width:8px;border:none"></td>${pairRows[i + 2]}` : ""}</tr>`;
  }
  const branch = branchName(run.branchId);
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;margin-bottom:6.5px"><tr>
      <td style="vertical-align:top"><div style="font-size:26.5px;font-weight:800;letter-spacing:-0.2px;font-family:Arial,Helvetica,sans-serif">QR Evaluator</div>
        <div style="font-size:14.5px;color:#555;border-top:1px solid #333;padding-top:2.5px;margin-top:3px;display:inline-block">${esc(reportBrandLine(run))}</div></td>
      <td style="vertical-align:top;text-align:right"><div style="font-size:32px;font-weight:800">${esc(run.analyte || "")}</div></td>
    </tr></table>
    <div style="text-align:center;font-size:23px;font-weight:700;margin:9px 0 3px">Qualitative Method Comparison</div>
    <div style="text-align:center;font-size:17px;margin-bottom:22px"><strong>New Method</strong> ${esc(run.newMethod || "")} &nbsp;&nbsp;&nbsp; <strong>Reference Method</strong> ${esc(run.refMethod || "")}</div>
    <table style="width:100%;border-collapse:collapse"><tr>
      <td style="width:36%;text-align:center;padding:9px;vertical-align:top">
        <div style="font-weight:700;font-size:17px;margin-bottom:9px">2×2 Table</div>${twoByTwo}
        <div style="font-weight:700;font-size:17px;margin:22px 0 9px">Agreement by Metric</div>${buildQualComparisonChartSVG(stats, run.minAgreementPct)}
      </td>
      <td style="padding:9px;vertical-align:top">${keyStatsTable}
        <div style="margin-top:18.5px;font-size:18.5px"><strong>Overall Result:</strong>
          <span style="font-weight:700;color:${stats.overall === "Fail" ? "#b91c1c" : stats.overall === "Pass" ? "#1a7a1a" : "#666"}">${esc(stats.overall || "--")}</span></div>
      </td>
    </tr></table>
    <div style="font-weight:700;font-size:18.5px;margin:22px 0 6.5px">Evaluation of Results</div>
    <div style="font-size:17px;line-height:1.5">${evalText}</div>
    <div style="font-weight:700;font-size:18.5px;text-align:center;margin:31px 0 12.5px">Experimental Results</div>
    <table style="width:100%;border-collapse:collapse"><thead><tr>
      <td style="${cell};background:#f2f2f2;font-weight:700">Specimen</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">New</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Ref</td>
      <td style="width:8px;border:none"></td><td style="${cell};background:#f2f2f2;font-weight:700">Specimen</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">New</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Ref</td>
      <td style="width:8px;border:none"></td><td style="${cell};background:#f2f2f2;font-weight:700">Specimen</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">New</td><td style="${cell};background:#f2f2f2;font-weight:700;text-align:center">Ref</td>
    </tr></thead><tbody>${resultsRows}</tbody></table>
    <table style="width:100%;border-collapse:collapse;margin-top:62px"><tr>
      <td style="width:34%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.analyst || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Prepared by / Analyst${run.expDate ? " · " + esc(run.expDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.reviewedBy || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Reviewed by${run.reviewedDate ? " · " + esc(run.reviewedDate) : ""}</div></td>
      <td style="width:33%"><div style="border-bottom:1px solid #111;font-style:italic;font-size:18px;padding-bottom:2.5px;min-height:20px">${esc(run.acceptedBy || "")}</div>
        <div style="font-size:13px;color:#555;margin-top:3px">Accepted by / Lab Director${run.acceptedDate ? " · " + esc(run.acceptedDate) : ""}</div></td>
    </tr></table>
    <div style="margin-top:31px;border-top:1px solid #ccc;padding-top:7px;font-size:14.5px;color:#666">
      <div style="display:flex;justify-content:space-between"><span>QR Evaluator&nbsp;&nbsp;1.0</span><span>Copyright &copy; 2026 QR Lab</span></div>
      <div style="display:flex;justify-content:space-between;margin-top:3px"><span>${esc(reportPrintedLine(run))}</span><span>Page 1</span></div>
    </div>`;
  document.body.appendChild(wrap);
  try {
    const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const margin = 10, maxW = pageW - margin * 2, maxH = pageH - margin * 2;
    const ratio = canvas.height / canvas.width;
    let drawW = maxW, drawH = drawW * ratio;
    if (drawH > maxH) { drawH = maxH; drawW = drawH / ratio; }
    const x = (pageW - drawW) / 2, y = margin;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", x, y, drawW, drawH);
    return pdf;
  } finally {
    document.body.removeChild(wrap);
  }
}
function qualComparisonPdfFilename(run) {
  return `qual-comparison_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderQualComparisonView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", newMethod: "", refMethod: "", labDept: "DELTA MEDICAL LABORATORIES",
    analyst: state.user.email, expDate: todayStr(), comment: "", minAgreementPct: "90",
    pairs: Array.from({ length: 6 }, () => QUAL_CMP_PAIR_BLANK()),
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.qualComparisonRun || emptyRun();
  state.ui.qualComparisonRun = run;
  const branchFilter = isMaster ? (state.ui.qualComparisonBranch || "") : (myBranch || "");
  const employeeNames = employeeDisplayNames();
  const stats = qualComparisonRunResultStats(run);

  const q = (state.ui.qualComparisonSearch || "").trim().toLowerCase();
  const saved = [...state.qualComparisonRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.newMethod, r.refMethod, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const resultOptions = (val) => `<option value="Positive" ${val === "Positive" ? "selected" : ""}>Positive</option><option value="Negative" ${val === "Negative" ? "selected" : ""}>Negative</option><option value="Equivocal" ${val === "Equivocal" ? "selected" : ""}>Equivocal</option>`;
  function pairRowHtml(p, idx) {
    return `<tr data-row="${idx}">
      <td><input data-f="id" data-i="${idx}" value="${esc(p.id)}" style="width:90px" placeholder="Specimen ID" /></td>
      <td><select data-f="newResult" data-i="${idx}">${resultOptions(p.newResult)}</select></td>
      <td><select data-f="refResult" data-i="${idx}">${resultOptions(p.refResult)}</select></td>
      <td><button type="button" class="icon-btn-sm" data-rm-row="${idx}" title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkQc"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Qualitative Comparison (QR Evaluator)</h2><span class="subtitle">New method vs a reference method — Sensitivity, Specificity, Overall Percent Agreement &amp; Kappa off a 2×2 table</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:24.5px"><select id="qcBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="qcBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="qcAnalyte" value="${esc(run.analyte)}" placeholder="e.g. HBsAg" />`)}
        ${fieldHtml("Minimum Agreement %", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="qcMinAgreement" value="${esc(run.minAgreementPct)}" placeholder="e.g. 90" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("New Method *", `<input id="qcNewMethod" value="${esc(run.newMethod)}" placeholder="e.g. Rapid Card Test" />`)}
        ${fieldHtml("Reference Method *", `<input id="qcRefMethod" value="${esc(run.refMethod)}" placeholder="e.g. ELISA (reference lab)" />`)}
      </div>

      <h4 style="margin:24.5px 0 12.5px;font-size:19.5px">Paired Results</h4>
      <div style="font-size:17px;color:var(--text-faint);margin-bottom:12.5px">Tip: copy a column of specimen IDs from Excel and paste into the first Specimen ID box — it fills the whole list down (Positive/Negative/Equivocal are picked from the dropdowns).</div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Specimen ID</th><th>New Method</th><th>Reference Method</th><th></th></tr></thead>
        <tbody>${run.pairs.map((p, i) => pairRowHtml(p, i)).join("")}</tbody>
      </table></div>
      <button type="button" class="btn secondary" id="qcAddRow" style="margin:15.5px 0 28px"><i class="fa-solid fa-plus"></i> Add pair</button>

      <div class="panel-card" style="margin-bottom:28px">
        <div class="panel-title">Statistics (live preview)</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:12.5px">
          <div><span class="field-label">2×2 (New＋/Ref＋, New＋/Ref−, New−/Ref＋, New−/Ref−)</span><div class="mono">${stats.a} / ${stats.b} / ${stats.c} / ${stats.d}</div></div>
          <div><span class="field-label">Sensitivity</span><div class="mono">${fmtN(stats.sensitivity, 1)}%</div></div>
          <div><span class="field-label">Specificity</span><div class="mono">${fmtN(stats.specificity, 1)}%</div></div>
          <div><span class="field-label">OPA</span><div class="mono">${fmtN(stats.opa, 1)}%</div></div>
          <div><span class="field-label">Kappa</span><div class="mono">${fmtN(stats.kappa, 3)}</div></div>
          <div><span class="field-label">Result</span><div>${stats.overall ? `<span class="badge" style="background:${stats.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${stats.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(stats.overall)}</span>` : "—"}</div></div>
        </div>
        <div class="live-chart-row">
          <div class="live-chart-box" style="flex-basis:100%"><div class="live-chart-title">Agreement by Metric</div>${buildQualComparisonChartSVG(stats, run.minAgreementPct)}</div>
        </div>
      </div>

      <datalist id="qcEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="qcAnalyst" list="qcEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="qcExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      ${fieldHtml("Comment", `<input id="qcComment" value="${esc(run.comment)}" />`)}
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="qcReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="qcReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="qcAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="qcAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="qcReset">Clear form</button>
        <button type="button" class="btn primary" id="qcSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved qualitative comparison runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="qcSearch" value="${esc(state.ui.qualComparisonSearch || "")}" placeholder="Search by analyte, method, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>New / Ref Method</th><th>Branch</th><th>N</th><th>OPA</th><th>Result</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="9" class="table-empty">${q ? "No runs match your search" : "No saved qualitative comparison runs yet"}</td></tr>` : saved.map((r) => {
        const s = qualComparisonRunResultStats(r);
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.newMethod || "—")} / ${esc(r.refMethod || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${s.n}</td><td class="mono">${fmtN(s.opa, 1)}%</td>
          <td>${s.overall ? `<span class="badge" style="background:${s.overall === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${s.overall === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(s.overall)}</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-qc="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-qc="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-qc="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("qcBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.qualComparisonBranch = e.target.value; renderQualComparisonView(); };
  const qcBranchEl = el("qcBranch"); if (qcBranchEl) qcBranchEl.onchange = (e) => { run.branchId = e.target.value; renderQualComparisonView(); };
  el("qcAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("qcMinAgreement").oninput = (e) => { run.minAgreementPct = e.target.value; renderQualComparisonView(); };
  el("qcNewMethod").oninput = (e) => run.newMethod = e.target.value;
  el("qcRefMethod").oninput = (e) => run.refMethod = e.target.value;
  el("qcAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("qcExpDate").oninput = (e) => run.expDate = e.target.value;
  el("qcComment").oninput = (e) => run.comment = e.target.value;
  el("qcReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("qcReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("qcAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("qcAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("qcAddRow").onclick = () => { run.pairs.push(QUAL_CMP_PAIR_BLANK()); renderQualComparisonView(); };
  el("mainContent").querySelectorAll('input[data-f="id"]').forEach((input) => {
    input.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (!text || !/[\n\t]/.test(text)) return;
      e.preventDefault();
      const startRow = Number(input.dataset.i);
      const vals = text.replace(/\r/g, "").split(/[\n\t]/).map((v) => v.trim());
      if (vals.length && vals[vals.length - 1] === "") vals.pop();
      vals.forEach((v, i) => { const idx = startRow + i; while (run.pairs.length <= idx) run.pairs.push(QUAL_CMP_PAIR_BLANK()); run.pairs[idx].id = v; });
      renderQualComparisonView();
    });
  });
  el("mainContent").querySelectorAll("[data-rm-row]").forEach((btn) => btn.onclick = () => {
    run.pairs.splice(Number(btn.dataset.rmRow), 1);
    if (run.pairs.length === 0) run.pairs.push(QUAL_CMP_PAIR_BLANK());
    renderQualComparisonView();
  });
  el("mainContent").querySelectorAll("[data-f]").forEach((input) => {
    const i = Number(input.dataset.i), f = input.dataset.f;
    if (input.tagName === "SELECT") input.onchange = (e) => { run.pairs[i][f] = e.target.value; renderQualComparisonView(); };
    else { input.oninput = (e) => { run.pairs[i][f] = e.target.value; }; input.onblur = () => renderQualComparisonView(); }
  });
  el("qcSearch").oninput = (e) => {
    state.ui.qualComparisonSearch = e.target.value;
    renderQualComparisonView();
    const refocused = el("qcSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("qcReset").onclick = () => { state.ui.qualComparisonRun = emptyRun(); renderQualComparisonView(); };
  const epBackLinkQcEl = el("epBackLinkQc"); if (epBackLinkQcEl) epBackLinkQcEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-qc]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.qualComparisonRuns.find((r) => r.id === btn.dataset.openQc);
    if (savedRun) { state.ui.qualComparisonRun = JSON.parse(JSON.stringify(savedRun)); renderQualComparisonView(); }
  });
  el("mainContent").querySelectorAll("[data-del-qc]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved qualitative comparison run?")) deleteQualComparisonRun(btn.dataset.delQc); });
  el("mainContent").querySelectorAll("[data-dl-qc]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.qualComparisonRuns.find((r) => r.id === btn.dataset.dlQc);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderQualComparisonPdf(savedRun); pdf.save(qualComparisonPdfFilename(savedRun)); }
    catch (err) { console.error("Qualitative Comparison PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("qcSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderQualComparisonPdf(run);
      pdf.save(qualComparisonPdfFilename(run));
      const saveResult = await saveQualComparisonRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.qualComparisonRun = emptyRun();
      renderQualComparisonView();
    } catch (err) {
      console.error("Qualitative Comparison save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Reference Interval Verification (QR Evaluator — CLSI EP28)
--------------------------------------------------------------------- */
async function saveReferenceIntervalRun(data) { return saveEpRunGuarded("referenceIntervalRuns", data, "analyte"); }
async function deleteReferenceIntervalRun(id) {
  const rr = state.referenceIntervalRuns.find((x) => x.id === id);
  await db.collection("referenceIntervalRuns").doc(id).delete();
  logAudit("delete_reference_interval_run", rr ? (rr.analyte || id) : id, rr ? `run ${rr.expDate || ""}` : "");
}
function referenceIntervalRunStats(run) { return referenceIntervalStats(run.results, run.proposedLow, run.proposedHigh, run.maxOutsidePct); }

/** SVG histogram of the reference-population results with the proposed [low, high] range marked —
 *  same visual role as the report's Reference Interval Histogram. */
/** Splits the reference population into "< low", `n` equal sub-intervals of [low, high], and
 *  "> high" buckets — same shape as the report's "Reference Interval Histogram" / "Results
 *  Distribution" table (e.g. "35.00-37.42 ... 5% ... 1"). Shared by the histogram SVG and the
 *  Results Distribution table so the two always agree. */
function referenceIntervalBuckets(vals, low, high, n) {
  n = n || 7;
  if (low == null || high == null || !vals.length) return [];
  const step = (high - low) / n;
  const rows = [{ label: `&lt; ${fmtN(low, 2)}`, count: vals.filter((v) => v < low).length }];
  for (let i = 0; i < n; i++) {
    const lo = low + i * step, hi = low + (i + 1) * step;
    rows.push({ label: `${fmtN(lo, 2)}-${fmtN(hi, 2)}`, count: vals.filter((v) => v >= lo && (i === n - 1 ? v <= hi : v < hi)).length });
  }
  rows.push({ label: `&gt; ${fmtN(high, 2)}`, count: vals.filter((v) => v > high).length });
  const total = vals.length || 1;
  return rows.map((r) => ({ ...r, pct: Math.round((r.count / total) * 100) }));
}

function buildRefHistogramSVG(buckets) {
  if (!buckets.length) return `<svg viewBox="0 0 260 160" width="299" height="184"></svg>`;
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const x0 = 34, y0 = 10, xw = 220, yh = 120;
  const barW = xw / buckets.length;
  const bars = buckets.map((b, i) => {
    const h = (b.count / maxCount) * yh;
    return `<rect x="${x0 + i * barW + 2}" y="${y0 + yh - h}" width="${barW - 4}" height="${h}" fill="#3355a8" />`;
  }).join("");
  return `<svg viewBox="0 0 260 175" width="299" height="201" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0 + yh}" x2="${x0 + xw}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" /><line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" />
    ${bars}
    <text x="${x0 + xw / 2}" y="${y0 + yh + 24}" font-size="13" text-anchor="middle" fill="#1a1a1a">Percent</text>
  </svg>`;
}

async function renderReferenceIntervalPdf(run) {
  const stats = referenceIntervalRunStats(run);
  const vals = (run.results || []).map(Number).filter((v) => !isNaN(v));
  const buckets = referenceIntervalBuckets(vals, stats.low, stats.high);
  const refTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="padding:4.5px 0;color:#333">Proposed</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.low, 2)} to ${fmtN(stats.high, 2)} ${esc(run.units || "")}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Results (Total/Excl)</td><td style="padding:4.5px 0;text-align:right">${stats.n} / 0</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Max/Obs outside</td><td style="padding:4.5px 0;text-align:right">${esc(run.maxOutsidePct || "10")}.0% / ${stats.pctOutside === null ? "--" : fmtN(stats.pctOutside, 1)}%</td></tr>
    <tr><td style="padding:4.5px 0;color:#333;font-weight:700">Passes</td><td style="padding:4.5px 0;text-align:right;font-weight:700;color:${stats.passed === "Fail" ? "#b91c1c" : "#1a7a1a"}">${esc(stats.passed || "--")}</td></tr>
  </table>`;
  const analysisTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="padding:4.5px 0;color:#333">Mean</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.mean, 3)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">SD</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.sd, 3)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Median</td><td style="padding:4.5px 0;text-align:right">${fmtN(stats.median, 3)}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Range</td><td style="padding:4.5px 0;text-align:right">${stats.range ? fmtN(stats.range.low, 2) + " to " + fmtN(stats.range.high, 2) : "--"}</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Central 95% Interval</td><td style="padding:4.5px 0;text-align:right">--</td></tr>
    <tr><td style="padding:4.5px 0;color:#333">Central 95% Index</td><td style="padding:4.5px 0;text-align:right">--</td></tr>
  </table>`;
  const distTable = `<table style="width:100%;border-collapse:collapse;font-size:18px">
    <tr style="font-weight:700"><td style="padding:4.5px 12.5px 4.5px 0">Interval</td><td style="padding:4.5px 12.5px;text-align:center">Percent</td><td style="padding:4.5px 0;text-align:center">Count</td></tr>
    ${buckets.map((b) => `<tr><td style="padding:3px 12.5px 3px 0">${b.label}</td><td style="padding:3px 12.5px;text-align:center">${b.pct}</td><td style="padding:3px 0;text-align:center">${b.count}</td></tr>`).join("")}
  </table>`;
  const resultRows = vals.map((v, i) => `<td style="padding:6.5px 12.5px;border:1px solid #999;font-size:18.5px">S${String(i + 1).padStart(5, "0")}</td><td style="padding:6.5px 12.5px;border:1px solid #999;font-size:18.5px;text-align:center">${v}</td>`);
  let resultsHtml = "";
  for (let i = 0; i < resultRows.length; i += 5) {
    resultsHtml += `<tr>${resultRows.slice(i, i + 5).map((c) => c).join("<td style='width:6px;border:none'></td>")}</tr>`;
  }
  const branch = branchName(run.branchId);
  const headerHtml = reportHeaderHtml(run, "Verification of Reference Interval", [
    `<strong>Instrument</strong> ${esc(run.instrument || "")}`,
  ], "", "centered-plain") + `<div style="font-size:18.5px;margin:-10px 0 12px"><strong>Analyst</strong> ${esc(run.analyst || "--")} &nbsp;&nbsp;&nbsp; <strong>Date</strong> ${esc(run.expDate || "--")}</div>`;
  const sections = [
    `<div style="font-weight:700;font-size:18.5px;margin-bottom:6.5px">Reference Interval</div>
    <table style="width:100%;border-collapse:collapse"><tr>
      <td style="width:50%;vertical-align:top;padding-right:16px">${refTable}</td>
      <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18.5px;margin-bottom:6.5px">Statistical Analysis</div>${analysisTable}</td>
    </tr></table>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:24.5px"><tr>
      <td style="width:44%;vertical-align:top;padding-right:16px"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Reference Interval Histogram</div>${buildRefHistogramSVG(buckets)}</td>
      <td style="vertical-align:top;padding-top:25.5px"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Results Distribution</div>${distTable}</td>
    </tr></table>`,
    `<div style="font-weight:700;font-size:19px;text-align:center;margin:34px 0 15.5px">Experimental Results</div>
    <table style="width:100%;border-collapse:collapse">${resultsHtml}</table>`,
    reportSignatureHtml(run),
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run) });
}
function referenceIntervalPdfFilename(run) {
  return `reference-interval_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderReferenceIntervalView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", instrument: "", labDept: "DELTA MEDICAL LABORATORIES",
    analyst: state.user.email, expDate: todayStr(), units: "", comment: "",
    proposedLow: "", proposedHigh: "", maxOutsidePct: "10", results: Array(20).fill(""),
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.referenceIntervalRun || emptyRun();
  state.ui.referenceIntervalRun = run;
  const branchFilter = isMaster ? (state.ui.referenceIntervalBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !run.branchId || i.branchId === run.branchId).map((i) => i.name))];
  const employeeNames = employeeDisplayNames();
  const stats = referenceIntervalRunStats(run);

  const q = (state.ui.referenceIntervalSearch || "").trim().toLowerCase();
  const saved = [...state.referenceIntervalRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkRi"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Reference Interval (QR Evaluator)</h2><span class="subtitle">CLSI EP28 — verify a proposed reference range against your own reference-population results</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:24.5px"><select id="riBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="riBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="riAnalyte" value="${esc(run.analyte)}" placeholder="e.g. ALBUMIN" />`)}
        ${fieldHtml("Instrument", `<input id="riInstrument" list="riInstruments" value="${esc(run.instrument)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Units", `<input id="riUnits" list="labUnitsList" value="${esc(run.units)}" placeholder="e.g. g/L" />${labUnitsDatalistHtml()}`)}
        ${fieldHtml("Proposed Low", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="riLow" value="${esc(run.proposedLow)}" />`)}
        ${fieldHtml("Proposed High", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="riHigh" value="${esc(run.proposedHigh)}" />`)}
        ${fieldHtml("Max % Outside", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="riMaxOutside" value="${esc(run.maxOutsidePct)}" placeholder="e.g. 10" />`)}
      </div>
      <datalist id="riInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>

      <h4 style="margin:24.5px 0 6.5px;font-size:19.5px">Reference Population Results</h4>
      <div style="font-size:17px;color:var(--text-faint);margin-bottom:9px">Tip: copy a column of results from Excel and paste it into the first Result box — it fills the rest.</div>
      <div class="table-wrap"><table class="data-table"><thead><tr>${run.results.map((_, i) => i % 5 === 0 ? "<th>#</th><th>Result</th>" : "").join("")}</tr></thead>
        <tbody><tr>${run.results.map((v, i) => `<td class="mono">${i + 1}</td><td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-ri-i="${i}" value="${esc(v)}" style="width:80px" /></td>`).join("")}</tr></tbody>
      </table></div>
      <button type="button" class="btn secondary" id="riAddResult" style="margin-top:15.5px"><i class="fa-solid fa-plus"></i> Add result</button>

      <div class="panel-card" style="margin:28px 0">
        <div class="panel-title">Statistics (live preview)</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:12.5px">
          <div><span class="field-label">N</span><div class="mono">${stats.n}</div></div>
          <div><span class="field-label">Mean</span><div class="mono">${fmtN(stats.mean, 3)}</div></div>
          <div><span class="field-label">SD</span><div class="mono">${fmtN(stats.sd, 3)}</div></div>
          <div><span class="field-label">Median</span><div class="mono">${fmtN(stats.median, 3)}</div></div>
          <div><span class="field-label">N / % Outside</span><div class="mono">${stats.nOutside === null ? "—" : `${stats.nOutside} / ${fmtN(stats.pctOutside, 1)}%`}</div></div>
          <div><span class="field-label">Result</span><div>${stats.passed ? `<span class="badge" style="background:${stats.passed === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${stats.passed === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(stats.passed)}</span>` : "—"}</div></div>
        </div>
        <div class="live-chart-row">
          <div class="live-chart-box" style="flex-basis:100%"><div class="live-chart-title">Histogram — spot results outside the proposed range</div>${buildRefHistogramSVG(referenceIntervalBuckets((run.results || []).map(Number).filter((v) => !isNaN(v)), stats.low, stats.high))}</div>
        </div>
      </div>

      <datalist id="riEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="riAnalyst" list="riEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="riExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      ${fieldHtml("Comment", `<input id="riComment" value="${esc(run.comment)}" />`)}
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="riReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="riReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="riAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="riAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="riReset">Clear form</button>
        <button type="button" class="btn primary" id="riSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved reference interval runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="riSearch" value="${esc(state.ui.referenceIntervalSearch || "")}" placeholder="Search by analyte, instrument, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Instrument</th><th>Branch</th><th>N</th><th>Result</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="8" class="table-empty">${q ? "No runs match your search" : "No saved reference interval runs yet"}</td></tr>` : saved.map((r) => {
        const s = referenceIntervalRunStats(r);
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.instrument || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${s.n}</td>
          <td>${s.passed ? `<span class="badge" style="background:${s.passed === "Pass" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${s.passed === "Pass" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(s.passed)}</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-ri="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-ri="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-ri="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("riBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.referenceIntervalBranch = e.target.value; renderReferenceIntervalView(); };
  const riBranchEl = el("riBranch"); if (riBranchEl) riBranchEl.onchange = (e) => { run.branchId = e.target.value; renderReferenceIntervalView(); };
  el("riAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("riInstrument").oninput = (e) => run.instrument = e.target.value;
  el("riUnits").oninput = (e) => run.units = e.target.value;
  el("riLow").oninput = (e) => { run.proposedLow = e.target.value; renderReferenceIntervalView(); };
  el("riHigh").oninput = (e) => { run.proposedHigh = e.target.value; renderReferenceIntervalView(); };
  el("riMaxOutside").oninput = (e) => { run.maxOutsidePct = e.target.value; renderReferenceIntervalView(); };
  el("riAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("riExpDate").oninput = (e) => run.expDate = e.target.value;
  el("riComment").oninput = (e) => run.comment = e.target.value;
  el("riReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("riReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("riAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("riAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("riAddResult").onclick = () => { run.results.push(""); renderReferenceIntervalView(); };
  el("mainContent").querySelectorAll("[data-ri-i]").forEach((input) => {
    const i = Number(input.dataset.riI);
    input.oninput = (e) => { run.results[i] = e.target.value; };
    input.onblur = () => renderReferenceIntervalView();
  });
  attachExcelPasteFlat(el("mainContent"), "[data-ri-i]", run.results, (input) => Number(input.dataset.riI), renderReferenceIntervalView);
  el("riSearch").oninput = (e) => {
    state.ui.referenceIntervalSearch = e.target.value;
    renderReferenceIntervalView();
    const refocused = el("riSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("riReset").onclick = () => { state.ui.referenceIntervalRun = emptyRun(); renderReferenceIntervalView(); };
  const epBackLinkRiEl = el("epBackLinkRi"); if (epBackLinkRiEl) epBackLinkRiEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-ri]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.referenceIntervalRuns.find((r) => r.id === btn.dataset.openRi);
    if (savedRun) { state.ui.referenceIntervalRun = JSON.parse(JSON.stringify(savedRun)); renderReferenceIntervalView(); }
  });
  el("mainContent").querySelectorAll("[data-del-ri]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved reference interval run?")) deleteReferenceIntervalRun(btn.dataset.delRi); });
  el("mainContent").querySelectorAll("[data-dl-ri]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.referenceIntervalRuns.find((r) => r.id === btn.dataset.dlRi);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderReferenceIntervalPdf(savedRun); pdf.save(referenceIntervalPdfFilename(savedRun)); }
    catch (err) { console.error("Reference Interval PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("riSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderReferenceIntervalPdf(run);
      pdf.save(referenceIntervalPdfFilename(run));
      const saveResult = await saveReferenceIntervalRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.referenceIntervalRun = emptyRun();
      renderReferenceIntervalView();
    } catch (err) {
      console.error("Reference Interval save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Linearity (QR Evaluator — CLSI EP06)
--------------------------------------------------------------------- */
const LINEARITY_LEVEL_BLANK = () => ({ level: "", assigned: "", results: "" });

async function saveLinearityRun(data) { return saveEpRunGuarded("linearityRuns", data, "analyte"); }
async function deleteLinearityRun(id) {
  const lr = state.linearityRuns.find((x) => x.id === id);
  await db.collection("linearityRuns").doc(id).delete();
  logAudit("delete_linearity_run", lr ? (lr.analyte || id) : id, lr ? `run ${lr.expDate || ""}` : "");
}
function linearitySpecForStats(run) { return { seaMode: run.seaMode, seaValue: run.seaValue }; }
function linearityRunResultStats(run) { return linearityRunStats(run.levels, linearitySpecForStats(run)); }

/** SVG recreation of the report's Linearity Scatter Plot: assigned vs measured mean per level, a
 *  1:1 reference line, and the fitted line — same layout as the PDF. */
function buildLinearityScatterSVG(stats) {
  const pts = stats.levels.map((l, idx) => ({ ...l, idx })).filter((l) => l.assigned !== null && l.mean !== null);
  const maxVal = Math.max(10, ...pts.map((p) => p.assigned), ...pts.map((p) => p.mean)) * 1.08;
  const x0 = 38, y0 = 10, size = 132;
  const sx = (v) => x0 + (v / maxVal) * size;
  const sy = (v) => y0 + size - (v / maxVal) * size;
  const diag = `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(maxVal)}" y2="${sy(maxVal)}" stroke="#555" stroke-width="1.2" stroke-dasharray="3,3" />`;
  const fit = stats.slope !== null ? `<line x1="${sx(0)}" y1="${sy(stats.intercept)}" x2="${sx(maxVal)}" y2="${sy(stats.slope * maxVal + stats.intercept)}" stroke="#c0392b" stroke-width="1.1" />` : "";
  const dots = pts.map((p) => `<circle data-pt="${p.idx}" data-fill="#1a3d8f" data-r="2.6" cx="${sx(p.assigned)}" cy="${sy(p.mean)}" r="2.6" fill="#1a3d8f" />`).join("");
  let ticks = "";
  const step = Math.ceil(maxVal / 5 / 10) * 10 || Math.ceil(maxVal / 5) || 1;
  for (let t = 0; t <= maxVal; t += step) {
    ticks += `<line x1="${sx(t)}" y1="${y0 + size}" x2="${sx(t)}" y2="${y0 + size + 4}" stroke="#1a1a1a" stroke-width="1.1" /><text x="${sx(t)}" y="${y0 + size + 14}" font-size="11.5" text-anchor="middle" fill="#1a1a1a">${t}</text>`;
    ticks += `<line x1="${x0 - 4}" y1="${sy(t)}" x2="${x0}" y2="${sy(t)}" stroke="#1a1a1a" stroke-width="1.1" /><text x="${x0 - 6}" y="${sy(t) + 3}" font-size="11.5" text-anchor="end" fill="#1a1a1a">${t}</text>`;
  }
  return `<svg viewBox="0 0 200 168" width="230" height="193" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + size}" stroke="#1a1a1a" stroke-width="1.1" /><line x1="${x0}" y1="${y0 + size}" x2="${x0 + size}" y2="${y0 + size}" stroke="#1a1a1a" stroke-width="1.1" />
    ${diag}${fit}${ticks}${dots}
    <text x="${x0 + size / 2}" y="${y0 + size + 26}" font-size="12" text-anchor="middle" fill="#1a1a1a">Assigned</text>
    <text x="9" y="${y0 + size / 2}" font-size="12" fill="#1a1a1a" transform="rotate(-90 9 ${y0 + size / 2})" text-anchor="middle">Measured</text>
  </svg>`;
}

/** SVG recreation of the report's Residual Plot: each level's residual (mean − line-predicted
 *  value) plotted against its assigned value, with a zero reference line — same layout as the PDF. */
function buildLinearityResidualSVG(stats) {
  const pts = stats.levels.map((l, idx) => ({ ...l, idx })).filter((l) => l.assigned !== null && l.residual !== null);
  const maxX = Math.max(10, ...pts.map((p) => p.assigned)) * 1.08;
  const maxAbsY = Math.max(1, ...pts.map((p) => Math.abs(p.residual))) * 1.4;
  const x0 = 38, y0 = 10, xw = 132, yh = 132;
  const sx = (v) => x0 + (v / maxX) * xw;
  const sy = (v) => y0 + yh / 2 - (v / maxAbsY) * (yh / 2);
  const zero = `<line x1="${x0}" y1="${sy(0)}" x2="${x0 + xw}" y2="${sy(0)}" stroke="#999" stroke-width="1" />`;
  const stems = pts.map((p) => `<line x1="${sx(p.assigned)}" y1="${sy(0)}" x2="${sx(p.assigned)}" y2="${sy(p.residual)}" stroke="#2255aa" stroke-width="1.2" /><circle data-pt="${p.idx}" data-fill="#1a3d8f" data-r="2.6" cx="${sx(p.assigned)}" cy="${sy(p.residual)}" r="2.6" fill="#1a3d8f" />`).join("");
  let ticksY = "";
  for (let t = -3; t <= 3; t++) { const v = t * (maxAbsY / 3); ticksY += `<line x1="${x0 - 4}" y1="${sy(v)}" x2="${x0}" y2="${sy(v)}" stroke="#1a1a1a" stroke-width="1.1" /><text x="${x0 - 6}" y="${sy(v) + 3}" font-size="11.5" text-anchor="end" fill="#1a1a1a">${fmtN(v, 1)}</text>`; }
  let ticksX = "";
  const step = Math.ceil(maxX / 5 / 10) * 10 || Math.ceil(maxX / 5) || 1;
  for (let t = 0; t <= maxX; t += step) ticksX += `<line x1="${sx(t)}" y1="${y0 + yh}" x2="${sx(t)}" y2="${y0 + yh + 4}" stroke="#1a1a1a" stroke-width="1.1" /><text x="${sx(t)}" y="${y0 + yh + 14}" font-size="11.5" text-anchor="middle" fill="#1a1a1a">${t}</text>`;
  return `<svg viewBox="0 0 200 168" width="230" height="193" xmlns="http://www.w3.org/2000/svg" style="font-family:Arial,Helvetica,sans-serif">
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" /><line x1="${x0}" y1="${y0 + yh}" x2="${x0 + xw}" y2="${y0 + yh}" stroke="#1a1a1a" stroke-width="1.1" />
    ${zero}${stems}${ticksY}${ticksX}
    <text x="${x0 + xw / 2}" y="${y0 + yh + 26}" font-size="12" text-anchor="middle" fill="#1a1a1a">Assigned</text>
    <text x="9" y="${y0 + yh / 2}" font-size="12" fill="#1a1a1a" transform="rotate(-90 9 ${y0 + yh / 2})" text-anchor="middle">Residual</text>
  </svg>`;
}

async function renderLinearityPdf(run) {
  const stats = linearityRunResultStats(run);
  const cell = "padding:4.5px 9px;border:1px solid #999;font-size:18px";
  const levelsRows = stats.levels.map((l, i) => `<tr>
    <td style="${cell}">${esc(run.levels[i].level || `LIN-${i + 1}`)}</td>
    <td style="${cell};text-align:center">${l.assigned === null ? "--" : fmtN(l.assigned, 2)}</td>
    <td style="${cell};text-align:center">--</td>
    <td style="${cell};text-align:center">${l.n}</td>
    <td style="${cell};text-align:center">${l.est === null ? "--" : fmtN(l.est, 3)}</td>
    <td style="${cell};text-align:center">${l.mean === null ? "--" : fmtN(l.mean, 3)}</td>
    <td style="${cell};text-align:center">${l.residual === null ? "--" : fmtN(l.residual, 3)}</td>
    <td style="${cell};text-align:center;font-weight:${l.linear === "Fail" ? "700" : "400"};color:${l.linear === "Fail" ? "#b91c1c" : "#111"}">${esc(l.linear || "--")}</td>
  </tr>`).join("");
  const summaryTable = `<table style="width:100%;border-collapse:collapse;font-size:18px">
    <tr><td style="padding:3px 0;color:#333;font-weight:700">Overall</td><td style="padding:3px 0;text-align:right;font-weight:700;color:${stats.overall === "NON-LINEAR" ? "#b91c1c" : "#1a7a1a"}">${esc(stats.overall || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">N</td><td style="padding:3px 0;text-align:right">${stats.levels.length}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Slope</td><td style="padding:3px 0;text-align:right">${fmtN(stats.slope, 3)}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Intercept</td><td style="padding:3px 0;text-align:right">${fmtN(stats.intercept, 3)}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Allowable Systematic Error</td><td style="padding:3px 0;text-align:right">${teaLabel(run.seaValue, run.seaMode)}</td></tr>
  </table>
  <div style="font-size:15.5px;margin-top:6.5px">${esc(stats.overall || "")} within SEa of ${teaLabel(run.seaValue, run.seaMode)}</div>`;
  const specTable = `<table style="width:100%;border-collapse:collapse;font-size:18px">
    <tr><td style="padding:3px 0;color:#333">Allowable Systematic Error (SEa)</td><td style="padding:3px 0;text-align:right">${teaLabel(run.seaValue, run.seaMode)}</td></tr>
  </table>`;
  const supportTable = `<table style="width:100%;border-collapse:collapse;font-size:18px">
    <tr><td style="padding:3px 0;color:#333">Analyst</td><td style="padding:3px 0;text-align:right">${esc(run.analyst || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Date</td><td style="padding:3px 0;text-align:right">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Value Mode</td><td style="padding:3px 0;text-align:right">Pre-Assigned</td></tr>
    <tr><td style="padding:3px 0;color:#333">Units</td><td style="padding:3px 0;text-align:right">${esc(run.units || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Controls</td><td style="padding:3px 0;text-align:right">${esc(run.controls || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Reagent</td><td style="padding:3px 0;text-align:right">${esc(run.reagentLot || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Calibrators</td><td style="padding:3px 0;text-align:right">${esc(run.calibrators || "--")}</td></tr>
    <tr><td style="padding:3px 0;color:#333">Comment</td><td style="padding:3px 0;text-align:right">${esc(run.comment || "--")}</td></tr>
  </table>`;
  const usableMeans = stats.levels.filter((l) => l.mean !== null).map((l) => l.mean);
  const rangeText = usableMeans.length ? `${fmtN(Math.min(...usableMeans), 3)} to ${fmtN(Math.max(...usableMeans), 3)}` : "--";
  const evalText = `The Linearity of ${esc(run.analyte || "this analyte")} was analyzed on ${esc(run.instrument || "the instrument")} over a measured range of ${rangeText} ${esc(run.units || "")}. Allowable systematic error (SEa) was ${teaLabel(run.seaValue, run.seaMode)}. The results are ${esc(stats.overall || "PENDING")}.`;
  const branch = branchName(run.branchId);
  const headerHtml = reportHeaderHtml(run, "Linearity", [`Instrument ${esc(run.instrument || "")}`], "", "left");
  // Compact single-row version of the summary table, used at the top of page 2 next to the
  // charts (the real report repeats the summary there in a horizontal N/Slope/Intercept/Error
  // layout rather than the vertical one used on page 1).
  const summaryRowTable = `<table style="width:100%;border-collapse:collapse;font-size:18px;text-align:center">
    <thead><tr style="font-weight:700"><td style="${cell};background:#f2f2f2">N</td><td style="${cell};background:#f2f2f2">Slope</td><td style="${cell};background:#f2f2f2">Intercept</td><td style="${cell};background:#f2f2f2">Error</td></tr></thead>
    <tbody><tr><td style="${cell}">${stats.levels.length}</td><td style="${cell}">${fmtN(stats.slope, 3)}</td><td style="${cell}">${fmtN(stats.intercept, 3)}</td><td style="${cell}">${teaLabel(run.seaValue, run.seaMode)}</td></tr></tbody>
  </table>
  <div style="font-size:15.5px;margin-top:6.5px">${esc(stats.overall || "")} within SEa of ${teaLabel(run.seaValue, run.seaMode)}</div>`;
  // Page 2's wide table combines the per-level summary with each level's raw measured values —
  // "Statistical Analysis and Experimental Results" in the real report.
  const statAnalysisRows = stats.levels.map((l, i) => `<tr>
    <td style="${cell}">${esc(run.levels[i].level || `LIN-${i + 1}`)}</td>
    <td style="${cell};text-align:center">${l.assigned === null ? "--" : fmtN(l.assigned, 2)}</td>
    <td style="${cell};text-align:center">--</td>
    <td style="${cell};text-align:center">${l.n}</td>
    <td style="${cell};text-align:center">${l.est === null ? "--" : fmtN(l.est, 3)}</td>
    <td style="${cell};text-align:center">${l.mean === null ? "--" : fmtN(l.mean, 3)}</td>
    <td style="${cell};text-align:center">${l.residual === null ? "--" : fmtN(l.residual, 3)}</td>
    <td style="${cell};text-align:center;font-weight:${l.linear === "Fail" ? "700" : "400"};color:${l.linear === "Fail" ? "#b91c1c" : "#111"}">${esc(l.linear || "--")}</td>
    <td style="${cell}">${parseNumberList(run.levels[i].results).map((v) => fmtN(v, 2)).join(", ") || "--"}</td>
  </tr>`).join("");
  const statAnalysisTable = `<table style="width:100%;border-collapse:collapse;margin-top:9px">
    <thead><tr style="font-weight:700"><td style="${cell};background:#f2f2f2">Level</td><td style="${cell};background:#f2f2f2;text-align:center">Assigned</td><td style="${cell};background:#f2f2f2;text-align:center">Pct</td><td style="${cell};background:#f2f2f2;text-align:center">N</td><td style="${cell};background:#f2f2f2;text-align:center">Est</td><td style="${cell};background:#f2f2f2;text-align:center">Mean</td><td style="${cell};background:#f2f2f2;text-align:center">Residual</td><td style="${cell};background:#f2f2f2;text-align:center">Linear</td><td style="${cell};background:#f2f2f2">Measured Concentrations</td></tr></thead>
    <tbody>${statAnalysisRows}</tbody>
  </table>
  <div style="font-size:14.5px;color:#666;margin-top:6.5px">X: Excluded from calculations &nbsp; T: Exceeds Allowed Total Error</div>`;
  const sections = [
    // Page 1 — same order as the real QR Evaluator printout: the per-level pass/fail table
    // first, then Linearity Summary + User's Specifications side by side, Supporting Data below,
    // Evaluation of Results, and the signature. No charts on this page.
    `<table style="width:100%;border-collapse:collapse">
      <thead><tr style="font-weight:700"><td style="${cell};background:#f2f2f2">Level</td><td style="${cell};background:#f2f2f2;text-align:center">Assigned</td><td style="${cell};background:#f2f2f2;text-align:center">Pct</td><td style="${cell};background:#f2f2f2;text-align:center">N</td><td style="${cell};background:#f2f2f2;text-align:center">Est</td><td style="${cell};background:#f2f2f2;text-align:center">Mean</td><td style="${cell};background:#f2f2f2;text-align:center">Residual</td><td style="${cell};background:#f2f2f2;text-align:center">Linearity</td></tr></thead>
      <tbody>${levelsRows}</tbody>
    </table>
    <div style="font-size:14.5px;color:#666;margin-top:4.5px">See User's Specifications for Pass/Fail criteria.</div>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:15.5px"><tr>
      <td style="width:34%;vertical-align:top;padding-right:14px"><div style="font-weight:700;font-size:18px;margin-bottom:4.5px">Linearity Summary</div>${summaryTable}</td>
      <td style="vertical-align:top"><div style="font-weight:700;font-size:18px;margin-bottom:4.5px">User's Specifications</div>${specTable}</td>
    </tr></table>
    <div style="font-weight:700;font-size:18px;margin:15.5px 0 4.5px">Supporting Data</div>${supportTable}`,
    `<div style="font-weight:700;font-size:18.5px;margin:15.5px 0 4.5px">Evaluation of Results</div>
    <div style="font-size:17px;line-height:1.4">${evalText}</div>`,
    reportSignatureHtml(run),
    // Page 2 — forced onto its own fresh page (breakBefore), matching the real report where
    // the charts + the wide experimental-results table always start a new sheet, followed by
    // the same Linearity Summary / User's Specifications / Supporting Data blocks repeated.
    {
      breakBefore: true,
      html: `<table style="width:100%;border-collapse:collapse"><tr>
        <td style="width:50%;text-align:center;padding:3px"><div style="font-weight:700;font-size:18px;margin-bottom:3px">Scatter Plot</div>${buildLinearityScatterSVG(stats)}</td>
        <td style="width:50%;text-align:center;padding:3px"><div style="font-weight:700;font-size:18px;margin-bottom:3px">Residual Plot</div>${buildLinearityResidualSVG(stats)}</td>
      </tr></table>
      <div style="font-weight:700;font-size:18px;margin:12px 0 4.5px">Linearity Summary</div>${summaryRowTable}
      <div style="font-weight:700;font-size:18.5px;margin:15.5px 0 4.5px">Statistical Analysis and Experimental Results</div>${statAnalysisTable}
      <table style="width:100%;border-collapse:collapse;margin-top:15.5px"><tr>
        <td style="width:50%;vertical-align:top;padding-right:14px"><div style="font-weight:700;font-size:18px;margin-bottom:4.5px">User's Specifications</div>${specTable}</td>
        <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18px;margin-bottom:4.5px">Supporting Data</div>${supportTable}</td>
      </tr></table>`,
    },
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run), version: "1.0" });
}
function linearityPdfFilename(run) {
  return `linearity_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

function renderLinearityView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", instrument: "", labDept: "DELTA MEDICAL LABORATORIES",
    analyst: state.user.email, expDate: todayStr(), units: "", comment: "",
    seaMode: "percent", seaValue: "", controls: "", reagentLot: "", calibrators: "",
    levels: Array.from({ length: 5 }, (_, i) => ({ ...LINEARITY_LEVEL_BLANK(), level: `LIN-0${i + 1}` })),
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "", branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "", projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.linearityRun || emptyRun();
  state.ui.linearityRun = run;
  const branchFilter = isMaster ? (state.ui.linearityBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.filter((i) => !run.branchId || i.branchId === run.branchId).map((i) => i.name))];
  const employeeNames = employeeDisplayNames();
  const stats = linearityRunResultStats(run);

  const q = (state.ui.linearitySearch || "").trim().toLowerCase();
  const saved = [...state.linearityRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function levelRowHtml(lv, idx) {
    const s = stats.levels[idx] || {};
    return `<tr data-row="${idx}">
      <td><input data-f="level" data-i="${idx}" value="${esc(lv.level)}" style="width:90px" placeholder="e.g. LIN-01" /></td>
      <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-f="assigned" data-i="${idx}" value="${esc(lv.assigned)}" style="width:90px" placeholder="Assigned" /></td>
      <td><input class="mono" data-f="results" data-i="${idx}" value="${esc(lv.results)}" style="width:100%;min-width:240px;font-size:14.5px;padding:10px 12px" placeholder="e.g. 15.1, 15.0" /></td>
      <td class="mono">${s.est === undefined || s.est === null ? "—" : fmtN(s.est, 3)}</td>
      <td class="mono">${s.mean === undefined || s.mean === null ? "—" : fmtN(s.mean, 3)}</td>
      <td class="mono">${s.residual === undefined || s.residual === null ? "—" : fmtN(s.residual, 3)}</td>
      <td>${s.linear ? `<span class="badge" style="background:${s.linear === "Fail" ? STATUS_STYLES.expired.bg : STATUS_STYLES.ok.bg};color:${s.linear === "Fail" ? STATUS_STYLES.expired.text : STATUS_STYLES.ok.text}">${esc(s.linear)}</span>` : "—"}</td>
      <td><button type="button" class="icon-btn-sm" data-rm-row="${idx}" title="Remove level"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
  }

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkLin"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Linearity (QR Evaluator)</h2><span class="subtitle">CLSI EP06 — fit a line across assigned vs measured values per level and flag any level outside the allowable systematic error</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:16px"><select id="linBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="linBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="linAnalyte" value="${esc(run.analyte)}" placeholder="e.g. ALBUMIN" />`)}
        ${fieldHtml("Instrument", `<input id="linInstrument" list="linInstruments" value="${esc(run.instrument)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Units", `<input id="linUnits" list="labUnitsList" value="${esc(run.units)}" placeholder="e.g. g/L" />${labUnitsDatalistHtml()}`)}
        ${fieldHtml("Allowable Systematic Error (SEa)", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="linSeaValue" value="${esc(run.seaValue)}" placeholder="e.g. 2.5" />`)}
        ${fieldHtml("SEa Basis", `<select id="linSeaMode"><option value="percent" ${run.seaMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.seaMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
      </div>
      <datalist id="linInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>

      <h4 style="margin:16px 0 4px;font-size:13px">Levels</h4>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Tip: copy Level, Assigned, and Measured columns from Excel and paste into the Level box — it fills all three down (Measured pastes as a single comma-separated cell per row).</div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Level</th><th>Assigned</th><th>Measured (comma-separated)</th><th>Est</th><th>Mean</th><th>Residual</th><th>Linear?</th><th></th></tr></thead>
        <tbody>${run.levels.map((lv, i) => levelRowHtml(lv, i)).join("")}</tbody>
      </table></div>
      <button type="button" class="btn secondary" id="linAddLevel" style="margin:10px 0 18px"><i class="fa-solid fa-plus"></i> Add level</button>

      <div class="panel-card" style="margin-bottom:18px">
        <div class="panel-title">Overall Result</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:8px">
          <div><span class="field-label">Slope</span><div class="mono">${fmtN(stats.slope, 3)}</div></div>
          <div><span class="field-label">Intercept</span><div class="mono">${fmtN(stats.intercept, 3)}</div></div>
          <div><span class="field-label">Overall</span><div>${stats.overall ? `<span class="badge" style="background:${stats.overall === "NON-LINEAR" ? STATUS_STYLES.expired.bg : STATUS_STYLES.ok.bg};color:${stats.overall === "NON-LINEAR" ? STATUS_STYLES.expired.text : STATUS_STYLES.ok.text}">${esc(stats.overall)}</span>` : "<span class=\"pick-empty\">Enter assigned values, measured results, and SEa to compute</span>"}</div></div>
        </div>
        <div class="live-chart-row">
          <div class="live-chart-box"><div class="live-chart-title">Scatter Plot</div>${buildLinearityScatterSVG(stats)}</div>
          <div class="live-chart-box"><div class="live-chart-title">Residual Plot — spot the level off the line</div>${buildLinearityResidualSVG(stats)}</div>
        </div>
      </div>

      <datalist id="linEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="linAnalyst" list="linEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="linExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      <h4 style="margin:16px 0 8px;font-size:13px">Supporting Data</h4>
      <div class="form-row">
        ${fieldHtml("Controls", `<input id="linControls" value="${esc(run.controls)}" placeholder="e.g. Beckman Coulter 1045 exp 01 Oct 2023" />`)}
        ${fieldHtml("Reagent", `<input id="linReagentLot" value="${esc(run.reagentLot)}" placeholder="e.g. Beckman Coulter 2571 exp 07 Jan 2023" />`)}
      </div>
      ${fieldHtml("Calibrators", `<input id="linCalibrators" value="${esc(run.calibrators)}" placeholder="e.g. Beckman Coulter 1123 exp 05 Jan 2024" />`)}
      ${fieldHtml("Comment", `<input id="linComment" value="${esc(run.comment)}" />`)}
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="linReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="linReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="linAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="linAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="linReset">Clear form</button>
        <button type="button" class="btn primary" id="linSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:26px 0 12px;font-size:14px">Saved linearity runs</h3>
    <div class="search-box" style="margin-bottom:14px"><i class="fa-solid fa-magnifying-glass"></i><input id="linSearch" value="${esc(state.ui.linearitySearch || "")}" placeholder="Search by analyte, instrument, branch, or analyst…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Instrument</th><th>Branch</th><th>Levels</th><th>Result</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="8" class="table-empty">${q ? "No runs match your search" : "No saved linearity runs yet"}</td></tr>` : saved.map((r) => {
        const s = linearityRunStats(r.levels, linearitySpecForStats(r));
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.instrument || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td class="mono">${(r.levels || []).length}</td>
          <td>${s.overall ? `<span class="badge" style="background:${s.overall === "NON-LINEAR" ? STATUS_STYLES.expired.bg : STATUS_STYLES.ok.bg};color:${s.overall === "NON-LINEAR" ? STATUS_STYLES.expired.text : STATUS_STYLES.ok.text}">${esc(s.overall)}</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-lin="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-lin="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-lin="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("linBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.linearityBranch = e.target.value; renderLinearityView(); };
  const linBranchEl = el("linBranch"); if (linBranchEl) linBranchEl.onchange = (e) => { run.branchId = e.target.value; renderLinearityView(); };
  el("linAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("linInstrument").oninput = (e) => run.instrument = e.target.value;
  el("linUnits").oninput = (e) => run.units = e.target.value;
  el("linSeaValue").oninput = (e) => { run.seaValue = e.target.value; renderLinearityView(); };
  el("linSeaMode").onchange = (e) => { run.seaMode = e.target.value; renderLinearityView(); };
  el("linAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("linExpDate").oninput = (e) => run.expDate = e.target.value;
  el("linControls").oninput = (e) => run.controls = e.target.value;
  el("linReagentLot").oninput = (e) => run.reagentLot = e.target.value;
  el("linCalibrators").oninput = (e) => run.calibrators = e.target.value;
  el("linComment").oninput = (e) => run.comment = e.target.value;
  el("linReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("linReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("linAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("linAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;
  el("linAddLevel").onclick = () => { run.levels.push(LINEARITY_LEVEL_BLANK()); renderLinearityView(); };
  el("mainContent").querySelectorAll("[data-rm-row]").forEach((btn) => btn.onclick = () => {
    run.levels.splice(Number(btn.dataset.rmRow), 1);
    if (run.levels.length === 0) run.levels.push(LINEARITY_LEVEL_BLANK());
    renderLinearityView();
  });
  el("mainContent").querySelectorAll("input[data-f]").forEach((input) => {
    const i = Number(input.dataset.i), f = input.dataset.f;
    input.oninput = (e) => { run.levels[i][f] = e.target.value; };
    input.onblur = () => renderLinearityView();
  });
  attachExcelPasteObjects(el("mainContent"), "input[data-f]", run.levels, ["level", "assigned", "results"], LINEARITY_LEVEL_BLANK, renderLinearityView);
  wireChartRowHighlight(el("mainContent"));
  el("linSearch").oninput = (e) => {
    state.ui.linearitySearch = e.target.value;
    renderLinearityView();
    const refocused = el("linSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("linReset").onclick = () => { state.ui.linearityRun = emptyRun(); renderLinearityView(); };
  const epBackLinkLinEl = el("epBackLinkLin"); if (epBackLinkLinEl) epBackLinkLinEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-lin]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.linearityRuns.find((r) => r.id === btn.dataset.openLin);
    if (savedRun) { state.ui.linearityRun = JSON.parse(JSON.stringify(savedRun)); renderLinearityView(); }
  });
  el("mainContent").querySelectorAll("[data-del-lin]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved linearity run?")) deleteLinearityRun(btn.dataset.delLin); });
  el("mainContent").querySelectorAll("[data-dl-lin]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.linearityRuns.find((r) => r.id === btn.dataset.dlLin);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderLinearityPdf(savedRun); pdf.save(linearityPdfFilename(savedRun)); }
    catch (err) { console.error("Linearity PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("linSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderLinearityPdf(run);
      pdf.save(linearityPdfFilename(run));
      const saveResult = await saveLinearityRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.linearityRun = emptyRun();
      renderLinearityView();
    } catch (err) {
      console.error("Linearity save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}
/* ---------------------------------------------------------------------
   Method Validation Summary (QR Evaluator — "Form LabGen 002")
   A one-page cover form (Installation/Operational Qualification +
   Performance Qualification checklist) matching the lab's original
   printed "Method Validation Summary" sheet, pixel for pixel — same
   html2canvas + jsPDF approach as renderLotVerificationPdf, but
   portrait to match the source form's orientation. Every field is a
   normal editable control in the app (text inputs + status dropdowns),
   saved as its own record (like Precision/Accuracy/…), and downloadable
   as a real PDF page laid out exactly like the attached form.
--------------------------------------------------------------------- */
async function saveMethodValidationSummaryRun(data) { return saveEpRunGuarded("methodValidationSummaryRuns", data, "testName"); }
async function deleteMethodValidationSummaryRun(id) {
  const r = state.methodValidationSummaryRuns.find((x) => x.id === id);
  await db.collection("methodValidationSummaryRuns").doc(id).delete();
  logAudit("delete_method_validation_summary", r ? (r.testName || id) : id, "");
}

/** Small bordered checkbox glyph (☒ / ☐), built from a plain div instead of a unicode
 *  character so it rasterizes identically everywhere html2canvas runs. */
function mvsBox(checked) {
  return `<span style="display:inline-block;width:12px;height:12px;border:1.3px solid #111;text-align:center;line-height:10px;font-size:11px;font-weight:800;vertical-align:middle;margin-right:5px">${checked ? "X" : ""}</span>`;
}
/** One "☒ LABEL   ☐ LABEL   …" choice row, `value` matched case-insensitively against each option. */
function mvsChoices(value, options) {
  return options.map((o) => `<span style="margin-right:22px;white-space:nowrap">${mvsBox((value || "") === o)}${esc(o)}</span>`).join("");
}
function methodValidationSummaryPdfFilename(run) {
  return `method-validation-summary_${(run.testName || "test").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}

async function renderMethodValidationSummaryPdf(run) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-9999px;top:0;width:900px;background:#fff;padding:34px 40px;font-family:Arial,Helvetica,sans-serif;color:#111";
  const border = "1px solid #000";
  const headCell = `padding:7px 12px;border:${border};font-weight:700;font-size:13.5px;vertical-align:top`;
  const valCell = `padding:7px 12px;border:${border};font-size:13.5px;vertical-align:top`;
  const sectionRow = (label) => `<tr><td colspan="2" style="border:${border};background:#dbe7f6;text-align:center;font-weight:700;font-size:13.5px;padding:7px">${esc(label)}</td></tr>`;
  const bulletRow = (label, choicesHtml) => `<tr><td style="${headCell};font-weight:400;width:46%">&bull;&nbsp; ${esc(label)}</td><td style="${valCell}">${choicesHtml}</td></tr>`;
  const pqRow = (label, sub, choicesHtml, extraHtml) => `<tr>
    <td style="${headCell};font-weight:400;width:46%">&bull;&nbsp; ${esc(label)}${sub ? `<div style="font-style:italic;font-weight:400;font-size:11.5px;color:#333;margin-top:2px">${esc(sub)}</div>` : ""}</td>
    <td style="${valCell}">${choicesHtml}${extraHtml ? `<div style="margin-top:5px">${extraHtml}</div>` : ""}</td>
  </tr>`;

  wrap.innerHTML = `
    <div style="text-align:center;margin-bottom:14px"><img src="assets/logo-delta-legacy.png" style="height:64px" /></div>
    <div style="text-align:center;font-weight:700;text-decoration:underline;font-size:19px;margin-bottom:20px">Method Validation<br/>Summary</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:0">
      <tr><td style="${headCell};width:22%">Analyzer:</td><td style="${valCell};font-weight:700">${esc(run.analyzer)}</td></tr>
      <tr><td style="${headCell}">Serial No.:</td><td style="${valCell};font-weight:700">${esc(run.serialNo)}</td></tr>
      <tr><td style="${headCell}">Test Name:</td><td style="${valCell};font-weight:700">${esc(run.testName)}</td></tr>
      <tr><td style="${headCell}">Methodology:</td><td style="${valCell};font-weight:700">${esc(run.methodology)}</td></tr>
      <tr><td style="${headCell}">Sample Type:</td><td style="${valCell};font-weight:700">${esc(run.sampleType)}</td></tr>
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:14px">
      ${sectionRow("Installation & Operational Qualifications")}
      ${bulletRow("Installation Report", mvsChoices(run.installationReport, ["YES", "NO"]))}
      ${bulletRow("Operational Checklist", mvsChoices(run.operationalChecklist, ["YES", "NO"]))}
      ${bulletRow("Approval Body", mvsChoices(run.approvalBody, ["FDA", "CE", "N/A"]))}
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:14px">
      ${sectionRow("Performance Qualification")}
      <tr><td colspan="2" style="border:${border};text-align:center;padding:8px">${mvsChoices(run.pqType, ["QUALITATIVE", "SEMI-QUANTITATIVE", "QUANTITATIVE"])}</td></tr>
      ${pqRow("Analytical Accuracy", "", mvsChoices(run.accuracy, ["PASS", "FAIL", "N/A"]))}
      ${pqRow("Analytical Precision", "", mvsChoices(run.precision, ["PASS", "FAIL", "N/A"]))}
      ${pqRow("Linearity/AMR", "", mvsChoices(run.linearity, ["PASS", "FAIL", "N/A"]), run.amrText ? `AMR: ${esc(run.amrText)}` : "")}
      ${pqRow("Reportable Range", "", `<div>${esc(run.reportableRange || "")}</div>`)}
      ${pqRow("Reference Intervals", "", mvsChoices(run.referenceIntervals, ["Verified", "Not Verified", "N/A"]))}
      ${pqRow("Analytical Sensitivity", "Limit of Detection (LOD)", mvsChoices(run.sensitivity, ["PASS", "FAIL", "N/A"]), `Manufacturer Claim: ${esc(run.lodManufacturerClaim || "")}`)}
      ${pqRow("Analytical Specificity/ Interfering Substances", "", `<div>${esc(run.specificity || "")}</div>`)}
      ${pqRow("Other Characteristics", "[Carryover, dilutions, sample type evaluations etc.]", `<div>${esc(run.otherCharacteristics || "")}</div>`)}
    </table>
    <div style="margin-top:26px;border-top:1px solid #ccc;padding-top:6px;font-size:10.5px;color:#444">Form LabGen 002 Method Validation Summary</div>`;
  document.body.appendChild(wrap);
  try {
    const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const maxW = pageW - margin * 2, maxH = pageH - margin * 2;
    const ratio = canvas.height / canvas.width;
    let drawW = maxW, drawH = drawW * ratio;
    if (drawH > maxH) { drawH = maxH; drawW = drawH / ratio; }
    const x = (pageW - drawW) / 2, y = margin;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", x, y, drawW, drawH);
    return pdf;
  } finally {
    document.body.removeChild(wrap);
  }
}

function renderMethodValidationSummaryView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyzer: "", serialNo: "", testName: "", methodology: "", sampleType: "",
    installationReport: "YES", operationalChecklist: "YES", approvalBody: "FDA",
    pqType: "QUANTITATIVE", accuracy: "PASS", precision: "PASS", linearity: "PASS", amrText: "",
    reportableRange: "", referenceIntervals: "Verified", sensitivity: "N/A", lodManufacturerClaim: "",
    specificity: "", otherCharacteristics: "",
    analyst: state.user.email, expDate: todayStr(), acceptedBy: "", acceptedDate: "",
    branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "",
    projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.methodValidationSummaryRun || emptyRun();
  state.ui.methodValidationSummaryRun = run;
  const branchFilter = isMaster ? (state.ui.mvsBranch || "") : (myBranch || "");

  const q = (state.ui.mvsSearch || "").trim().toLowerCase();
  const saved = [...state.methodValidationSummaryRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.testName, r.analyzer, r.serialNo, branchName(r.branchId)].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const statusSelect = (id, value, options) => `<select id="${id}">${options.map((o) => `<option value="${o}" ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkMvs"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Method Validation Summary (QR Evaluator)</h2><span class="subtitle">Form LabGen 002 — Installation/Operational Qualification and Performance Qualification cover sheet, same layout as the printed form</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:16px"><select id="mvsBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="mvsBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyzer *", `<input id="mvsAnalyzer" value="${esc(run.analyzer)}" placeholder="e.g. DXC-700AU" />`)}
        ${fieldHtml("Serial No.", `<input id="mvsSerialNo" value="${esc(run.serialNo)}" placeholder="e.g. B8644" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Test Name *", `<input id="mvsTestName" value="${esc(run.testName)}" placeholder="e.g. ALBUMIN ( ALB )" />`)}
        ${fieldHtml("Methodology", `<input id="mvsMethodology" value="${esc(run.methodology)}" placeholder="e.g. bromocresol green spectrometry" />`)}
        ${fieldHtml("Sample Type", `<input id="mvsSampleType" value="${esc(run.sampleType)}" placeholder="e.g. Plasma and serum" />`)}
      </div>

      <h4 style="margin:22px 0 12px;font-size:17.5px">Installation &amp; Operational Qualifications</h4>
      <div class="form-row">
        ${fieldHtml("Installation Report", statusSelect("mvsInstallationReport", run.installationReport, ["YES", "NO"]))}
        ${fieldHtml("Operational Checklist", statusSelect("mvsOperationalChecklist", run.operationalChecklist, ["YES", "NO"]))}
        ${fieldHtml("Approval Body", statusSelect("mvsApprovalBody", run.approvalBody, ["FDA", "CE", "N/A"]))}
      </div>

      <h4 style="margin:22px 0 12px;font-size:17.5px">Performance Qualification</h4>
      <div class="form-row">
        ${fieldHtml("Type", statusSelect("mvsPqType", run.pqType, ["QUALITATIVE", "SEMI-QUANTITATIVE", "QUANTITATIVE"]))}
      </div>
      <div class="form-row">
        ${fieldHtml("Analytical Accuracy", statusSelect("mvsAccuracy", run.accuracy, ["PASS", "FAIL", "N/A"]))}
        ${fieldHtml("Analytical Precision", statusSelect("mvsPrecision", run.precision, ["PASS", "FAIL", "N/A"]))}
      </div>
      <div class="form-row">
        ${fieldHtml("Linearity/AMR", statusSelect("mvsLinearity", run.linearity, ["PASS", "FAIL", "N/A"]))}
        ${fieldHtml("AMR (e.g. 15.0 – 60, Verified range 15.05 – 56.355)", `<input id="mvsAmrText" value="${esc(run.amrText)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Reportable Range", `<input id="mvsReportableRange" value="${esc(run.reportableRange)}" placeholder="e.g. 15.0 – 60 g/L" />`)}
        ${fieldHtml("Reference Intervals", statusSelect("mvsReferenceIntervals", run.referenceIntervals, ["Verified", "Not Verified", "N/A"]))}
      </div>
      <div class="form-row">
        ${fieldHtml("Analytical Sensitivity (LOD)", statusSelect("mvsSensitivity", run.sensitivity, ["PASS", "FAIL", "N/A"]))}
        ${fieldHtml("Manufacturer Claim", `<input id="mvsLodManufacturerClaim" value="${esc(run.lodManufacturerClaim)}" />`)}
      </div>
      ${fieldHtml("Analytical Specificity / Interfering Substances", `<input id="mvsSpecificity" value="${esc(run.specificity)}" placeholder="e.g. Manufacture Data" />`)}
      ${fieldHtml("Other Characteristics (carryover, dilutions, sample type evaluations, etc.)", `<input id="mvsOtherCharacteristics" value="${esc(run.otherCharacteristics)}" />`)}

      <div class="form-row" style="margin-top:18px">
        ${fieldHtml("Analyst", `<input id="mvsAnalyst" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Date", `<input type="date" id="mvsExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="mvsReset">Clear form</button>
        <button type="button" class="btn primary" id="mvsSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved Method Validation Summaries</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="mvsSearch" value="${esc(state.ui.mvsSearch || "")}" placeholder="Search by test name, analyzer, serial no., or branch…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Test Name</th><th>Analyzer / Serial No.</th><th>Branch</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="6" class="table-empty">${q ? "No records match your search" : "No saved summaries yet"}</td></tr>` : saved.map((r) => `
        <tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.testName || "—")}</td><td>${esc(r.analyzer || "—")} / ${esc(r.serialNo || "—")}</td><td>${esc(branchName(r.branchId))}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-mvs="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-mvs="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-mvs="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("mvsBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.mvsBranch = e.target.value; renderMethodValidationSummaryView(); };
  const mvsBranchEl = el("mvsBranch"); if (mvsBranchEl) mvsBranchEl.onchange = (e) => { run.branchId = e.target.value; renderMethodValidationSummaryView(); };
  el("mvsAnalyzer").oninput = (e) => run.analyzer = e.target.value;
  el("mvsSerialNo").oninput = (e) => run.serialNo = e.target.value;
  el("mvsTestName").oninput = (e) => run.testName = e.target.value;
  el("mvsMethodology").oninput = (e) => run.methodology = e.target.value;
  el("mvsSampleType").oninput = (e) => run.sampleType = e.target.value;
  el("mvsInstallationReport").onchange = (e) => run.installationReport = e.target.value;
  el("mvsOperationalChecklist").onchange = (e) => run.operationalChecklist = e.target.value;
  el("mvsApprovalBody").onchange = (e) => run.approvalBody = e.target.value;
  el("mvsPqType").onchange = (e) => run.pqType = e.target.value;
  el("mvsAccuracy").onchange = (e) => run.accuracy = e.target.value;
  el("mvsPrecision").onchange = (e) => run.precision = e.target.value;
  el("mvsLinearity").onchange = (e) => run.linearity = e.target.value;
  el("mvsAmrText").oninput = (e) => run.amrText = e.target.value;
  el("mvsReportableRange").oninput = (e) => run.reportableRange = e.target.value;
  el("mvsReferenceIntervals").onchange = (e) => run.referenceIntervals = e.target.value;
  el("mvsSensitivity").onchange = (e) => run.sensitivity = e.target.value;
  el("mvsLodManufacturerClaim").oninput = (e) => run.lodManufacturerClaim = e.target.value;
  el("mvsSpecificity").oninput = (e) => run.specificity = e.target.value;
  el("mvsOtherCharacteristics").oninput = (e) => run.otherCharacteristics = e.target.value;
  el("mvsAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("mvsExpDate").oninput = (e) => run.expDate = e.target.value;
  el("mvsSearch").oninput = (e) => {
    state.ui.mvsSearch = e.target.value;
    renderMethodValidationSummaryView();
    const refocused = el("mvsSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("mvsReset").onclick = () => { state.ui.methodValidationSummaryRun = emptyRun(); renderMethodValidationSummaryView(); };
  const epBackLinkMvsEl = el("epBackLinkMvs"); if (epBackLinkMvsEl) epBackLinkMvsEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-mvs]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.methodValidationSummaryRuns.find((r) => r.id === btn.dataset.openMvs);
    if (savedRun) { state.ui.methodValidationSummaryRun = JSON.parse(JSON.stringify(savedRun)); renderMethodValidationSummaryView(); }
  });
  el("mainContent").querySelectorAll("[data-del-mvs]").forEach((btn) => btn.onclick = () => { if (confirm("Delete this saved Method Validation Summary?")) deleteMethodValidationSummaryRun(btn.dataset.delMvs); });
  el("mainContent").querySelectorAll("[data-dl-mvs]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.methodValidationSummaryRuns.find((r) => r.id === btn.dataset.dlMvs);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderMethodValidationSummaryPdf(savedRun); pdf.save(methodValidationSummaryPdfFilename(savedRun)); }
    catch (err) { console.error("Method Validation Summary PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("mvsSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.testName.trim()) { toast("Please enter the test name.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderMethodValidationSummaryPdf(run);
      pdf.save(methodValidationSummaryPdfFilename(run));
      const saveResult = await saveMethodValidationSummaryRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.methodValidationSummaryRun = emptyRun();
      renderMethodValidationSummaryView();
    } catch (err) {
      console.error("Method Validation Summary save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   To Do — pending tasks that need action before routine work continues.
   Two auto-detected kinds share the same lotToLotTasks collection and
   list: reagent lot switches (flagLotToLotIfLotChanged) and annual
   EP Evaluator revalidations coming due (syncRevalidationTasks). Kept
   generic (a "kind" + status field) so future task types can land here too.
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   ASSIGNED TASKS (Master → everyone / a branch / a person; branch manager → their branch)
--------------------------------------------------------------------- */
/** Normalizes to "none" | "daily" | "monthly" — also reads the old boolean `recurring` field so
 *  tasks created before this existed keep working as "daily" (that's what they were). */
function taskRecurrence(t) { return t.recurrence || (t.recurring ? "daily" : "none"); }
/** The key completions are recorded under for the CURRENT period — resets automatically: a new
 *  key each day for daily tasks, a new key each calendar month for monthly ones. */
function taskPeriodKey(t) {
  const rec = taskRecurrence(t);
  if (rec === "daily") return todayStr();
  if (rec === "monthly") return todayStr().slice(0, 7); // "YYYY-MM"
  return null;
}
/** Monthly tasks restart on the 1st with a deadline of `deadlineDays` days to finish — overdue
 *  once that many days into the month have passed and this period isn't done yet. Daily tasks
 *  don't get an overdue flag: the whole point of "daily" is that it simply resets each morning. */
function taskIsOverdue(t) {
  if (taskRecurrence(t) !== "monthly" || isAssignedTaskDoneForMe(t)) return false;
  const deadlineDays = Number(t.deadlineDays) || 7;
  return new Date().getDate() > deadlineDays;
}
function tasksVisibleToMe() {
  const email = (state.user.email || "").toLowerCase();
  const myBranch = state.managedBranchId || state.myBranchId || null;
  return state.assignedTasks.filter((t) =>
    t.scope === "all" ||
    (t.scope === "branch" && t.branchId === myBranch) ||
    (t.scope === "user" && (t.targetEmail || "").toLowerCase() === email)
  );
}
function isAssignedTaskDoneForMe(t) {
  const mine = (t.completions || {})[state.user.email];
  if (!mine) return false;
  const periodKey = taskPeriodKey(t);
  return periodKey ? !!mine[periodKey] : !!mine;
}
/** Completion is per-recipient: a broadcast task ("all"/"branch") has one shared task document,
 *  but each person's tick only marks THEIR OWN copy done — never anyone else's. Firestore field
 *  names with dots (emails!) can't safely use dot-path update strings, so this always merges a real
 *  nested object instead — that keeps every other recipient's (and every other period's) completion
 *  entries intact. */
async function toggleAssignedTaskDone(t) {
  const email = state.user.email;
  const done = isAssignedTaskDoneForMe(t);
  const periodKey = taskPeriodKey(t);
  const patch = periodKey ? { completions: { [email]: { [periodKey]: !done } } } : { completions: { [email]: !done } };
  await db.collection("assignedTasks").doc(t.id).set(patch, { merge: true });
}
async function createAssignedTask(data) {
  await db.collection("assignedTasks").add({ ...data, completions: {}, createdBy: state.user.email, createdAt: nowStr() });
}
async function deleteAssignedTask(id) { await db.collection("assignedTasks").doc(id).delete(); }
function assignedTaskAudienceCount(t) {
  if (t.scope === "all") return state.allowed.length;
  if (t.scope === "branch") return state.allowed.filter((u) => u.branchId === t.branchId).length;
  return 1;
}
function assignedTaskDoneCount(t) {
  const comps = t.completions || {};
  const periodKey = taskPeriodKey(t);
  if (!periodKey) return Object.values(comps).filter(Boolean).length;
  return Object.values(comps).filter((byPeriod) => byPeriod && byPeriod[periodKey]).length;
}
function openAssignTaskModal() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || null; // only set when the signed-in user manages a branch
  const ts = { title: "", description: "", scope: isMaster ? "all" : "branch", branchId: isMaster ? "" : myBranch, targetEmail: "", recurrence: "none", deadlineDays: 7, dueDate: "" };
  function render() {
    const branchEmployees = ts.scope !== "user" ? [] : (isMaster ? state.allowed : state.allowed.filter((u) => u.branchId === myBranch));
    openModal(`<div class="modal fade-in" onclick="event.stopPropagation()">
      <div class="modal-head"><span class="modal-title">Assign a task</span><button class="btn ghost icon-only" id="atClose">✕</button></div>
      <form id="assignTaskForm"><div class="modal-body">
        ${fieldHtml("Title *", `<input required id="atTitle" value="${esc(ts.title)}" placeholder="e.g. Restock lab coats" />`)}
        ${fieldHtml("Description (optional)", `<textarea id="atDesc" rows="2">${esc(ts.description)}</textarea>`)}
        <label class="field"><span class="field-label">Assign to</span>
          <select id="atScope">
            ${isMaster ? `<option value="all" ${ts.scope === "all" ? "selected" : ""}>Everyone (all branches)</option>` : ""}
            ${isMaster ? `<option value="branch" ${ts.scope === "branch" ? "selected" : ""}>A specific branch</option>` : `<option value="branch" selected>Everyone in my branch</option>`}
            <option value="user" ${ts.scope === "user" ? "selected" : ""}>A specific person</option>
          </select>
        </label>
        ${isMaster && ts.scope === "branch" ? fieldHtml("Branch", `<select id="atBranch">${state.branches.map((b) => `<option value="${b.id}" ${b.id === ts.branchId ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select>`) : ""}
        ${ts.scope === "user" ? fieldHtml("Person", `<select id="atUser"><option value="">Select…</option>${branchEmployees.map((u) => `<option value="${esc(u.id)}" ${u.id === ts.targetEmail ? "selected" : ""}>${esc(u.name || u.id)}</option>`).join("")}</select>`) : ""}
        <label class="field"><span class="field-label">Repeat</span>
          <select id="atRecurrence">
            <option value="none" ${ts.recurrence === "none" ? "selected" : ""}>One-off (no repeat)</option>
            <option value="daily" ${ts.recurrence === "daily" ? "selected" : ""}>Daily — resets every day</option>
            <option value="monthly" ${ts.recurrence === "monthly" ? "selected" : ""}>Monthly — resets on the 1st of every month</option>
          </select>
        </label>
        ${ts.recurrence === "monthly" ? fieldHtml("Deadline — finish within how many days of the 1st?", `<input type="number" min="1" max="28" id="atDeadlineDays" value="${esc(ts.deadlineDays)}" />`) : ""}
        ${ts.recurrence === "none" ? fieldHtml("Due date (optional)", `<input type="date" id="atDue" value="${esc(ts.dueDate)}" />`) : ""}
      </div>
      <div class="modal-foot"><button type="button" class="btn secondary" id="atCancel">Cancel</button><button type="submit" class="btn primary">Assign</button></div>
      </form></div>`);
    el("atClose").onclick = closeModal;
    el("atCancel").onclick = closeModal;
    el("atTitle").oninput = (e) => ts.title = e.target.value;
    el("atDesc").oninput = (e) => ts.description = e.target.value;
    el("atScope").onchange = (e) => { ts.scope = e.target.value; render(); };
    const branchEl = el("atBranch"); if (branchEl) branchEl.onchange = (e) => { ts.branchId = e.target.value; render(); };
    const userEl = el("atUser"); if (userEl) userEl.onchange = (e) => ts.targetEmail = e.target.value;
    el("atRecurrence").onchange = (e) => { ts.recurrence = e.target.value; render(); };
    const deadlineEl = el("atDeadlineDays"); if (deadlineEl) deadlineEl.onchange = (e) => ts.deadlineDays = e.target.value;
    const dueEl = el("atDue"); if (dueEl) dueEl.onchange = (e) => ts.dueDate = e.target.value;
    el("assignTaskForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!ts.title.trim()) { toast("Give the task a title.", "warn"); return; }
      if (ts.scope === "user" && !ts.targetEmail) { toast("Pick who this task is for.", "warn"); return; }
      const branchId = ts.scope === "branch" ? (isMaster ? ts.branchId : myBranch) : null;
      if (ts.scope === "branch" && !branchId) { toast("Pick a branch.", "warn"); return; }
      await createAssignedTask({
        title: ts.title.trim(), description: ts.description.trim(), scope: ts.scope,
        branchId, targetEmail: ts.scope === "user" ? ts.targetEmail : null,
        recurrence: ts.recurrence,
        deadlineDays: ts.recurrence === "monthly" ? (Number(ts.deadlineDays) || 7) : null,
        dueDate: ts.recurrence === "none" ? ts.dueDate : "",
      });
      closeModal();
      toast("Task assigned.", "success");
    };
  }
  render();
}

function renderToDoView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const canAssign = isMaster || !!state.managedBranchId;
  const branchFilter = isMaster ? (state.ui.todoBranch || "") : (myBranch || "");
  const pending = pendingLotToLotTasks().filter((t) => !branchFilter || t.branchId === branchFilter);
  const done = [...state.lotToLotTasks].filter((t) => t.status === "done" && (!branchFilter || t.branchId === branchFilter))
    .sort((a, b) => (a.resolvedAt < b.resolvedAt ? 1 : -1)).slice(0, 20);

  const myTasks = tasksVisibleToMe().filter((t) => {
    const doneForMe = isAssignedTaskDoneForMe(t);
    return state.ui.showDoneTasks || !doneForMe;
  });
  const assignedByMe = canAssign ? state.assignedTasks.filter((t) => t.createdBy === state.user.email) : [];

  const scopeLabel = (t) => t.scope === "all" ? "Everyone" : t.scope === "branch" ? branchName(t.branchId) : nameForEmail(t.targetEmail);

  const myTasksHtml = `
    <div class="panel-card" style="margin-bottom:20px">
      <div class="page-header" style="margin-bottom:12px">
        <div><h3 style="margin:0">My Tasks</h3><span class="subtitle">Assigned to you by Master or your branch manager</span></div>
        ${canAssign ? `<button type="button" class="btn primary" id="btnAssignTask"><i class="fa-solid fa-plus"></i> Assign a task</button>` : ""}
      </div>
      ${myTasks.length === 0
        ? `<p class="auth-hint" style="text-align:left">No tasks assigned to you right now.</p>`
        : `<div style="display:flex;flex-direction:column;gap:8px">${myTasks.map((t) => {
            const doneForMe = isAssignedTaskDoneForMe(t);
            const rec = taskRecurrence(t);
            const overdue = taskIsOverdue(t);
            const recBadge = rec === "none" ? "" : ` <span class="badge" style="background:${STATUS_STYLES.watch.bg};color:${STATUS_STYLES.watch.text};border-color:${STATUS_STYLES.watch.border}">${rec === "daily" ? "Daily" : "Monthly"}</span>`;
            const overdueBadge = overdue ? ` <span class="badge" style="background:${STATUS_STYLES.expired.bg};color:${STATUS_STYLES.expired.text};border-color:${STATUS_STYLES.expired.border}">Overdue</span>` : "";
            const deadlineNote = rec === "monthly" ? ` · Due within ${esc(t.deadlineDays || 7)} day(s) of the 1st` : "";
            return `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid var(--border);border-radius:10px;${doneForMe ? "opacity:.55" : ""}">
              <button type="button" class="icon-btn-sm" data-toggle-task="${t.id}" title="${doneForMe ? "Mark not done" : "Mark done"}"><i class="fa-solid ${doneForMe ? "fa-rotate-left" : "fa-check"}"></i></button>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;${doneForMe ? "text-decoration:line-through" : ""}">${esc(t.title)}${recBadge}${overdueBadge}</div>
                ${t.description ? `<div style="font-size:12.5px;color:var(--text-dim);margin-top:2px">${esc(t.description)}</div>` : ""}
                <div style="font-size:11px;color:var(--text-faint);margin-top:4px">From ${esc(nameForEmail(t.createdBy))}${t.dueDate ? ` · Due ${esc(t.dueDate)}` : ""}${deadlineNote}</div>
              </div>
            </div>`;
          }).join("")}</div>`}
      <label class="field-row" style="align-items:center;gap:8px;margin-top:12px;font-size:12.5px;color:var(--text-dim)"><input type="checkbox" id="toggleShowDoneTasks" ${state.ui.showDoneTasks ? "checked" : ""} style="width:auto" /><span>Show completed tasks</span></label>
    </div>
    ${canAssign ? `
    <div class="panel-card" style="margin-bottom:20px">
      <div class="page-header" style="margin-bottom:10px"><div><h3 style="margin:0">Tasks I've Assigned</h3></div></div>
      ${assignedByMe.length === 0 ? `<p class="auth-hint" style="text-align:left">You haven't assigned any tasks yet.</p>` : `
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Title</th><th>Assigned to</th><th>Type</th><th>Progress</th><th></th></tr></thead>
        <tbody>${assignedByMe.map((t) => {
          const rec = taskRecurrence(t);
          const typeLabel = rec === "daily" ? "Daily" : rec === "monthly" ? `Monthly (${t.deadlineDays || 7}d deadline)` : t.dueDate ? `Due ${esc(t.dueDate)}` : "One-off";
          const periodNote = rec === "daily" ? " today" : rec === "monthly" ? " this month" : "";
          return `<tr>
            <td>${esc(t.title)}</td>
            <td>${esc(scopeLabel(t))}</td>
            <td>${typeLabel}</td>
            <td class="mono">${assignedTaskDoneCount(t)}/${assignedTaskAudienceCount(t)}${periodNote}</td>
            <td><button class="icon-btn-sm" data-del-task="${t.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td>
          </tr>`;
        }).join("")}
        </tbody>
      </table></div>`}
    </div>` : ""}
  `;

  el("mainContent").innerHTML = `
    <div class="page-header"><div><h2>To Do</h2><span class="subtitle">Assigned tasks, plus reagent lot switches and annual revalidations waiting on you</span></div></div>
    ${myTasksHtml}
    <h3 style="margin:0 0 14px;font-size:16px;color:var(--text-dim)">Lot & Revalidation Tasks</h3>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:16px"><select id="todoBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Detected</th><th>Item</th><th>Details</th><th>Branch</th><th>Action</th></tr></thead>
      <tbody>${pending.length === 0 ? `<tr><td colspan="5" class="table-empty">Nothing pending — no lot switches or revalidations waiting on action</td></tr>` : pending.map((t) => `
        <tr><td class="mono">${esc((t.createdAt || "").slice(0, 10))}</td><td>${esc(t.itemName || "—")}</td>
          <td class="mono">${t.kind === "revalidation" ? `Revalidation ${daysUntil(t.dueDate) < 0 ? "overdue since" : "due"} ${esc(t.dueDate)}` : `${esc(t.oldLot)} → ${esc(t.newLot)}`}</td><td>${esc(branchName(t.branchId))}</td>
          <td style="white-space:nowrap">
            ${t.kind === "revalidation"
              ? `<button type="button" class="btn secondary" data-open-study="${esc(t.studyView || "")}"><i class="fa-solid fa-vial-circle-check"></i> Open study</button>`
              : `<button type="button" class="btn secondary" data-start-lt="${t.id}"><i class="fa-solid fa-flask-vial"></i> Start Lot-to-Lot</button>`}
            <button type="button" class="icon-btn-sm" data-done-todo="${t.id}" title="Mark as done"><i class="fa-solid fa-check"></i></button>
            <button type="button" class="icon-btn-sm" data-del-todo="${t.id}" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>
          </td></tr>`).join("")}
      </tbody></table></div>
    ${done.length ? `<h3 style="margin:32px 0 14px;font-size:16px;color:var(--text-dim)">Recently completed</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Detected</th><th>Item</th><th>Details</th><th>Branch</th><th>Completed</th></tr></thead>
      <tbody>${done.map((t) => `<tr><td class="mono">${esc((t.createdAt || "").slice(0, 10))}</td><td>${esc(t.itemName || "—")}</td>
        <td class="mono">${t.kind === "revalidation" ? `Due ${esc(t.dueDate)}` : `${esc(t.oldLot)} → ${esc(t.newLot)}`}</td><td>${esc(branchName(t.branchId))}</td>
        <td class="mono">${esc((t.resolvedAt || "").slice(0, 10))}</td></tr>`).join("")}</tbody>
    </table></div>` : ""}`;

  const assignBtn = el("btnAssignTask"); if (assignBtn) assignBtn.onclick = openAssignTaskModal;
  el("mainContent").querySelectorAll("[data-toggle-task]").forEach((b) => b.onclick = () => toggleAssignedTaskDone(myTasks.find((t) => t.id === b.dataset.toggleTask)));
  el("mainContent").querySelectorAll("[data-del-task]").forEach((b) => b.onclick = () => { if (confirm("Delete this task for everyone it was assigned to?")) deleteAssignedTask(b.dataset.delTask); });
  const showDoneEl = el("toggleShowDoneTasks"); if (showDoneEl) showDoneEl.onchange = (e) => { state.ui.showDoneTasks = e.target.checked; renderToDoView(); };
  const scopeEl = el("todoBranchScope"); if (scopeEl) scopeEl.onchange = (e) => { state.ui.todoBranch = e.target.value; renderToDoView(); };
  el("mainContent").querySelectorAll("[data-open-study]").forEach((btn) => btn.onclick = () => { if (btn.dataset.openStudy) navigateTo(btn.dataset.openStudy); });
  el("mainContent").querySelectorAll("[data-start-lt]").forEach((btn) => btn.onclick = () => {
    const t = state.lotToLotTasks.find((x) => x.id === btn.dataset.startLt);
    if (!t) return;
    state.ui.lotToLot = {
      id: null, instrument: "", section: "", performedBy: state.user.email, reviewedBy: "",
      sessionDate: todayStr(), reviewDate: "", branchId: t.branchId || myBranch || "",
      rows: [{ ...LOT_ROW_BLANK(), assayLong: t.itemName || "", newLot: t.newLot || "", oldLot: t.oldLot || "" }],
    };
    navigateTo("lotToLot");
  });
  el("mainContent").querySelectorAll("[data-done-todo]").forEach((btn) => btn.onclick = () => completeLotToLotTask(btn.dataset.doneTodo));
  el("mainContent").querySelectorAll("[data-del-todo]").forEach((btn) => btn.onclick = () => { if (confirm("Dismiss this task?")) deleteLotToLotTask(btn.dataset.delTodo); });
}

/* ---------------------------------------------------------------------
   Analytical Sensitivity — LoB / LoD / LoQ verification (CLSI EP17-style)
   A blank-sample replicate set gives the Limit of Blank; a low-level
   sample replicate set (near the expected detection limit) gives the
   Limit of Detection; an optional replicate set at the claimed LoQ
   verifies quantitation precision there. Same module pattern as
   Precision/Accuracy — analyte + instrument header, a live stats
   preview, a locking 3-level signature, and a one-page PDF.
--------------------------------------------------------------------- */
async function saveSensitivityRun(data) { return saveEpRunGuarded("sensitivityRuns", data, "analyte"); }
async function deleteSensitivityRun(id) {
  const r = state.sensitivityRuns.find((x) => x.id === id);
  if (!canDeleteLockedEpRun(r)) { toast("This report was already accepted and is locked — only the master account can delete it. Save an Amendment instead.", "warn"); return; }
  await db.collection("sensitivityRuns").doc(id).delete();
  logAudit("delete_sensitivity_run", r ? (r.analyte || id) : id, r ? `run ${r.expDate || ""}` : "");
}
function sensitivityValues(rows) { return (rows || []).filter((r) => !r.excluded && r.value !== "" && r.value != null).map((r) => Number(r.value)); }
/** LoB = mean(blank) + 1.645·SD(blank); LoD = LoB + 1.645·SD(low-level sample) — the standard
 *  CLSI EP17 parametric estimate. LoQ is verified separately: %CV of replicates run at the
 *  claimed LoQ concentration, checked against the lab's allowable CV goal for that level. */
function sensitivityStats(run) {
  const blank = sensitivityValues(run.blankResults), low = sensitivityValues(run.lowResults), loq = sensitivityValues(run.loqResults);
  const blankMean = meanOf(blank), blankSD = sdOf(blank);
  const lowMean = meanOf(low), lowSD = sdOf(low);
  const loqMean = meanOf(loq), loqSD = sdOf(loq);
  const loqCV = computeCV(loqMean, loqSD);
  const lob = blankMean !== null && blankSD !== null ? blankMean + 1.645 * blankSD : null;
  const lod = lob !== null && lowSD !== null ? lob + 1.645 * lowSD : null;
  const lobGoal = run.manufacturerLoB !== "" && run.manufacturerLoB != null ? Number(run.manufacturerLoB) : null;
  const lodGoal = run.manufacturerLoD !== "" && run.manufacturerLoD != null ? Number(run.manufacturerLoD) : null;
  const loqCVGoal = run.loqAllowableCV !== "" && run.loqAllowableCV != null ? Number(run.loqAllowableCV) : null;
  return {
    blankN: blank.length, blankMean, blankSD, lob, lobGoal, lobPass: lob !== null && lobGoal !== null ? (lob <= lobGoal ? "Yes" : "No") : null,
    lowN: low.length, lowMean, lowSD, lod, lodGoal, lodPass: lod !== null && lodGoal !== null ? (lod <= lodGoal ? "Yes" : "No") : null,
    loqN: loq.length, loqMean, loqSD, loqCV, loqCVGoal, loqPass: loqCV !== null && loqCVGoal !== null ? (loqCV <= loqCVGoal ? "Yes" : "No") : null,
  };
}
function sensitivityPdfFilename(run) {
  return `sensitivity-lob-lod-loq_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}
async function renderSensitivityPdf(run) {
  const stats = sensitivityStats(run);
  const cell = "padding:8px 12.5px;font-size:18.5px";
  const verdictBadge = (v) => v == null ? "--" : `<span class="badge" style="background:${v === "Yes" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${v === "Yes" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(v)}</span>`;
  const statsTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333;font-weight:700">Limit of Blank (LoB)</td><td style="${cell};padding-right:0;text-align:right;font-weight:700">${fmtN(stats.lob, 3)} ${esc(run.units || "")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#666">Blank: N / Mean / SD</td><td style="${cell};padding-right:0;text-align:right;color:#666">${stats.blankN} / ${fmtN(stats.blankMean, 3)} / ${fmtN(stats.blankSD, 3)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Manufacturer LoB claim</td><td style="${cell};padding-right:0;text-align:right">${stats.lobGoal !== null ? fmtN(stats.lobGoal, 3) : "--"}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">LoB Verified</td><td style="${cell};padding-right:0;text-align:right">${verdictBadge(stats.lobPass)}</td></tr>
    <tr><td colspan="2" style="padding:6px 0"></td></tr>
    <tr><td style="${cell};padding-left:0;color:#333;font-weight:700">Limit of Detection (LoD)</td><td style="${cell};padding-right:0;text-align:right;font-weight:700">${fmtN(stats.lod, 3)} ${esc(run.units || "")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#666">Low-level: N / Mean / SD</td><td style="${cell};padding-right:0;text-align:right;color:#666">${stats.lowN} / ${fmtN(stats.lowMean, 3)} / ${fmtN(stats.lowSD, 3)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Manufacturer LoD claim</td><td style="${cell};padding-right:0;text-align:right">${stats.lodGoal !== null ? fmtN(stats.lodGoal, 3) : "--"}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">LoD Verified</td><td style="${cell};padding-right:0;text-align:right">${verdictBadge(stats.lodPass)}</td></tr>
    <tr><td colspan="2" style="padding:6px 0"></td></tr>
    <tr><td style="${cell};padding-left:0;color:#333;font-weight:700">Limit of Quantitation (LoQ)</td><td style="${cell};padding-right:0;text-align:right;font-weight:700">${esc(run.claimedLoQ || "--")} ${esc(run.units || "")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#666">At claimed LoQ: N / Mean / CV</td><td style="${cell};padding-right:0;text-align:right;color:#666">${stats.loqN} / ${fmtN(stats.loqMean, 3)} / ${fmtN(stats.loqCV, 1)}%</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Allowable CV at LoQ</td><td style="${cell};padding-right:0;text-align:right">${stats.loqCVGoal !== null ? stats.loqCVGoal + "%" : "--"}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">LoQ Verified</td><td style="${cell};padding-right:0;text-align:right">${verdictBadge(stats.loqPass)}</td></tr>
  </table>`;
  const supportTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333">Analyst</td><td style="${cell};padding-right:0;text-align:right">${esc(run.analyst || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Expt Date</td><td style="${cell};padding-right:0;text-align:right">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Units</td><td style="${cell};padding-right:0;text-align:right">${esc(run.units || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Methodology</td><td style="${cell};padding-right:0;text-align:right">${esc(run.methodology || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Comment</td><td style="${cell};padding-right:0;text-align:right">${esc(run.comment || "--")}</td></tr>
  </table>`;
  const dataCols = (rows, title) => {
    const list = rows || [];
    return `<td style="vertical-align:top;padding-right:18.5px;width:33%"><div style="font-weight:700;font-size:17px;margin-bottom:6px">${title} (N=${list.length})</div><table style="border-collapse:collapse;font-size:16.5px;width:100%">
      <tr style="font-weight:700"><td style="padding:4.5px 12px 4.5px 0">#</td><td style="padding:4.5px 0">Result</td></tr>
      ${list.map((r, k) => `<tr><td style="padding:3.5px 12px 3.5px 0">${k + 1}</td><td style="padding:3.5px 0">${esc(r.value || "")}${r.excluded ? " (X)" : ""}</td></tr>`).join("")}
    </table></td>`;
  };
  const headerHtml = reportHeaderHtml(run, "Analytical Sensitivity (LoB / LoD / LoQ)", [
    `<strong>Instrument</strong> ${esc(run.instrument || "")}`,
  ]);
  const sections = [
    `<table style="width:100%;border-collapse:collapse;border:1px solid #999"><tr>
      <td style="padding:22px">${statsTable}</td>
    </tr></table>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:28px"><tr>
      <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Supporting Data</div>${supportTable}</td>
    </tr></table>`,
    reportSignatureHtml(run),
    `<div style="font-weight:700;font-size:19px;text-align:center;margin:34px 0 15.5px">Replicate Data</div>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;padding:12.5px 0"><tr>${dataCols(run.blankResults, "Blank Samples")}${dataCols(run.lowResults, "Low-Level Samples")}${dataCols(run.loqResults, "At Claimed LoQ")}</tr></table>
    <div style="font-size:15.5px;color:#666;margin-top:6.5px">X: excluded from calculations</div>`,
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run) });
}

function renderSensitivityView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", instrument: "", units: "", methodology: "", comment: "",
    blankResults: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    lowResults: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    loqResults: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    manufacturerLoB: "", manufacturerLoD: "", claimedLoQ: "", loqAllowableCV: "20",
    analyst: state.user.email, expDate: todayStr(),
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "",
    branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "",
    projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.sensitivityRun || emptyRun();
  state.ui.sensitivityRun = run;
  const branchFilter = isMaster ? (state.ui.sensBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.map((i) => i.name).filter(Boolean))];
  const employeeNames = employeeDisplayNames();

  const q = (state.ui.sensSearch || "").trim().toLowerCase();
  const saved = [...state.sensitivityRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const stats = sensitivityStats(run);
  const verdictSpan = (v) => v == null ? "—" : `<span class="badge" style="background:${v === "Yes" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${v === "Yes" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(v)}</span>`;
  const rowsTable = (rows, key, title) => `
    <div style="flex:1;min-width:230px">
      <h4 style="margin:0 0 6.5px;font-size:17px">${title}</h4>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>#</th><th>Result</th><th>Excl.</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td class="mono">${i + 1}</td>
          <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-grp="${key}" data-f="value" data-i="${i}" value="${esc(r.value)}" style="width:90px" /></td>
          <td style="text-align:center"><input type="checkbox" data-grp="${key}" data-f="excluded" data-i="${i}" ${r.excluded ? "checked" : ""} /></td>
          <td><button type="button" class="icon-btn-sm" data-rm-grp="${key}" data-i="${i}"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join("")}
        </tbody></table></div>
      <button type="button" class="btn secondary" data-add-grp="${key}" style="margin-top:8px;font-size:12.5px"><i class="fa-solid fa-plus"></i> Add</button>
    </div>`;

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkSens"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Analytical Sensitivity — LoB/LoD/LoQ (QR Evaluator)</h2><span class="subtitle">CLSI EP17-style Limit of Blank / Limit of Detection / Limit of Quantitation verification</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:16px"><select id="sensBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="sensBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="sensAnalyte" value="${esc(run.analyte)}" />`)}
        ${fieldHtml("Instrument", `<input id="sensInstrument" list="sensInstruments" value="${esc(run.instrument)}" />`)}
        ${fieldHtml("Units", `<input id="sensUnits" list="labUnitsList" value="${esc(run.units)}" />${labUnitsDatalistHtml()}`)}
      </div>
      <datalist id="sensInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Methodology", `<input id="sensMethodology" value="${esc(run.methodology)}" />`)}
        ${fieldHtml("Comment", `<input id="sensComment" value="${esc(run.comment)}" />`)}
      </div>

      <div style="display:flex;gap:24px;flex-wrap:wrap;margin:26px 0">
        ${rowsTable(run.blankResults, "blank", "Blank Samples (→ LoB)")}
        ${rowsTable(run.lowResults, "low", "Low-Level Samples (→ LoD)")}
        ${rowsTable(run.loqResults, "loq", "At Claimed LoQ (→ LoQ verification)")}
      </div>

      <div class="form-row">
        ${fieldHtml("Manufacturer LoB claim", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="sensManufLoB" value="${esc(run.manufacturerLoB)}" />`)}
        ${fieldHtml("Manufacturer LoD claim", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="sensManufLoD" value="${esc(run.manufacturerLoD)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Claimed LoQ (concentration tested above)", `<input id="sensClaimedLoQ" value="${esc(run.claimedLoQ)}" />`)}
        ${fieldHtml("Allowable CV% at LoQ", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="sensLoqCV" value="${esc(run.loqAllowableCV)}" />`)}
      </div>

      <div class="panel-card" style="margin:22px 0 28px">
        <div class="panel-title">Sensitivity Results (live preview)</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:12.5px">
          <div><span class="field-label">LoB</span><div class="mono">${fmtN(stats.lob, 3)} ${esc(run.units || "")}</div></div>
          <div><span class="field-label">LoB Verified</span><div>${verdictSpan(stats.lobPass)}</div></div>
          <div><span class="field-label">LoD</span><div class="mono">${fmtN(stats.lod, 3)} ${esc(run.units || "")}</div></div>
          <div><span class="field-label">LoD Verified</span><div>${verdictSpan(stats.lodPass)}</div></div>
          <div><span class="field-label">LoQ CV</span><div class="mono">${fmtN(stats.loqCV, 1)}%</div></div>
          <div><span class="field-label">LoQ Verified</span><div>${verdictSpan(stats.loqPass)}</div></div>
        </div>
      </div>

      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="sensAnalyst" list="sensEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="sensExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      <datalist id="sensEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="sensReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="sensReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="sensAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="sensAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="sensReset">Clear form</button>
        <button type="button" class="btn primary" id="sensSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved Sensitivity (LoB/LoD/LoQ) runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="sensSearch" value="${esc(state.ui.sensSearch || "")}" placeholder="Search by analyte, instrument, analyst, or branch…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Instrument</th><th>LoB</th><th>LoD</th><th>Branch</th><th>Status</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="9" class="table-empty">${q ? "No records match your search" : "No saved sensitivity runs yet"}</td></tr>` : saved.map((r) => {
        const s = sensitivityStats(r);
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.instrument || "—")}</td>
          <td class="mono">${fmtN(s.lob, 3)}</td><td class="mono">${fmtN(s.lod, 3)}</td><td>${esc(branchName(r.branchId))}</td>
          <td>${r.acceptedBy ? `<span class="badge" style="background:${STATUS_STYLES.ok.bg};color:${STATUS_STYLES.ok.text}">Accepted</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-sens="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-sens="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-sens="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("sensBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.sensBranch = e.target.value; renderSensitivityView(); };
  const sensBranchEl = el("sensBranch"); if (sensBranchEl) sensBranchEl.onchange = (e) => { run.branchId = e.target.value; renderSensitivityView(); };
  el("sensAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("sensInstrument").oninput = (e) => run.instrument = e.target.value;
  el("sensUnits").oninput = (e) => run.units = e.target.value;
  el("sensMethodology").oninput = (e) => run.methodology = e.target.value;
  el("sensComment").oninput = (e) => run.comment = e.target.value;
  el("sensManufLoB").oninput = (e) => run.manufacturerLoB = e.target.value;
  el("sensManufLoD").oninput = (e) => run.manufacturerLoD = e.target.value;
  el("sensClaimedLoQ").oninput = (e) => run.claimedLoQ = e.target.value;
  el("sensLoqCV").oninput = (e) => run.loqAllowableCV = e.target.value;
  el("sensAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("sensExpDate").oninput = (e) => run.expDate = e.target.value;
  el("sensReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("sensReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("sensAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("sensAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;

  const groups = { blank: run.blankResults, low: run.lowResults, loq: run.loqResults };
  el("mainContent").querySelectorAll("[data-add-grp]").forEach((btn) => btn.onclick = () => { groups[btn.dataset.addGrp].push(PRECISION_RESULT_BLANK()); renderSensitivityView(); });
  el("mainContent").querySelectorAll("[data-rm-grp]").forEach((btn) => btn.onclick = () => {
    const arr = groups[btn.dataset.rmGrp];
    arr.splice(Number(btn.dataset.i), 1);
    if (arr.length === 0) arr.push(PRECISION_RESULT_BLANK());
    renderSensitivityView();
  });
  el("mainContent").querySelectorAll("input[data-grp]").forEach((input) => {
    const arr = groups[input.dataset.grp], i = Number(input.dataset.i), f = input.dataset.f;
    if (input.type === "checkbox") input.onchange = (e) => { arr[i][f] = e.target.checked; renderSensitivityView(); };
    else { input.oninput = (e) => { arr[i][f] = e.target.value; }; input.onblur = () => renderSensitivityView(); }
  });
  ["blank", "low", "loq"].forEach((key) => {
    attachExcelPasteObjects(el("mainContent"), `input[data-grp="${key}"][data-f="value"]`, groups[key], ["value"], PRECISION_RESULT_BLANK, renderSensitivityView);
  });

  el("sensSearch").oninput = (e) => {
    state.ui.sensSearch = e.target.value;
    renderSensitivityView();
    const refocused = el("sensSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("sensReset").onclick = () => { state.ui.sensitivityRun = emptyRun(); renderSensitivityView(); };
  const epBackLinkSensEl = el("epBackLinkSens"); if (epBackLinkSensEl) epBackLinkSensEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-sens]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.sensitivityRuns.find((r) => r.id === btn.dataset.openSens);
    if (savedRun) { state.ui.sensitivityRun = JSON.parse(JSON.stringify(savedRun)); renderSensitivityView(); }
  });
  el("mainContent").querySelectorAll("[data-del-sens]").forEach((btn) => btn.onclick = () => deleteSensitivityRun(btn.dataset.delSens));
  el("mainContent").querySelectorAll("[data-dl-sens]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.sensitivityRuns.find((r) => r.id === btn.dataset.dlSens);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderSensitivityPdf(savedRun); pdf.save(sensitivityPdfFilename(savedRun)); }
    catch (err) { console.error("Sensitivity PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("sensSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderSensitivityPdf(run);
      pdf.save(sensitivityPdfFilename(run));
      const saveResult = await saveSensitivityRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.sensitivityRun = emptyRun();
      renderSensitivityView();
    } catch (err) {
      console.error("Sensitivity save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Carryover verification (QR Evaluator)
   Standard protocol: run a high-concentration sample 3× immediately
   followed by a low-concentration sample 3× (H1,H2,H3,L1,L2,L3) — any
   residual analyte from the high sample shows up as an elevated L1
   relative to the later, unaffected L readings. Same module pattern as
   Sensitivity: two replicate tables, a live-computed verdict against
   an allowable-carryover goal, 3-level signature, one-page PDF.
--------------------------------------------------------------------- */
async function saveCarryoverRun(data) { return saveEpRunGuarded("carryoverRuns", data, "analyte"); }
async function deleteCarryoverRun(id) {
  const r = state.carryoverRuns.find((x) => x.id === id);
  if (!canDeleteLockedEpRun(r)) { toast("This report was already accepted and is locked — only the master account can delete it. Save an Amendment instead.", "warn"); return; }
  await db.collection("carryoverRuns").doc(id).delete();
  logAudit("delete_carryover_run", r ? (r.analyte || id) : id, r ? `run ${r.expDate || ""}` : "");
}
function epSeriesValues(rows) { return (rows || []).filter((r) => !r.excluded && r.value !== "" && r.value != null).map((r) => Number(r.value)); }
/** Carryover % = (L1 − L_last) / (H_last − L_last) × 100 — the standard formula comparing the
 *  first low reading right after the high sample to the later, carryover-free low readings. */
function carryoverStats(run) {
  const H = epSeriesValues(run.highResults), L = epSeriesValues(run.lowResults);
  const hLast = H.length ? H[H.length - 1] : null;
  const lFirst = L.length ? L[0] : null;
  const lLast = L.length ? L[L.length - 1] : null;
  const carryoverAbs = lFirst !== null && lLast !== null ? lFirst - lLast : null;
  const carryoverPct = carryoverAbs !== null && hLast !== null && lLast !== null && (hLast - lLast) !== 0 ? (carryoverAbs / (hLast - lLast)) * 100 : null;
  const goal = run.allowableCarryoverValue !== "" && run.allowableCarryoverValue != null ? Number(run.allowableCarryoverValue) : null;
  const pass = goal === null ? null
    : run.allowableCarryoverMode === "conc"
      ? (carryoverAbs !== null ? (Math.abs(carryoverAbs) <= goal ? "Yes" : "No") : null)
      : (carryoverPct !== null ? (Math.abs(carryoverPct) <= goal ? "Yes" : "No") : null);
  return { hN: H.length, hLast, lN: L.length, lFirst, lLast, carryoverAbs, carryoverPct, goal, pass };
}
function carryoverPdfFilename(run) {
  return `carryover_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}
async function renderCarryoverPdf(run) {
  const stats = carryoverStats(run);
  const cell = "padding:8px 12.5px;font-size:18.5px";
  const verdictBadge = (v) => v == null ? "--" : `<span class="badge" style="background:${v === "Yes" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${v === "Yes" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(v)}</span>`;
  const statsTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333;font-weight:700">Carryover</td><td style="${cell};padding-right:0;text-align:right;font-weight:700">${fmtN(stats.carryoverPct, 2)}% (${fmtN(stats.carryoverAbs, 3)} ${esc(run.units || "")})</td></tr>
    <tr><td style="${cell};padding-left:0;color:#666">High series: N / Last (H)</td><td style="${cell};padding-right:0;text-align:right;color:#666">${stats.hN} / ${fmtN(stats.hLast, 3)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#666">Low series: N / First (L1) / Last</td><td style="${cell};padding-right:0;text-align:right;color:#666">${stats.lN} / ${fmtN(stats.lFirst, 3)} / ${fmtN(stats.lLast, 3)}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Allowable Carryover</td><td style="${cell};padding-right:0;text-align:right">${stats.goal !== null ? (run.allowableCarryoverMode === "conc" ? fmtN(stats.goal, 3) + " " + esc(run.units || "") : stats.goal + "%") : "--"}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Verified</td><td style="${cell};padding-right:0;text-align:right">${verdictBadge(stats.pass)}</td></tr>
  </table>`;
  const supportTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333">Analyst</td><td style="${cell};padding-right:0;text-align:right">${esc(run.analyst || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Expt Date</td><td style="${cell};padding-right:0;text-align:right">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Units</td><td style="${cell};padding-right:0;text-align:right">${esc(run.units || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Methodology</td><td style="${cell};padding-right:0;text-align:right">${esc(run.methodology || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Comment</td><td style="${cell};padding-right:0;text-align:right">${esc(run.comment || "--")}</td></tr>
  </table>`;
  const dataCols = (rows, title) => {
    const list = rows || [];
    return `<td style="vertical-align:top;padding-right:18.5px;width:50%"><div style="font-weight:700;font-size:17px;margin-bottom:6px">${title} (N=${list.length})</div><table style="border-collapse:collapse;font-size:16.5px;width:100%">
      <tr style="font-weight:700"><td style="padding:4.5px 12px 4.5px 0">#</td><td style="padding:4.5px 0">Result</td></tr>
      ${list.map((r, k) => `<tr><td style="padding:3.5px 12px 3.5px 0">${k + 1}</td><td style="padding:3.5px 0">${esc(r.value || "")}${r.excluded ? " (X)" : ""}</td></tr>`).join("")}
    </table></td>`;
  };
  const headerHtml = reportHeaderHtml(run, "Carryover Verification", [
    `<strong>Instrument</strong> ${esc(run.instrument || "")}`,
  ]);
  const sections = [
    `<table style="width:100%;border-collapse:collapse;border:1px solid #999"><tr>
      <td style="padding:22px">${statsTable}</td>
    </tr></table>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:28px"><tr>
      <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Supporting Data</div>${supportTable}</td>
    </tr></table>`,
    reportSignatureHtml(run),
    `<div style="font-weight:700;font-size:19px;text-align:center;margin:34px 0 15.5px">Replicate Data (run in sequence: High series, then Low series immediately after)</div>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;padding:12.5px 0"><tr>${dataCols(run.highResults, "High-Concentration Sample")}${dataCols(run.lowResults, "Low-Concentration Sample (run right after)")}</tr></table>
    <div style="font-size:15.5px;color:#666;margin-top:6.5px">X: excluded from calculations</div>`,
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run) });
}

function renderCarryoverView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", instrument: "", units: "", methodology: "", comment: "",
    highResults: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    lowResults: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    allowableCarryoverMode: "percent", allowableCarryoverValue: "10",
    analyst: state.user.email, expDate: todayStr(),
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "",
    branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "",
    projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.carryoverRun || emptyRun();
  state.ui.carryoverRun = run;
  const branchFilter = isMaster ? (state.ui.coBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.map((i) => i.name).filter(Boolean))];
  const employeeNames = employeeDisplayNames();

  const q = (state.ui.coSearch || "").trim().toLowerCase();
  const saved = [...state.carryoverRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const stats = carryoverStats(run);
  const verdictSpan = (v) => v == null ? "—" : `<span class="badge" style="background:${v === "Yes" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${v === "Yes" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(v)}</span>`;
  const rowsTable = (rows, key, title) => `
    <div style="flex:1;min-width:230px">
      <h4 style="margin:0 0 6.5px;font-size:17px">${title}</h4>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>#</th><th>Result</th><th>Excl.</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td class="mono">${i + 1}</td>
          <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-grp="${key}" data-f="value" data-i="${i}" value="${esc(r.value)}" style="width:90px" /></td>
          <td style="text-align:center"><input type="checkbox" data-grp="${key}" data-f="excluded" data-i="${i}" ${r.excluded ? "checked" : ""} /></td>
          <td><button type="button" class="icon-btn-sm" data-rm-grp="${key}" data-i="${i}"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join("")}
        </tbody></table></div>
      <button type="button" class="btn secondary" data-add-grp="${key}" style="margin-top:8px;font-size:12.5px"><i class="fa-solid fa-plus"></i> Add</button>
    </div>`;

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkCo"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Carryover Verification (QR Evaluator)</h2><span class="subtitle">Run a high-concentration sample 3× then a low-concentration sample 3× immediately after — checks for analyte residue carrying between samples</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:16px"><select id="coBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="coBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="coAnalyte" value="${esc(run.analyte)}" />`)}
        ${fieldHtml("Instrument", `<input id="coInstrument" list="coInstruments" value="${esc(run.instrument)}" />`)}
        ${fieldHtml("Units", `<input id="coUnits" list="labUnitsList" value="${esc(run.units)}" />${labUnitsDatalistHtml()}`)}
      </div>
      <datalist id="coInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Methodology", `<input id="coMethodology" value="${esc(run.methodology)}" />`)}
        ${fieldHtml("Comment", `<input id="coComment" value="${esc(run.comment)}" />`)}
      </div>

      <div style="display:flex;gap:24px;flex-wrap:wrap;margin:26px 0">
        ${rowsTable(run.highResults, "high", "High-Concentration Sample (run first)")}
        ${rowsTable(run.lowResults, "low", "Low-Concentration Sample (run right after)")}
      </div>

      <div class="form-row">
        ${fieldHtml("Allowable Carryover", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="coAllowableValue" value="${esc(run.allowableCarryoverValue)}" />`)}
        ${fieldHtml("Basis", `<select id="coAllowableMode"><option value="percent" ${run.allowableCarryoverMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.allowableCarryoverMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
      </div>

      <div class="panel-card" style="margin:22px 0 28px">
        <div class="panel-title">Carryover Result (live preview)</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:12.5px">
          <div><span class="field-label">Carryover %</span><div class="mono">${fmtN(stats.carryoverPct, 2)}%</div></div>
          <div><span class="field-label">Carryover (conc)</span><div class="mono">${fmtN(stats.carryoverAbs, 3)} ${esc(run.units || "")}</div></div>
          <div><span class="field-label">Verified</span><div>${verdictSpan(stats.pass)}</div></div>
        </div>
      </div>

      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="coAnalyst" list="coEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="coExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      <datalist id="coEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="coReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="coReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="coAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="coAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="coReset">Clear form</button>
        <button type="button" class="btn primary" id="coSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved Carryover runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="coSearch" value="${esc(state.ui.coSearch || "")}" placeholder="Search by analyte, instrument, analyst, or branch…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Instrument</th><th>Carryover %</th><th>Branch</th><th>Status</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="8" class="table-empty">${q ? "No records match your search" : "No saved carryover runs yet"}</td></tr>` : saved.map((r) => {
        const s = carryoverStats(r);
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.instrument || "—")}</td>
          <td class="mono">${fmtN(s.carryoverPct, 2)}%</td><td>${esc(branchName(r.branchId))}</td>
          <td>${r.acceptedBy ? `<span class="badge" style="background:${STATUS_STYLES.ok.bg};color:${STATUS_STYLES.ok.text}">Accepted</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-co="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-co="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-co="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("coBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.coBranch = e.target.value; renderCarryoverView(); };
  const coBranchEl = el("coBranch"); if (coBranchEl) coBranchEl.onchange = (e) => { run.branchId = e.target.value; renderCarryoverView(); };
  el("coAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("coInstrument").oninput = (e) => run.instrument = e.target.value;
  el("coUnits").oninput = (e) => run.units = e.target.value;
  el("coMethodology").oninput = (e) => run.methodology = e.target.value;
  el("coComment").oninput = (e) => run.comment = e.target.value;
  el("coAllowableValue").oninput = (e) => run.allowableCarryoverValue = e.target.value;
  el("coAllowableMode").onchange = (e) => { run.allowableCarryoverMode = e.target.value; renderCarryoverView(); };
  el("coAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("coExpDate").oninput = (e) => run.expDate = e.target.value;
  el("coReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("coReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("coAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("coAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;

  const groups = { high: run.highResults, low: run.lowResults };
  el("mainContent").querySelectorAll("[data-add-grp]").forEach((btn) => btn.onclick = () => { groups[btn.dataset.addGrp].push(PRECISION_RESULT_BLANK()); renderCarryoverView(); });
  el("mainContent").querySelectorAll("[data-rm-grp]").forEach((btn) => btn.onclick = () => {
    const arr = groups[btn.dataset.rmGrp];
    arr.splice(Number(btn.dataset.i), 1);
    if (arr.length === 0) arr.push(PRECISION_RESULT_BLANK());
    renderCarryoverView();
  });
  el("mainContent").querySelectorAll("input[data-grp]").forEach((input) => {
    const arr = groups[input.dataset.grp], i = Number(input.dataset.i), f = input.dataset.f;
    if (input.type === "checkbox") input.onchange = (e) => { arr[i][f] = e.target.checked; renderCarryoverView(); };
    else { input.oninput = (e) => { arr[i][f] = e.target.value; }; input.onblur = () => renderCarryoverView(); }
  });
  ["high", "low"].forEach((key) => {
    attachExcelPasteObjects(el("mainContent"), `input[data-grp="${key}"][data-f="value"]`, groups[key], ["value"], PRECISION_RESULT_BLANK, renderCarryoverView);
  });

  el("coSearch").oninput = (e) => {
    state.ui.coSearch = e.target.value;
    renderCarryoverView();
    const refocused = el("coSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("coReset").onclick = () => { state.ui.carryoverRun = emptyRun(); renderCarryoverView(); };
  const epBackLinkCoEl = el("epBackLinkCo"); if (epBackLinkCoEl) epBackLinkCoEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-co]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.carryoverRuns.find((r) => r.id === btn.dataset.openCo);
    if (savedRun) { state.ui.carryoverRun = JSON.parse(JSON.stringify(savedRun)); renderCarryoverView(); }
  });
  el("mainContent").querySelectorAll("[data-del-co]").forEach((btn) => btn.onclick = () => deleteCarryoverRun(btn.dataset.delCo));
  el("mainContent").querySelectorAll("[data-dl-co]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.carryoverRuns.find((r) => r.id === btn.dataset.dlCo);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderCarryoverPdf(savedRun); pdf.save(carryoverPdfFilename(savedRun)); }
    catch (err) { console.error("Carryover PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("coSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderCarryoverPdf(run);
      pdf.save(carryoverPdfFilename(run));
      const saveResult = await saveCarryoverRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.carryoverRun = emptyRun();
      renderCarryoverView();
    } catch (err) {
      console.error("Carryover save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Interference / Specificity verification (QR Evaluator — CLSI EP7-style)
   Paired-difference protocol: a base pool is split into a "Control"
   aliquot (interferent-free, diluent added) and a "Test" aliquot
   (spiked with the interferent — hemolysis/icterus/lipemia/other — at
   a stated level), each run in replicate. Interference is the
   difference between the two means, checked against an allowable-
   interference goal. Same module pattern as Carryover: two replicate
   tables, live verdict, 3-level signature, one-page PDF.
--------------------------------------------------------------------- */
const INTERFERENT_TYPES = ["Hemolysis", "Icterus (Bilirubin)", "Lipemia", "Other"];
async function saveInterferenceRun(data) { return saveEpRunGuarded("interferenceRuns", data, "analyte"); }
async function deleteInterferenceRun(id) {
  const r = state.interferenceRuns.find((x) => x.id === id);
  if (!canDeleteLockedEpRun(r)) { toast("This report was already accepted and is locked — only the master account can delete it. Save an Amendment instead.", "warn"); return; }
  await db.collection("interferenceRuns").doc(id).delete();
  logAudit("delete_interference_run", r ? (r.analyte || id) : id, r ? `run ${r.expDate || ""} — ${r.interferentName || ""}` : "");
}
/** Interference = mean(Test) − mean(Control) — the standard paired-difference estimate (CLSI
 *  EP7): same base pool, one aliquot spiked with the interferent, one left interferent-free. */
function interferenceStats(run) {
  const C = epSeriesValues(run.controlResults), T = epSeriesValues(run.testResults);
  const controlMean = meanOf(C), testMean = meanOf(T);
  const diffAbs = controlMean !== null && testMean !== null ? testMean - controlMean : null;
  const diffPct = diffAbs !== null && controlMean ? (diffAbs / controlMean) * 100 : null;
  const goal = run.allowableInterferenceValue !== "" && run.allowableInterferenceValue != null ? Number(run.allowableInterferenceValue) : null;
  const pass = goal === null ? null
    : run.allowableInterferenceMode === "conc"
      ? (diffAbs !== null ? (Math.abs(diffAbs) <= goal ? "Yes" : "No") : null)
      : (diffPct !== null ? (Math.abs(diffPct) <= goal ? "Yes" : "No") : null);
  return { cN: C.length, controlMean, tN: T.length, testMean, diffAbs, diffPct, goal, pass };
}
function interferencePdfFilename(run) {
  return `interference_${(run.interferentName || "interferent").replace(/[^a-z0-9]+/gi, "-")}_${(run.analyte || "run").replace(/[^a-z0-9]+/gi, "-")}_${run.expDate || todayStr()}.pdf`;
}
async function renderInterferencePdf(run) {
  const stats = interferenceStats(run);
  const cell = "padding:8px 12.5px;font-size:18.5px";
  const verdictBadge = (v) => v == null ? "--" : `<span class="badge" style="background:${v === "Yes" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${v === "Yes" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(v)}</span>`;
  const statsTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333;font-weight:700">Interferent</td><td style="${cell};padding-right:0;text-align:right;font-weight:700">${esc(run.interferentName || "--")}${run.interferentLevel ? " @ " + esc(run.interferentLevel) : ""}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#666">Control: N / Mean</td><td style="${cell};padding-right:0;text-align:right;color:#666">${stats.cN} / ${fmtN(stats.controlMean, 3)} ${esc(run.units || "")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#666">Test (spiked): N / Mean</td><td style="${cell};padding-right:0;text-align:right;color:#666">${stats.tN} / ${fmtN(stats.testMean, 3)} ${esc(run.units || "")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333;font-weight:700">Interference</td><td style="${cell};padding-right:0;text-align:right;font-weight:700">${fmtN(stats.diffAbs, 3)} ${esc(run.units || "")} (${fmtN(stats.diffPct, 2)}%)</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Allowable Interference</td><td style="${cell};padding-right:0;text-align:right">${stats.goal !== null ? (run.allowableInterferenceMode === "conc" ? fmtN(stats.goal, 3) + " " + esc(run.units || "") : stats.goal + "%") : "--"}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Verified (no significant interference)</td><td style="${cell};padding-right:0;text-align:right">${verdictBadge(stats.pass)}</td></tr>
  </table>`;
  const supportTable = `<table style="width:100%;border-collapse:collapse;font-size:18.5px">
    <tr><td style="${cell};padding-left:0;color:#333">Analyst</td><td style="${cell};padding-right:0;text-align:right">${esc(run.analyst || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Expt Date</td><td style="${cell};padding-right:0;text-align:right">${esc(run.expDate || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Units</td><td style="${cell};padding-right:0;text-align:right">${esc(run.units || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Methodology</td><td style="${cell};padding-right:0;text-align:right">${esc(run.methodology || "--")}</td></tr>
    <tr><td style="${cell};padding-left:0;color:#333">Comment</td><td style="${cell};padding-right:0;text-align:right">${esc(run.comment || "--")}</td></tr>
  </table>`;
  const dataCols = (rows, title) => {
    const list = rows || [];
    return `<td style="vertical-align:top;padding-right:18.5px;width:50%"><div style="font-weight:700;font-size:17px;margin-bottom:6px">${title} (N=${list.length})</div><table style="border-collapse:collapse;font-size:16.5px;width:100%">
      <tr style="font-weight:700"><td style="padding:4.5px 12px 4.5px 0">#</td><td style="padding:4.5px 0">Result</td></tr>
      ${list.map((r, k) => `<tr><td style="padding:3.5px 12px 3.5px 0">${k + 1}</td><td style="padding:3.5px 0">${esc(r.value || "")}${r.excluded ? " (X)" : ""}</td></tr>`).join("")}
    </table></td>`;
  };
  const headerHtml = reportHeaderHtml(run, "Interference / Specificity Verification", [
    `<strong>Instrument</strong> ${esc(run.instrument || "")}`,
  ]);
  const sections = [
    `<table style="width:100%;border-collapse:collapse;border:1px solid #999"><tr>
      <td style="padding:22px">${statsTable}</td>
    </tr></table>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:28px"><tr>
      <td style="width:50%;vertical-align:top"><div style="font-weight:700;font-size:18.5px;margin-bottom:9px">Supporting Data</div>${supportTable}</td>
    </tr></table>`,
    reportSignatureHtml(run),
    `<div style="font-weight:700;font-size:19px;text-align:center;margin:34px 0 15.5px">Replicate Data (same base pool, split into interferent-free Control and spiked Test)</div>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;padding:12.5px 0"><tr>${dataCols(run.controlResults, "Control (interferent-free)")}${dataCols(run.testResults, "Test (spiked with interferent)")}</tr></table>
    <div style="font-size:15.5px;color:#666;margin-top:6.5px">X: excluded from calculations</div>`,
  ];
  return renderPaginatedPdf(headerHtml, sections, { left: reportPrintedLine(run) });
}

function renderInterferenceView() {
  const isMaster = state.role === "master";
  const myBranch = state.managedBranchId || state.myBranchId || null;
  const emptyRun = () => ({
    id: null, analyte: "", instrument: "", units: "", methodology: "", comment: "",
    interferentName: "Hemolysis", interferentLevel: "",
    controlResults: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    testResults: [PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK(), PRECISION_RESULT_BLANK()],
    allowableInterferenceMode: "percent", allowableInterferenceValue: "10",
    analyst: state.user.email, expDate: todayStr(),
    reviewedBy: "", reviewedDate: "", acceptedBy: "", acceptedDate: "",
    branchId: (state.ui.epProject && state.ui.epProject.branchId) || myBranch || "",
    projectId: (state.ui.epProject && state.ui.epProject.id) || null,
  });
  const run = state.ui.interferenceRun || emptyRun();
  state.ui.interferenceRun = run;
  const branchFilter = isMaster ? (state.ui.ifBranch || "") : (myBranch || "");
  const instrumentNames = [...new Set(state.instruments.map((i) => i.name).filter(Boolean))];
  const employeeNames = employeeDisplayNames();

  const q = (state.ui.ifSearch || "").trim().toLowerCase();
  const saved = [...state.interferenceRuns]
    .filter((r) => !branchFilter || r.branchId === branchFilter)
    .filter((r) => !state.ui.epProject || r.projectId === state.ui.epProject.id)
    .filter((r) => !q || [r.analyte, r.instrument, r.interferentName, r.analyst, branchName(r.branchId), r.expDate].some((v) => (v || "").toString().toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const stats = interferenceStats(run);
  const verdictSpan = (v) => v == null ? "—" : `<span class="badge" style="background:${v === "Yes" ? STATUS_STYLES.ok.bg : STATUS_STYLES.expired.bg};color:${v === "Yes" ? STATUS_STYLES.ok.text : STATUS_STYLES.expired.text}">${esc(v)}</span>`;
  const rowsTable = (rows, key, title) => `
    <div style="flex:1;min-width:230px">
      <h4 style="margin:0 0 6.5px;font-size:17px">${title}</h4>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>#</th><th>Result</th><th>Excl.</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td class="mono">${i + 1}</td>
          <td><input type="text" inputmode="decimal" dir="ltr" step="any" class="mono" data-grp="${key}" data-f="value" data-i="${i}" value="${esc(r.value)}" style="width:90px" /></td>
          <td style="text-align:center"><input type="checkbox" data-grp="${key}" data-f="excluded" data-i="${i}" ${r.excluded ? "checked" : ""} /></td>
          <td><button type="button" class="icon-btn-sm" data-rm-grp="${key}" data-i="${i}"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join("")}
        </tbody></table></div>
      <button type="button" class="btn secondary" data-add-grp="${key}" style="margin-top:8px;font-size:12.5px"><i class="fa-solid fa-plus"></i> Add</button>
    </div>`;

  el("mainContent").innerHTML = `
    <div class="page-header"><div>${state.ui.epProject ? `<div style="font-size:11.5px;margin-bottom:4px"><button type="button" class="link-btn" id="epBackLinkIf"><i class="fa-solid fa-arrow-left"></i> ${esc(state.ui.epProject.name)}</button></div>` : ""}<h2>Interference / Specificity (QR Evaluator)</h2><span class="subtitle">CLSI EP7-style — same base pool split into an interferent-free Control and a spiked Test (hemolysis, icterus, lipemia, etc.)</span></div></div>
    ${isMaster ? `<div class="filter-bar" style="display:flex;gap:10px;margin-bottom:16px"><select id="ifBranchScope" style="width:auto"><option value="">All branches</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === branchFilter ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select></div>` : ""}
    <div class="card-form card-form-wide">
      <div class="form-row">
        ${isMaster ? fieldHtml("Branch *", `<select id="ifBranch"><option value="" ${run.branchId ? "" : "selected"} disabled>Select…</option>${state.branches.map((br) => `<option value="${br.id}" ${br.id === run.branchId ? "selected" : ""}>${esc(br.name)}</option>`).join("")}</select>`) : ""}
        ${fieldHtml("Analyte / Test *", `<input id="ifAnalyte" value="${esc(run.analyte)}" />`)}
        ${fieldHtml("Instrument", `<input id="ifInstrument" list="ifInstruments" value="${esc(run.instrument)}" />`)}
        ${fieldHtml("Units", `<input id="ifUnits" list="labUnitsList" value="${esc(run.units)}" />${labUnitsDatalistHtml()}`)}
      </div>
      <datalist id="ifInstruments">${instrumentNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Interferent", `<select id="ifInterferentName">${INTERFERENT_TYPES.map((n) => `<option value="${esc(n)}" ${n === run.interferentName ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>`)}
        ${fieldHtml("Interferent Level", `<input id="ifInterferentLevel" value="${esc(run.interferentLevel)}" placeholder="e.g. 500 mg/dL Hb" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Methodology", `<input id="ifMethodology" value="${esc(run.methodology)}" />`)}
        ${fieldHtml("Comment", `<input id="ifComment" value="${esc(run.comment)}" />`)}
      </div>

      <div style="display:flex;gap:24px;flex-wrap:wrap;margin:26px 0">
        ${rowsTable(run.controlResults, "control", "Control (interferent-free)")}
        ${rowsTable(run.testResults, "test", "Test (spiked with interferent)")}
      </div>

      <div class="form-row">
        ${fieldHtml("Allowable Interference", `<input type="text" inputmode="decimal" dir="ltr" step="any" id="ifAllowableValue" value="${esc(run.allowableInterferenceValue)}" />`)}
        ${fieldHtml("Basis", `<select id="ifAllowableMode"><option value="percent" ${run.allowableInterferenceMode === "percent" ? "selected" : ""}>%</option><option value="conc" ${run.allowableInterferenceMode === "conc" ? "selected" : ""}>Concentration</option></select>`)}
      </div>

      <div class="panel-card" style="margin:22px 0 28px">
        <div class="panel-title">Interference Result (live preview)</div>
        <div class="form-row" style="flex-wrap:wrap;gap:18px 32px;margin-top:12.5px">
          <div><span class="field-label">Interference</span><div class="mono">${fmtN(stats.diffAbs, 3)} ${esc(run.units || "")}</div></div>
          <div><span class="field-label">Interference %</span><div class="mono">${fmtN(stats.diffPct, 2)}%</div></div>
          <div><span class="field-label">Verified</span><div>${verdictSpan(stats.pass)}</div></div>
        </div>
      </div>

      <div class="form-row">
        ${fieldHtml("Analyst", `<input id="ifAnalyst" list="ifEmployees" value="${esc(run.analyst)}" />`)}
        ${fieldHtml("Expt Date", `<input type="date" id="ifExpDate" value="${esc(run.expDate)}" />`)}
      </div>
      <datalist id="ifEmployees">${employeeNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="form-row">
        ${fieldHtml("Reviewed by", `<input id="ifReviewedBy" value="${esc(run.reviewedBy)}" placeholder="Senior tech / supervisor" />`)}
        ${fieldHtml("Reviewed date", `<input type="date" id="ifReviewedDate" value="${esc(run.reviewedDate)}" />`)}
      </div>
      <div class="form-row">
        ${fieldHtml("Accepted by (Lab Director sign-off — locks the report)", `<input id="ifAcceptedBy" value="${esc(run.acceptedBy)}" />`)}
        ${fieldHtml("Accepted date", `<input type="date" id="ifAcceptedDate" value="${esc(run.acceptedDate)}" />`)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn secondary" id="ifReset">Clear form</button>
        <button type="button" class="btn primary" id="ifSavePdf"><i class="fa-solid fa-file-pdf"></i> Save &amp; download PDF</button>
      </div>
    </div>

    <h3 style="margin:40px 0 18.5px;font-size:20.5px">Saved Interference/Specificity runs</h3>
    <div class="search-box" style="margin-bottom:22px"><i class="fa-solid fa-magnifying-glass"></i><input id="ifSearch" value="${esc(state.ui.ifSearch || "")}" placeholder="Search by analyte, interferent, instrument, analyst, or branch…" /></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Analyte</th><th>Interferent</th><th>Instrument</th><th>Interference</th><th>Branch</th><th>Status</th><th>PDF</th><th>Actions</th></tr></thead>
      <tbody>${saved.length === 0 ? `<tr><td colspan="9" class="table-empty">${q ? "No records match your search" : "No saved interference runs yet"}</td></tr>` : saved.map((r) => {
        const s = interferenceStats(r);
        return `<tr><td class="mono">${esc(r.expDate || "—")}</td><td>${esc(r.analyte || "—")}</td><td>${esc(r.interferentName || "—")}</td><td>${esc(r.instrument || "—")}</td>
          <td class="mono">${fmtN(s.diffPct, 2)}%</td><td>${esc(branchName(r.branchId))}</td>
          <td>${r.acceptedBy ? `<span class="badge" style="background:${STATUS_STYLES.ok.bg};color:${STATUS_STYLES.ok.text}">Accepted</span>` : "—"}</td>
          <td><button type="button" class="icon-btn-sm" data-dl-if="${r.id}" title="Download PDF"><i class="fa-solid fa-file-pdf"></i></button></td>
          <td><button type="button" class="icon-btn-sm" data-open-if="${r.id}" title="Open / edit"><i class="fa-solid fa-pen"></i></button> <button class="icon-btn-sm" data-del-if="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button></td></tr>`;
      }).join("")}
      </tbody></table></div>`;

  const branchScopeEl = el("ifBranchScope"); if (branchScopeEl) branchScopeEl.onchange = (e) => { state.ui.ifBranch = e.target.value; renderInterferenceView(); };
  const ifBranchEl = el("ifBranch"); if (ifBranchEl) ifBranchEl.onchange = (e) => { run.branchId = e.target.value; renderInterferenceView(); };
  el("ifAnalyte").oninput = (e) => run.analyte = e.target.value;
  el("ifInstrument").oninput = (e) => run.instrument = e.target.value;
  el("ifUnits").oninput = (e) => run.units = e.target.value;
  el("ifInterferentName").onchange = (e) => run.interferentName = e.target.value;
  el("ifInterferentLevel").oninput = (e) => run.interferentLevel = e.target.value;
  el("ifMethodology").oninput = (e) => run.methodology = e.target.value;
  el("ifComment").oninput = (e) => run.comment = e.target.value;
  el("ifAllowableValue").oninput = (e) => run.allowableInterferenceValue = e.target.value;
  el("ifAllowableMode").onchange = (e) => { run.allowableInterferenceMode = e.target.value; renderInterferenceView(); };
  el("ifAnalyst").oninput = (e) => run.analyst = e.target.value;
  el("ifExpDate").oninput = (e) => run.expDate = e.target.value;
  el("ifReviewedBy").oninput = (e) => run.reviewedBy = e.target.value;
  el("ifReviewedDate").oninput = (e) => run.reviewedDate = e.target.value;
  el("ifAcceptedBy").oninput = (e) => run.acceptedBy = e.target.value;
  el("ifAcceptedDate").oninput = (e) => run.acceptedDate = e.target.value;

  const groups = { control: run.controlResults, test: run.testResults };
  el("mainContent").querySelectorAll("[data-add-grp]").forEach((btn) => btn.onclick = () => { groups[btn.dataset.addGrp].push(PRECISION_RESULT_BLANK()); renderInterferenceView(); });
  el("mainContent").querySelectorAll("[data-rm-grp]").forEach((btn) => btn.onclick = () => {
    const arr = groups[btn.dataset.rmGrp];
    arr.splice(Number(btn.dataset.i), 1);
    if (arr.length === 0) arr.push(PRECISION_RESULT_BLANK());
    renderInterferenceView();
  });
  el("mainContent").querySelectorAll("input[data-grp]").forEach((input) => {
    const arr = groups[input.dataset.grp], i = Number(input.dataset.i), f = input.dataset.f;
    if (input.type === "checkbox") input.onchange = (e) => { arr[i][f] = e.target.checked; renderInterferenceView(); };
    else { input.oninput = (e) => { arr[i][f] = e.target.value; }; input.onblur = () => renderInterferenceView(); }
  });
  ["control", "test"].forEach((key) => {
    attachExcelPasteObjects(el("mainContent"), `input[data-grp="${key}"][data-f="value"]`, groups[key], ["value"], PRECISION_RESULT_BLANK, renderInterferenceView);
  });

  el("ifSearch").oninput = (e) => {
    state.ui.ifSearch = e.target.value;
    renderInterferenceView();
    const refocused = el("ifSearch");
    if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
  };
  el("ifReset").onclick = () => { state.ui.interferenceRun = emptyRun(); renderInterferenceView(); };
  const epBackLinkIfEl = el("epBackLinkIf"); if (epBackLinkIfEl) epBackLinkIfEl.onclick = () => navigateTo("epProject");
  el("mainContent").querySelectorAll("[data-open-if]").forEach((btn) => btn.onclick = () => {
    const savedRun = state.interferenceRuns.find((r) => r.id === btn.dataset.openIf);
    if (savedRun) { state.ui.interferenceRun = JSON.parse(JSON.stringify(savedRun)); renderInterferenceView(); }
  });
  el("mainContent").querySelectorAll("[data-del-if]").forEach((btn) => btn.onclick = () => deleteInterferenceRun(btn.dataset.delIf));
  el("mainContent").querySelectorAll("[data-dl-if]").forEach((btn) => btn.onclick = async () => {
    const savedRun = state.interferenceRuns.find((r) => r.id === btn.dataset.dlIf);
    if (!savedRun) return;
    btn.disabled = true;
    try { const pdf = await renderInterferencePdf(savedRun); pdf.save(interferencePdfFilename(savedRun)); }
    catch (err) { console.error("Interference PDF regeneration failed:", err); toast("Failed to generate PDF: " + (err && err.message ? err.message : err), "error"); }
    finally { btn.disabled = false; }
  });

  el("ifSavePdf").onclick = async (e) => {
    if (isMaster && !run.branchId) { toast("Please select a branch.", "warn"); return; }
    if (!run.analyte.trim()) { toast("Please enter the analyte / test name.", "warn"); return; }
    if ((run.acceptedBy || "").trim() && (!(run.reviewedBy || "").trim() || !run.reviewedDate)) { toast("A report needs a Reviewed by name and date before it can be Accepted.", "warn"); return; }
    const btn = e.currentTarget; const originalText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = "Generating…";
    try {
      const data = { ...run, branchId: run.branchId || myBranch || null };
      const pdf = await renderInterferencePdf(run);
      pdf.save(interferencePdfFilename(run));
      const saveResult = await saveInterferenceRun(data);
      if (saveResult.amended) toast(`This report was already accepted — your changes were saved as Amendment #${saveResult.amendmentNo} (the accepted original stays locked).`, "warn");
      state.ui.interferenceRun = emptyRun();
      renderInterferenceView();
    } catch (err) {
      console.error("Interference save/PDF failed:", err);
      toast("Failed to save/generate PDF: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false; btn.innerHTML = originalText;
    }
  };
}

/* ---------------------------------------------------------------------
   Firestore mutations
--------------------------------------------------------------------- */
async function upsertCatalogItem(data) {
  if (data.id) { await db.collection("catalog").doc(data.id).set(data, { merge: true }); return data; }
  const ref = db.collection("catalog").doc();
  const created = { id: ref.id, ...data };
  await ref.set(created);
  return created;
}
async function importCatalogFromExcel(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: "array" });
  const pickKey = (row, aliases) => {
    const keys = Object.keys(row);
    for (const a of aliases) {
      const k = keys.find((k) => k.trim().toLowerCase() === a);
      if (k) return k;
    }
    return null;
  };

  // The workbook may contain more than one sheet (e.g. a "Read me first" instructions tab plus a
  // "Catalog Import" data tab). Prefer a sheet literally named like the data tab; otherwise scan
  // every sheet and use the first one whose header row actually has an Item ID + Product Name
  // column, so an instructions-only first sheet never gets mistaken for the data.
  let rows = null, idKey = null, nameKey = null;
  const byNamePreference = [...wb.SheetNames].sort((a, b) => {
    const score = (n) => /catalog\s*import|import/i.test(n) ? 0 : 1;
    return score(a) - score(b);
  });
  for (const sheetName of byNamePreference) {
    const candidateRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
    if (!candidateRows.length) continue;
    const iKey = pickKey(candidateRows[0], ["item id", "itemid", "gtin", "barcode"]);
    const nKey = pickKey(candidateRows[0], ["product name", "item name", "name", "description"]);
    if (iKey && nKey) { rows = candidateRows; idKey = iKey; nameKey = nKey; break; }
  }
  if (!rows) throw new Error('Could not find a sheet with an "Item ID" and a "Product Name" column in the file.');

  const numberKey = pickKey(rows[0], ["item number", "itemnumber", "item no", "code", "sku"]);
  const unitsPerBoxKey = pickKey(rows[0], ["units per box", "unitsperbox", "units/box", "cartridges per box"]);
  const testsPerUnitKey = pickKey(rows[0], ["tests per unit", "testsperunit", "tests/unit"]);
  const unitKey = pickKey(rows[0], ["unit name", "unitname", "unit"]);

  const byBarcode = {};
  state.catalog.forEach((c) => { if (c.barcode) byBarcode[c.barcode] = c; });

  let added = 0, updated = 0, skipped = 0;
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const row of rows) {
    const barcode = String(row[idKey] ?? "").trim();
    const name = String(row[nameKey] ?? "").trim();
    const itemNumber = numberKey ? String(row[numberKey] ?? "").trim() : "";
    const unitsPerBox = unitsPerBoxKey ? Number(row[unitsPerBoxKey]) || 1 : undefined;
    const testsPerUnit = testsPerUnitKey ? Number(row[testsPerUnitKey]) || 0 : undefined;
    const unit = unitKey ? normalizeUnitName(row[unitKey]) : "";
    const suggestedCategory = suggestCategoryFromItemNumber(itemNumber);
    if (!barcode || !name) { skipped++; continue; }
    const existing = byBarcode[barcode];
    if (existing) {
      const update = { name, itemNumber };
      if (unitsPerBox !== undefined) update.unitsPerBox = unitsPerBox;
      if (testsPerUnit !== undefined) update.testsPerUnit = testsPerUnit;
      if (unit) update.unit = unit; // auto-fill the unit an item is measured in from the catalog file
      if (suggestedCategory) update.category = suggestedCategory; // CAL/CTRL/RGT prefix on the item number
      batch.set(db.collection("catalog").doc(existing.id), update, { merge: true });
      updated++;
    } else {
      const ref = db.collection("catalog").doc();
      batch.set(ref, { id: ref.id, name, barcode, itemNumber, category: suggestedCategory || CATEGORIES[0], unit: unit || UNITS[0], unitsPerBox: unitsPerBox || 1, testsPerUnit: testsPerUnit || "" });
      byBarcode[barcode] = { id: ref.id, barcode }; // avoid duplicate creates within the same file
      added++;
    }
    ops++;
    if (ops >= 400) await flush(); // stay under Firestore's 500-op batch limit
  }
  await flush();
  return { added, updated, skipped };
}
/**
 * Returns a catalog item's barcode, generating and saving a new internal one (LOCAL0001, LOCAL0002…)
 * if it doesn't have a real one yet. Uses a Firestore transaction on counters/localBarcode so two
 * people generating codes at the same time never collide. This is a *product-level* code (shared by
 * every lot of that item) — used only for generic shelf/catalog labels. For a label tied to one
 * specific received lot, use getOrCreateBatchBarcode instead.
 */
async function getOrCreateBarcode(catalogItem) {
  if (catalogItem.barcode) return catalogItem.barcode;
  const counterRef = db.collection("counters").doc("localBarcode");
  const code = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists ? snap.data().value : 0) + 1;
    tx.set(counterRef, { value: next }, { merge: true });
    return "LOCAL" + String(next).padStart(4, "0");
  });
  await db.collection("catalog").doc(catalogItem.id).set({ barcode: code }, { merge: true });
  catalogItem.barcode = code;
  return code;
}
/**
 * Returns a *batch-specific* label barcode, generating and saving one ("LOT00001", "LOT00002"…) the
 * first time it's needed. Distinct code space from getOrCreateBarcode/catalog barcodes on purpose:
 * - It is recognized ONLY by Dispense (findByBatchBarcode), so it can only ever be used to withdraw
 *   from that exact lot — it will never be mistaken for a manufacturer barcode during Addition.
 * - Receiving the item's real manufacturer barcode later still works exactly as before and creates
 *   its own new lot, unaffected by this code.
 * Uses a Firestore transaction on counters/localLotBarcode so two people printing at once never collide.
 */
async function getOrCreateBatchBarcode(batch) {
  if (batch.barcode) return batch.barcode;
  const counterRef = db.collection("counters").doc("localLotBarcode");
  const code = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists ? snap.data().value : 0) + 1;
    tx.set(counterRef, { value: next }, { merge: true });
    return "LOT" + String(next).padStart(5, "0");
  });
  await db.collection("batches").doc(batch.id).set({ barcode: code }, { merge: true });
  batch.barcode = code;
  return code;
}

/* ---------------------------------------------------------------------
   ZEBRA DIRECT PRINTING (Zebra Browser Print SDK)
   Optional — only active if the free "Zebra Browser Print" app is installed on this computer AND
   its JS SDK is loaded (see index.html + README §8). Falls back to the normal browser print dialog
   (JsBarcode popup below) when unavailable, so nothing breaks without it.
--------------------------------------------------------------------- */
function zebraAvailable() { return typeof window.BrowserPrint !== "undefined"; }
/** Strips characters that have special meaning inside a ZPL ^FD field (^ ~ and the field delimiter). */
function zplSafe(s) { return String(s ?? "").replace(/[\^~]/g, " ").slice(0, 60); }
/** Builds a compact ZPL label: item name, lot/expiry/qty, and a Code128 barcode of `code`. Sized for a
 *  standard 3" x 2" (76mm x 51mm) thermal label at 203dpi — adjust ^PW/^LL if your label stock differs. */
function buildLabelZpl({ name, lot, expiry, qty, unit, code }) {
  const line2 = [lot ? `Lot: ${lot}` : "", expiry ? `Exp: ${expiry}` : "", qty != null ? `Qty: ${qty}${unit ? " " + unit : ""}` : ""].filter(Boolean).join("   ");
  return ["^XA", "^PW609", "^LL406", "^FO20,20^A0N,32,32^FD" + zplSafe(name) + "^FS", "^FO20,60^A0N,24,24^FD" + zplSafe(line2) + "^FS", "^FO20,110^BY2,2,90", "^BCN,90,Y,N,N", "^FD" + zplSafe(code) + "^FS", "^XZ"].join("\n");
}
/** Sends raw ZPL to the computer's default Zebra printer via the Browser Print SDK. */
function zebraPrintZpl(zpl, onOk, onErr) {
  if (!zebraAvailable()) { if (onErr) onErr("Zebra Browser Print is not installed/loaded on this device."); return; }
  window.BrowserPrint.getDefaultDevice("printer", (device) => {
    if (!device) { if (onErr) onErr("No Zebra printer found — make sure it's connected and powered on."); return; }
    device.send(zpl, () => { if (onOk) onOk(); }, (err) => { if (onErr) onErr(err); });
  }, (err) => { if (onErr) onErr(err); });
}
/** Opens a small print-ready window with a scannable Code128 barcode, plus a "Print via Zebra" button
 *  when the SDK is available (sends ZPL directly, no dialog) alongside the normal browser Print button. */
function openBarcodeWindow({ title, lines, code, zpl }) {
  const win = window.open("", "_blank", "width=420,height=380");
  if (!win) { toast("Please allow pop-ups to print the barcode.", "warn"); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>${esc(title)}</title>
    <style>body{font-family:Arial,sans-serif;text-align:center;padding:24px}
    h2{font-size:14px;margin:0 0 4px}p{font-size:11px;color:#555;margin:2px 0}
    button{margin:4px;padding:8px 14px;font-size:13px}
    @media print{button,#zebraRow{display:none}}</style></head><body>
    <h2>${esc(title)}</h2>
    ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
    <svg id="bc"></svg>
    <p><button onclick="window.print()">Print (browser)</button></p>
    <p id="zebraRow"><button id="zebraBtn" style="display:none">Print via Zebra (direct)</button></p>
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
    <script>JsBarcode("#bc", ${JSON.stringify(code)}, { format: "CODE128", width: 2, height: 70, fontSize: 14 });</script>
    </body></html>`);
  win.document.close();
  if (zebraAvailable() && zpl) {
    const btn = win.document.getElementById("zebraBtn");
    if (btn) {
      btn.style.display = "inline-block";
      btn.onclick = () => {
        btn.disabled = true; btn.textContent = "Printing…";
        zebraPrintZpl(zpl, () => { win.close(); }, (err) => { toast("Zebra print failed: " + err, "error"); btn.disabled = false; btn.textContent = "Print via Zebra (direct)"; });
      };
    }
  }
}
/** Opens a print-ready window with a *product-level* barcode (generating one first if it doesn't have one yet). Used for generic shelf/catalog labels — not tied to one lot. */
async function printBarcodeFor(catalogItem) {
  if (!catalogItem) { toast("Item not found.", "error"); return; }
  let code;
  try { code = await getOrCreateBarcode(catalogItem); }
  catch (err) { toast("Could not generate a barcode: " + (err && err.message ? err.message : err), "error"); return; }
  openBarcodeWindow({ title: catalogItem.name, lines: [], code, zpl: buildLabelZpl({ name: catalogItem.name, code }) });
}
/** Opens a print-ready window with a *batch-specific* label barcode (generating one first if it doesn't
 *  have one yet). Scanning this label during Dispense pulls from this exact lot only — it plays no part
 *  in Addition/receiving, where the item's real manufacturer barcode continues to work as before. */
async function printBatchLabel(batchId) {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch) { toast("Batch not found.", "error"); return; }
  const cat = catalogById(batch.catalogItemId);
  const name = cat ? cat.name : "(deleted item)";
  let code;
  try { code = await getOrCreateBatchBarcode(batch); }
  catch (err) { toast("Could not generate a barcode: " + (err && err.message ? err.message : err), "error"); return; }
  const lines = [`Lot: ${batch.lot || "—"}${batch.expiry ? " · Exp: " + batch.expiry : ""}`, `Qty: ${batch.quantity}${cat ? " " + cat.unit : ""}`];
  openBarcodeWindow({ title: name, lines, code, zpl: buildLabelZpl({ name, lot: batch.lot, expiry: batch.expiry, qty: batch.quantity, unit: cat ? cat.unit : "", code }) });
}
async function addLog(entry) {
  const branchName = state.branches.find((b) => b.id === state.myBranchId)?.name || "";
  await db.collection("logs").add({ date: nowStr(), byEmail: state.user.email, branchId: state.myBranchId || null, branchName, ...entry });
}
async function receiveBatch({ catalogItem, fridgeId, shelf, quantity, expiry, lot, notes, method, addedAt }) {
  const item = await upsertCatalogItem(catalogItem);
  const qty = Number(quantity) || 0;
  const existing = findMatchingBatch(item.id, fridgeId, lot, expiry);
  let batchId;
  if (existing) {
    await db.collection("batches").doc(existing.id).update({ quantity: round4(existing.quantity + qty) });
    batchId = existing.id;
  } else {
    const batch = { catalogItemId: item.id, fridgeId, branchId: fridgeBranchId(fridgeId), shelf, quantity: qty, expiry, lot, notes, addedAt: addedAt || todayStr() };
    const ref = await db.collection("batches").add(batch);
    batchId = ref.id;
  }
  await addLog({ type: "in", catalogItemId: item.id, quantity: qty, lot: lot || "", expiry: expiry || "", method: method || "Manual", note: `Received${lot ? " · lot " + lot : ""}${existing ? " (added to existing batch)" : ""}`, date: nowStr() });
  return { id: batchId, catalogItemId: item.id, fridgeId, shelf, quantity: qty, expiry, lot, notes };
}
/** Detects a reagent lot switch on routine consumption: compares this withdrawal's lot against
 *  the lot used in the *previous* "out" withdrawal of the same catalog item. If they differ, a
 *  Lot-to-Lot verification is required before the new lot goes into routine use, so this creates
 *  a pending task (surfaced in the To Do list and the notification bell) rather than silently
 *  letting the switch go unverified. Naturally fires once per switch: after the first withdrawal
 *  of the new lot, the "previous out" comparison lands on that same new lot and stays quiet until
 *  the lot changes again. */
async function flagLotToLotIfLotChanged(batch, branchId) {
  if (!batch.lot || !(batch.lot || "").trim()) return;
  const priorOut = state.logs
    .filter((l) => l.catalogItemId === batch.catalogItemId && l.type === "out" && (l.lot || "").trim())
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!priorOut) return;
  const oldLot = priorOut.lot.trim(), newLot = batch.lot.trim();
  if (oldLot === newLot) return;
  const cat = catalogById(batch.catalogItemId);
  const itemName = cat ? cat.name : "(deleted item)";
  await db.collection("lotToLotTasks").add({
    kind: "lotChange", catalogItemId: batch.catalogItemId, itemName, oldLot, newLot, branchId: branchId || null,
    status: "pending", createdAt: nowStr(), createdBy: state.user.email,
  });
  toast(`Lot change detected for ${itemName}: ${oldLot} → ${newLot}. Lot-to-Lot verification is required — added to your To Do list.`, "warn");
}
async function completeLotToLotTask(id) {
  await db.collection("lotToLotTasks").doc(id).set({ status: "done", resolvedAt: nowStr(), resolvedBy: state.user.email }, { merge: true });
}
async function deleteLotToLotTask(id) {
  await db.collection("lotToLotTasks").doc(id).delete();
}
/** Pending Lot-to-Lot tasks visible to the signed-in user — everything for master, own branch
 *  otherwise (state.lotToLotTasks is already branch-scoped server-side for non-master users). */
function pendingLotToLotTasks() {
  return state.lotToLotTasks.filter((t) => t.status !== "done").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/* ---------------------------------------------------------------------
   Periodic re-validation reminders — CAP/ISO 15189 expects a method
   validation to be repeated (annually, by default) once it's been in
   routine use a while. Every ACCEPTED (locked/signed-off) EP Evaluator
   study already carries acceptedDate, so this needs no new data entry:
   it just watches that date per (test/analyte + instrument + branch)
   group and flags the group once its most recent acceptance is
   approaching (or past) the revalidation interval.
--------------------------------------------------------------------- */
const REVALIDATION_INTERVAL_MONTHS = 12;
const REVALIDATION_WARN_DAYS = 30; // start warning this many days before the due date
/** One row per (analyte/test + instrument + branch + study type) group, keyed off the most
 *  recently accepted run in that group — amendments (which re-open acceptance) naturally take
 *  over as "most recent" once they themselves are accepted, so the clock restarts correctly. */
function revalidationGroups() {
  const groups = {};
  EP_RUN_TYPES.forEach((t) => {
    if (t.key === "methodValidationSummaryRuns") return; // one-time cover sheet, not a recurring study
    (state[t.key] || []).forEach((r) => {
      if (!r.acceptedBy || !r.acceptedDate) return; // only an accepted/locked study starts the clock
      const analyte = r.analyte || r.testName || "—";
      const key = [t.key, analyte, r.instrument || "", r.branchId || ""].join("|");
      if (!groups[key] || r.acceptedDate > groups[key].acceptedDate) {
        groups[key] = { studyType: t.label, studyView: t.view, analyte, instrument: r.instrument || "", branchId: r.branchId || null, acceptedDate: r.acceptedDate };
      }
    });
  });
  return Object.values(groups).map((g) => ({ ...g, dueDate: addMonths(g.acceptedDate, REVALIDATION_INTERVAL_MONTHS) }));
}
function revalidationsDueSoon() {
  return revalidationGroups()
    .map((g) => ({ ...g, days: daysUntil(g.dueDate) }))
    .filter((g) => g.days !== null && g.days <= REVALIDATION_WARN_DAYS)
    .sort((a, b) => a.days - b.days);
}
function revalidationTaskKey(g) { return [g.studyType, g.analyte, g.instrument, g.branchId].join("|"); }
/** Revalidation reminders that don't already have an open To Do task tracking them — avoids
 *  spamming a fresh task in on every re-render; the task itself is what shows up in the bell/list. */
function newRevalidationTasksNeeded() {
  const existingKeys = new Set(state.lotToLotTasks.filter((t) => t.kind === "revalidation" && t.status !== "done").map((t) => t.taskKey));
  return revalidationsDueSoon().filter((g) => !existingKeys.has(revalidationTaskKey(g)));
}
/** Creates (or re-surfaces) a To Do task for each due-soon study that doesn't already have a
 *  pending one — called once after the EP run collections + lotToLotTasks have loaded. Reuses the
 *  same lotToLotTasks collection/list (kind: "revalidation" vs "lotChange") so one To Do page and
 *  one notification feed cover both. */
async function syncRevalidationTasks() {
  const due = newRevalidationTasksNeeded();
  for (const g of due) {
    await db.collection("lotToLotTasks").add({
      kind: "revalidation", taskKey: revalidationTaskKey(g),
      itemName: `${g.analyte}${g.instrument ? " · " + g.instrument : ""} (${g.studyType})`,
      studyView: g.studyView, dueDate: g.dueDate, branchId: g.branchId,
      status: "pending", createdAt: nowStr(), createdBy: "system",
    });
  }
}

async function dispenseFromBatch(batchId, qty, { type, method, reason, date }) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) return;
  const remaining = b.quantity - qty;
  if (type === "out") await flagLotToLotIfLotChanged(b, b.branchId);
  await addLog({ type, catalogItemId: b.catalogItemId, quantity: qty, lot: b.lot || "", expiry: b.expiry || "", method: method || "Manual", reason: reason || "", note: reason || "", date: date ? `${date} ${nowStr().split(" ")[1] || ""}`.trim() : nowStr() });
  if (remaining <= 0) await db.collection("batches").doc(batchId).delete();
  // Mark the lot "in use" the first time anything is taken from it (dispense OR waste) — this is what
  // the green "In use" indicator in Inventory List reads, so partial/opened lots stand out from
  // still-sealed ones. Once set it stays set for the life of this batch record.
  else await db.collection("batches").doc(batchId).update({ quantity: remaining, inUse: true, lastDispensedAt: nowStr() });
}
async function mergeLots(sourceId, targetId, qty, unit) {
  const source = state.batches.find((b) => b.id === sourceId);
  const target = state.batches.find((b) => b.id === targetId);
  if (!source || !target) return;
  const cat = catalogById(source.catalogItemId);
  const qtyBase = round4(toBaseQty(cat, qty, unit));
  const remaining = round4(source.quantity - qtyBase);
  if (remaining <= 0.0001) await db.collection("batches").doc(sourceId).delete();
  else await db.collection("batches").doc(sourceId).update({ quantity: remaining });
  await db.collection("batches").doc(targetId).update({ quantity: round4(target.quantity + qtyBase) });
  await db.collection("merges").add({
    catalogItemId: source.catalogItemId, itemName: cat ? cat.name : "(deleted item)",
    sourceLot: source.lot || "—", targetLot: target.lot || "—", quantity: qty, unit: unit || (cat ? cat.unit : ""),
    date: nowStr(), byEmail: state.user.email, branchId: state.myBranchId || null,
  });
}
/** Sends `qty` units of a batch to another branch: deducts it from the sender's stock immediately
 *  and creates a pending transfer record for the destination branch to receive. */
async function sendTransfer(batchId, qty, unit, toBranchId) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) return;
  const cat = catalogById(b.catalogItemId);
  const baseUnit = cat ? cat.unit : "";
  const qtyBase = round4(toBaseQty(cat, qty, unit));
  const remaining = round4(b.quantity - qtyBase);
  if (remaining <= 0.0001) await db.collection("batches").doc(batchId).delete();
  else await db.collection("batches").doc(batchId).update({ quantity: remaining });
  const fromBranchId = state.managedBranchId || state.myBranchId || null;
  await db.collection("transfers").add({
    catalogItemId: b.catalogItemId, itemName: cat ? cat.name : "(deleted item)", unit: unit || baseUnit,
    lot: b.lot || "", expiry: b.expiry || "", quantity: qty, qtyBase, baseUnit,
    fromBranchId, fromBranchName: branchName(fromBranchId), fromFridgeId: b.fridgeId, fromShelf: b.shelf || "",
    toBranchId, toBranchName: branchName(toBranchId),
    status: "pending", createdAt: nowStr(), createdBy: state.user.email,
  });
  await addLog({ type: "transfer_out", catalogItemId: b.catalogItemId, quantity: qty, lot: b.lot || "", expiry: b.expiry || "", method: "Manual", note: `Sent ${qty} ${unit || baseUnit} to ${branchName(toBranchId)}`, date: nowStr() });
}
/** Confirms receipt of a pending transfer: creates a new batch in the chosen fridge and marks the transfer received. */
async function receiveTransfer(transferId, fridgeId, shelf) {
  const t = state.transfers.find((x) => x.id === transferId);
  if (!t) return;
  const qtyBase = t.qtyBase != null ? t.qtyBase : Number(t.quantity) || 0; // older transfers predate qtyBase
  const existing = findMatchingBatch(t.catalogItemId, fridgeId, t.lot, t.expiry);
  if (existing) await db.collection("batches").doc(existing.id).update({ quantity: round4(existing.quantity + qtyBase) });
  else await db.collection("batches").add({ catalogItemId: t.catalogItemId, fridgeId, branchId: t.toBranchId || fridgeBranchId(fridgeId), shelf: shelf || "", quantity: qtyBase, expiry: t.expiry || "", lot: t.lot || "", notes: `Received transfer from ${t.fromBranchName || "—"}${t.unit && t.unit !== t.baseUnit ? ` (sent as ${t.quantity} ${t.unit})` : ""}`, addedAt: todayStr() });
  await db.collection("transfers").doc(transferId).set({ status: "received", receivedAt: nowStr(), receivedBy: state.user.email, receivedFridgeId: fridgeId, receivedShelf: shelf || "" }, { merge: true });
  await addLog({ type: "transfer_in", catalogItemId: t.catalogItemId, quantity: t.quantity, lot: t.lot || "", expiry: t.expiry || "", method: "Manual", note: `Received from ${t.fromBranchName || "—"}`, date: nowStr() });
}
/** Cancels a still-pending transfer and restores the quantity back into its original fridge/shelf. */
async function cancelTransfer(transferId) {
  const t = state.transfers.find((x) => x.id === transferId);
  if (!t) return;
  const qtyBase = t.qtyBase != null ? t.qtyBase : Number(t.quantity) || 0; // older transfers predate qtyBase
  if (t.fromFridgeId) {
    const existing = state.batches.find((b) => b.catalogItemId === t.catalogItemId && b.fridgeId === t.fromFridgeId && (b.lot || "") === (t.lot || "") && (b.expiry || "") === (t.expiry || ""));
    if (existing) await db.collection("batches").doc(existing.id).update({ quantity: round4(existing.quantity + qtyBase) });
    else await db.collection("batches").add({ catalogItemId: t.catalogItemId, fridgeId: t.fromFridgeId, branchId: t.fromBranchId || fridgeBranchId(t.fromFridgeId), shelf: t.fromShelf || "", quantity: qtyBase, expiry: t.expiry || "", lot: t.lot || "", notes: "Restored from cancelled transfer", addedAt: todayStr() });
  }
  await db.collection("transfers").doc(transferId).set({ status: "cancelled", cancelledAt: nowStr(), cancelledBy: state.user.email }, { merge: true });
}
async function saveBatchEdit(data) {
  const { id, ...rest } = data;
  rest.quantity = Number(rest.quantity) || 0;
  rest.branchId = fridgeBranchId(rest.fridgeId);
  await db.collection("batches").doc(id).set(rest, { merge: true });
}
/** Immutable admin/security audit trail — separate from the inventory transaction log (`logs`).
 *  Records who did a sensitive admin action (delete, user/role change, branch change) and when.
 *  Fire-and-forget by design: an audit write failing must never block the actual action. */
/** Shared save path for every QR Evaluator / EP report (Precision, Accuracy, Comparison,
 *  Qualitative Precision/Comparison, Reference Interval, Linearity, Method Validation Summary).
 *  Gives all of them, for free, the same compliance behaviour (ISO 15189 style):
 *   1. Field-level audit trail — every create/edit is logged with exactly which fields changed.
 *   2. Report lock after sign-off — once a report has been accepted (acceptedBy + acceptedDate
 *      are both set), further changes can no longer overwrite it. Instead an Amendment is
 *      created: a new, separate record carrying the edited data, linked back to the original via
 *      amendmentOf/amendmentNo, with its own (blank) acceptance fields so it goes through sign-off
 *      again. The original stays exactly as it was accepted — a real audit requirement, not just
 *      a UI nicety.
 *  Returns { id, amended, amendmentNo } so the calling view can tell the user what happened and
 *  keep editing the right record (the new amendment id, not the locked original). */
/** Shared delete guard for every QR Evaluator / EP report: once a report is accepted (locked),
 *  only the master account can delete it — anyone else gets redirected to raise an Amendment
 *  instead, so a signed-off record can't just quietly disappear. Non-locked (draft) records can
 *  still be deleted freely by whoever created them, same as before. */
function canDeleteLockedEpRun(existing) {
  const isLocked = !!(existing && existing.acceptedBy && existing.acceptedDate);
  return !isLocked || state.role === "master";
}

async function saveEpRunGuarded(collectionName, data, labelField) {
  const existing = data.id ? state[collectionName].find((x) => x.id === data.id) : null;
  const isLocked = !!(existing && existing.acceptedBy && existing.acceptedDate);
  const { id, ...rest } = data;
  const changedKeys = existing ? Object.keys(rest).filter((k) => JSON.stringify(rest[k]) !== JSON.stringify(existing[k])) : [];
  const onlySignatureChanged = changedKeys.every((k) => k === "acceptedBy" || k === "acceptedDate");
  const label = data[labelField] || (existing && existing[labelField]) || "";

  if (isLocked && !onlySignatureChanged) {
    const amendmentNo = (existing.amendmentOf ? existing.amendmentNo : 0) + 1; // count amendments off the true original, not off a prior amendment
    const ref = await db.collection(collectionName).add({
      ...rest, amendmentOf: existing.amendmentOf || existing.id, amendmentNo,
      acceptedBy: "", acceptedDate: "",
      createdBy: state.user.email, createdAt: nowStr(),
    });
    await logAudit(`amend_${collectionName}`, label, `Amendment #${amendmentNo} — original ${existing.amendmentOf || existing.id} was locked after acceptance by ${existing.acceptedBy} (${existing.acceptedDate}); changed: ${changedKeys.join(", ") || "—"}`);
    return { id: ref.id, amended: true, amendmentNo };
  }
  if (id) {
    await db.collection(collectionName).doc(id).set(rest, { merge: true });
    if (changedKeys.length) await logAudit(`edit_${collectionName}`, label, `changed: ${changedKeys.join(", ")}`);
    return { id, amended: false };
  }
  const ref = await db.collection(collectionName).add({ ...rest, createdBy: state.user.email, createdAt: nowStr() });
  await logAudit(`create_${collectionName}`, label, `created`);
  return { id: ref.id, amended: false };
}

async function logAudit(action, targetLabel, details) {
  try {
    await db.collection("auditLog").add({
      action, targetLabel: targetLabel || "", details: details || "",
      byEmail: state.user.email, byBranchId: state.managedBranchId || state.myBranchId || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), clientAt: new Date().toISOString(),
    });
  } catch (e) { console.warn("audit log write failed:", e); }
}
async function deleteBatch(id) {
  const b = state.batches.find((x) => x.id === id);
  const cat = b ? catalogById(b.catalogItemId) : null;
  await db.collection("batches").doc(id).delete();
  logAudit("delete_batch", cat ? cat.name : id, `qty ${b ? b.quantity : "?"}${b && b.lot ? " · lot " + b.lot : ""}`);
}
async function saveFridge(data) {
  if (data.id) { const { id, ...rest } = data; await db.collection("fridges").doc(id).set(rest, { merge: true }); }
  else await db.collection("fridges").add(data);
}
async function deleteFridge(id) {
  if (state.batches.some((b) => b.fridgeId === id)) { toast("Cannot delete this fridge — items are still linked to it.", "error"); return; }
  const f = state.fridges.find((x) => x.id === id);
  await db.collection("fridges").doc(id).delete();
  logAudit("delete_fridge", f ? f.name : id);
  if (state.ui.activeFridge === id) { state.ui.activeFridge = "all"; renderView(); }
}
async function deleteCatalogItem(id) {
  if (state.batches.some((b) => b.catalogItemId === id)) { toast("Cannot delete this item — stock is still linked to it.", "error"); return; }
  const item = catalogById(id);
  await db.collection("catalog").doc(id).delete();
  logAudit("delete_catalog_item", item ? item.name : id);
}
async function addAllowedEmail(email, role, branchId, name) {
  await db.collection("allowedEmails").doc(email.trim().toLowerCase()).set({ email: email.trim().toLowerCase(), name: (name || "").trim(), role, branchId: branchId || null, addedAt: todayStr(), addedBy: state.user.email });
  logAudit("add_user", email.trim().toLowerCase(), `role: ${role}`);
}
async function setUserName(email, name) { await db.collection("allowedEmails").doc(email).set({ name: (name || "").trim() }, { merge: true }); }
/** Every employee currently allowed into the system, as "Full Name (email)" or just the email
 *  when no name was entered — used to populate the Lot-to-Lot "Performed By / Reviewed By" list. */
function employeeDisplayNames() {
  const names = state.allowed.map((u) => (u.name && u.name.trim()) ? u.name.trim() : u.id);
  if (state.user && state.user.email && !names.some((n) => n.toLowerCase() === state.user.email.toLowerCase())) names.push(state.user.email);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}
async function setUserBranch(email, branchId) {
  await db.collection("allowedEmails").doc(email).set({ branchId: branchId || null }, { merge: true });
  logAudit("change_user_branch", email, `branch: ${branchName(branchId) || "—"}`);
}
async function removeAllowedEmail(email) {
  await db.collection("allowedEmails").doc(email).delete();
  logAudit("remove_user", email);
}
async function saveBranch(data) {
  if (data.id) { const { id, ...rest } = data; await db.collection("branches").doc(id).set(rest, { merge: true }); }
  else await db.collection("branches").add(data);
}
async function deleteBranch(id) {
  if (state.allowed.some((u) => u.branchId === id)) { toast("Cannot delete this branch — employees are still assigned to it.", "error"); return; }
  const b = state.branches.find((x) => x.id === id);
  await db.collection("branches").doc(id).delete();
  logAudit("delete_branch", b ? b.name : id);
}
/** One-time cleanup for data that existed before branch separation was enabled: assigns every fridge
 *  and batch that has no branchId yet to the chosen branch, so that branch's staff can see it. Only
 *  Master can reach this (fridges/batches without a branch are otherwise invisible to everyone else). */
async function migrateUngroupedToBranch(branchId) {
  const looseFridges = state.fridges.filter((f) => !f.branchId);
  const looseBatches = state.batches.filter((b) => !b.branchId);
  const batchWrite = db.batch();
  looseFridges.forEach((f) => batchWrite.update(db.collection("fridges").doc(f.id), { branchId }));
  looseBatches.forEach((b) => batchWrite.update(db.collection("batches").doc(b.id), { branchId }));
  await batchWrite.commit();
}
async function changePassword(currentPass, newPass) {
  const cred = firebase.auth.EmailAuthProvider.credential(state.user.email, currentPass);
  await state.user.reauthenticateWithCredential(cred);
  await state.user.updatePassword(newPass);
}

/* ---------------------------------------------------------------------
   Modal helpers
--------------------------------------------------------------------- */
function openModal(html) { el("modalRoot").innerHTML = `<div class="overlay" id="ovl">${html}</div>`; el("ovl").onclick = (e) => { if (e.target.id === "ovl") closeModal(); }; }
function closeModal() { el("modalRoot").innerHTML = ""; }

/* ---------------------------------------------------------------------
   CAMERA BARCODE SCANNER (ZXing, lazy-loaded)
   Lets Dispense/Addition read a barcode straight from the phone/laptop camera instead of only through
   a physical USB/Bluetooth scanner or manual typing. Needs the page to be served over HTTPS (Firebase
   Hosting already is) and the browser to grant camera permission.
--------------------------------------------------------------------- */
let _zxingLoadPromise = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  if (_zxingLoadPromise) return _zxingLoadPromise;
  _zxingLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@zxing/library@latest/umd/index.min.js";
    s.onload = () => resolve();
    s.onerror = () => { _zxingLoadPromise = null; reject(new Error("Could not load the barcode-scanning library — check your internet connection.")); };
    document.head.appendChild(s);
  });
  return _zxingLoadPromise;
}
/** Opens a camera scanner in a modal; calls onResult(text) with the decoded value once the person
 *  confirms it (never silently on first read — see showConfirm). Prefers the browser's native
 *  BarcodeDetector when available — it uses the OS's own (hardware-accelerated) decoder, which reads
 *  small/dense 2D codes like GS1 DataMatrix far more reliably than a pure-JS decoder can, especially
 *  on a phone. zxing-js is the fallback for browsers without it (notably Safari/iOS), with explicit
 *  format hints, TRY_HARDER, and a higher-resolution camera request. A "Enter code manually" escape
 *  hatch is reachable from the same modal at any time, for codes the camera just won't catch. */
function openCameraScanner(onResult) {
  openModal(`<div class="modal fade-in" style="max-width:420px" onclick="event.stopPropagation()">
      <div class="modal-head"><span class="modal-title">Scan with camera</span><button class="btn ghost icon-only" id="mClose">✕</button></div>
      <div class="modal-body" id="camScanBody"></div>
      <div class="modal-foot" id="camScanFoot"></div>
    </div>`);

  let stream = null, rafId = null, codeReader = null, stopped = false;
  const stopCamera = () => {
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } stream = null; }
    try { if (codeReader) codeReader.reset(); } catch (e) { /* ignore */ }
  };
  const stop = () => { stopped = true; stopCamera(); };
  el("mClose").onclick = () => { stop(); closeModal(); };

  const CAMERA_CONSTRAINTS = { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } };

  function renderScanningUI() {
    el("camScanBody").innerHTML = `
      <div id="camScanStatus" style="font-size:12px;color:var(--text-dim);margin-bottom:10px">Starting camera…</div>
      <video id="camScanVideo" playsinline autoplay muted style="width:100%;border-radius:10px;background:#000;display:block"></video>
      <p class="field-note" style="margin-top:10px">Tip: fill the frame with just the barcode — hold steady and a little closer than feels natural, especially for the small square (DataMatrix) codes.</p>`;
    el("camScanFoot").innerHTML = `<button type="button" class="btn link" id="mManual" style="margin-inline-end:auto">Enter code manually</button><button type="button" class="btn secondary" id="mCancel">Cancel</button>`;
    el("mManual").onclick = showManualEntry;
    el("mCancel").onclick = () => { stop(); closeModal(); };
  }

  function showManualEntry() {
    stopCamera(); // free the camera while typing — no need to keep it running in the background
    el("camScanBody").innerHTML = `
      <label class="field"><span class="field-label">Barcode / code value</span><input id="camManualInput" autocomplete="off" placeholder="Paste or type the code…" /></label>
      <p class="field-note" style="margin-top:6px">Same value the camera would have filled in — paste it from another scanner app, or type it by hand.</p>`;
    el("camScanFoot").innerHTML = `<button type="button" class="btn link" id="mBackToCam" style="margin-inline-end:auto">Back to camera</button><button type="button" class="btn secondary" id="mCancel2">Cancel</button><button type="button" class="btn primary" id="mUseManual">Use this code</button>`;
    const input = el("camManualInput");
    input.focus();
    el("mBackToCam").onclick = () => { stopped = false; renderScanningUI(); start(); };
    el("mCancel2").onclick = () => { stop(); closeModal(); };
    const submit = () => {
      const val = input.value.trim();
      if (!val) { toast("Enter a code first.", "warn"); return; }
      showConfirm(val);
    };
    el("mUseManual").onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  }

  /** Never hands a scan straight to onResult — shows what it decoded (and what it parsed out of it,
   *  if it's a GS1 label) so the person can catch a bad read before it becomes a wrong lot/expiry. */
  function showConfirm(rawCode) {
    stopCamera();
    const info = scanInfo(rawCode);
    el("camScanBody").innerHTML = `
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Got this — check it before using it:</div>
      <div style="background:rgba(127,127,127,0.08);border:1px solid var(--border);border-radius:10px;padding:12px;font-size:13px;line-height:1.7">
        <div><strong>${info.item ? esc(info.item.name) : "Not recognized in the catalog yet"}</strong></div>
        <div style="font-family:monospace;word-break:break-all;color:var(--text-dim);margin-top:4px">${esc(rawCode)}</div>
        ${info.lot ? `<div style="margin-top:6px">Lot: <strong>${esc(info.lot)}</strong></div>` : ""}
        ${info.expiry ? `<div>Expiry: <strong>${esc(info.expiry)}</strong></div>` : ""}
        ${!info.lot && !info.expiry ? `<div style="color:var(--text-faint);margin-top:6px">No lot/expiry encoded in this code — just a product barcode.</div>` : ""}
      </div>`;
    el("camScanFoot").innerHTML = `<button type="button" class="btn link" id="mRescan" style="margin-inline-end:auto">Scan again</button><button type="button" class="btn secondary" id="mCancel3">Cancel</button><button type="button" class="btn primary" id="mConfirmUse">Use this</button>`;
    el("mRescan").onclick = () => { stopped = false; renderScanningUI(); start(); };
    el("mCancel3").onclick = () => { stop(); closeModal(); };
    el("mConfirmUse").onclick = () => { stop(); closeModal(); onResult(rawCode); };
  }

  function startWithNativeDetector() {
    const detector = new window.BarcodeDetector({ formats: ["data_matrix", "code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39", "qr_code", "pdf417", "itf", "codabar"] });
    return navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS).then((s) => {
      stream = s;
      const video = el("camScanVideo");
      if (!video) { stop(); return; } // modal closed while getUserMedia was pending
      video.srcObject = stream;
      return video.play().then(() => {
        const statusEl = el("camScanStatus");
        if (statusEl) statusEl.textContent = "Point the camera at the barcode…";
        const scanLoop = () => {
          if (stopped || !el("camScanVideo")) return;
          detector.detect(video)
            .then((codes) => {
              if (stopped) return;
              if (codes && codes.length) { showConfirm(codes[0].rawValue); return; }
              rafId = requestAnimationFrame(scanLoop);
            })
            .catch(() => { if (!stopped) rafId = requestAnimationFrame(scanLoop); }); // a frame that fails to decode is normal — keep going
        };
        scanLoop();
      });
    });
  }

  function startWithZxing() {
    loadZxing()
      .then(() => {
        if (!el("camScanVideo")) return; // modal was closed while the library was still loading
        const statusEl = el("camScanStatus");
        if (statusEl) statusEl.textContent = "Point the camera at the barcode…";
        const hints = new Map();
        hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
          window.ZXing.BarcodeFormat.DATA_MATRIX, window.ZXing.BarcodeFormat.CODE_128,
          window.ZXing.BarcodeFormat.EAN_13, window.ZXing.BarcodeFormat.EAN_8,
          window.ZXing.BarcodeFormat.UPC_A, window.ZXing.BarcodeFormat.UPC_E,
          window.ZXing.BarcodeFormat.CODE_39, window.ZXing.BarcodeFormat.QR_CODE,
          window.ZXing.BarcodeFormat.PDF_417, window.ZXing.BarcodeFormat.ITF,
          window.ZXing.BarcodeFormat.CODABAR,
        ]);
        hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
        codeReader = new window.ZXing.BrowserMultiFormatReader(hints);
        codeReader.decodeFromConstraints(CAMERA_CONSTRAINTS, "camScanVideo", (result) => {
          if (result && !stopped) showConfirm(result.getText());
        }).catch((err) => {
          const s = el("camScanStatus");
          if (s) s.textContent = "Could not access the camera: " + (err && err.message ? err.message : err) + ". Make sure you allowed camera access.";
        });
      })
      .catch((err) => { const s = el("camScanStatus"); if (s) s.textContent = err.message || "Could not load the scanner."; });
  }

  function start() {
    if (window.BarcodeDetector) {
      startWithNativeDetector().catch(() => { if (!stopped) startWithZxing(); });
    } else {
      startWithZxing();
    }
  }

  renderScanningUI();
  start();
}
function fieldHtml(label, inner) { return `<label class="field"><span class="field-label">${label}</span>${inner}</label>`; }
/** Shared <datalist> of common lab reporting units — attach via list="labUnitsList" on an
 *  <input>. Native datalist still lets the user type any value not in the list. */
function labUnitsDatalistHtml() { return `<datalist id="labUnitsList">${COMMON_LAB_UNITS.map((u) => `<option value="${esc(u)}"></option>`).join("")}</datalist>`; }

/* ------------------- Fridge modal (shared by Add and Edit) ------------------- */
function openFridgeModal(existing) {
  const isMaster = state.role === "master";
  const isEdit = !!existing;
  openModal(`<div class="modal fade-in" style="max-width:380px" onclick="event.stopPropagation()">
      <div class="modal-head"><span class="modal-title">${isEdit ? "Edit fridge unit" : "Add fridge unit"}</span><button class="btn ghost icon-only" id="mClose">✕</button></div>
      <form id="fridgeForm"><div class="modal-body">
          ${fieldHtml("Unit name *", `<input required id="fName" value="${esc(existing?.name || "")}" placeholder="e.g. Sample Fridge 2" />`)}
          ${isMaster ? fieldHtml("Branch *", `<select required id="fBranch"><option value="" disabled ${existing?.branchId ? "" : "selected"}>Select…</option>${state.branches.map((b) => `<option value="${b.id}" ${existing?.branchId === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select>`) : ""}
          ${isMaster && state.branches.length === 0 ? `<p class="field-note">No branches set up yet — add one from "Branches" first.</p>` : ""}
          ${fieldHtml("Temperature range", `<input id="fTemp" value="${esc(existing?.tempRange || "")}" placeholder="e.g. 2°C – 8°C" />`)}
          ${fieldHtml("Location", `<input id="fLoc" value="${esc(existing?.location || "")}" placeholder="e.g. Microbiology Lab" />`)}
        </div>
        <div class="modal-foot"><button type="button" class="btn secondary" id="mCancel">Cancel</button><button type="submit" class="btn primary">${isEdit ? "Save changes" : "Add"}</button></div>
      </form></div>`);
  el("mClose").onclick = closeModal; el("mCancel").onclick = closeModal;
  el("fridgeForm").onsubmit = async (e) => {
    e.preventDefault();
    const branchId = isMaster ? el("fBranch").value : (existing?.branchId || state.myBranchId || null);
    if (isMaster && !branchId) { toast("Please select a branch.", "warn"); return; }
    await saveFridge({ id: existing?.id, name: el("fName").value.trim(), branchId, tempRange: el("fTemp").value.trim(), location: el("fLoc").value.trim() });
    closeModal();
  };
}
el("btnAddFridge").onclick = () => openFridgeModal(null);
el("btnToggleFridgeList").onclick = () => {
  const list = el("fridgeList"), chevron = el("fridgeListChevron");
  const nowOpen = list.hidden;
  list.hidden = !nowOpen;
  chevron.style.transform = nowOpen ? "rotate(90deg)" : "rotate(0deg)";
};
// Collapsible sidebar nav groups (Inventory, Quality & Instruments, Team, Alerts, Reports & Admin) —
// same collapsed-by-default / tap-to-reveal behavior as the "Store" fridge list above. Wired once
// at load since #navList is static markup, never rebuilt via innerHTML.
document.querySelectorAll(".nav-section-toggle").forEach((btn) => {
  const body = document.querySelector(`[data-section-body="${btn.dataset.section}"]`);
  if (!body) return;
  btn.setAttribute("aria-expanded", "false");
  btn.onclick = () => {
    const nowOpen = body.hidden;
    body.hidden = !nowOpen;
    btn.setAttribute("aria-expanded", nowOpen ? "true" : "false");
  };
});

/* ------------------- Batch edit modal ------------------- */
function openBatchEdit(batchId) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) return;
  const cat = catalogById(b.catalogItemId);
  openModal(`<div class="modal fade-in" onclick="event.stopPropagation()">
      <div class="modal-head"><span class="modal-title">Edit batch: ${esc(cat?.name || "")}</span><button class="btn ghost icon-only" id="mClose">✕</button></div>
      <form id="editForm"><div class="modal-body">
          <div class="field-row">
            ${fieldHtml("Fridge unit *", `<select required id="eFridge">${state.fridges.map((f) => `<option value="${f.id}" ${f.id === b.fridgeId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>`)}
            ${fieldHtml("Shelf / position", `<input id="eShelf" value="${esc(b.shelf || "")}" />`)}
          </div>
          <div class="field-row">
            ${fieldHtml("Quantity", `<input type="text" inputmode="decimal" dir="ltr" min="0" step="any" id="eQty" value="${b.quantity}" />`)}
            ${fieldHtml("Expiry date", `<input type="date" id="eExpiry" value="${esc(b.expiry || "")}" />`)}
          </div>
          ${fieldHtml("Lot number", `<input id="eLot" value="${esc(b.lot || "")}" />`)}
          ${fieldHtml("Notes", `<textarea id="eNotes" style="min-height:64px">${esc(b.notes || "")}</textarea>`)}
        </div>
        <div class="modal-foot"><button type="button" class="btn secondary" id="mCancel">Cancel</button><button type="submit" class="btn primary">Save changes</button></div>
      </form></div>`);
  el("mClose").onclick = closeModal; el("mCancel").onclick = closeModal;
  el("editForm").onsubmit = async (e) => {
    e.preventDefault();
    await saveBatchEdit({ id: b.id, fridgeId: el("eFridge").value, shelf: el("eShelf").value.trim(), quantity: el("eQty").value, expiry: el("eExpiry").value, lot: el("eLot").value.trim(), notes: el("eNotes").value.trim(), catalogItemId: b.catalogItemId, addedAt: b.addedAt });
    closeModal();
  };
}

/* ------------------- Catalog page ------------------- */
function renderCatalogView() {
  const cs = state.ui.catalogPage || { editing: null, form: { name: "", category: CATEGORIES[0], unit: UNITS[0], barcode: "", itemNumber: "", unitsPerBox: 1, testsPerUnit: "", safetyLimit: "", supplier: "", countingNote: "" }, importMsg: "", query: "" };
  state.ui.catalogPage = cs;

  function render() {
    let body;
    if (cs.editing) {
      body = `<button type="button" class="link-btn" id="cBack">← Back to list</button>
        ${fieldHtml("Item name *", `<input required id="cName" value="${esc(cs.form.name)}" />`)}
        <div class="field-row">
          ${fieldHtml("Category", `<select id="cCat">${CATEGORIES.map((c) => `<option ${c === cs.form.category ? "selected" : ""}>${c}</option>`).join("")}</select>`)}
          ${fieldHtml("Unit", `<select id="cUnit">${UNITS.map((u) => `<option ${u === cs.form.unit ? "selected" : ""}>${u}</option>`).join("")}</select>`)}
        </div>
        <div class="field-row">
          ${fieldHtml("Barcode / Item ID (optional)", `<input class="mono" id="cBarcode" value="${esc(cs.form.barcode)}" placeholder="e.g. 15099590575229" />`)}
          ${fieldHtml("Item number (optional)", `<input class="mono" id="cItemNumber" value="${esc(cs.form.itemNumber)}" placeholder="e.g. RGT00140" />`)}
        </div>
        <p class="auth-hint" style="text-align:left">Enter the GTIN / Item ID printed under the barcode on the box (the (01) code) — not the whole scanned string — so the same product is recognized across lots.</p>
        <div class="field-row">
          ${fieldHtml("Units per box (from one scan)", `<input type="text" inputmode="decimal" dir="ltr" min="1" id="cUnitsPerBox" value="${esc(cs.form.unitsPerBox || 1)}" />`)}
          ${fieldHtml("Tests per unit (optional)", `<input type="text" inputmode="decimal" dir="ltr" min="0" id="cTestsPerUnit" value="${esc(cs.form.testsPerUnit || "")}" placeholder="e.g. 50" />`)}
        </div>
        <p class="auth-hint" style="text-align:left">Some boxes contain more than one cartridge/tube — e.g. a "100 TEST" kit made of 2 cartridges of 50 tests each. Set "Units per box" to 2 so scanning the box once during Addition queues 2 units. "Tests per unit" auto-fills from the number before "TEST" in the name (divided by units per box for "KIT" names, kept as-is for "CART" names) — double check it's right for this product before saving, since it drives the Total Tests figure in Inventory List.</p>
        ${fieldHtml("Safety limit (optional)", `<input type="text" inputmode="decimal" dir="ltr" min="0" step="any" id="cSafetyLimit" value="${esc(cs.form.safetyLimit)}" placeholder="e.g. 20" />`)}
        <p class="auth-hint" style="text-align:left">If total stock of this item across all lots drops below this number, it will show up in the Reorder List and trigger a low-stock notification. Leave empty to disable tracking for this item.</p>
        ${fieldHtml("Supplier (optional)", `<input id="cSupplier" value="${esc(cs.form.supplier || "")}" placeholder="e.g. Beckman Coulter KSA" />`)}
        <p class="auth-hint" style="text-align:left">Shown on the Reorder List next to this item so whoever orders it knows who to contact. "Last Order" on that list is picked up automatically from the most recent Addition — no need to type it here.</p>
        ${fieldHtml("Counting note (optional)", `<textarea id="cCountingNote" rows="2" placeholder="e.g. Count in SETS, not boxes — 1 box = 3 sets">${esc(cs.form.countingNote || "")}</textarea>`)}
        <p class="auth-hint" style="text-align:left">Shown as a reminder whenever this item comes up during an Inventory Count — use it for anything easy to get wrong when counting this specific item (unit quirks, where it's split across fridges, etc.).</p>
        <div style="display:flex;justify-content:flex-end;margin-top:16px"><button type="submit" class="btn primary">Save</button></div>`;
    } else {
      const q = cs.query.trim().toLowerCase();
      const list = (q ? state.catalog.filter((c) => [c.name, c.itemNumber, c.barcode, c.category].some((v) => (v || "").toLowerCase().includes(q))) : state.catalog);
      body = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn primary" id="cNew" style="width:fit-content">+ New item</button>
          <button type="button" class="btn secondary" id="cImport" style="width:fit-content"><i class="fa-solid fa-file-excel"></i> Import from Excel</button>
          <button type="button" class="btn secondary" id="cExport" style="width:fit-content" ${state.catalog.length === 0 ? "disabled" : ""}><i class="fa-solid fa-file-arrow-down"></i> Export to Excel</button>
          <input type="file" id="cImportFile" accept=".xlsx,.xls,.csv" hidden />
        </div>
        <p class="auth-hint" style="text-align:left;margin-top:6px">Excel needs a column with the Item ID (GTIN/barcode) and a column with the product name — e.g. "Item ID", "Item Number", "Product Name". Existing items are matched and updated by Item ID; new ones are created.</p>
        ${cs.importMsg ? `<div class="scan-result" style="border-color:#7cb342;margin-top:8px"><div class="scan-result-row"><span class="v">${esc(cs.importMsg)}</span></div></div>` : ""}
        <div class="filter-bar" style="margin:16px 0"><input id="cSearch" placeholder="Search ${state.catalog.length} items by name, item number, category or barcode…" value="${esc(cs.query)}" /></div>
        <div style="display:flex;flex-direction:column;gap:8px">
        ${list.length === 0 ? `<div class="pick-empty">${state.catalog.length === 0 ? "No items yet" : "No items match your search"}</div>` : list.map((c) => {
          const stock = totalStockFor(c.id);
          const low = Number(c.safetyLimit) > 0 && stock < Number(c.safetyLimit);
          return `
          <div class="catalog-row"><div><div style="font-size:12.5px;font-weight:600">${esc(c.name)} ${low ? `<span class="badge" style="background:${STATUS_STYLES.expired.bg};color:${STATUS_STYLES.expired.text};border-color:${STATUS_STYLES.expired.border}">Low stock</span>` : ""}</div>
            <div style="font-size:11.5px;color:var(--text-dim)">${esc(c.category)} · ${esc(c.unit)}${c.itemNumber ? " · " + esc(c.itemNumber) : ""}${c.unitsPerBox > 1 ? ` · ${c.unitsPerBox}/box` : ""}${c.testsPerUnit ? ` · ${c.testsPerUnit} tests/unit` : ""}${Number(c.safetyLimit) > 0 ? ` · stock ${stock} / limit ${c.safetyLimit}` : ""}${c.barcode ? " · " : ""}<span class="mono">${esc(c.barcode)}</span></div></div>
            <div style="display:flex;gap:6px"><button type="button" class="icon-btn-sm" data-print-cat="${c.id}" title="Print barcode"><i class="fa-solid fa-print"></i></button><button type="button" class="icon-btn-sm" data-edit-cat="${c.id}"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn-sm" data-del-cat="${c.id}"><i class="fa-solid fa-trash"></i></button></div>
          </div>`;
        }).join("")}
        </div>`;
    }
    el("mainContent").innerHTML = `
      <div class="page-header"><div><h2>Item Catalog</h2><span class="subtitle">${state.catalog.length} item${state.catalog.length === 1 ? "" : "s"} — names, barcodes, units and safety limits</span></div></div>
      <div class="card-form"><form id="catForm">${body}</form></div>`;

    if (cs.editing) {
      el("cBack").onclick = () => { cs.editing = null; render(); };
      el("cName").oninput = (e) => {
        cs.form.name = e.target.value;
        if (!cs.form.testsPerUnitTouched) {
          const suggestion = suggestTestsPerUnit(cs.form.name, cs.form.unitsPerBox);
          if (suggestion !== null) {
            cs.form.testsPerUnit = suggestion;
            const tpuSel = el("cTestsPerUnit"); if (tpuSel) tpuSel.value = suggestion;
          }
        }
      };
      el("cCat").onchange = (e) => cs.form.category = e.target.value;
      el("cUnit").onchange = (e) => cs.form.unit = e.target.value;
      el("cBarcode").oninput = (e) => cs.form.barcode = e.target.value.trim();
      el("cItemNumber").oninput = (e) => cs.form.itemNumber = e.target.value.trim();
      el("cUnitsPerBox").oninput = (e) => {
        cs.form.unitsPerBox = e.target.value;
        if (!cs.form.testsPerUnitTouched) {
          const suggestion = suggestTestsPerUnit(cs.form.name, cs.form.unitsPerBox);
          if (suggestion !== null) {
            cs.form.testsPerUnit = suggestion;
            const tpuSel = el("cTestsPerUnit"); if (tpuSel) tpuSel.value = suggestion;
          }
        }
      };
      el("cTestsPerUnit").oninput = (e) => { cs.form.testsPerUnit = e.target.value; cs.form.testsPerUnitTouched = true; };
      el("cSafetyLimit").oninput = (e) => cs.form.safetyLimit = e.target.value;
      el("cSupplier").oninput = (e) => cs.form.supplier = e.target.value;
      el("cCountingNote").oninput = (e) => cs.form.countingNote = e.target.value;
      el("catForm").onsubmit = async (e) => {
        e.preventDefault(); if (!cs.form.name.trim()) return;
        const data = { ...cs.form, unitsPerBox: Number(cs.form.unitsPerBox) || 1, testsPerUnit: cs.form.testsPerUnit === "" ? "" : Number(cs.form.testsPerUnit) || 0, safetyLimit: cs.form.safetyLimit === "" ? "" : Number(cs.form.safetyLimit) || 0 };
        await upsertCatalogItem(cs.editing === "new" ? data : { id: cs.editing, ...data }); cs.editing = null; render();
      };
    } else {
      el("cNew").onclick = () => { cs.editing = "new"; cs.form = { name: "", category: CATEGORIES[0], unit: UNITS[0], barcode: "", itemNumber: "", unitsPerBox: 1, testsPerUnit: "", safetyLimit: "", supplier: "", countingNote: "" }; render(); };
      el("cImport").onclick = () => el("cImportFile").click();
      el("cExport").onclick = () => exportCatalogToExcel();
      const searchEl = el("cSearch");
      if (searchEl) {
        searchEl.focus();
        searchEl.oninput = (e) => {
          cs.query = e.target.value; render();
          const refocused = el("cSearch");
          if (refocused) { refocused.focus(); refocused.setSelectionRange(refocused.value.length, refocused.value.length); }
        };
      }
      el("cImportFile").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        cs.importMsg = "Importing…"; render();
        try {
          const { added, updated, skipped } = await importCatalogFromExcel(file);
          cs.importMsg = `Import complete: ${added} item(s) added, ${updated} updated${skipped ? `, ${skipped} row(s) skipped (missing Item ID or name)` : ""}.`;
        } catch (err) {
          cs.importMsg = "Import failed: " + (err && err.message ? err.message : "could not read the file.");
        }
        el("cImportFile").value = "";
        render();
      };
      el("mainContent").querySelectorAll("[data-edit-cat]").forEach((b) => b.onclick = () => {
        const item = catalogById(b.dataset.editCat);
        cs.editing = item.id;
        const unitsPerBox = item.unitsPerBox || 1;
        let testsPerUnit = item.testsPerUnit;
        if (testsPerUnit === undefined || testsPerUnit === null || testsPerUnit === "") {
          testsPerUnit = suggestTestsPerUnit(item.name, unitsPerBox);
          testsPerUnit = testsPerUnit === null ? "" : testsPerUnit;
        }
        cs.form = { name: item.name, category: item.category, unit: item.unit, barcode: item.barcode || "", itemNumber: item.itemNumber || "", unitsPerBox, testsPerUnit, safetyLimit: item.safetyLimit === undefined || item.safetyLimit === null ? "" : item.safetyLimit, supplier: item.supplier || "", countingNote: item.countingNote || "" };
        render();
      });
      el("mainContent").querySelectorAll("[data-del-cat]").forEach((b) => b.onclick = () => deleteCatalogItem(b.dataset.delCat).then(render));
      el("mainContent").querySelectorAll("[data-print-cat]").forEach((b) => b.onclick = () => printBarcodeFor(catalogById(b.dataset.printCat)));
    }
  }
  render();
}

el("btnCatalog").onclick = () => navigateTo("catalog");

/* ------------------- Users modal (master only) ------------------- */
el("btnUsers").onclick = () => {
  function render() {
    const branchOptions = (selectedId) => `<option value="">No branch</option>` + state.branches.map((b) => `<option value="${b.id}" ${b.id === selectedId ? "selected" : ""}>${esc(b.name)}</option>`).join("");
    openModal(`<div class="modal fade-in" onclick="event.stopPropagation()">
        <div class="modal-head"><span class="modal-title">Manage users</span><button class="btn ghost icon-only" id="mClose">✕</button></div>
        <div class="modal-body">
          <div class="scan-result" style="border-color:#f0d090"><div class="scan-result-row"><span class="v">👑 Master: <span class="mono">${esc(MASTER_EMAIL)}</span></span></div></div>
          <form id="addUserForm" class="field-row" style="align-items:flex-end;flex-wrap:wrap">
            ${fieldHtml("Full name", `<input id="newUserName" placeholder="e.g. Adel Darraj" />`)}
            ${fieldHtml("New email address", `<input type="email" required id="newUserEmail" placeholder="name@lab.com" />`)}
            <label class="field" style="flex:0 0 110px"><span class="field-label">Role</span><select id="newUserRole"><option value="user">User</option><option value="master">Additional master</option></select></label>
            <label class="field" style="flex:0 0 130px"><span class="field-label">Branch</span><select id="newUserBranch">${branchOptions("")}</select></label>
            <button type="submit" class="btn primary">Add</button>
          </form>
          <p class="auth-hint" style="text-align:left">The full name is what shows up in the "Performed By / Reviewed By" employee list on forms like Lot to Lot — leave it blank to just show the email there.</p>
          <div class="divider"></div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${state.allowed.length === 0 ? `<div class="pick-empty">No authorized users yet</div>` : state.allowed.map((u) => `
              <div class="user-row"><div style="flex:1;min-width:0">
                  <input data-set-name="${u.id}" value="${esc(u.name || "")}" placeholder="Full name (optional)" style="font-size:13px;font-weight:600;border:1px solid transparent;background:transparent;border-radius:6px;padding:3px 4px;width:100%" onfocus="this.style.border='1px solid var(--border)';this.style.background='var(--panel-2)'" onblur="this.style.border='1px solid transparent';this.style.background='transparent'" />
                  <div class="mono" style="font-size:11px;color:var(--text-dim)">${esc(u.id)} · ${u.role === "master" ? "Additional master" : "User"}</div></div>
                <div style="display:flex;align-items:center;gap:8px">
                  <select data-set-branch="${u.id}" style="font-size:11.5px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--panel-2)">${branchOptions(u.branchId)}</select>
                  <button type="button" class="icon-btn-sm" data-rm-user="${u.id}"><i class="fa-solid fa-trash"></i></button>
                </div></div>`).join("")}
          </div>
        </div></div>`);
    el("mClose").onclick = closeModal;
    el("addUserForm").onsubmit = async (e) => { e.preventDefault(); await addAllowedEmail(el("newUserEmail").value, el("newUserRole").value, el("newUserBranch").value, el("newUserName").value); render(); };
    el("modalRoot").querySelectorAll("[data-rm-user]").forEach((b) => b.onclick = () => removeAllowedEmail(b.dataset.rmUser).then(render));
    el("modalRoot").querySelectorAll("[data-set-branch]").forEach((sel) => sel.onchange = () => setUserBranch(sel.dataset.setBranch, sel.value));
    el("modalRoot").querySelectorAll("[data-set-name]").forEach((inp) => inp.onchange = () => setUserName(inp.dataset.setName, inp.value));
  }
  render();
};

/* ------------------- Branches modal (master only) ------------------- */
el("btnBranches").onclick = () => {
  const bs = { editing: null, form: { name: "", managerEmail: "" } };
  function render() {
    let body;
    if (bs.editing) {
      body = `<button type="button" class="link-btn" id="bBack">← Back to list</button>
        ${fieldHtml("Branch name *", `<input required id="bName" value="${esc(bs.form.name)}" placeholder="e.g. Riyadh Branch" />`)}
        ${fieldHtml("Manager email", `<input type="email" id="bManager" value="${esc(bs.form.managerEmail)}" placeholder="manager@lab.com" />`)}
        <p class="auth-hint" style="text-align:left">The manager can only view the activity log for employees assigned to this branch. Make sure this email is also added under "Users".</p>
        <div style="display:flex;justify-content:flex-end"><button type="submit" class="btn primary">Save</button></div>`;
    } else {
      body = `<button type="button" class="btn primary" id="bNew" style="width:fit-content">+ New branch</button>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        ${state.branches.length === 0 ? `<div class="pick-empty">No branches yet</div>` : state.branches.map((b) => {
          const empCount = state.allowed.filter((u) => u.branchId === b.id).length;
          return `<div class="catalog-row"><div><div style="font-size:12.5px;font-weight:600">${esc(b.name)}</div><div style="font-size:11.5px;color:var(--text-dim)">Manager: <span class="mono">${esc(b.managerEmail || "—")}</span> · ${empCount} employee(s)</div></div>
            <div style="display:flex;gap:6px"><button type="button" class="icon-btn-sm" data-edit-branch="${b.id}"><i class="fa-solid fa-pen"></i></button><button type="button" class="icon-btn-sm" data-del-branch="${b.id}"><i class="fa-solid fa-trash"></i></button></div></div>`;
        }).join("")}</div>
        ${(() => {
          const looseFridges = state.fridges.filter((f) => !f.branchId).length;
          const looseBatches = state.batches.filter((b) => !b.branchId).length;
          if (!looseFridges && !looseBatches) return "";
          return `<div class="scan-result" style="border-color:#f5a524;margin-top:16px">
            <div class="scan-result-row"><span class="v" style="color:#a5680a">${looseFridges} fridge unit(s) and ${looseBatches} batch(es) predate branch separation and aren't assigned to any branch yet — only you (Master) can see them for now. Assign them to a branch so that branch's staff see them too:</span></div>
            <div class="form-row" style="margin-top:8px">
              <select id="migrateBranch"><option value="">Select branch…</option>${state.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}</select>
              <button type="button" class="btn secondary" id="migrateBtn">Assign all to this branch</button>
            </div>
          </div>`;
        })()}`;
    }
    openModal(`<div class="modal fade-in" onclick="event.stopPropagation()">
        <div class="modal-head"><span class="modal-title">Branches</span><button class="btn ghost icon-only" id="mClose">✕</button></div>
        <form id="branchForm"><div class="modal-body">${body}</div></form></div>`);
    el("mClose").onclick = closeModal;
    if (bs.editing) {
      el("bBack").onclick = () => { bs.editing = null; render(); };
      el("bName").oninput = (e) => bs.form.name = e.target.value;
      el("bManager").oninput = (e) => bs.form.managerEmail = e.target.value.trim().toLowerCase();
      el("branchForm").onsubmit = async (e) => { e.preventDefault(); if (!bs.form.name.trim()) return; await saveBranch(bs.editing === "new" ? bs.form : { id: bs.editing, ...bs.form }); bs.editing = null; render(); };
    } else {
      el("bNew").onclick = () => { bs.editing = "new"; bs.form = { name: "", managerEmail: "" }; render(); };
      el("modalRoot").querySelectorAll("[data-edit-branch]").forEach((b) => b.onclick = () => { const item = state.branches.find((x) => x.id === b.dataset.editBranch); bs.editing = item.id; bs.form = { name: item.name, managerEmail: item.managerEmail || "" }; render(); });
      el("modalRoot").querySelectorAll("[data-del-branch]").forEach((b) => b.onclick = () => deleteBranch(b.dataset.delBranch).then(render));
      const migrateBtn = el("migrateBtn");
      if (migrateBtn) migrateBtn.onclick = async () => {
        const branchId = el("migrateBranch").value;
        if (!branchId) { toast("Please select a branch.", "warn"); return; }
        migrateBtn.disabled = true; migrateBtn.textContent = "Assigning…";
        try { await migrateUngroupedToBranch(branchId); render(); }
        catch (err) { toast("Failed: " + (err && err.message ? err.message : err), "error"); migrateBtn.disabled = false; migrateBtn.textContent = "Assign all to this branch"; }
      };
    }
  }
  render();
};

/* ------------------- Account & password modal ------------------- */
el("btnAccount").onclick = () => {
  openModal(`<div class="modal fade-in" style="max-width:380px" onclick="event.stopPropagation()">
      <div class="modal-head"><span class="modal-title">Account &amp; password</span><button class="btn ghost icon-only" id="mClose">✕</button></div>
      <form id="pwForm"><div class="modal-body">
          <div class="scan-result" style="border-color:var(--border)"><div class="scan-result-row"><span class="k">Signed in as</span><span class="v mono">${esc(state.user.email)}</span></div></div>
          ${fieldHtml("Current password", `<input type="password" id="curPass" required autocomplete="current-password" />`)}
          ${fieldHtml("New password (min. 6 characters)", `<input type="password" id="newPass" required minlength="6" autocomplete="new-password" />`)}
          ${fieldHtml("Confirm new password", `<input type="password" id="confPass" required minlength="6" autocomplete="new-password" />`)}
          <div id="pwError" class="auth-error" hidden></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn secondary" id="mCancel">Cancel</button><button type="submit" class="btn primary">Update password</button></div>
      </form></div>`);
  el("mClose").onclick = closeModal; el("mCancel").onclick = closeModal;
  el("pwForm").onsubmit = async (e) => {
    e.preventDefault();
    el("pwError").hidden = true;
    const newPass = el("newPass").value, confPass = el("confPass").value;
    if (newPass !== confPass) { el("pwError").textContent = "New passwords do not match."; el("pwError").hidden = false; return; }
    try { await changePassword(el("curPass").value, newPass); toast("Password updated successfully.", "success"); closeModal(); }
    catch (err) { el("pwError").textContent = translateAuthError(err); el("pwError").hidden = false; }
  };
};
