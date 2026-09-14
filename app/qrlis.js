/* QR LIS — now wired to a real local API + database (see server/api.js, server/db.js).
   Rows with `live: true` are results that arrived automatically from an instrument via the
   HL7 listener (hl7-listener/listener.js), not typed in by hand. */

let INSTRUMENTS = [];
let RESULTS = [];

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

// ---- Auth: session check, login form, role-based nav ----
let CURRENT_USER = null;
let ALLOWED_VIEWS = [];

function applyRoleToNav() {
  document.querySelectorAll("[data-view]").forEach((btn) => {
    const allowed = ALLOWED_VIEWS.includes(btn.dataset.view) || btn.dataset.view === "viewSoon";
    btn.style.display = allowed ? "" : "none";
  });
  // Hide a whole dropdown group if every item inside it just got hidden.
  document.querySelectorAll(".lis-nav-group").forEach((group) => {
    const items = group.querySelectorAll(".lis-nav-dropdown [data-view]");
    const anyVisible = Array.from(items).some((el) => el.style.display !== "none");
    group.style.display = items.length && !anyVisible ? "none" : "";
  });
}

async function checkSession() {
  const res = await fetch("/api/me");
  const out = await res.json();
  if (!out.user) {
    document.getElementById("loginOverlay").hidden = false;
    return false;
  }
  CURRENT_USER = out.user;
  ALLOWED_VIEWS = out.views || [];
  document.getElementById("loginOverlay").hidden = true;
  document.getElementById("lisUserName").textContent = out.user.name;
  document.getElementById("lisUserRole").textContent = out.user.role;
  applyRoleToNav();
  return true;
}

document.getElementById("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";
  const res = await fetch("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: document.getElementById("loginUsername").value.trim(), password: document.getElementById("loginPassword").value }),
  });
  if (!res.ok) {
    const out = await res.json().catch(() => ({}));
    errEl.textContent = out.error || "Login failed";
    errEl.style.display = "block";
    return;
  }
  document.getElementById("loginForm").reset();
  await startApp();
};

document.getElementById("btnLogout").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
};


// ---- Top-nav view switching (generic, data-view driven — covers both flat nav
// items and items nested inside a dropdown group like "Processing ▾") ----
const ALL_VIEWS = ["viewDashboard", "viewBooking", "viewPatient360", "viewReservations", "viewSamples", "viewPCR", "viewProcessing", "viewValidation", "viewApproval", "viewAdmin", "viewQC", "viewArchiving", "viewWarehouse", "viewReporting", "viewSoon", "viewConnection"];
const viewConnection = document.getElementById("viewConnection");
document.querySelectorAll("[data-view]").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".lis-nav-item, .lis-nav-dropdown button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    // If this button lives inside a dropdown, also mark its parent group's trigger active.
    const group = btn.closest(".lis-nav-group");
    if (group) group.querySelector(":scope > .lis-nav-item").classList.add("active");
    document.querySelectorAll(".lis-nav-group.open").forEach((g) => g.classList.remove("open"));
    const target = btn.dataset.view;
    ALL_VIEWS.forEach((id) => { document.getElementById(id).hidden = id !== target; });
    if (target === "viewSoon") document.getElementById("soonTitle").textContent = btn.dataset.label || btn.textContent.trim();
    if (target === "viewConnection") renderConnectionsTable();
    if (target === "viewDashboard") loadDashboardStats();
    if (target === "viewPatient360") runPatient360Search();
    if (target === "viewReservations") loadReservations();
    if (target === "viewSamples") loadSamples();
    if (target === "viewPCR") loadPcr();
    if (target === "viewProcessing") loadProcessing();
    if (target === "viewAdmin") { loadStaff(); loadBranches(); }
    if (target === "viewQC") loadQc();
    if (target === "viewArchiving") loadArchiving();
    if (target === "viewWarehouse") loadWarehouse();
    if (target === "viewValidation") loadValidationQueue();
    if (target === "viewApproval") loadApprovalQueue();
    if (target === "viewReporting") {
      if (btn.dataset.report) document.getElementById("reportType").value = btn.dataset.report;
      loadReport();
    }
  };
});

