/**
 * QR LIS — tiny local "database" (JSON file on disk, no native modules).
 * Lives in the app's userData folder so it survives updates and works from
 * an installed (possibly read-only) Program Files directory.
 */

const fs = require("fs");
const path = require("path");
const { hashPassword } = require("./auth");

const SEED = {
  instruments: [
    { id: "dxi", name: "DxI", model: "DxI", conn: "serial", protocol: "im", address: "COM3" },
    { id: "dxc700", name: "DxC 700 AU", model: "DxC700", conn: "tcp", protocol: "im", address: "192.168.1.51:5100" },
    { id: "dxh", name: "DxH", model: "DxH", conn: "serial", protocol: "im", address: "COM4" },
    { id: "d10h", name: "D-10", model: "D-10", conn: "serial", protocol: "astm", address: "COM5" },
  ],
  patients: [
    { id: "p1", name: "Fahad Al-Qahtani", mobile: "0501234567", mrn: "MRN-88213", gender: "M", dob: "1988-03-14" },
    { id: "p2", name: "Noura Al-Shehri", mobile: "0559876543", mrn: "MRN-77410", gender: "F", dob: "1995-11-02" },
  ],
  reservations: [
    { id: "res1", patientId: "p1", status: "Completed", type: "Walk-in", date: "2026-09-07" },
    { id: "res2", patientId: "p2", status: "Completed", type: "Home Collection", date: "2026-09-07" },
  ],
  samples: [
    { id: "5147822", patientId: "p1", reservationId: "res1", status: "Processing", collectionDate: "2026-09-07 11:20", receivingDate: "2026-09-07 11:35", branch: "CC059 Suways, Jazan", centrifuged: true, aliquoted: false, loaded: false, rackId: null, position: null, disposed: false, disposalDate: null },
    { id: "5146769", patientId: "p2", reservationId: "res2", status: "Validated", collectionDate: "2026-09-07 18:10", receivingDate: "2026-09-07 18:25", branch: "LB012 Raqi, Khamis Mushait", centrifuged: true, aliquoted: true, loaded: true, rackId: "rk2", position: "B1", disposed: false, disposalDate: null },
  ],
  pcrTests: [
    { id: "pcr1", sampleId: "5147822", patientId: "p1", target: "SARS-CoV-2 (N gene)", ctValue: 29.4, interpretation: "Positive", runDate: "2026-09-07 14:10", kit: "TaqPath COVID-19" },
  ],
  qcResults: [],
  staff: [
    { id: "u1", name: "Khalid Mohammad", role: "Admin", branch: "LB010 Suways, Jazan", active: true, username: "khalid", passwordHash: hashPassword("admin123") },
    { id: "u2", name: "Sara Al-Amri", role: "Lab Technician", branch: "LB012 Raqi, Khamis Mushait", active: true, username: "sara", passwordHash: hashPassword("tech123") },
  ],
  branches: [
    { id: "b1", code: "LB010", name: "Suways, Jazan", type: "Collection Center" },
    { id: "b2", code: "LB012", name: "Raqi, Khamis Mushait", type: "Main Lab" },
  ],
  storageUnits: [
    { id: "su1", name: "Freezer A", type: "Freezer -20°C", branch: "LB010 Suways, Jazan" },
    { id: "su2", name: "Fridge B", type: "Fridge 2-8°C", branch: "LB012 Raqi, Khamis Mushait" },
  ],
  racks: [
    { id: "rk1", unitId: "su1", code: "A-R1", capacity: 25 },
    { id: "rk2", unitId: "su2", code: "B-R1", capacity: 25 },
  ],
  suppliers: [
    { id: "sp1", name: "MedSupply KSA", contact: "0112223333" },
  ],
  inventoryItems: [
    { id: "it1", name: "Zinc QC1 Lot 1783UN", category: "QC Material", unit: "vial", quantity: 8, reorderLevel: 5, branch: "LB010 Suways, Jazan" },
    { id: "it2", name: "TaqPath COVID-19 Kit", category: "PCR Reagent", unit: "kit", quantity: 3, reorderLevel: 5, branch: "LB012 Raqi, Khamis Mushait" },
  ],
  purchaseOrders: [],
  results: [
    { id: "r1", sampleId: "5147822", testId: "4640167245", testName: "Globulin, Serum", result: null, unit: "g/L", min: 20, max: 35, expected: "2026-09-07 11:55", instrumentId: "dxc700", branch: "CC059 Suways, Jazan", live: true },
    { id: "r2", sampleId: "5147822", testId: "4640167246", testName: "Calcium - Ionized, Serum", result: null, unit: "mmol/L", min: 1.05, max: 1.3, expected: "2026-09-07 11:55", instrumentId: "dxc700", branch: "CC059 Suways, Jazan", live: true },
    { id: "r3", sampleId: "5147822", testId: "4640167247", testName: "Albumin / Globulin Ratio, Serum", result: null, unit: "-", min: 1.1, max: 2.6, expected: "2026-09-07 11:55", instrumentId: null, branch: "CC059 Suways, Jazan", live: false },
    { id: "r4", sampleId: "5146769", testId: "0038248261", testName: "TSH", result: null, unit: "mIU/L", min: 0.4, max: 4.0, expected: "2026-09-07 18:43", instrumentId: "dxi", branch: "LB012 Raqi, Khamis Mushait", live: true },
    { id: "r5", sampleId: "5146769", testId: "0038248262", testName: "WBC", result: null, unit: "x10\u00b3/\u00b5L", min: 4.0, max: 11.0, expected: "2026-09-07 18:43", instrumentId: "dxh", branch: "LB012 Raqi, Khamis Mushait", live: true },
    { id: "r6", sampleId: "5146769", testId: "0038248263", testName: "HbA1c", result: null, unit: "%", min: 4.0, max: 5.6, expected: "2026-09-07 18:43", instrumentId: "d10h", branch: "LB012 Raqi, Khamis Mushait", live: true },
  ],
};

