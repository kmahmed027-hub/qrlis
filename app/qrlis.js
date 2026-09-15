/* QR LIS — now wired to a real local API + database (see server/api.js, server/db.js).
   Rows with `live: true` are results that arrived automatically from an instrument via the
   HL7 listener (hl7-listener/listener.js), not typed in by hand. */

let INSTRUMENTS = [];
let RESULTS = [];
let CURRENT_USER = null;
let STAFF_CACHE = [];
let CATALOG_CACHE = [];

// Every fetch to our own API goes through here so a session that expired mid-use
// (cookie timed out, or an admin deactivated the account) drops back to the login
// screen instead of the app silently failing.
const _rawFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const res = await _rawFetch(url, opts);
  if (res.status === 401 && typeof url === "string" && url.startsWith("/api/") && !url.startsWith("/api/auth/")) {
    showLoginScreen();
  }
  return res;
};

const MODULE_FOR_VIEW = {
  viewDashboard: "dashboard", viewBooking: "booking", viewPatient360: "patient360",
  viewReservations: "reservations", viewSamples: "samples", viewPCR: "pcr",
  viewProcessing: "processing", viewAdmin: "admin", viewConnection: "connection",
};

function showLoginScreen(message) {
  document.getElementById("lisAppShell").hidden = true;
  document.getElementById("loginOverlay").hidden = false;
  document.getElementById("loginError").textContent = message || "";
  CURRENT_USER = null;
}

function hideLoginScreen() {
  document.getElementById("loginOverlay").hidden = true;
  document.getElementById("lisAppShell").hidden = false;
}

function applyPermissionsToNav() {
  const perms = (CURRENT_USER && CURRENT_USER.permissions) || [];
  document.querySelectorAll(".lis-nav-item[data-view]").forEach((btn) => {
    const mod = MODULE_FOR_VIEW[btn.dataset.view];
    btn.hidden = !!mod && !perms.includes(mod);
  });
}

let pollingStarted = false;
async function startAppPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  try {
    await loadInstruments();
    await loadResults();
    await loadDashboardStats();
  } catch (e) { /* a 401 mid-load already triggers the login screen above */ }
  setInterval(() => loadResults().catch(() => {}), 3000);
}

async function onLoggedIn() {
  hideLoginScreen();
  document.getElementById("lisUserName").textContent = CURRENT_USER.name || CURRENT_USER.username;
  document.getElementById("lisUserRole").textContent = CURRENT_USER.role;
  applyPermissionsToNav();
  const activeStillVisible = document.querySelector(".lis-nav-item.active[data-view]:not([hidden])");
  if (!activeStillVisible) {
    const firstVisible = document.querySelector(".lis-nav-item[data-view]:not([hidden])");
    if (firstVisible) firstVisible.click();
  }
  await startAppPolling();
}

async function checkSession() {
  const res = await fetch("/api/auth/me");
  if (res.ok) {
    CURRENT_USER = await res.json();
    await onLoggedIn();
  } else {
    showLoginScreen();
  }
}

document.getElementById("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const btn = document.getElementById("loginSubmit");
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  btn.disabled = true;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { errEl.textContent = body.error || "Login failed"; return; }
    CURRENT_USER = body;
    document.getElementById("loginForm").reset();
    await onLoggedIn();
  } finally {
    btn.disabled = false;
  }
};

document.getElementById("btnLogout").onclick = async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
};

function instrumentById(id) { return INSTRUMENTS.find((i) => i.id === id); }

function renderTable(rows) {
  const tbody = document.getElementById("lisTableBody");
  tbody.innerHTML = rows.map((r) => {
    const inst = instrumentById(r.instrumentId);
    return `
    <tr>
      <td><input type="checkbox" /></td>
      <td>${r.sampleId}</td>
      <td>${r.testId}</td>
      <td>${r.testName}</td>
      <td>${r.result ?? '<span style="color:var(--text-faint);text-decoration:underline dotted">Empty</span>'}</td>
      <td class="mono">${r.unit}</td>
      <td class="mono">${r.min ?? ""}</td>
      <td class="mono">${r.max ?? ""}</td>
      <td>${r.expected}</td>
      <td>${r.live && inst ? `<span class="lis-badge lis-badge-live">LIVE</span> ${inst.name}` : (inst ? inst.name : "\u2014")}</td>
      <td>${r.branch}</td>
      <td><button class="btn primary" style="padding:4px 14px;font-size:11.5px">Validate</button></td>
      <td><button class="btn ghost" style="padding:4px 10px;font-size:11.5px">Actions \u25be</button></td>
    </tr>`;
  }).join("");
}

function renderInstrumentChips() {
  document.getElementById("cntInstruments").textContent = INSTRUMENTS.length;
  document.getElementById("instrumentChips").innerHTML = INSTRUMENTS.map((i) => `
    <span class="lis-instrument-chip" data-id="${i.id}">
      <span class="dot"></span> ${i.name} <span style="color:var(--text-faint)">\u00b7 ${i.address || ""}</span>
      <span class="remove" data-remove-instrument="${i.id}" title="Remove"><i class="fa-solid fa-xmark"></i></span>
    </span>`).join("");
  document.getElementById("analyzerSelect").innerHTML = `<option value="">Select Analyzer</option>` +
    INSTRUMENTS.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");
  document.querySelectorAll("[data-remove-instrument]").forEach((el) => {
    el.onclick = async () => {
      await fetch(`/api/instruments/${el.dataset.removeInstrument}`, { method: "DELETE" });
      await loadInstruments();
      if (!viewConnection.hidden) renderConnectionsTable();
    };
  });
}

