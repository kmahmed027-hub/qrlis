/**
 * QR LIS — tiny local "database" (JSON file on disk, no native modules).
 * Lives in the app's userData folder so it survives updates and works from
 * an installed (possibly read-only) Program Files directory.
 */

const fs = require("fs");
const path = require("path");
const { hashPassword, verifyPassword } = require("./auth");
const { permissionsForRole } = require("./roles");

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
    { id: "5147822", patientId: "p1", reservationId: "res1", status: "Processing", collectionDate: "2026-09-07 11:20", receivingDate: "2026-09-07 11:35", branch: "CC059 Suways, Jazan", centrifuged: true, aliquoted: false, loaded: false },
    { id: "5146769", patientId: "p2", reservationId: "res2", status: "Validated", collectionDate: "2026-09-07 18:10", receivingDate: "2026-09-07 18:25", branch: "LB012 Raqi, Khamis Mushait", centrifuged: true, aliquoted: true, loaded: true },
  ],
  pcrTests: [
    { id: "pcr1", sampleId: "5147822", patientId: "p1", target: "SARS-CoV-2 (N gene)", ctValue: 29.4, interpretation: "Positive", runDate: "2026-09-07 14:10", kit: "TaqPath COVID-19" },
  ],
  staff: [
    { id: "u1", name: "Khalid Mohammad", role: "Admin", branch: "LB010 Suways, Jazan", active: true },
    { id: "u2", name: "Sara Al-Amri", role: "Lab Technician", branch: "LB012 Raqi, Khamis Mushait", active: true },
  ],
  branches: [
    { id: "b1", code: "LB010", name: "Suways, Jazan", type: "Collection Center" },
    { id: "b2", code: "LB012", name: "Raqi, Khamis Mushait", type: "Main Lab" },
  ],
  // Login accounts (separate from `staff`, which is just the directory of
  // people/branches — this is what actually controls sign-in and permissions).
  // Populated by JsonDb's constructor on first run, not hardcoded here, because
  // the initial admin password should come from QRLIS_USER/QRLIS_PASS if set.
  users: [],
  // Test/Service catalog with pricing — the base that Booking, the Samples
  // Report and (eventually) invoicing all pull test names/prices from,
  // instead of everyone typing free-text test names by hand.
  catalog: [
    { id: "c1", code: "34663", name: "Gentamicin - Trough", kind: "Test", price: 216 },
    { id: "c2", code: "34662", name: "Gentamicin - Peak", kind: "Test", price: 216 },
    { id: "c3", code: "34661", name: "Amikacin - Trough", kind: "Test", price: 186 },
    { id: "c4", code: "34660", name: "Amikacin - Peak", kind: "Test", price: 186 },
    { id: "c5", code: "34628", name: "Immunohistochemistry: Lysozyme", kind: "Test", price: 456 },
    { id: "c6", code: "34515", name: "NBS Card: 200 Cards", kind: "Service", price: 1200 },
    { id: "c7", code: "34503", name: "Gram Stain, Nugent Score", kind: "Test", price: 24 },
    { id: "c8", code: "34480", name: "Acylcarnitine structure, Serum", kind: "Test", price: 786 },
    { id: "c9", code: "0038248261", name: "TSH", kind: "Test", price: 45 },
    { id: "c10", code: "0038248262", name: "WBC", kind: "Test", price: 20 },
    { id: "c11", code: "0038248263", name: "HbA1c", kind: "Test", price: 60 },
  ],
  results: [
    { id: "r1", sampleId: "5147822", testId: "4640167245", testName: "Globulin, Serum", result: null, unit: "g/L", min: 20, max: 35, expected: "2026-09-07 11:55", instrumentId: "dxc700", branch: "CC059 Suways, Jazan", live: true, testStatus: "Sample Collected", isOnHold: false, registeredAt: "2026-09-07 11:20", collectedAt: "2026-09-07 11:20", receivedAt: "2026-09-07 11:35" },
    { id: "r2", sampleId: "5147822", testId: "4640167246", testName: "Calcium - Ionized, Serum", result: null, unit: "mmol/L", min: 1.05, max: 1.3, expected: "2026-09-07 11:55", instrumentId: "dxc700", branch: "CC059 Suways, Jazan", live: true, testStatus: "Sample Collected", isOnHold: false, registeredAt: "2026-09-07 11:20", collectedAt: "2026-09-07 11:20", receivedAt: "2026-09-07 11:35" },
    { id: "r3", sampleId: "5147822", testId: "4640167247", testName: "Albumin / Globulin Ratio, Serum", result: null, unit: "-", min: 1.1, max: 2.6, expected: "2026-09-07 11:55", instrumentId: null, branch: "CC059 Suways, Jazan", live: false, testStatus: "Pending", isOnHold: false, registeredAt: "2026-09-07 11:20", collectedAt: "2026-09-07 11:20", receivedAt: null },
    { id: "r4", sampleId: "5146769", testId: "0038248261", testName: "TSH", result: null, unit: "mIU/L", min: 0.4, max: 4.0, expected: "2026-09-07 18:43", instrumentId: "dxi", branch: "LB012 Raqi, Khamis Mushait", live: true, testStatus: "Ready", isOnHold: false, registeredAt: "2026-09-07 18:10", collectedAt: "2026-09-07 18:10", receivedAt: "2026-09-07 18:25" },
    { id: "r5", sampleId: "5146769", testId: "0038248262", testName: "WBC", result: null, unit: "x10\u00b3/\u00b5L", min: 4.0, max: 11.0, expected: "2026-09-07 18:43", instrumentId: "dxh", branch: "LB012 Raqi, Khamis Mushait", live: true, testStatus: "Ready", isOnHold: false, registeredAt: "2026-09-07 18:10", collectedAt: "2026-09-07 18:10", receivedAt: "2026-09-07 18:25" },
    { id: "r6", sampleId: "5146769", testId: "0038248263", testName: "HbA1c", result: null, unit: "%", min: 4.0, max: 5.6, expected: "2026-09-07 18:43", instrumentId: "d10h", branch: "LB012 Raqi, Khamis Mushait", live: true, testStatus: "Order Confirmed", isOnHold: false, registeredAt: "2026-09-07 18:10", collectedAt: "2026-09-07 18:10", receivedAt: "2026-09-07 18:25" },
  ],
};