/**
 * DataStore holds every read/write method the app uses. It only ever touches
 * `this.data` (a plain object shaped like SEED) and calls `this._save()`
 * after a mutation — so JsonDb and PgDb below share 100% of this logic and
 * only differ in *where* `this.data` is persisted.
 */
class DataStore {
  getInstruments() {
    return this.data.instruments;
  }

  addInstrument(inst) {
    const record = { id: "inst_" + Date.now(), ...inst };
    this.data.instruments.push(record);
    this._save();
    return record;
  }

  removeInstrument(id) {
    this.data.instruments = this.data.instruments.filter((i) => i.id !== id);
    this._save();
  }

  getResults() {
    return this.data.results;
  }

  getPatients() {
    return this.data.patients || [];
  }

  addPatient(p) {
    const record = { id: "p_" + Date.now(), ...p };
    this.data.patients.push(record);
    this._save();
    return record;
  }

  addReservation(r) {
    const record = { id: "res_" + Date.now(), status: "Pending", ...r };
    this.data.reservations.push(record);
    this._save();
    return record;
  }

  addSample(s) {
    const record = { centrifuged: false, aliquoted: false, loaded: false, rackId: null, position: null, disposed: false, disposalDate: null, validatedBy: null, validatedAt: null, approvedBy: null, approvedAt: null, ...s, id: s.id || String(Date.now()), status: s.status || "Received" };
    this.data.samples.push(record);
    this._save();
    return record;
  }

  updateSampleStatus(id, status) {
    const sample = this.data.samples.find((s) => s.id === id);
    if (!sample) return null;
    sample.status = status;
    this._save();
    return sample;
  }

  validateSample(id, byName) {
    const sample = this.data.samples.find((s) => s.id === id);
    if (!sample) return null;
    sample.status = "Validated";
    sample.validatedBy = byName;
    sample.validatedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    this._save();
    return sample;
  }

  approveSample(id, byName) {
    const sample = this.data.samples.find((s) => s.id === id);
    if (!sample) return null;
    sample.status = "Reported";
    sample.approvedBy = byName;
    sample.approvedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    this._save();
    return sample;
  }

  updateProcessingStep(id, step, value) {
    const sample = this.data.samples.find((s) => s.id === id);
    if (!sample || !["centrifuged", "aliquoted", "loaded"].includes(step)) return null;
    sample[step] = !!value;
    this._save();
    return sample;
  }

  getPcrTests() {
    return this.data.pcrTests || [];
  }

  addPcrTest(t) {
    const record = { id: "pcr_" + Date.now(), ...t };
    this.data.pcrTests.push(record);
    this._save();
    return record;
  }

  getQcResults() {
    return this.data.qcResults || [];
  }

  /** Finds the most recent prior QC entry for the same analyzer+qcName+lot+test. */
  findPreviousQc({ instrumentId, qcName, lotName, testName }) {
    const matches = (this.data.qcResults || []).filter(
      (r) => r.instrumentId === instrumentId && r.qcName === qcName && r.lotName === lotName && r.testName === testName
    );
    return matches.length ? matches[matches.length - 1] : null;
  }