function updateCounts() {
  document.getElementById("cntReservations").textContent = new Set(RESULTS.map((r) => r.sampleId)).size;
  document.getElementById("cntPatients").textContent = new Set(RESULTS.map((r) => r.sampleId)).size;
  document.getElementById("cntSamples").textContent = new Set(RESULTS.map((r) => r.sampleId)).size;
  document.getElementById("cntTests").textContent = RESULTS.length;
  document.getElementById("cntBranch").textContent = new Set(RESULTS.map((r) => r.branch)).size;
}

async function loadInstruments() {
  const res = await fetch("/api/instruments");
  INSTRUMENTS = await res.json();
  renderInstrumentChips();
}

async function loadResults() {
  const res = await fetch("/api/results");
  RESULTS = await res.json();
  applyCurrentFilter();
  updateCounts();
}

function applyCurrentFilter() {
  const q = document.getElementById("lisSearch").value.trim().toLowerCase();
  const filtered = RESULTS.filter((r) => !q || Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q)));
  renderTable(filtered);
}

// ---- Top-nav view switching (generic, data-view driven) ----
const ALL_VIEWS = ["viewDashboard", "viewBooking", "viewPatient360", "viewReservations", "viewSamples", "viewPCR", "viewProcessing", "viewAdmin", "viewSoon", "viewConnection"];
const viewConnection = document.getElementById("viewConnection");
document.querySelectorAll(".lis-nav-item[data-view]").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".lis-nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.dataset.view;
    ALL_VIEWS.forEach((id) => { document.getElementById(id).hidden = id !== target; });
    if (target === "viewSoon") document.getElementById("soonTitle").textContent = btn.dataset.label || btn.textContent.trim();
    if (target === "viewConnection") renderConnectionsTable();
    if (target === "viewDashboard") loadDashboardStats();
    if (target === "viewPatient360") runPatient360Search();
    if (target === "viewReservations") loadReservations();
    if (target === "viewSamples") loadSamplesReportView();
    if (target === "viewPCR") loadPcr();
    if (target === "viewProcessing") loadProcessing();
    if (target === "viewAdmin") { loadStaff(); loadBranches(); loadUsers(); loadCatalog(); }
  };
});

async function loadDashboardStats() {
  const res = await fetch("/api/dashboard/stats");
  const s = await res.json();
  document.getElementById("kpiPatients").textContent = s.totalPatients;
  document.getElementById("kpiSamples").textContent = s.totalSamples;
  document.getElementById("kpiReservations").textContent = s.totalReservations;
  document.getElementById("kpiPending").textContent = s.pendingResults;
  document.getElementById("kpiInstruments").textContent = `${s.liveInstruments}/${s.totalInstruments}`;
  const entries = Object.entries(s.samplesByStatus);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  document.getElementById("dashStatusChart").innerHTML = entries.length
    ? entries.map(([status, count]) => `
      <div class="dash-bar-row">
        <span class="dash-bar-label">${status}</span>
        <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${(count / max) * 100}%"></div></div>
        <span class="dash-bar-count">${count}</span>
      </div>`).join("")
    : `<p class="lis-instrument-note">No samples yet.</p>`;
}

async function runPatient360Search() {
  const q = document.getElementById("p360Query").value.trim();
  const sampleId = document.getElementById("p360SampleId").value.trim();
  const status = document.getElementById("p360Status").value;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (sampleId) params.set("sampleId", sampleId);
  if (status) params.set("status", status);
  const res = await fetch(`/api/patient360?${params}`);
  const rows = await res.json();
  const box = document.getElementById("p360Results");
  if (!rows.length) { box.innerHTML = `<p class="lis-instrument-note">No matching records found.</p>`; return; }
  box.innerHTML = rows.map(({ sample, patient, reservation, tests }) => `
    <div class="panel-card p360-card">
      <div class="p360-head">
        <div><strong>${patient ? patient.name : "Unknown patient"}</strong> <span class="lis-instrument-note" style="display:inline;padding:0">${patient ? `· ${patient.mrn} · ${patient.mobile}` : ""}</span></div>
        <span class="lis-badge">${sample.status}</span>
      </div>
      <div class="p360-meta">
        <span><i class="fa-solid fa-vial"></i> Sample ${sample.id}</span>
        <span><i class="fa-solid fa-calendar-check"></i> ${reservation ? reservation.type : "—"}</span>
        <span><i class="fa-solid fa-location-dot"></i> ${sample.branch}</span>
        <span><i class="fa-solid fa-clock"></i> Collected ${sample.collectionDate}</span>
      </div>
      <table class="data-table lis-table" style="margin-top:8px">
        <thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Range</th><th>Status</th></tr></thead>
        <tbody>${tests.map((t) => `<tr>
          <td>${t.testName}</td>
          <td>${t.result ?? '<span style="color:var(--text-faint)">Pending</span>'}</td>
          <td>${t.unit || "—"}</td>
          <td>${t.min ?? "—"}–${t.max ?? "—"}</td>
          <td>${t.live ? '<span class="lis-badge lis-badge-live">LIVE</span>' : "Manual"}</td>
        </tr>`).join("") || `<tr><td colspan="5" class="lis-instrument-note">No tests linked to this sample.</td></tr>`}</tbody>
      </table>
    </div>`).join("");
}
document.getElementById("btnP360Search").onclick = runPatient360Search;
document.getElementById("p360Query").addEventListener("keydown", (e) => { if (e.key === "Enter") runPatient360Search(); });