// Dropdown groups (Processing, Administration, Sample Archiving, Warehouse, QC,
// Reporting): tap the top-level button to toggle the submenu open on touch/mobile
// (desktop also gets it on :hover via CSS).
document.querySelectorAll(".lis-nav-group > .lis-nav-item").forEach((trigger) => {
  trigger.onclick = (e) => {
    e.stopPropagation();
    const group = trigger.parentElement;
    const wasOpen = group.classList.contains("open");
    document.querySelectorAll(".lis-nav-group.open").forEach((g) => g.classList.remove("open"));
    if (!wasOpen) group.classList.add("open");
  };
});
document.addEventListener("click", () => {
  document.querySelectorAll(".lis-nav-group.open").forEach((g) => g.classList.remove("open"));
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

// ---- Samples ----
const SAMPLE_STATUSES = ["Received", "Processing", "Validated", "Reported"];
async function loadSamples() {
  const res = await fetch("/api/samples");
  const rows = await res.json();
  document.getElementById("cntSampleRows").textContent = rows.length;
  document.getElementById("samplesTableBody").innerHTML = rows.map((s) => `
    <tr>
      <td>${s.id}</td>
      <td>${s.patient ? s.patient.name : "—"}</td>
      <td>${s.branch || "—"}</td>
      <td>${s.collectionDate || "—"}</td>
      <td>
        <select class="lis-filter-input" style="padding:4px 8px;font-size:12px" data-status-select="${s.id}">
          ${SAMPLE_STATUSES.map((st) => `<option ${st === s.status ? "selected" : ""}>${st}</option>`).join("")}
        </select>
      </td>
      <td><span class="lis-instrument-note" style="padding:0" id="save-${s.id}"></span></td>
    </tr>`).join("") || `<tr><td colspan="6" class="lis-instrument-note">No samples yet.</td></tr>`;
  document.querySelectorAll("[data-status-select]").forEach((sel) => {
    sel.onchange = async () => {
      const id = sel.dataset.statusSelect;
      await fetch(`/api/samples/${id}/status`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: sel.value }),
      });
      const tag = document.getElementById(`save-${id}`);
      tag.textContent = "Saved ✓";
      setTimeout(() => { tag.textContent = ""; }, 1500);
    };
  });
}

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
  await loadSamples();
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

// ---- QC ----
const QC_STATUS_CLASS = { Pass: "qc-status-pass", Warning: "qc-status-warning", Fail: "qc-status-fail" };
let LAST_QC_ROWS = [];

async function loadQc() {
  const [rows, instruments] = await Promise.all([
    fetch("/api/qc").then((r) => r.json()),
    fetch("/api/instruments").then((r) => r.json()),
  ]);
  const instSel = document.getElementById("qcFilterInstrument");
  if (instSel.options.length <= 1) {
    instSel.innerHTML = `<option value="">All</option>` + instruments.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");
  }
  const filterInst = document.getElementById("qcFilterInstrument").value;
  const filterStatus = document.getElementById("qcFilterStatus").value;
  const filtered = rows.filter((r) => (!filterInst || r.instrumentId === filterInst) && (!filterStatus || r.qcStatus === filterStatus));
  LAST_QC_ROWS = filtered;

  document.getElementById("cntQcRows").textContent = filtered.length;
  document.getElementById("qcTableBody").innerHTML = filtered.map((r) => `
    <tr>
      <td>${r.instrumentName}</td>
      <td>${r.qcName}</td>
      <td>${r.lotName}</td>
      <td>${r.testName}</td>
      <td>${r.mean}</td>
      <td>${r.sd}</td>
      <td>${r.result}</td>
      <td>${r.westgardRule ? `<span class="qc-rule-tag">${r.westgardRule}</span>` : "—"}</td>
      <td>${r.westgardLevel || "—"}</td>
      <td><span class="lis-badge ${QC_STATUS_CLASS[r.qcStatus] || ""}">${r.qcStatus}</span></td>
      <td><input type="checkbox" data-qc-exclude="${r.id}" ${r.isExcluded ? "checked" : ""} /></td>
      <td>${r.validateBy ? `<span class="lis-instrument-note" style="padding:0">${r.validateBy}</span>` : `<button class="btn ghost" style="padding:3px 8px;font-size:11px" data-qc-validate="${r.id}">Validate</button>`}</td>
      <td>${r.approveBy ? `<span class="lis-instrument-note" style="padding:0">${r.approveBy}</span>` : `<button class="btn ghost" style="padding:3px 8px;font-size:11px" data-qc-approve="${r.id}">Approve</button>`}</td>
    </tr>`).join("") || `<tr><td colspan="13" class="lis-instrument-note">No QC results yet.</td></tr>`;

  document.querySelectorAll("[data-qc-exclude]").forEach((cb) => {
    cb.onchange = async () => {
      await fetch(`/api/qc/${cb.dataset.qcExclude}/exclude`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ excluded: cb.checked }),
      });
      await loadQc();
    };
  });
  document.querySelectorAll("[data-qc-validate]").forEach((btn) => {
    btn.onclick = async () => { await fetch(`/api/qc/${btn.dataset.qcValidate}/validate`, { method: "PATCH" }); await loadQc(); };
  });
  document.querySelectorAll("[data-qc-approve]").forEach((btn) => {
    btn.onclick = async () => {
      const res = await fetch(`/api/qc/${btn.dataset.qcApprove}/approve`, { method: "PATCH" });
      if (!res.ok) { const out = await res.json().catch(() => ({})); alert(out.error || "Not allowed"); }
      await loadQc();
    };
  });
}
document.getElementById("qcFilterInstrument").onchange = () => { loadQc(); if (!document.getElementById("ljChartPanel").hidden) renderLjChart(); };
document.getElementById("qcFilterStatus").onchange = () => { loadQc(); if (!document.getElementById("ljChartPanel").hidden) renderLjChart(); };

