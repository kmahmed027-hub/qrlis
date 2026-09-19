const express = require("express");
const path = require("path");
const net = require("net");
const { JsonDb, TEST_STATUSES } = require("./db");
const {
  attachUser,
  requireAuth,
  requireModule,
  listenerBasicAuth,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
} = require("./auth");
const { ROLES } = require("./roles");

function createServer({ appDir, dbFilePath, requireAuth: authEnabled = false }) {
  const db = new JsonDb(dbFilePath);
  const app = express();
  app.set("trust proxy", 1); // so req.secure is correct behind Render/Railway/etc.'s proxy
  app.use(express.json());
  app.use(attachUser(db));

  // The HTML/CSS/JS app shell is public (it has no lab data in it) — the login
  // screen itself lives inside it. Everything that actually returns data goes
  // through /api/*, which IS gated below.
  app.use(express.static(appDir));

  // Pass-through guards when auth is disabled (e.g. a trusted LAN-only deployment).
  const guard = authEnabled ? requireAuth : (req, res, next) => next();
  const guardModule = (...mods) => (authEnabled ? requireModule(...mods) : (req, res, next) => next());

  // ---- Auth endpoints (never behind the guard below) ----
  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password are required" });
    const user = db.verifyCredentials(username, password);
    if (!user) return res.status(401).json({ error: "Invalid username or password" });
    const token = createSession(user.id);
    setSessionCookie(req, res, token);
    res.json(user);
  });

  app.post("/api/auth/logout", (req, res) => {
    if (req.sessionToken) destroySession(req.sessionToken);
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    res.json(req.user);
  });

  // Everything else under /api requires a valid login when authEnabled is true —
  // except /api/hl7-results, which is called by the HL7 listener (a background
  // process on the lab PC, not a browser) and authenticates separately below.
  app.use("/api", (req, res, next) => {
    if (req.path === "/hl7-results") return next();
    return guard(req, res, next);
  });

  app.get("/api/auth/roles", guardModule("admin"), (req, res) => res.json(ROLES));

  // ---- User accounts (login access) — Admin only ----
  app.get("/api/users", guardModule("admin"), (req, res) => res.json(db.getUsers()));

  app.post("/api/users", guardModule("admin"), (req, res) => {
    const { username, password, name, role, staffId } = req.body || {};
    if (!username || !password || !role) return res.status(400).json({ error: "username, password and role are required" });
    if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (!ROLES.includes(role)) return res.status(400).json({ error: "Unknown role" });
    if (db.findUserByUsername(username)) return res.status(409).json({ error: "That username is already taken" });
    res.status(201).json(db.addUser({ username, password, name, role, staffId }));
  });

  app.patch("/api/users/:id", guardModule("admin"), (req, res) => {
    const { password, name, role, staffId, active } = req.body || {};
    if (password && String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: "Unknown role" });
    if (active === false && req.user.id === req.params.id) return res.status(400).json({ error: "You can't deactivate your own account while logged in as it." });
    const updated = db.updateUser(req.params.id, { password, name, role, staffId, active });
    if (!updated) return res.status(404).json({ error: "Account not found" });
    res.json(updated);
  });

  app.delete("/api/users/:id", guardModule("admin"), (req, res) => {
    if (req.user.id === req.params.id) return res.status(400).json({ error: "You can't delete your own account while logged in as it." });
    db.removeUser(req.params.id);
    res.status(204).end();
  });

  app.get("/api/instruments", (req, res) => {
    res.json(db.getInstruments());
  });

  app.get("/api/dashboard/reports", (req, res) => {
    res.json(db.statisticsReports());
  });

  app.get("/api/dashboard/stats", (req, res) => {
    res.json(db.dashboardStats());
  });

  app.get("/api/patient360", guardModule("patient360"), (req, res) => {
    const { q, sampleId, status } = req.query;
    res.json(db.search360({ patientQuery: q, sampleId, sampleStatus: status }));
  });

  app.get("/api/patients", guardModule("booking", "patient360", "reservations"), (req, res) => {
    res.json(db.getPatients());
  });

  app.post("/api/patients", guardModule("booking"), (req, res) => {
    const { name, mobile, mrn, gender, dob } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    res.status(201).json(db.addPatient({ name, mobile, mrn, gender, dob }));
  });

  app.get("/api/reservations", guardModule("booking", "reservations", "patient360"), (req, res) => {
    const patients = db.getPatients();
    const clients = db.getClients();
    const samples = db.getSamples();
    const results = db.getResults();
    const rows = db.getReservations().map((r) => {
      // Total = the priced test lines booked under this reservation's sample(s).
      const sampleIds = samples.filter((s) => s.reservationId === r.id).map((s) => s.id);
      const total = results
        .filter((x) => sampleIds.includes(x.sampleId))
        .reduce((sum, x) => sum + Number(x.price || 0), 0);
      return {
        ...r,
        patient: patients.find((p) => p.id === r.patientId) || null,
        client: clients.find((c) => c.id === r.clientId) || null,
        total,
      };
    });
    res.json(rows);
  });

  app.post("/api/reservations", guardModule("booking"), (req, res) => {
    const { patientId, type, date, status } = req.body || {};
    if (!patientId) return res.status(400).json({ error: "patientId is required" });
    res.status(201).json(db.addReservation({ patientId, type, date, status }));
  });

  app.get("/api/samples", guardModule("booking", "samples", "processing", "patient360"), (req, res) => {
    const patients = db.getPatients();
    const rows = db.getSamples().map((s) => ({ ...s, patient: patients.find((p) => p.id === s.patientId) || null }));
    res.json(rows);
  });

  app.post("/api/samples", guardModule("booking", "samples"), (req, res) => {
    const { id, patientId, reservationId, branch, collectionDate, receivingDate, status } = req.body || {};
    if (!patientId) return res.status(400).json({ error: "patientId is required" });
    res.status(201).json(db.addSample({ id, patientId, reservationId, branch, collectionDate, receivingDate, status }));
  });

  app.patch("/api/samples/:id/status", guardModule("samples", "processing"), (req, res) => {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: "status is required" });
    const updated = db.updateSampleStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: "Sample not found" });
    res.json(updated);
  });

  app.patch("/api/samples/:id/processing", guardModule("processing"), (req, res) => {
    const { step, value } = req.body || {};
    const updated = db.updateProcessingStep(req.params.id, step, value);
    if (!updated) return res.status(404).json({ error: "Sample or step not found" });
    res.json(updated);
  });

  app.get("/api/pcr", guardModule("pcr", "patient360"), (req, res) => {
    const patients = db.getPatients();
    const rows = db.getPcrTests().map((t) => ({ ...t, patient: patients.find((p) => p.id === t.patientId) || null }));
    res.json(rows);
  });

  app.post("/api/pcr", guardModule("pcr"), (req, res) => {
    const { sampleId, patientId, target, ctValue, interpretation, kit, runDate } = req.body || {};
    if (!sampleId || !target) return res.status(400).json({ error: "sampleId and target are required" });
    res.status(201).json(db.addPcrTest({ sampleId, patientId, target, ctValue: ctValue ?? null, interpretation: interpretation || "Pending", kit, runDate }));
  });

  // ---- Reporting: generate a snapshot report from resulted tests, then release it ----
  app.get("/api/reporting/candidates", guardModule("reporting"), (req, res) => res.json(db.reportableSamples()));

  app.get("/api/reports", guardModule("reporting"), (req, res) => res.json(db.getReports()));

  app.post("/api/reports", guardModule("reporting"), (req, res) => {
    const { sampleId } = req.body || {};
    if (!sampleId) return res.status(400).json({ error: "sampleId is required" });
    const report = db.addReport({ sampleId, releasedBy: req.user ? req.user.name || req.user.username : "—" });
    if (!report) return res.status(404).json({ error: "No resulted tests found for that sample" });
    res.status(201).json(report);
  });

  app.patch("/api/reports/:id/release", guardModule("reporting"), (req, res) => {
    const report = db.releaseReport(req.params.id, req.user ? req.user.name || req.user.username : "—");
    if (!report) return res.status(404).json({ error: "Report not found" });
    res.json(report);
  });

  // ---- Quality Control ----
  app.get("/api/qc/lots", guardModule("qc"), (req, res) => res.json(db.getQcLots()));

  app.post("/api/qc/lots", guardModule("qc"), (req, res) => {
    const { testName, mean, sd } = req.body || {};
    if (!testName) return res.status(400).json({ error: "testName is required" });
    if (mean === undefined || sd === undefined) return res.status(400).json({ error: "mean and sd are required" });
    res.status(201).json(db.addQcLot(req.body));
  });

  app.delete("/api/qc/lots/:id", guardModule("qc"), (req, res) => {
    db.removeQcLot(req.params.id);
    res.status(204).end();
  });

  app.get("/api/qc/runs", guardModule("qc"), (req, res) => res.json(db.getQcRuns(req.query.lotId)));

  app.post("/api/qc/runs", guardModule("qc"), (req, res) => {
    const { lotId, value } = req.body || {};
    if (!lotId || value === undefined || value === "") return res.status(400).json({ error: "lotId and value are required" });
    const run = db.addQcRun({
      lotId, value, comment: req.body.comment,
      userName: req.user ? req.user.name || req.user.username : "—",
    });
    if (!run) return res.status(404).json({ error: "QC lot not found" });
    res.status(201).json(run);
  });

  // ---- Warehouse: stock on hand + the movement trail that drives it ----
  app.get("/api/inventory", guardModule("warehouse"), (req, res) => res.json(db.getInventory()));

  app.post("/api/inventory", guardModule("warehouse"), (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    res.status(201).json(db.addInventoryItem(req.body));
  });

  app.delete("/api/inventory/:id", guardModule("warehouse"), (req, res) => {
    db.removeInventoryItem(req.params.id);
    res.status(204).end();
  });

  app.post("/api/inventory/:id/movements", guardModule("warehouse"), (req, res) => {
    const { type, qty, reason } = req.body || {};
    if (!["Receive", "Issue", "Adjust", "Waste"].includes(type)) {
      return res.status(400).json({ error: "type must be Receive, Issue, Adjust or Waste" });
    }
    if (qty === undefined || Number(qty) < 0) return res.status(400).json({ error: "qty must be zero or more" });
    const outcome = db.recordStockMovement({
      itemId: req.params.id, type, qty, reason,
      userName: req.user ? req.user.name || req.user.username : "—",
    });
    if (!outcome) return res.status(404).json({ error: "Item not found" });
    if (outcome.error) return res.status(400).json({ error: outcome.error });
    res.status(201).json(outcome);
  });

  app.get("/api/inventory/movements", guardModule("warehouse"), (req, res) => {
    res.json(db.getStockMovements(req.query.itemId));
  });

  // ---- Client accounts (bookings are billed to one) ----
  app.get("/api/clients", guardModule("booking", "reservations", "admin"), (req, res) => res.json(db.getClients()));

  app.post("/api/clients", guardModule("admin"), (req, res) => {
    const { name, accountType, commissionPct } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    if (accountType && !["Cash", "Credit", "Insurance"].includes(accountType)) {
      return res.status(400).json({ error: "accountType must be Cash, Credit or Insurance" });
    }
    res.status(201).json(db.addClient({ name, accountType, commissionPct }));
  });

  app.delete("/api/clients/:id", guardModule("admin"), (req, res) => {
    db.removeClient(req.params.id);
    res.status(204).end();
  });

  // ---- Contracts-style booking: one call creates patients + reservations +
  // samples + priced test lines for everyone on the contract. ----
  app.post("/api/bookings", guardModule("booking"), (req, res) => {
    const { clientId, bookingType, patients } = req.body || {};
    if (!Array.isArray(patients) || patients.length === 0) {
      return res.status(400).json({ error: "At least one patient is required" });
    }
    if (patients.some((p) => !p || !p.name)) return res.status(400).json({ error: "Every patient needs a name" });
    res.status(201).json(db.createBooking({ clientId, bookingType, patients }));
  });

  // ---- Test/Service catalog (pricing is admin-managed; anyone doing
  // Booking/PCR just needs to read it to pick tests) ----
  app.get("/api/catalog", guardModule("booking", "pcr", "admin", "reservations"), (req, res) => res.json(db.getCatalog()));

  app.post("/api/catalog", guardModule("admin"), (req, res) => {
    const { code, name, kind, price } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    if (kind && !["Test", "Service"].includes(kind)) return res.status(400).json({ error: "kind must be Test or Service" });
    res.status(201).json(db.addCatalogItem({ code, name, kind, price }));
  });

  app.patch("/api/catalog/:id", guardModule("admin"), (req, res) => {
    const { code, name, kind, price } = req.body || {};
    if (kind && !["Test", "Service"].includes(kind)) return res.status(400).json({ error: "kind must be Test or Service" });
    const updated = db.updateCatalogItem(req.params.id, { code, name, kind, price });
    if (!updated) return res.status(404).json({ error: "Catalog item not found" });
    res.json(updated);
  });

  app.delete("/api/catalog/:id", guardModule("admin"), (req, res) => {
    db.removeCatalogItem(req.params.id);
    res.status(204).end();
  });

  app.get("/api/staff", guardModule("admin"), (req, res) => res.json(db.getStaff()));
  app.post("/api/staff", guardModule("admin"), (req, res) => {
    const { name, role, branch } = req.body || {};
    if (!name || !role) return res.status(400).json({ error: "name and role are required" });
    res.status(201).json(db.addStaff({ name, role, branch }));
  });
  app.delete("/api/staff/:id", guardModule("admin"), (req, res) => { db.removeStaff(req.params.id); res.status(204).end(); });

  app.get("/api/branches", guardModule("admin"), (req, res) => res.json(db.getBranches()));
  app.post("/api/branches", guardModule("admin"), (req, res) => {
    const { code, name, type } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: "code and name are required" });
    res.status(201).json(db.addBranch({ code, name, type }));
  });
  app.delete("/api/branches/:id", guardModule("admin"), (req, res) => { db.removeBranch(req.params.id); res.status(204).end(); });

  app.post("/api/instruments", guardModule("connection", "booking"), (req, res) => {
    const { name, model, conn, protocol, address } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const record = db.addInstrument({ name, model, conn, protocol, address });
    res.status(201).json(record);
  });

  app.delete("/api/instruments/:id", guardModule("connection"), (req, res) => {
    db.removeInstrument(req.params.id);
    res.status(204).end();
  });

  // Live-checks a connection. TCP/IP instruments get a real socket probe against
  // host:port. Serial (COM-port) instruments can't be reached from a web server —
  // that link only exists on the lab PC running qrlis-hl7-listener.exe — so we
  // return an explanatory message instead of a false "connected".
  app.post("/api/instruments/:id/test", guardModule("connection"), (req, res) => {
    const inst = db.getInstruments().find((i) => i.id === req.params.id);
    if (!inst) return res.status(404).json({ ok: false, message: "Instrument not found" });

    if (inst.conn !== "tcp") {
      return res.json({
        ok: false,
        message: "Serial (COM) links are tested from the lab PC — run qrlis-hl7-listener.exe there.",
      });
    }

    const [host, portStr] = String(inst.address || "").split(":");
    const port = parseInt(portStr, 10);
    if (!host || !port) {
      return res.json({ ok: false, message: "Address must be host:port, e.g. 192.168.1.50:5100" });
    }

    const socket = new net.Socket();
    const timeout = 3000;
    let done = false;
    const finish = (ok, message) => {
      if (done) return;
      done = true;
      socket.destroy();
      res.json({ ok, message });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true, `Reachable at ${host}:${port}`));
    socket.once("timeout", () => finish(false, `Timed out after ${timeout / 1000}s`));
    socket.once("error", (err) => finish(false, err.code || "Connection failed"));
    socket.connect(port, host);
  });

  app.get("/api/results", (req, res) => {
    res.json(db.getResults());
  });

  // ---- Samples Report: one row per test, joined with sample/patient/reservation,
  // with the same filters the report's filter panel exposes. ----
  app.get("/api/samples-report", guardModule("booking", "samples", "processing", "patient360"), (req, res) => {
    res.json(db.reportRows(req.query));
  });

  app.get("/api/meta/test-statuses", guardModule("booking", "samples", "processing", "patient360"), (req, res) => {
    res.json(TEST_STATUSES);
  });

  app.patch("/api/results/:id", guardModule("samples", "processing"), (req, res) => {
    const { testStatus, isOnHold } = req.body || {};
    if (testStatus && !TEST_STATUSES.includes(testStatus)) return res.status(400).json({ error: "Unknown test status" });
    const updated = db.updateResultFields(req.params.id, { testStatus, isOnHold });
    if (!updated) return res.status(404).json({ error: "Result not found" });
    res.json(updated);
  });

  // Called by the HL7 listener (see hl7-listener/listener.js -> forwardToQrLis) whenever a
  // real (or test) instrument message arrives.
  app.post("/api/hl7-results", listenerBasicAuth, (req, res) => {
    const { sampleId, sendingSystem, results } = req.body || {};
    if (!sampleId || !Array.isArray(results)) {
      return res.status(400).json({ error: "sampleId and results[] are required" });
    }
    const instruments = db.getInstruments();
    const matchedInstrument = instruments.find(
      (i) =>
        sendingSystem &&
        (i.name.toLowerCase() === String(sendingSystem).toLowerCase() ||
          i.model.toLowerCase() === String(sendingSystem).toLowerCase())
    );
    results.forEach((r) => {
      db.upsertResultFromHl7({
        sampleId,
        testId: r.testCode,
        testName: r.testName,
        result: r.value,
        unit: r.unit,
        referenceRange: r.referenceRange,
        instrumentId: matchedInstrument ? matchedInstrument.id : null,
        sendingSystem,
      });
    });
    res.status(201).json({ ok: true, stored: results.length });
  });

  return { app, db };
}

module.exports = { createServer };