const CONN_LABEL = { serial: "RS-232 (Serial)", tcp: "TCP/IP" };
const PROTO_LABEL = { astm: "ASTM", hl7: "HL7 v2.x", im: "Middleware (Instrument Manager)", remisol: "Middleware (REMISOL)", unknown: "Not set" };

function renderConnectionsTable() {
  document.getElementById("cntConnections").textContent = INSTRUMENTS.length;
  document.getElementById("connectionsTableBody").innerHTML = INSTRUMENTS.map((i) => `
    <tr data-row-id="${i.id}">
      <td><span class="conn-status" data-status-for="${i.id}"><i class="fa-solid fa-circle-question" style="color:var(--text-faint)"></i> Not tested</span></td>
      <td>${i.name}</td>
      <td>${i.model || "\u2014"}</td>
      <td>${CONN_LABEL[i.conn] || i.conn}</td>
      <td>${PROTO_LABEL[i.protocol] || i.protocol || "\u2014"}</td>
      <td class="mono">${i.address || "\u2014"}</td>
      <td style="display:flex;gap:6px">
        <button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-test-connection="${i.id}"><i class="fa-solid fa-plug-circle-check"></i> Test</button>
        <button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-remove-instrument="${i.id}"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join("");
  document.querySelectorAll("#connectionsTableBody [data-remove-instrument]").forEach((el) => {
    el.onclick = async () => { await fetch(`/api/instruments/${el.dataset.removeInstrument}`, { method: "DELETE" }); await loadInstruments(); renderConnectionsTable(); };
  });
  document.querySelectorAll("#connectionsTableBody [data-test-connection]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.testConnection;
      const statusEl = document.querySelector(`[data-status-for="${id}"]`);
      statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="color:var(--text-faint)"></i> Testing…`;
      try {
        const res = await fetch(`/api/instruments/${id}/test`, { method: "POST" });
        const out = await res.json();
        if (out.ok) {
          statusEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color:var(--ok-text)"></i> ${out.message || "Connected"}`;
        } else {
          statusEl.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:var(--warn)"></i> ${out.message || "Failed"}`;
        }
      } catch {
        statusEl.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:var(--warn)"></i> Request failed`;
      }
    };
  });
}

// ---- Reservations ----
async function loadReservations() {
  const res = await fetch("/api/reservations");
  const rows = await res.json();
  document.getElementById("cntResRows").textContent = rows.length;
  document.getElementById("reservationsTableBody").innerHTML = rows.map((r) => `
    <tr>
      <td>${r.id}</td>
      <td>${r.patient ? r.patient.name : "—"}</td>
      <td>${r.patient ? r.patient.mobile || "—" : "—"}</td>
      <td>${r.type || "—"}</td>
      <td>${r.date || "—"}</td>
      <td><span class="lis-badge">${r.status}</span></td>
    </tr>`).join("") || `<tr><td colspan="6" class="lis-instrument-note">No reservations yet.</td></tr>`;
}

async function populatePatientDropdown(selectEl, includeNewOption) {
  const patients = await (await fetch("/api/patients")).json();
  selectEl.innerHTML = `<option value="">Select…</option>` +
    (includeNewOption ? `<option value="__new__">+ New patient</option>` : "") +
    patients.map((p) => `<option value="${p.id}">${p.name} (${p.mrn || p.id})</option>`).join("");
}

const resModal = document.getElementById("reservationModalOverlay");
document.getElementById("btnAddReservation").onclick = async () => {
  await populatePatientDropdown(document.getElementById("resPatientSelect"), true);
  document.getElementById("resDate").value = new Date().toISOString().slice(0, 10);
  resModal.hidden = false;
};
const closeResModal = () => { resModal.hidden = true; document.getElementById("reservationForm").reset(); document.getElementById("resNewPatientWrap").hidden = true; };
document.getElementById("reservationModalClose").onclick = closeResModal;
document.getElementById("reservationModalCancel").onclick = closeResModal;
resModal.onclick = (e) => { if (e.target === resModal) closeResModal(); };
document.getElementById("resPatientSelect").onchange = (e) => {
  document.getElementById("resNewPatientWrap").hidden = e.target.value !== "__new__";
};
document.getElementById("reservationForm").onsubmit = async (e) => {
  e.preventDefault();
  let patientId = document.getElementById("resPatientSelect").value;
  if (patientId === "__new__") {
    const name = document.getElementById("resNewName").value.trim();
    if (!name) return;
    const p = await (await fetch("/api/patients", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mobile: document.getElementById("resNewMobile").value.trim(), mrn: document.getElementById("resNewMrn").value.trim() }),
    })).json();
    patientId = p.id;
  }
  await fetch("/api/reservations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId, type: document.getElementById("resType").value, date: document.getElementById("resDate").value, status: "Pending" }),
  });
  closeResModal();
  await loadReservations();
};