function renderLjChart() {
  const panel = document.getElementById("ljChartPanel");
  if (!LAST_QC_ROWS.length) { panel.innerHTML = `<p class="lis-instrument-note" style="padding:16px">No QC results to chart yet — add some QC results first.</p>`; return; }

  // Group by analyzer+qcName+lot+test so each line is a real, comparable series.
  const groups = {};
  LAST_QC_ROWS.forEach((r) => {
    const key = `${r.instrumentName}|${r.qcName}|${r.lotName}|${r.testName}`;
    (groups[key] = groups[key] || []).push(r);
  });

  const W = 760, H = 220, PAD_L = 50, PAD_R = 20, PAD_T = 16, PAD_B = 30;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const yFor = (z) => PAD_T + plotH / 2 - (Math.max(-3.5, Math.min(3.5, z)) / 3.5) * (plotH / 2);
  const gridline = (sd, color, label) => `
    <line x1="${PAD_L}" y1="${yFor(sd)}" x2="${W - PAD_R}" y2="${yFor(sd)}" stroke="${color}" stroke-width="1" stroke-dasharray="${sd === 0 ? "0" : "4,3"}" opacity="0.6"/>
    <text x="${W - PAD_R + 3}" y="${yFor(sd) + 3}" font-size="9" fill="${color}">${label}</text>`;

  const charts = Object.entries(groups).map(([key, pts]) => {
    const sorted = [...pts].sort((a, b) => new Date(a.resultTime) - new Date(b.resultTime));
    const xs = sorted.map((_, i) => sorted.length > 1 ? PAD_L + (i / (sorted.length - 1)) * plotW : PAD_L + plotW / 2);
    const zs = sorted.map((r) => (r.result - r.mean) / r.sd);
    const linePoints = xs.map((x, i) => `${x},${yFor(zs[i])}`).join(" ");
    const dots = sorted.map((r, i) => {
      const color = r.qcStatus === "Fail" ? "#f87171" : r.qcStatus === "Warning" ? "#facc15" : "#4ade80";
      return `<circle cx="${xs[i]}" cy="${yFor(zs[i])}" r="4" fill="${color}" stroke="#0b1120" stroke-width="1"><title>${r.resultTime} — result ${r.result} (${zs[i].toFixed(2)} SD) — ${r.qcStatus}${r.westgardRule ? " — " + r.westgardRule : ""}</title></circle>`;
    }).join("");
    const [analyzer, qcName, lot, test] = key.split("|");
    return `
      <div style="margin-bottom:18px">
        <div class="lis-filter-head" style="border:none;padding:0 0 6px">${analyzer} — ${qcName} — ${lot} — ${test}</div>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:var(--panel-bg,#0b1120);border-radius:8px">
          ${gridline(3, "#f87171", "+3SD")}${gridline(2, "#facc15", "+2SD")}${gridline(1, "#4b5563", "+1SD")}
          ${gridline(0, "#94a3b8", "Mean")}
          ${gridline(-1, "#4b5563", "-1SD")}${gridline(-2, "#facc15", "-2SD")}${gridline(-3, "#f87171", "-3SD")}
          <polyline points="${linePoints}" fill="none" stroke="#38bdf8" stroke-width="1.5"/>
          ${dots}
        </svg>
      </div>`;
  }).join("");

  panel.innerHTML = `<div style="padding:16px">${charts}</div>`;
}