  addQcResult(record) {
    const full = { id: "qc_" + Date.now(), isExcluded: false, validateBy: null, validateAt: null, approveBy: null, approveAt: null, ...record };
    this.data.qcResults.push(full);
    this._save();
    return full;
  }

  setQcExcluded(id, excluded) {
    const r = (this.data.qcResults || []).find((x) => x.id === id);
    if (!r) return null;
    r.isExcluded = !!excluded;
    this._save();
    return r;
  }

  setQcValidation(id, field, byName) {
    const r = (this.data.qcResults || []).find((x) => x.id === id);
    if (!r) return null;
    r[field + "By"] = byName;
    r[field + "At"] = new Date().toISOString().slice(0, 19).replace("T", " ");
    this._save();
    return r;
  }

  getStaff() {
    return this.data.staff || [];
  }

  findStaffByUsername(username) {
    if (!username) return null;
    return (this.data.staff || []).find((u) => u.username && u.username.toLowerCase() === username.toLowerCase()) || null;
  }

  addStaff(u) {
    const record = { id: "u_" + Date.now(), active: true, username: null, passwordHash: null, ...u };
    this.data.staff.push(record);
    this._save();
    return record;
  }

  removeStaff(id) {
    this.data.staff = this.data.staff.filter((u) => u.id !== id);
    this._save();
  }

  getBranches() {
    return this.data.branches || [];
  }

  addBranch(b) {
    const record = { id: "b_" + Date.now(), ...b };
    this.data.branches.push(record);
    this._save();
    return record;
  }

  removeBranch(id) {
    this.data.branches = this.data.branches.filter((b) => b.id !== id);
    this._save();
  }

  getReservations() {
    return this.data.reservations || [];
  }

  getSamples() {
    return this.data.samples || [];
  }

  /** Full Patient-360 style search across patients/reservations/samples/results, joined. */
  search360({ patientQuery, sampleId, sampleStatus } = {}) {
    let samples = this.getSamples();
    if (sampleId) samples = samples.filter((s) => s.id.includes(sampleId));
    if (sampleStatus) samples = samples.filter((s) => s.status === sampleStatus);
    const patients = this.getPatients();
    const reservations = this.getReservations();
    if (patientQuery) {
      const q = patientQuery.toLowerCase();
      const matchingPatientIds = new Set(
        patients.filter((p) => [p.name, p.mobile, p.mrn, p.id].some((v) => String(v).toLowerCase().includes(q))).map((p) => p.id)
      );
      samples = samples.filter((s) => matchingPatientIds.has(s.patientId));
    }
    return samples.map((s) => {
      const patient = patients.find((p) => p.id === s.patientId) || null;
      const reservation = reservations.find((r) => r.id === s.reservationId) || null;
      const tests = this.data.results.filter((r) => r.sampleId === s.id);
      return { sample: s, patient, reservation, tests };
    });
  }

  dashboardStats() {
    const samples = this.getSamples();
    const results = this.data.results;
    const byStatus = {};
    for (const s of samples) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    const pendingResults = results.filter((r) => r.result === null || r.result === undefined).length;
    const liveInstruments = new Set(results.filter((r) => r.live).map((r) => r.instrumentId)).size;
    return {
      totalPatients: this.getPatients().length,
      totalSamples: samples.length,
      totalReservations: this.getReservations().length,
      pendingResults,
      liveInstruments,
      totalInstruments: this.getInstruments().length,
      samplesByStatus: byStatus,
    };
  }

  /** Upsert a result coming from the HL7 listener. Matches on sampleId + testId. */
  upsertResultFromHl7({ sampleId, testId, testName, result, unit, referenceRange, instrumentId, sendingSystem }) {
    let min = null, max = null;
    if (referenceRange && referenceRange.includes("-")) {
      const [lo, hi] = referenceRange.split("-").map((n) => parseFloat(n));
      if (!Number.isNaN(lo)) min = lo;
      if (!Number.isNaN(hi)) max = hi;
    }
    const existing = this.data.results.find((r) => r.sampleId === sampleId && r.testId === testId);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace("T", " ");
    if (existing) {
      existing.result = result;
      existing.unit = unit || existing.unit;
      if (min !== null) existing.min = min;
      if (max !== null) existing.max = max;
      existing.live = true;
      existing.instrumentId = instrumentId || existing.instrumentId;
      existing.receivedAt = stamp;
    } else {
      this.data.results.unshift({
        id: "r_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
        sampleId,
        testId: testId || sendingSystem + "-" + Date.now(),
        testName: testName || testId || "Unknown test",
        result,
        unit: unit || "",
        min,
        max,
        expected: stamp,
        instrumentId: instrumentId || null,
        branch: "Auto (HL7 feed)",
        live: true,
        receivedAt: stamp,
      });
    }
    this._save();
  }