// ---- Samples Report (grouped, filtered, exportable) ----
const SAMPLE_STATUSES = ["Received", "Processing", "Validated", "Reported"];
let TEST_STATUS_OPTIONS = ["Order Confirmed", "Sample Collected", "Pending", "Ready", "On Hold", "Cancelled"];
let TEST_STATUS_OPTIONS_LOADED = false;
let SR_ROWS = [];
let SR_PAGE = 0;
const SR_PAGE_SIZE = 10; // groups (samples) per page

async function ensureTestStatusOptions() {
  if (TEST_STATUS_OPTIONS_LOADED) return;
  try {
    const res = await fetch("/api/meta/test-statuses");
    if (res.ok) TEST_STATUS_OPTIONS = await res.json();
  } catch (e) { /* keep the defaults above */ }
  document.getElementById("srTestStatus").innerHTML = `<option value="">Test Status</option>` + TEST_STATUS_OPTIONS.map((s) => `<option>${s}</option>`).join("");
  TEST_STATUS_OPTIONS_LOADED = true;
}

function srCollectFilters() {
  return {
    reservationStatus: document.getElementById("srResStatus").value,
    patientQuery: document.getElementById("srPatientQuery").value.trim(),
    sampleId: document.getElementById("srSampleId").value.trim(),
    sampleStatus: document.getElementById("srSampleStatus").value,
    collectionFrom: document.getElementById("srCollectionFrom").value,
    collectionTo: document.getElementById("srCollectionTo").value,
    testName: document.getElementById("srTestName").value.trim(),
    testStatus: document.getElementById("srTestStatus").value,
    branch: document.getElementById("srBranch").value.trim(),
  };
}

async function loadSamplesReportView() {
  await ensureTestStatusOptions();
  await loadSamplesReport();
}

async function loadSamplesReport() {
  const filters = srCollectFilters();
  const appliedCount = Object.values(filters).filter((v) => v).length;
  document.getElementById("srFilterCount").textContent = `${appliedCount} filter${appliedCount === 1 ? "" : "s"} applied`;
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
  const res = await fetch(`/api/samples-report?${params.toString()}`);
  SR_ROWS = await res.json();
  SR_PAGE = 0;
  renderSamplesReport();
}

function srGroupRows(rows) {
  if (!document.getElementById("srGroupToggle").checked) {
    return rows.map((r) => ({ key: r.id, sample: r.sample, patient: r.patient, reservation: r.reservation, tests: [r] }));
  }
  const groups = new Map();
  rows.forEach((r) => {
    const key = r.sampleId;
    if (!groups.has(key)) groups.set(key, { key, sample: r.sample, patient: r.patient, reservation: r.reservation, tests: [] });
    groups.get(key).tests.push(r);
  });
  return Array.from(groups.values());
}

function testStatusColor(status) {
  return { "Order Confirmed": "#3498db", "Sample Collected": "#9b59b6", Pending: "#e0a300", Ready: "#2ecc71", "On Hold": "#e67e22", Cancelled: "#c0392b" }[status] || "inherit";
}

function renderSamplesReport() {
  const groups = srGroupRows(SR_ROWS);
  document.getElementById("cntSampleRows").textContent = SR_ROWS.length;
  const totalPages = Math.max(1, Math.ceil(groups.length / SR_PAGE_SIZE));
  SR_PAGE = Math.min(SR_PAGE, totalPages - 1);
  const pageGroups = groups.slice(SR_PAGE * SR_PAGE_SIZE, (SR_PAGE + 1) * SR_PAGE_SIZE);
  document.getElementById("srPageLabel").textContent = `Page ${SR_PAGE + 1} of ${totalPages}`;

  const body = document.getElementById("samplesTableBody");
  if (pageGroups.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="lis-instrument-note">No results match these filters.</td></tr>`;
    return;
  }

  body.innerHTML = pageGroups.map((g) => {
    const p = g.patient;
    const header = `
    <tr>
      <td colspan="10" style="background:rgba(255,255,255,0.03)">
        <span class="lis-badge">${g.sample ? g.sample.id : "—"}</span>
        <span class="lis-badge">${p ? p.name : "Unknown patient"}</span>
        ${p && p.mrn ? `<span class="lis-badge">${p.mrn}</span>` : ""}
        ${g.sample && g.sample.branch ? `<span class="lis-badge">${g.sample.branch}</span>` : ""}
        ${g.reservation ? `<span class="lis-badge">${g.reservation.status}</span>` : ""}
      </td>
    </tr>`;
    const testRows = g.tests.map((r) => `
    <tr>
      <td class="mono">${r.testId}</td>
      <td>${r.testName}</td>
      <td>${r.registeredAt || "—"}</td>
      <td>${r.collectedAt || "—"}</td>
      <td>${r.receivedAt || "—"}</td>
      <td>${r.expected || "—"}</td>
      <td style="text-align:center"><input type="checkbox" data-hold="${r.id}" ${r.isOnHold ? "checked" : ""} /></td>
      <td><select class="lis-filter-input" style="padding:4px 8px;font-size:12px;color:${testStatusColor(r.testStatus)}" data-status="${r.id}">${TEST_STATUS_OPTIONS.map((s) => `<option ${s === r.testStatus ? "selected" : ""}>${s}</option>`).join("")}</select></td>
      <td>${r.result ?? '<span style="color:var(--text-faint);text-decoration:underline dotted">Pending</span>'}</td>
      <td><button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-cancel-test="${r.id}">Cancel</button></td>
    </tr>`).join("");
    return header + testRows;
  }).join("");

  document.querySelectorAll("[data-status]").forEach((el) => {
    el.onchange = async () => {
      await fetch(`/api/results/${el.dataset.status}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ testStatus: el.value }) });
      await loadSamplesReport();
    };
  });
  document.querySelectorAll("[data-hold]").forEach((el) => {
    el.onchange = async () => {
      await fetch(`/api/results/${el.dataset.hold}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isOnHold: el.checked }) });
    };
  });
  document.querySelectorAll("[data-cancel-test]").forEach((el) => {
    el.onclick = async () => {
      await fetch(`/api/results/${el.dataset.cancelTest}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ testStatus: "Cancelled" }) });
      await loadSamplesReport();
    };
  });
}