document.getElementById("btnLjChart").onclick = () => {
  const panel = document.getElementById("ljChartPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderLjChart();
};

const qcModal = document.getElementById("qcModalOverlay");
document.getElementById("btnAddQc").onclick = async () => {
  const instruments = await (await fetch("/api/instruments")).json();
  document.getElementById("qcInstrument").innerHTML = instruments.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");
  qcModal.hidden = false;
};
const closeQcModal = () => { qcModal.hidden = true; document.getElementById("qcForm").reset(); };
document.getElementById("qcModalClose").onclick = closeQcModal;
document.getElementById("qcModalCancel").onclick = closeQcModal;
qcModal.onclick = (e) => { if (e.target === qcModal) closeQcModal(); };
document.getElementById("qcForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/qc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instrumentId: document.getElementById("qcInstrument").value,
      qcName: document.getElementById("qcName").value.trim(),
      lotName: document.getElementById("qcLot").value.trim(),
      testName: document.getElementById("qcTest").value.trim(),
      mean: document.getElementById("qcMean").value,
      sd: document.getElementById("qcSd").value,
      result: document.getElementById("qcResult").value,
    }),
  });
  closeQcModal();
  await loadQc();
};

// ---- Sample Archiving ----
async function loadArchiving() {
  const [units, racks, samples] = await Promise.all([
    fetch("/api/storage-units").then((r) => r.json()),
    fetch("/api/racks").then((r) => r.json()),
    fetch("/api/samples").then((r) => r.json()),
  ]);

  document.getElementById("cntUnitRows").textContent = units.length;
  document.getElementById("unitsTableBody").innerHTML = units.map((u) => `
    <tr><td>${u.name}</td><td>${u.type || "—"}</td><td>${u.branch || "—"}</td></tr>`).join("")
    || `<tr><td colspan="3" class="lis-instrument-note">No storage units yet.</td></tr>`;

  document.getElementById("cntRackRows").textContent = racks.length;
  document.getElementById("racksTableBody").innerHTML = racks.map((r) => `
    <tr><td>${r.code}</td><td>${r.unitName}</td><td>${r.capacity ?? "—"}</td></tr>`).join("")
    || `<tr><td colspan="3" class="lis-instrument-note">No racks yet.</td></tr>`;

  document.getElementById("cntArchSampleRows").textContent = samples.length;
  document.getElementById("archSamplesTableBody").innerHTML = samples.map((s) => {
    const rack = racks.find((r) => r.id === s.rackId);
    return `
    <tr>
      <td>${s.id}</td>
      <td>${s.patient ? s.patient.name : "—"}</td>
      <td>${rack ? rack.code : "—"}</td>
      <td>${s.position || "—"}</td>
      <td><span class="lis-badge ${s.disposed ? "qc-status-fail" : rack ? "qc-status-pass" : ""}">${s.disposed ? "Disposed" : rack ? "Stored" : "Not stored"}</span></td>
      <td style="display:flex;gap:6px">
        ${s.disposed ? "" : `<button class="btn ghost" style="padding:3px 8px;font-size:11px" data-store-sample="${s.id}">${rack ? "Move" : "Store"}</button>`}
        ${!s.disposed && rack ? `<button class="btn ghost" style="padding:3px 8px;font-size:11px" data-dispose-sample="${s.id}">Dispose</button>` : ""}
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="lis-instrument-note">No samples yet.</td></tr>`;

  document.querySelectorAll("[data-store-sample]").forEach((btn) => {
    btn.onclick = async () => {
      const racksNow = await (await fetch("/api/racks")).json();
      document.getElementById("storeRackSelect").innerHTML = racksNow.map((r) => `<option value="${r.id}">${r.code} (${r.unitName})</option>`).join("");
      storeModal.dataset.sampleId = btn.dataset.storeSample;
      storeModal.hidden = false;
    };
  });
  document.querySelectorAll("[data-dispose-sample]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`Mark sample ${btn.dataset.disposeSample} as disposed? This frees its rack slot.`)) return;
      await fetch(`/api/samples/${btn.dataset.disposeSample}/dispose`, { method: "PATCH" });
      await loadArchiving();
    };
  });
}