const TEST_STATUSES = ["Order Confirmed", "Sample Collected", "Pending", "Ready", "On Hold", "Cancelled"];

/**
 * DataStore holds every read/write method the app uses. It only ever touches
 * `this.data` (a plain object shaped like SEED) and calls `this._save()`
 * after a mutation — so JsonDb and PgDb below share 100% of this logic and
 * only differ in *where* `this.data` is persisted.
 */
class DataStore {
  /** First run only: turns the old shared QRLIS_USER/QRLIS_PASS into the first real login account. */
  _bootstrapAdmin() {
    if (!this.data.users) this.data.users = [];
    if (this.data.users.length > 0) return;
    const username = process.env.QRLIS_USER || "admin";
    const password = process.env.QRLIS_PASS || "changeme123";
    const { salt, hash } = hashPassword(password);
    this.data.users.push({
      id: "usr_" + Date.now(),
      username,
      passwordSalt: salt,
      passwordHash: hash,
      name: "Administrator",
      role: "Admin",
      staffId: null,
      active: true,
      createdAt: new Date().toISOString(),
    });
    this._save();
    console.log(`QR LIS: created initial admin login "${username}" from QRLIS_USER/QRLIS_PASS (or the defaults). Log in with it once, then create a named account per person from Administration \u2192 User Accounts and retire this shared one.`);
  }

  _load() {
    // Overridden per subclass (JsonDb reads a file; PgDb reads a Postgres row).
  }

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
    const record = { centrifuged: false, aliquoted: false, loaded: false, ...s, id: s.id || String(Date.now()), status: s.status || "Received" };
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

  getStaff() {
    return this.data.staff || [];
  }

  addStaff(u) {
    const record = { id: "u_" + Date.now(), active: true, ...u };
    this.data.staff.push(record);
    this._save();
    return record;
  }

  removeStaff(id) {
    this.data.staff = this.data.staff.filter((u) => u.id !== id);
    this._save();
  }

  // ---- Login accounts (users) ----
  _safeUser(u) {
    if (!u) return null;
    const { passwordHash, passwordSalt, ...safe } = u;
    return { ...safe, permissions: permissionsForRole(u.role) };
  }

  getUsers() {
    return (this.data.users || []).map((u) => this._safeUser(u));
  }

  getUserSafe(id) {
    return this._safeUser((this.data.users || []).find((u) => u.id === id));
  }

  findUserByUsername(username) {
    return (this.data.users || []).find((u) => u.username.toLowerCase() === String(username || "").toLowerCase());
  }