document.getElementById("btnSrSearch").onclick = loadSamplesReport;
document.getElementById("srGroupToggle").onchange = () => { SR_PAGE = 0; renderSamplesReport(); };
document.getElementById("srPrevPage").onclick = () => { if (SR_PAGE > 0) { SR_PAGE--; renderSamplesReport(); } };
document.getElementById("srNextPage").onclick = () => { SR_PAGE++; renderSamplesReport(); };
["srResStatus", "srSampleStatus", "srTestStatus"].forEach((id) => {
  document.getElementById(id).addEventListener("change", loadSamplesReport);
});
["srPatientQuery", "srSampleId", "srTestName", "srBranch"].forEach((id) => {
  document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") loadSamplesReport(); });
});

function srExportTable() {
  const cols = ["Sample ID", "Patient", "Branch", "Test ID", "Test Name", "Registered at", "Collected at", "Received at", "Test Status", "On Hold", "Result"];
  const lines = [cols];
  srGroupRows(SR_ROWS).forEach((g) => {
    g.tests.forEach((r) => {
      lines.push([
        g.sample ? g.sample.id : "", g.patient ? g.patient.name : "", (g.sample && g.sample.branch) || "",
        r.testId, r.testName, r.registeredAt || "", r.collectedAt || "", r.receivedAt || "",
        r.testStatus, r.isOnHold ? "Yes" : "No", r.result ?? "",
      ]);
    });
  });
  return lines;
}