const unitModal = document.getElementById("unitModalOverlay");
document.getElementById("btnAddUnit").onclick = () => { unitModal.hidden = false; };
const closeUnitModal = () => { unitModal.hidden = true; document.getElementById("unitForm").reset(); };
document.getElementById("unitModalClose").onclick = closeUnitModal;
document.getElementById("unitModalCancel").onclick = closeUnitModal;
unitModal.onclick = (e) => { if (e.target === unitModal) closeUnitModal(); };
document.getElementById("unitForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/storage-units", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: document.getElementById("unitName").value.trim(), type: document.getElementById("unitType").value, branch: document.getElementById("unitBranch").value.trim() }),
  });
  closeUnitModal();
  await loadArchiving();
};

const rackModal = document.getElementById("rackModalOverlay");
document.getElementById("btnAddRack").onclick = async () => {
  const units = await (await fetch("/api/storage-units")).json();
  document.getElementById("rackUnitSelect").innerHTML = units.map((u) => `<option value="${u.id}">${u.name}</option>`).join("");
  rackModal.hidden = false;
};
const closeRackModal = () => { rackModal.hidden = true; document.getElementById("rackForm").reset(); };
document.getElementById("rackModalClose").onclick = closeRackModal;
document.getElementById("rackModalCancel").onclick = closeRackModal;
rackModal.onclick = (e) => { if (e.target === rackModal) closeRackModal(); };
document.getElementById("rackForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/racks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unitId: document.getElementById("rackUnitSelect").value, code: document.getElementById("rackCode").value.trim(), capacity: document.getElementById("rackCapacity").value }),
  });
  closeRackModal();
  await loadArchiving();
};

const storeModal = document.getElementById("storeModalOverlay");
const closeStoreModal = () => { storeModal.hidden = true; document.getElementById("storeForm").reset(); };
document.getElementById("storeModalClose").onclick = closeStoreModal;
document.getElementById("storeModalCancel").onclick = closeStoreModal;
storeModal.onclick = (e) => { if (e.target === storeModal) closeStoreModal(); };
document.getElementById("storeForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch(`/api/samples/${storeModal.dataset.sampleId}/store`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rackId: document.getElementById("storeRackSelect").value, position: document.getElementById("storePosition").value.trim() }),
  });
  closeStoreModal();
  await loadArchiving();
};

