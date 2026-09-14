const express = require("express");
const path = require("path");
const net = require("net");
const { sessionAuth, hashPassword, verifyPassword, setSessionCookie, clearSessionCookie, readSession, ROLE_VIEWS } = require("./auth");
const westgard = require("./westgard");

// `db` is now passed in ready-to-use (see server.js) instead of built here —
// that's what lets the same createServer() work with either JsonDb or PgDb.
function createServer({ appDir, db, requireAuth = false }) {
  const app = express();
  app.use(express.json());

  // ---- Auth routes (public: must work before a session exists) ----
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password are required" });

    const BOOT_USER = process.env.QRLIS_USER || "admin";
    const BOOT_PASS = process.env.QRLIS_PASS || "changeme123";
    if (username === BOOT_USER && password === BOOT_PASS) {
      const user = { sub: "bootstrap", name: "Administrator", role: "Admin" };
      setSessionCookie(res, user);
      return res.json({ ...user, views: ROLE_VIEWS.Admin });
    }

    const staff = db.findStaffByUsername(username);
    if (!staff || !staff.active || !verifyPassword(password, staff.passwordHash)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const user = { sub: staff.id, name: staff.name, role: staff.role };
    setSessionCookie(res, user);
    res.json({ ...user, views: ROLE_VIEWS[staff.role] || ROLE_VIEWS.Receptionist });
  });

  app.post("/api/logout", (req, res) => { clearSessionCookie(req, res); res.status(204).end(); });

  app.get("/api/me", (req, res) => {
    const user = readSession(req);
    if (!user) return res.json({ user: null });
    res.json({ user: { sub: user.sub, name: user.name, role: user.role }, views: ROLE_VIEWS[user.role] || ROLE_VIEWS.Receptionist });
  });

  app.use(express.static(appDir));
  if (requireAuth) app.use("/api", sessionAuth);

  app.get("/api/instruments", (req, res) => {
    res.json(db.getInstruments());
  });

  app.get("/api/dashboard/stats", (req, res) => {
    res.json(db.dashboardStats());
  });

  app.get("/api/patient360", (req, res) => {
    const { q, sampleId, status } = req.query;
    res.json(db.search360({ patientQuery: q, sampleId, sampleStatus: status }));
  });

  app.get("/api/patients", (req, res) => {
    res.json(db.getPatients());
  });

  app.post("/api/patients", (req, res) => {
    const { name, mobile, mrn, gender, dob } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    res.status(201).json(db.addPatient({ name, mobile, mrn, gender, dob }));
  });

  app.get("/api/reservations", (req, res) => {
    const patients = db.getPatients();
    const rows = db.getReservations().map((r) => ({ ...r, patient: patients.find((p) => p.id === r.patientId) || null }));
    res.json(rows);
  });

  app.post("/api/reservations", (req, res) => {
    const { patientId, type, date, status } = req.body || {};
    if (!patientId) return res.status(400).json({ error: "patientId is required" });
    res.status(201).json(db.addReservation({ patientId, type, date, status }));
  });

  app.get("/api/samples", (req, res) => {
    const patients = db.getPatients();
    const rows = db.getSamples().map((s) => ({ ...s, patient: patients.find((p) => p.id === s.patientId) || null }));
    res.json(rows);
  });

  app.post("/api/samples", (req, res) => {
    const { id, patientId, reservationId, branch, collectionDate, receivingDate, status } = req.body || {};
    if (!patientId) return res.status(400).json({ error: "patientId is required" });
    res.status(201).json(db.addSample({ id, patientId, reservationId, branch, collectionDate, receivingDate, status }));
  });

  app.patch("/api/samples/:id/status", (req, res) => {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: "status is required" });
    const updated = db.updateSampleStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: "Sample not found" });
    res.json(updated);
  });

  app.patch("/api/samples/:id/validate", (req, res) => {
    if (!["Admin", "Lab Technician"].includes(req.user.role)) return res.status(403).json({ error: "Requires role: Admin or Lab Technician" });
    const updated = db.validateSample(req.params.id, req.user.name);
    if (!updated) return res.status(404).json({ error: "Sample not found" });
    res.json(updated);
  });

  app.patch("/api/samples/:id/approve", (req, res) => {
    if (req.user.role !== "Admin") return res.status(403).json({ error: "Requires role: Admin" });
    const updated = db.approveSample(req.params.id, req.user.name);
    if (!updated) return res.status(404).json({ error: "Sample not found" });
    res.json(updated);
  });

  app.patch("/api/samples/:id/processing", (req, res) => {
    const { step, value } = req.body || {};
    const updated = db.updateProcessingStep(req.params.id, step, value);
    if (!updated) return res.status(404).json({ error: "Sample or step not found" });
    res.json(updated);
  });

  app.get("/api/pcr", (req, res) => {
    const patients = db.getPatients();
    const rows = db.getPcrTests().map((t) => ({ ...t, patient: patients.find((p) => p.id === t.patientId) || null }));
    res.json(rows);
  });

  app.post("/api/pcr", (req, res) => {
    if (!["Admin", "Lab Technician"].includes(req.user.role)) return res.status(403).json({ error: "Requires role: Admin or Lab Technician" });
    const { sampleId, patientId, target, ctValue, interpretation, kit, runDate } = req.body || {};
    if (!sampleId || !target) return res.status(400).json({ error: "sampleId and target are required" });
    res.status(201).json(db.addPcrTest({ sampleId, patientId, target, ctValue: ctValue ?? null, interpretation: interpretation || "Pending", kit, runDate }));
  });

  app.get("/api/qc", (req, res) => {
    const instruments = db.getInstruments();
    const rows = db.getQcResults().map((r) => ({ ...r, instrumentName: (instruments.find((i) => i.id === r.instrumentId) || {}).name || r.instrumentId }));
    res.json(rows);
  });

  app.post("/api/qc", (req, res) => {
    if (!["Admin", "Lab Technician"].includes(req.user.role)) return res.status(403).json({ error: "Requires role: Admin or Lab Technician" });
    const { instrumentId, qcName, lotName, testName, mean, sd, result } = req.body || {};
    if (!instrumentId || !qcName || !lotName || !testName || mean == null || sd == null || result == null) {
      return res.status(400).json({ error: "instrumentId, qcName, lotName, testName, mean, sd and result are all required" });
    }
    const previous = db.findPreviousQc({ instrumentId, qcName, lotName, testName });
    const verdict = westgard.evaluate({ mean: Number(mean), sd: Number(sd), result: Number(result), previous });
    const record = db.addQcResult({
      instrumentId, qcName, lotName, testName,
      mean: Number(mean), sd: Number(sd), result: Number(result),
      resultTime: new Date().toISOString().slice(0, 19).replace("T", " "),
      westgardRule: verdict.rule, westgardLevel: verdict.level, qcStatus: verdict.status,
    });
    res.status(201).json(record);
  });

  app.patch("/api/qc/:id/exclude", (req, res) => {
    const updated = db.setQcExcluded(req.params.id, req.body?.excluded);
    if (!updated) return res.status(404).json({ error: "QC result not found" });
    res.json(updated);
  });

  app.patch("/api/qc/:id/validate", (req, res) => {
    const updated = db.setQcValidation(req.params.id, "validate", req.user.name);
    if (!updated) return res.status(404).json({ error: "QC result not found" });
    res.json(updated);
  });

  app.patch("/api/qc/:id/approve", (req, res) => {
    if (req.user.role !== "Admin") return res.status(403).json({ error: "Requires role: Admin" });
    const updated = db.setQcValidation(req.params.id, "approve", req.user.name);
    if (!updated) return res.status(404).json({ error: "QC result not found" });
    res.json(updated);
  });

  app.get("/api/storage-units", (req, res) => res.json(db.getStorageUnits()));
  app.post("/api/storage-units", (req, res) => {
    const { name, type, branch } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    res.status(201).json(db.addStorageUnit({ name, type, branch }));
  });

  app.get("/api/racks", (req, res) => {
    const units = db.getStorageUnits();
    res.json(db.getRacks().map((r) => ({ ...r, unitName: (units.find((u) => u.id === r.unitId) || {}).name || r.unitId })));
  });
  app.post("/api/racks", (req, res) => {
    const { unitId, code, capacity } = req.body || {};
    if (!unitId || !code) return res.status(400).json({ error: "unitId and code are required" });
    res.status(201).json(db.addRack({ unitId, code, capacity: capacity ? Number(capacity) : null }));
  });

  app.patch("/api/samples/:id/store", (req, res) => {
    const { rackId, position } = req.body || {};
    if (!rackId || !position) return res.status(400).json({ error: "rackId and position are required" });
    const updated = db.storeSample(req.params.id, rackId, position);
    if (!updated) return res.status(404).json({ error: "Sample not found" });
    res.json(updated);
  });

  app.patch("/api/samples/:id/dispose", (req, res) => {
    const updated = db.disposeSample(req.params.id);
    if (!updated) return res.status(404).json({ error: "Sample not found" });
    res.json(updated);
  });

  app.get("/api/suppliers", (req, res) => res.json(db.getSuppliers()));
  app.post("/api/suppliers", (req, res) => {
    const { name, contact } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    res.status(201).json(db.addSupplier({ name, contact }));
  });

  app.get("/api/inventory", (req, res) => res.json(db.getInventoryItems()));
  app.post("/api/inventory", (req, res) => {
    const { name, category, unit, quantity, reorderLevel, branch } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    res.status(201).json(db.addInventoryItem({ name, category, unit, quantity: Number(quantity) || 0, reorderLevel: Number(reorderLevel) || 0, branch }));
  });

  app.get("/api/purchase-orders", (req, res) => {
    const items = db.getInventoryItems();
    const suppliers = db.getSuppliers();
    const rows = db.getPurchaseOrders().map((o) => ({
      ...o,
      itemName: (items.find((i) => i.id === o.itemId) || {}).name || o.itemId,
      supplierName: (suppliers.find((s) => s.id === o.supplierId) || {}).name || o.supplierId,
    }));
    res.json(rows);
  });
  app.post("/api/purchase-orders", (req, res) => {
    const { itemId, supplierId, quantity } = req.body || {};
    if (!itemId || !quantity) return res.status(400).json({ error: "itemId and quantity are required" });
    res.status(201).json(db.addPurchaseOrder({ itemId, supplierId, quantity: Number(quantity) }));
  });
  app.patch("/api/purchase-orders/:id/receive", (req, res) => {
    const updated = db.receivePurchaseOrder(req.params.id);
    if (!updated) return res.status(404).json({ error: "Order not found or already received" });
    res.json(updated);
  });

  app.get("/api/reports/:type", (req, res) => {
    const type = req.params.type;
    const patients = db.getPatients();
    const samples = db.getSamples();
    const results = db.getResults();
    const pcr = db.getPcrTests();
    const qc = db.getQcResults();
    const racks = db.getRacks();
    const instruments = db.getInstruments();

    if (type === "patient-count") {
      const byGender = {};
      patients.forEach((p) => { byGender[p.gender || "Unknown"] = (byGender[p.gender || "Unknown"] || 0) + 1; });
      return res.json({
        columns: ["Metric", "Value"],
        rows: [["Total patients", patients.length], ...Object.entries(byGender).map(([g, n]) => [`Gender: ${g}`, n])],
      });
    }

    if (type === "patient-details") {
      return res.json({
        columns: ["ID", "Name", "MRN", "Mobile", "Gender", "DOB"],
        rows: patients.map((p) => [p.id, p.name, p.mrn || "—", p.mobile || "—", p.gender || "—", p.dob || "—"]),
      });
    }

    if (type === "services") {
      const counts = {};
      results.forEach((r) => { counts[r.testName] = (counts[r.testName] || 0) + 1; });
      return res.json({
        columns: ["Test Name", "Times Ordered"],
        rows: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => [name, n]),
      });
    }

    if (type === "performance") {
      const byStatus = {};
      samples.forEach((s) => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
      const byInterp = {};
      pcr.forEach((t) => { byInterp[t.interpretation] = (byInterp[t.interpretation] || 0) + 1; });
      return res.json({
        columns: ["Metric", "Value"],
        rows: [
          ["Total samples", samples.length],
          ...Object.entries(byStatus).map(([s, n]) => [`Samples: ${s}`, n]),
          ["Total PCR runs", pcr.length],
          ...Object.entries(byInterp).map(([s, n]) => [`PCR: ${s}`, n]),
        ],
      });
    }

    if (type === "qc") {
      const byAnalyzer = {};
      qc.forEach((r) => {
        const name = (instruments.find((i) => i.id === r.instrumentId) || {}).name || r.instrumentId;
        byAnalyzer[name] = byAnalyzer[name] || { Pass: 0, Warning: 0, Fail: 0 };
        byAnalyzer[name][r.qcStatus] = (byAnalyzer[name][r.qcStatus] || 0) + 1;
      });
      return res.json({
        columns: ["Analyzer", "Pass", "Warning", "Fail"],
        rows: Object.entries(byAnalyzer).map(([name, c]) => [name, c.Pass || 0, c.Warning || 0, c.Fail || 0]),
      });
    }

    if (type === "storage") {
      return res.json({
        columns: ["Rack", "Capacity", "Occupied", "Free"],
        rows: racks.map((r) => {
          const occupied = samples.filter((s) => s.rackId === r.id && !s.disposed).length;
          return [r.code, r.capacity ?? "—", occupied, r.capacity != null ? r.capacity - occupied : "—"];
        }),
      });
    }

    res.status(404).json({ error: "Unknown report type" });
  });

  app.get("/api/staff", (req, res) => res.json(db.getStaff().map(({ passwordHash, ...rest }) => rest)));
  app.post("/api/staff", (req, res) => {
    if (req.user.role !== "Admin") return res.status(403).json({ error: "Admin role required" });
    const { name, role, branch, username, password } = req.body || {};
    if (!name || !role) return res.status(400).json({ error: "name and role are required" });
    if (username && db.findStaffByUsername(username)) return res.status(409).json({ error: "Username already taken" });
    const record = db.addStaff({ name, role, branch, username: username || null, passwordHash: password ? hashPassword(password) : null });
    const { passwordHash, ...safe } = record;
    res.status(201).json(safe);
  });
  app.delete("/api/staff/:id", (req, res) => {
    if (req.user.role !== "Admin") return res.status(403).json({ error: "Admin role required" });
    db.removeStaff(req.params.id);
    res.status(204).end();
  });

  app.get("/api/branches", (req, res) => res.json(db.getBranches()));
  app.post("/api/branches", (req, res) => {
    if (req.user.role !== "Admin") return res.status(403).json({ error: "Admin role required" });
    const { code, name, type } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: "code and name are required" });
    res.status(201).json(db.addBranch({ code, name, type }));
  });
  app.delete("/api/branches/:id", (req, res) => {
    if (req.user.role !== "Admin") return res.status(403).json({ error: "Admin role required" });
    db.removeBranch(req.params.id);
    res.status(204).end();
  });

  app.post("/api/instruments", (req, res) => {
    if (!["Admin", "Lab Technician"].includes(req.user.role)) return res.status(403).json({ error: "Requires role: Admin or Lab Technician" });
    const { name, model, conn, protocol, address } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const record = db.addInstrument({ name, model, conn, protocol, address });
    res.status(201).json(record);
  });

  app.delete("/api/instruments/:id", (req, res) => {
    if (!["Admin", "Lab Technician"].includes(req.user.role)) return res.status(403).json({ error: "Requires role: Admin or Lab Technician" });
    db.removeInstrument(req.params.id);
    res.status(204).end();
  });

  // Live-checks a connection. TCP/IP instruments get a real socket probe against
  // host:port. Serial (COM-port) instruments can't be reached from a web server —
  // that link only exists on the lab PC running qrlis-hl7-listener.exe — so we
  // return an explanatory message instead of a false "connected".
  app.post("/api/instruments/:id/test", (req, res) => {
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

  // Called by the HL7 listener (see hl7-listener/listener.js -> forwardToQrLis) whenever a
  // real (or test) instrument message arrives.
  app.post("/api/hl7-results", (req, res) => {
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