document.getElementById("btnSrCopy").onclick = async () => {
  const tsv = srExportTable().map((row) => row.join("\t")).join("\n");
  try { await navigator.clipboard.writeText(tsv); } catch (e) { /* clipboard blocked — user can still export as a file */ }
};
document.getElementById("btnSrCsv").onclick = () => {
  const csv = srExportTable().map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "samples-report.csv";
  a.click();
};
document.getElementById("btnSrExcel").onclick = () => {
  const rows = srExportTable();
  const html = `<table>${rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("")}</table>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "application/vnd.ms-excel" }));
  a.download = "samples-report.xls";
  a.click();
};
document.getElementById("btnSrPrint").onclick = () => {
  const rows = srExportTable();
  const w = window.open("", "_blank");
  w.document.write(`<html><head><title>Samples Report</title></head><body>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:12px">
      ${rows.map((r, i) => `<tr>${r.map((v) => `<${i === 0 ? "th" : "td"}>${v}</${i === 0 ? "th" : "td"}>`).join("")}</tr>`).join("")}
    </table></body></html>`);
  w.document.close();
  w.print();
};

const smpModal = document.getElementById("sampleModalOverlay");
document.getElementById("btnAddSample").onclick = async () => {
  await populatePatientDropdown(document.getElementById("smpPatientSelect"), false);
  const reservations = await (await fetch("/api/reservations")).json();
  document.getElementById("smpReservationSelect").innerHTML = `<option value="">None</option>` +
    reservations.map((r) => `<option value="${r.id}">${r.id} — ${r.patient ? r.patient.name : "?"}</option>`).join("");
  document.getElementById("smpCollection").value = new Date().toISOString().slice(0, 16).replace("T", " ");
  smpModal.hidden = false;
};
const closeSmpModal = () => { smpModal.hidden = true; document.getElementById("sampleForm").reset(); };
document.getElementById("sampleModalClose").onclick = closeSmpModal;
document.getElementById("sampleModalCancel").onclick = closeSmpModal;
smpModal.onclick = (e) => { if (e.target === smpModal) closeSmpModal(); };
document.getElementById("sampleForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: document.getElementById("smpId").value.trim(),
      patientId: document.getElementById("smpPatientSelect").value,
      reservationId: document.getElementById("smpReservationSelect").value || null,
      branch: document.getElementById("smpBranch").value.trim(),
      collectionDate: document.getElementById("smpCollection").value.trim(),
    }),
  });
  closeSmpModal();
  await loadSamplesReport();
};

// ---- PCR ----
async function loadPcr() {
  const res = await fetch("/api/pcr");
  const rows = await res.json();
  document.getElementById("cntPcrRows").textContent = rows.length;
  const badgeClass = (v) => v === "Positive" ? "lis-badge-live" : "";
  document.getElementById("pcrTableBody").innerHTML = rows.map((t) => `
    <tr>
      <td>${t.sampleId}</td>
      <td>${t.patient ? t.patient.name : "—"}</td>
      <td>${t.target}</td>
      <td>${t.ctValue ?? "—"}</td>
      <td><span class="lis-badge ${badgeClass(t.interpretation)}">${t.interpretation}</span></td>
      <td>${t.kit || "—"}</td>
      <td>${t.runDate || "—"}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="lis-instrument-note">No PCR results yet.</td></tr>`;
}

const pcrModal = document.getElementById("pcrModalOverlay");
document.getElementById("btnAddPcr").onclick = async () => {
  const samples = await (await fetch("/api/samples")).json();
  document.getElementById("pcrSampleSelect").innerHTML = `<option value="">Select…</option>` +
    samples.map((s) => `<option value="${s.id}" data-patient="${s.patientId}">${s.id} — ${s.patient ? s.patient.name : "?"}</option>`).join("");
  pcrModal.hidden = false;
};
const closePcrModal = () => { pcrModal.hidden = true; document.getElementById("pcrForm").reset(); };
document.getElementById("pcrModalClose").onclick = closePcrModal;
document.getElementById("pcrModalCancel").onclick = closePcrModal;
pcrModal.onclick = (e) => { if (e.target === pcrModal) closePcrModal(); };
document.getElementById("pcrForm").onsubmit = async (e) => {
  e.preventDefault();
  const sel = document.getElementById("pcrSampleSelect");
  const opt = sel.options[sel.selectedIndex];
  await fetch("/api/pcr", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sampleId: sel.value,
      patientId: opt.dataset.patient,
      target: document.getElementById("pcrTarget").value.trim(),
      ctValue: document.getElementById("pcrCt").value ? parseFloat(document.getElementById("pcrCt").value) : null,
      interpretation: document.getElementById("pcrInterpretation").value,
      kit: document.getElementById("pcrKit").value.trim(),
      runDate: new Date().toISOString().slice(0, 16).replace("T", " "),
    }),
  });
  closePcrModal();
  await loadPcr();
};

// ---- Processing ----
async function loadProcessing() {
  const res = await fetch("/api/samples");
  const rows = await res.json();
  document.getElementById("cntProcRows").textContent = rows.length;
  document.getElementById("processingTableBody").innerHTML = rows.map((s) => {
    const ready = s.centrifuged && s.aliquoted && s.loaded;
    return `
    <tr>
      <td>${s.id}</td>
      <td>${s.patient ? s.patient.name : "—"}</td>
      <td><input type="checkbox" data-proc="${s.id}:centrifuged" ${s.centrifuged ? "checked" : ""} /></td>
      <td><input type="checkbox" data-proc="${s.id}:aliquoted" ${s.aliquoted ? "checked" : ""} /></td>
      <td><input type="checkbox" data-proc="${s.id}:loaded" ${s.loaded ? "checked" : ""} /></td>
      <td><span class="lis-badge">${s.status}</span></td>
      <td><button class="btn ${ready && s.status === "Received" ? "primary" : "ghost"}" style="padding:4px 10px;font-size:11.5px" data-send-analyzer="${s.id}" ${!ready || s.status !== "Received" ? "disabled" : ""}>Send to Analyzer</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="lis-instrument-note">No samples yet.</td></tr>`;

  document.querySelectorAll("[data-proc]").forEach((cb) => {
    cb.onchange = async () => {
      const [id, step] = cb.dataset.proc.split(":");
      await fetch(`/api/samples/${id}/processing`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, value: cb.checked }),
      });
      await loadProcessing();
    };
  });
  document.querySelectorAll("[data-send-analyzer]").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/samples/${btn.dataset.sendAnalyzer}/status`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "Processing" }),
      });
      await loadProcessing();
    };
  });
}

// ---- Administration: Staff ----
async function loadStaff() {
  const rows = await (await fetch("/api/staff")).json();
  STAFF_CACHE = rows;
  document.getElementById("cntStaffRows").textContent = rows.length;
  document.getElementById("staffTableBody").innerHTML = rows.map((u) => `
    <tr>
      <td>${u.name}</td><td>${u.role}</td><td>${u.branch || "—"}</td>
      <td><button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-remove-staff="${u.id}"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`).join("") || `<tr><td colspan="4" class="lis-instrument-note">No staff yet.</td></tr>`;
  document.querySelectorAll("[data-remove-staff]").forEach((el) => {
    el.onclick = async () => { await fetch(`/api/staff/${el.dataset.removeStaff}`, { method: "DELETE" }); await loadStaff(); };
  });
}
const staffModal = document.getElementById("staffModalOverlay");
document.getElementById("btnAddStaff").onclick = () => { staffModal.hidden = false; };
const closeStaffModal = () => { staffModal.hidden = true; document.getElementById("staffForm").reset(); };
document.getElementById("staffModalClose").onclick = closeStaffModal;
document.getElementById("staffModalCancel").onclick = closeStaffModal;
staffModal.onclick = (e) => { if (e.target === staffModal) closeStaffModal(); };
document.getElementById("staffForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/staff", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: document.getElementById("stfName").value.trim(), role: document.getElementById("stfRole").value, branch: document.getElementById("stfBranch").value.trim() }),
  });
  closeStaffModal();
  await loadStaff();
};