// ---- Warehouse: Suppliers, Inventory, Purchasing ----
async function loadWarehouse() {
  const [suppliers, items, orders] = await Promise.all([
    fetch("/api/suppliers").then((r) => r.json()),
    fetch("/api/inventory").then((r) => r.json()),
    fetch("/api/purchase-orders").then((r) => r.json()),
  ]);

  document.getElementById("cntSupplierRows").textContent = suppliers.length;
  document.getElementById("suppliersTableBody").innerHTML = suppliers.map((s) => `
    <tr><td>${s.name}</td><td>${s.contact || "—"}</td></tr>`).join("")
    || `<tr><td colspan="2" class="lis-instrument-note">No suppliers yet.</td></tr>`;

  document.getElementById("cntInventoryRows").textContent = items.length;
  document.getElementById("inventoryTableBody").innerHTML = items.map((i) => {
    const low = i.quantity <= i.reorderLevel;
    return `
    <tr>
      <td>${i.name}</td><td>${i.category || "—"}</td><td>${i.quantity}</td><td>${i.reorderLevel}</td><td>${i.branch || "—"}</td>
      <td><span class="lis-badge ${low ? "qc-status-fail" : "qc-status-pass"}">${low ? "Reorder" : "OK"}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="lis-instrument-note">No inventory items yet.</td></tr>`;

  document.getElementById("cntPoRows").textContent = orders.length;
  document.getElementById("poTableBody").innerHTML = orders.map((o) => `
    <tr>
      <td>${o.itemName}</td><td>${o.supplierName || "—"}</td><td>${o.quantity}</td><td>${o.orderDate}</td>
      <td><span class="lis-badge ${o.status === "Received" ? "qc-status-pass" : ""}">${o.status}</span></td>
      <td>${o.status === "Pending" ? `<button class="btn ghost" style="padding:3px 8px;font-size:11px" data-receive-po="${o.id}">Receive</button>` : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="lis-instrument-note">No purchase orders yet.</td></tr>`;

  document.querySelectorAll("[data-receive-po]").forEach((btn) => {
    btn.onclick = async () => { await fetch(`/api/purchase-orders/${btn.dataset.receivePo}/receive`, { method: "PATCH" }); await loadWarehouse(); };
  });
}

const supplierModal = document.getElementById("supplierModalOverlay");
document.getElementById("btnAddSupplier").onclick = () => { supplierModal.hidden = false; };
const closeSupplierModal = () => { supplierModal.hidden = true; document.getElementById("supplierForm").reset(); };
document.getElementById("supplierModalClose").onclick = closeSupplierModal;
document.getElementById("supplierModalCancel").onclick = closeSupplierModal;
supplierModal.onclick = (e) => { if (e.target === supplierModal) closeSupplierModal(); };
document.getElementById("supplierForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/suppliers", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: document.getElementById("spName").value.trim(), contact: document.getElementById("spContact").value.trim() }),
  });
  closeSupplierModal();
  await loadWarehouse();
};

const itemModal = document.getElementById("itemModalOverlay");
document.getElementById("btnAddInventoryItem").onclick = () => { itemModal.hidden = false; };
const closeItemModal = () => { itemModal.hidden = true; document.getElementById("itemForm").reset(); };
document.getElementById("itemModalClose").onclick = closeItemModal;
document.getElementById("itemModalCancel").onclick = closeItemModal;
itemModal.onclick = (e) => { if (e.target === itemModal) closeItemModal(); };
document.getElementById("itemForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/inventory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("itName").value.trim(),
      category: document.getElementById("itCategory").value.trim(),
      quantity: document.getElementById("itQuantity").value,
      reorderLevel: document.getElementById("itReorder").value,
      branch: document.getElementById("itBranch").value.trim(),
    }),
  });
  closeItemModal();
  await loadWarehouse();
};

const poModal = document.getElementById("poModalOverlay");
document.getElementById("btnAddPo").onclick = async () => {
  const [items, suppliers] = await Promise.all([
    fetch("/api/inventory").then((r) => r.json()),
    fetch("/api/suppliers").then((r) => r.json()),
  ]);
  document.getElementById("poItemSelect").innerHTML = items.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");
  document.getElementById("poSupplierSelect").innerHTML = `<option value="">—</option>` + suppliers.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
  poModal.hidden = false;
};
const closePoModal = () => { poModal.hidden = true; document.getElementById("poForm").reset(); };
document.getElementById("poModalClose").onclick = closePoModal;
document.getElementById("poModalCancel").onclick = closePoModal;
poModal.onclick = (e) => { if (e.target === poModal) closePoModal(); };
document.getElementById("poForm").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/purchase-orders", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: document.getElementById("poItemSelect").value,
      supplierId: document.getElementById("poSupplierSelect").value || null,
      quantity: document.getElementById("poQuantity").value,
    }),
  });
  closePoModal();
  await loadWarehouse();
};

// ---- Reporting ----
let CURRENT_REPORT = { columns: [], rows: [] };