  addUser({ username, password, name, role, staffId }) {
    if (!this.data.users) this.data.users = [];
    const { salt, hash } = hashPassword(password);
    const record = {
      id: "usr_" + Date.now(),
      username,
      passwordSalt: salt,
      passwordHash: hash,
      name: name || username,
      role,
      staffId: staffId || null,
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(record);
    this._save();
    return this._safeUser(record);
  }

  updateUser(id, patch) {
    const u = (this.data.users || []).find((x) => x.id === id);
    if (!u) return null;
    if (patch.password) {
      const { salt, hash } = hashPassword(patch.password);
      u.passwordSalt = salt;
      u.passwordHash = hash;
    }
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.role !== undefined) u.role = patch.role;
    if (patch.staffId !== undefined) u.staffId = patch.staffId;
    if (patch.active !== undefined) u.active = !!patch.active;
    this._save();
    return this._safeUser(u);
  }

  removeUser(id) {
    this.data.users = (this.data.users || []).filter((u) => u.id !== id);
    this._save();
  }

  verifyCredentials(username, password) {
    const u = this.findUserByUsername(username);
    if (!u || u.active === false) return null;
    if (!verifyPassword(password, u.passwordSalt, u.passwordHash)) return null;
    return this._safeUser(u);
  }

  // ---- Test/Service catalog ----
  getCatalog() {
    return this.data.catalog || [];
  }

  addCatalogItem({ code, name, kind, price }) {
    if (!this.data.catalog) this.data.catalog = [];
    const record = { id: "c_" + Date.now(), code: code || "", name, kind: kind || "Test", price: Number(price) || 0 };
    this.data.catalog.push(record);
    this._save();
    return record;
  }

  updateCatalogItem(id, patch) {
    const item = (this.data.catalog || []).find((c) => c.id === id);
    if (!item) return null;
    if (patch.code !== undefined) item.code = patch.code;
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.kind !== undefined) item.kind = patch.kind;
    if (patch.price !== undefined) item.price = Number(patch.price) || 0;
    this._save();
    return item;
  }

  removeCatalogItem(id) {
    this.data.catalog = (this.data.catalog || []).filter((c) => c.id !== id);
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

  /** Flattened, joined rows for the Samples Report: one row per test, with its
   * sample/patient/reservation attached, optionally filtered. */
  reportRows(filters = {}) {
    const samples = this.getSamples();
    const patients = this.getPatients();
    const reservations = this.getReservations();
    let rows = this.data.results.map((r) => {
      const sample = samples.find((s) => s.id === r.sampleId) || null;
      const patient = sample ? patients.find((p) => p.id === sample.patientId) || null : null;
      const reservation = sample ? reservations.find((res) => res.id === sample.reservationId) || null : null;
      return { ...r, testStatus: r.testStatus || "Pending", isOnHold: !!r.isOnHold, sample, patient, reservation };
    });

    const {
      sampleId, sampleStatus, testStatus, testName, patientQuery,
      branch, reservationStatus, collectionFrom, collectionTo, receivingFrom, receivingTo,
    } = filters;

    if (sampleId) rows = rows.filter((r) => r.sampleId.includes(sampleId));
    if (sampleStatus) rows = rows.filter((r) => r.sample && r.sample.status === sampleStatus);
    if (testStatus) rows = rows.filter((r) => r.testStatus === testStatus);
    if (testName) {
      const q = testName.toLowerCase();
      rows = rows.filter((r) => r.testName.toLowerCase().includes(q));
    }
    if (branch) {
      const q = branch.toLowerCase();
      rows = rows.filter((r) => String(r.branch || "").toLowerCase().includes(q));
    }
    if (reservationStatus) rows = rows.filter((r) => r.reservation && r.reservation.status === reservationStatus);
    if (patientQuery) {
      const q = patientQuery.toLowerCase();
      rows = rows.filter(
        (r) => r.patient && [r.patient.name, r.patient.mobile, r.patient.mrn, r.patient.id].some((v) => String(v || "").toLowerCase().includes(q))
      );
    }
    if (collectionFrom) rows = rows.filter((r) => r.sample && r.sample.collectionDate && r.sample.collectionDate >= collectionFrom);
    if (collectionTo) rows = rows.filter((r) => r.sample && r.sample.collectionDate && r.sample.collectionDate <= collectionTo);
    if (receivingFrom) rows = rows.filter((r) => r.sample && r.sample.receivingDate && r.sample.receivingDate >= receivingFrom);
    if (receivingTo) rows = rows.filter((r) => r.sample && r.sample.receivingDate && r.sample.receivingDate <= receivingTo);

    return rows;
  }

  updateResultFields(id, patch) {
    const r = this.data.results.find((x) => x.id === id);
    if (!r) return null;
    if (patch.testStatus !== undefined) r.testStatus = patch.testStatus;
    if (patch.isOnHold !== undefined) r.isOnHold = !!patch.isOnHold;
    this._save();
    return r;
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
    this._bootstrapAdmin();
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
    db._bootstrapAdmin();
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

module.exports = { JsonDb, PgDb, TEST_STATUSES };