// ---- Administration: Branches ----
async function loadBranches() {
  const rows = await (await fetch("/api/branches")).json();
  document.getElementById("cntBranchRows").textContent = rows.length;
  document.getElementById("branchesTableBody").innerHTML = rows.map((b) => `
    <tr>
      <td>${b.code}</td><td>${b.name}</td><td>${b.type || "—"}</td>
      <td><button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-remove-branch="${b.id}"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`).join("") || `<tr><td colspan="4" class="lis-instrument-note">No branches yet.</td></tr>`;
  document.querySelectorAll("[data-remove-branch]").forEach((el) => {
    el.onclick = async () => { await fetch(`/api/branches/${el.dataset.removeBranch}`, { method: "DELETE" }); await loadBranches(); };
  });
}
const branchModal = document.getElementById("branchModalOverlay");
document.getElementById("btnAddBranch").onclick = () => { branchModal.hidden = false; };
const closeBranchModal = () => { branchModal.hidden = true; document.getElementById("branchForm").reset(); };
document.getElementById("branchModalClose").onclick = closeBranchModal;
document.getElementById("branchModalCancel").onclick = closeBranchModal;
branchModal.onclick = (e) => { if (e.target === branchModal) closeBranchModal(); };
document.getElementById("branchForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/branches", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: document.getElementById("brCode").value.trim(), name: document.getElementById("brName").value.trim(), type: document.getElementById("brType").value }),
  });
  closeBranchModal();
  await loadBranches();
};

// ---- Administration: Test/Service Catalog ----
function fmtSAR(n) { return `${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} SAR`; }

async function loadCatalog() {
  const rows = await (await fetch("/api/catalog")).json();
  CATALOG_CACHE = rows;
  document.getElementById("cntCatalogRows").textContent = rows.length;
  document.getElementById("catalogTableBody").innerHTML = rows.map((c) => `
    <tr>
      <td class="mono">${c.code || "—"}</td><td>${c.name}</td><td>${c.kind}</td><td class="mono">${fmtSAR(c.price)}</td>
      <td><button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-remove-catalog="${c.id}"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`).join("") || `<tr><td colspan="5" class="lis-instrument-note">No catalog items yet.</td></tr>`;
  document.querySelectorAll("[data-remove-catalog]").forEach((el) => {
    el.onclick = async () => { await fetch(`/api/catalog/${el.dataset.removeCatalog}`, { method: "DELETE" }); await loadCatalog(); };
  });
}
const catalogModal = document.getElementById("catalogModalOverlay");
document.getElementById("btnAddCatalogItem").onclick = () => { catalogModal.hidden = false; };
const closeCatalogModal = () => { catalogModal.hidden = true; document.getElementById("catalogForm").reset(); };
document.getElementById("catalogModalClose").onclick = closeCatalogModal;
document.getElementById("catalogModalCancel").onclick = closeCatalogModal;
catalogModal.onclick = (e) => { if (e.target === catalogModal) closeCatalogModal(); };
document.getElementById("catalogForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/catalog", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: document.getElementById("catCode").value.trim(),
      name: document.getElementById("catName").value.trim(),
      kind: document.getElementById("catKind").value,
      price: document.getElementById("catPrice").value,
    }),
  });
  closeCatalogModal();
  await loadCatalog();
};

// ---- Administration: User Accounts (real login access) ----
let ROLE_OPTIONS_LOADED = false;
async function ensureRoleOptions() {
  if (ROLE_OPTIONS_LOADED) return;
  const roles = await (await fetch("/api/auth/roles")).json();
  document.getElementById("usrRole").innerHTML = roles.map((r) => `<option>${r}</option>`).join("");
  ROLE_OPTIONS_LOADED = true;
}

function refreshStaffLinkOptions() {
  const sel = document.getElementById("usrStaff");
  const current = sel.value;
  sel.innerHTML = `<option value="">None</option>` + STAFF_CACHE.map((s) => `<option value="${s.id}">${s.name} (${s.role})</option>`).join("");
  sel.value = current;
}