  getStorageUnits() {
    return this.data.storageUnits || [];
  }

  addStorageUnit(u) {
    const record = { id: "su_" + Date.now(), ...u };
    this.data.storageUnits.push(record);
    this._save();
    return record;
  }

  getRacks() {
    return this.data.racks || [];
  }

  addRack(r) {
    const record = { id: "rk_" + Date.now(), ...r };
    this.data.racks.push(record);
    this._save();
    return record;
  }

  storeSample(id, rackId, position) {
    const sample = this.data.samples.find((s) => s.id === id);
    if (!sample) return null;
    sample.rackId = rackId;
    sample.position = position;
    this._save();
    return sample;
  }

  disposeSample(id) {
    const sample = this.data.samples.find((s) => s.id === id);
    if (!sample) return null;
    sample.disposed = true;
    sample.disposalDate = new Date().toISOString().slice(0, 19).replace("T", " ");
    sample.rackId = null;
    sample.position = null;
    this._save();
    return sample;
  }

  getSuppliers() {
    return this.data.suppliers || [];
  }

  addSupplier(s) {
    const record = { id: "sp_" + Date.now(), ...s };
    this.data.suppliers.push(record);
    this._save();
    return record;
  }

  getInventoryItems() {
    return this.data.inventoryItems || [];
  }

  addInventoryItem(i) {
    const record = { id: "it_" + Date.now(), quantity: 0, ...i };
    this.data.inventoryItems.push(record);
    this._save();
    return record;
  }

  getPurchaseOrders() {
    return this.data.purchaseOrders || [];
  }

  addPurchaseOrder(o) {
    const record = { id: "po_" + Date.now(), status: "Pending", orderDate: new Date().toISOString().slice(0, 10), ...o };
    this.data.purchaseOrders.push(record);
    this._save();
    return record;
  }

  receivePurchaseOrder(id) {
    const order = (this.data.purchaseOrders || []).find((o) => o.id === id);
    if (!order || order.status === "Received") return null;
    order.status = "Received";
    order.receivedDate = new Date().toISOString().slice(0, 10);
    const item = (this.data.inventoryItems || []).find((i) => i.id === order.itemId);
    if (item) item.quantity += Number(order.quantity) || 0;
    this._save();
    return order;
  }
}

/** Original storage: a JSON file on disk. Used when no DATABASE_URL is set (local/dev use). */
class JsonDb extends DataStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(SEED, null, 2));
    }
    this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

/**
 * Real persistent storage: a single JSONB row in Postgres. Used when
 * DATABASE_URL is set. Keeps the exact same in-memory shape/behavior as
 * JsonDb (same SEED, same methods) — just durable across restarts/deploys,
 * unlike a Render free-tier disk which can be wiped.
 */
class PgDb extends DataStore {
  constructor(pool) {
    super();
    this.pool = pool;
    this.data = null;
  }

  static async create(connectionString) {
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString,
      // Render (and most managed Postgres hosts) require SSL but use a
      // certificate chain `pg` won't validate by default — this is the
      // standard, documented way to connect to them from Node.
      ssl: { rejectUnauthorized: false },
    });

    await pool.query(`CREATE TABLE IF NOT EXISTS qrlis_store (id INT PRIMARY KEY, data JSONB NOT NULL)`);

    const { rows } = await pool.query("SELECT data FROM qrlis_store WHERE id = 1");
    const db = new PgDb(pool);
    if (rows.length === 0) {
      db.data = SEED;
      await pool.query("INSERT INTO qrlis_store (id, data) VALUES (1, $1::jsonb)", [JSON.stringify(SEED)]);
      console.log("QR LIS: Postgres table was empty — seeded with starter data.");
    } else {
      db.data = rows[0].data;
    }
    return db;
  }

  _save() {
    // Fire-and-forget, matching JsonDb's synchronous-but-uncoordinated writes.
    // Fine for this app's scale (single lab, low write concurrency); log
    // failures instead of throwing so a slow network blip doesn't crash a request.
    this.pool
      .query("UPDATE qrlis_store SET data = $1::jsonb WHERE id = 1", [JSON.stringify(this.data)])
      .catch((err) => console.error("QR LIS: Postgres save failed:", err.message));
  }
}

module.exports = { JsonDb, PgDb, SEED };