async function loadReport() {
  const type = document.getElementById("reportType").value || document.getElementById("reportType").options[0].value;
  const data = await (await fetch(`/api/reports/${type}`)).json();
  CURRENT_REPORT = data;
  const out = document.getElementById("reportOutput");
  out.innerHTML = `
    <div class="table-wrap">
      <table class="data-table lis-table">
        <thead><tr>${data.columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>${data.rows.map((row) => `<tr>${row.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${data.columns.length}" class="lis-instrument-note">No data for this report.</td></tr>`}</tbody>
      </table>
    </div>`;
}
document.getElementById("reportType").onchange = loadReport;

document.getElementById("btnExportReport").onclick = () => {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [CURRENT_REPORT.columns.map(esc).join(","), ...CURRENT_REPORT.rows.map((r) => r.map(esc).join(","))].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${document.getElementById("reportType").value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// ---- Validation & Approval queues ----
async function loadValidationQueue() {
  const samples = await (await fetch("/api/samples")).json();
  const results = await (await fetch("/api/results")).json();
  const queue = samples.filter((s) => s.status === "Processing" && !s.disposed);
  const box = document.getElementById("validationList");
  box.innerHTML = queue.length ? queue.map((s) => {
    const tests = results.filter((r) => r.sampleId === s.id);
    return `
    <div class="panel-card p360-card">
      <div class="p360-head">
        <div><strong>${s.patient ? s.patient.name : "—"}</strong> <span class="lis-instrument-note" style="display:inline;padding:0">· Sample ${s.id}</span></div>
        <button class="btn primary" style="padding:5px 14px;font-size:12px" data-validate-sample="${s.id}">Validate</button>
      </div>
      <table class="data-table lis-table" style="margin-top:8px">
        <thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Range</th></tr></thead>
        <tbody>${tests.map((t) => `<tr><td>${t.testName}</td><td>${t.result ?? '<span style="color:var(--text-faint)">Pending</span>'}</td><td>${t.unit || "—"}</td><td>${t.min ?? "—"}–${t.max ?? "—"}</td></tr>`).join("") || `<tr><td colspan="4" class="lis-instrument-note">No tests linked.</td></tr>`}</tbody>
      </table>
    </div>`;
  }).join("") : `<p class="lis-instrument-note">Nothing waiting for validation right now.</p>`;

  document.querySelectorAll("[data-validate-sample]").forEach((btn) => {
    btn.onclick = async () => {
      const res = await fetch(`/api/samples/${btn.dataset.validateSample}/validate`, { method: "PATCH" });
      if (!res.ok) { const out = await res.json().catch(() => ({})); alert(out.error || "Not allowed"); }
      await loadValidationQueue();
    };
  });
}

async function loadApprovalQueue() {
  const samples = await (await fetch("/api/samples")).json();
  const queue = samples.filter((s) => s.status === "Validated" && !s.disposed);
  const canApprove = CURRENT_USER && CURRENT_USER.role === "Admin";
  const box = document.getElementById("approvalList");
  box.innerHTML = queue.length ? `
    <div class="panel-card" style="padding:0;overflow:hidden">
      <div class="table-wrap">
        <table class="data-table lis-table">
          <thead><tr><th>Sample</th><th>Patient</th><th>Validated By</th><th>Validated At</th><th>Action</th></tr></thead>
          <tbody>${queue.map((s) => `
            <tr>
              <td>${s.id}</td><td>${s.patient ? s.patient.name : "—"}</td><td>${s.validatedBy || "—"}</td><td>${s.validatedAt || "—"}</td>
              <td>${canApprove
                ? `<button class="btn primary" style="padding:4px 10px;font-size:11.5px" data-approve-sample="${s.id}">Approve &amp; Report</button>`
                : `<span class="lis-instrument-note" style="padding:0">Admin only</span>`}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>` : `<p class="lis-instrument-note">Nothing waiting for approval right now.</p>`;

  document.querySelectorAll("[data-approve-sample]").forEach((btn) => {
    btn.onclick = async () => {
      const res = await fetch(`/api/samples/${btn.dataset.approveSample}/approve`, { method: "PATCH" });
      if (!res.ok) { const out = await res.json().catch(() => ({})); alert(out.error || "Not allowed"); }
      await loadApprovalQueue();
    };
  });
}

async function startApp() {
  const ok = await checkSession();
  if (!ok) return;
  await loadInstruments();
  await loadResults();
  await loadDashboardStats();
  // Poll for new results every 3s so anything the HL7 listener forwards shows up live,
  // without needing a manual refresh — mirrors how a real LIS worklist behaves.
  if (!window.__qrlisPolling) {
    window.__qrlisPolling = true;
    setInterval(loadResults, 3000);
  }
}
startApp();

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