async function loadUsers() {
  const rows = await (await fetch("/api/users")).json();
  document.getElementById("cntUserRows").textContent = rows.length;
  document.getElementById("usersTableBody").innerHTML = rows.map((u) => {
    const staff = STAFF_CACHE.find((s) => s.id === u.staffId);
    const isSelf = CURRENT_USER && CURRENT_USER.id === u.id;
    return `
    <tr>
      <td>${u.username}${isSelf ? ' <span class="lis-badge">you</span>' : ""}</td>
      <td>${u.name || "—"}</td>
      <td>${u.role}</td>
      <td>${staff ? staff.name : "—"}</td>
      <td>${u.active === false ? '<span style="color:#c0392b">Inactive</span>' : '<span style="color:#2ecc71">Active</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-reset-user="${u.id}" title="Reset password"><i class="fa-solid fa-key"></i></button>
        <button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-toggle-user="${u.id}" data-active="${u.active !== false}" title="${u.active === false ? "Reactivate" : "Deactivate"}"><i class="fa-solid ${u.active === false ? "fa-toggle-off" : "fa-toggle-on"}"></i></button>
        ${isSelf ? "" : `<button class="btn ghost" style="padding:4px 10px;font-size:11.5px" data-remove-user="${u.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>`}
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="lis-instrument-note">No login accounts yet.</td></tr>`;

  document.querySelectorAll("[data-reset-user]").forEach((el) => {
    el.onclick = async () => {
      const pw = prompt("New password for this account (at least 8 characters):");
      if (!pw) return;
      if (pw.length < 8) return alert("Password must be at least 8 characters.");
      const res = await fetch(`/api/users/${el.dataset.resetUser}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); alert(b.error || "Could not reset password."); }
    };
  });
  document.querySelectorAll("[data-toggle-user]").forEach((el) => {
    el.onclick = async () => {
      const nowActive = el.dataset.active === "true";
      const res = await fetch(`/api/users/${el.dataset.toggleUser}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !nowActive }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); alert(b.error || "Could not update account."); return; }
      await loadUsers();
    };
  });
  document.querySelectorAll("[data-remove-user]").forEach((el) => {
    el.onclick = async () => {
      if (!confirm("Delete this login account? The person will no longer be able to sign in.")) return;
      const res = await fetch(`/api/users/${el.dataset.removeUser}`, { method: "DELETE" });
      if (!res.ok) { const b = await res.json().catch(() => ({})); alert(b.error || "Could not delete account."); return; }
      await loadUsers();
    };
  });
}

const userModal = document.getElementById("userModalOverlay");
document.getElementById("btnAddUser").onclick = async () => {
  await ensureRoleOptions();
  refreshStaffLinkOptions();
  document.getElementById("userFormError").textContent = "";
  userModal.hidden = false;
};
const closeUserModal = () => { userModal.hidden = true; document.getElementById("userForm").reset(); };
document.getElementById("userModalClose").onclick = closeUserModal;
document.getElementById("userModalCancel").onclick = closeUserModal;
userModal.onclick = (e) => { if (e.target === userModal) closeUserModal(); };
document.getElementById("userForm").onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("userFormError");
  errEl.textContent = "";
  const res = await fetch("/api/users", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: document.getElementById("usrUsername").value.trim(),
      password: document.getElementById("usrPassword").value,
      name: document.getElementById("usrName").value.trim(),
      role: document.getElementById("usrRole").value,
      staffId: document.getElementById("usrStaff").value || null,
    }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); errEl.textContent = b.error || "Could not create account."; return; }
  closeUserModal();
  await loadUsers();
};

// Poll for new results every 3s so anything the HL7 listener forwards shows up live,
// without needing a manual refresh — mirrors how a real LIS worklist behaves.
// (Kicked off from startAppPolling(), once we know someone is actually logged in.)
checkSession();

document.getElementById("selectAll").onchange = (e) => {
  document.querySelectorAll("#lisTableBody input[type=checkbox]").forEach((cb) => cb.checked = e.target.checked);
};

document.getElementById("lisSearch").oninput = () => applyCurrentFilter();

document.getElementById("btnValidateAll").onclick = () => alert("Prototype only \u2014 validation write-back isn't wired up yet (results and instruments are, via the local API).");
document.getElementById("btnBatchUpload").onclick = () => alert("Prototype only \u2014 batch upload isn't wired up yet (results and instruments are, via the local API).");

// ---- Add instrument modal ----
const instModal = document.getElementById("instrumentModalOverlay");
const openInstModal = () => { instModal.hidden = false; };
const closeInstModal = () => { instModal.hidden = true; document.getElementById("instrumentForm").reset(); document.getElementById("instOtherWrap").hidden = true; };
document.getElementById("btnAddInstrument").onclick = openInstModal;
document.getElementById("btnAddConnection").onclick = openInstModal;
document.getElementById("instrumentModalClose").onclick = closeInstModal;
document.getElementById("instrumentModalCancel").onclick = closeInstModal;
instModal.onclick = (e) => { if (e.target === instModal) closeInstModal(); };
document.getElementById("instModel").onchange = (e) => { document.getElementById("instOtherWrap").hidden = e.target.value !== "other"; };
document.getElementById("instrumentForm").onsubmit = async (e) => {
  e.preventDefault();
  const model = document.getElementById("instModel").value;
  const name = document.getElementById("instName").value.trim();
  await fetch("/api/instruments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      model: model === "other" ? (document.getElementById("instOtherModel").value.trim() || "Other") : model,
      conn: document.getElementById("instConn").value,
      protocol: document.getElementById("instProtocol").value,
      address: document.getElementById("instAddress").value.trim(),
    }),
  });
  await loadInstruments();
  if (!viewConnection.hidden) renderConnectionsTable();
  closeInstModal();
};
