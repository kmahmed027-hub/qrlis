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
  // Quality Control: each lot defines the expected mean/SD for a test at a given
  // control level; qcRuns are the actual points plotted against it (Levey-Jennings).
  // Generated patient reports — a snapshot taken at generation time (so a report
  // doesn't silently change if someone edits a result afterward), plus its release status.
  reports: [],
  qcLots: [
    { id: "qc1", testName: "TSH", level: "Level 1", lotNumber: "QC-TSH-L1-25A", unit: "mIU/L", mean: 1.2, sd: 0.12, expiryDate: "2026-12-31", instrumentId: "dxi" },
    { id: "qc2", testName: "TSH", level: "Level 2", lotNumber: "QC-TSH-L2-25A", unit: "mIU/L", mean: 8.5, sd: 0.6, expiryDate: "2026-12-31", instrumentId: "dxi" },
    { id: "qc3", testName: "WBC", level: "Level 1", lotNumber: "QC-WBC-L1-25A", unit: "x10\u00b3/\u00b5L", mean: 5.0, sd: 0.3, expiryDate: "2026-11-30", instrumentId: "dxh" },
  ],
  qcRuns: [],
  // Warehouse: reagents/consumables on the shelf, plus every movement in and out
  // so stock levels are derived from a real audit trail rather than typed over.
  inventory: [
    { id: "inv1", code: "RGT-CHEM-01", name: "Chemistry Calibrator Set", category: "Reagent", unit: "kit", quantity: 8, reorderLevel: 3, lotNumber: "L24-8891", expiryDate: "2026-12-31", supplier: "Beckman Coulter", branch: "LB012 Raqi, Khamis Mushait" },
    { id: "inv2", code: "RGT-HBA1C", name: "HbA1c Reagent Cartridge", category: "Reagent", unit: "box", quantity: 2, reorderLevel: 4, lotNumber: "L25-1042", expiryDate: "2026-10-15", supplier: "Bio-Rad", branch: "LB012 Raqi, Khamis Mushait" },
    { id: "inv3", code: "CON-TUBE-EDTA", name: "EDTA Blood Collection Tubes", category: "Consumable", unit: "pack", quantity: 46, reorderLevel: 15, lotNumber: "T-5521", expiryDate: "2027-06-30", supplier: "BD", branch: "CC059 Suways, Jazan" },
    { id: "inv4", code: "KIT-PCR-RESP", name: "Respiratory PCR Panel Kit", category: "Kit", unit: "kit", quantity: 5, reorderLevel: 2, lotNumber: "PCR-9930", expiryDate: "2026-09-30", supplier: "Roche", branch: "LB012 Raqi, Khamis Mushait" },
  ],
  stockMovements: [],
  // Client accounts that bookings are billed to (walk-in cash, corporate credit,
  // insurance) — a booking picks one, and its commission % applies to that contract.
  clients: [
    { id: "cl1", name: "Cash (Walk-in)", accountType: "Cash", commissionPct: 0, active: true },
    { id: "cl2", name: "Al Noor Hospital", accountType: "Credit", commissionPct: 15, active: true },
    { id: "cl3", name: "Bupa Arabia", accountType: "Insurance", commissionPct: 10, active: true },
  ],
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

class JsonDb {
  constructor(filePath) {
    this.filePath = filePath;
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(SEED, null, 2));
    }
    this._load();
    this._bootstrapAdmin();
  }

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
    this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
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
    const record = { id: "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), ...p };
    this.data.patients.push(record);
    this._save();
    return record;
  }

  addReservation(r) {
    const record = { id: "res_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), status: "Pending", ...r };
    this.data.reservations.push(record);
    this._save();
    return record;
  }

  // ---- Client accounts ----
  getClients() {
    return this.data.clients || [];
  }

  addClient({ name, accountType, commissionPct }) {
    if (!this.data.clients) this.data.clients = [];
    const record = {
      id: "cl_" + Date.now(),
      name,
      accountType: accountType || "Cash",
      commissionPct: Number(commissionPct) || 0,
      active: true,
    };
    this.data.clients.push(record);
    this._save();
    return record;
  }

  removeClient(id) {
    this.data.clients = (this.data.clients || []).filter((c) => c.id !== id);
    this._save();
  }

  /** The Contracts-style booking: for each patient in the contract, create the
   * patient, their reservation (billed to a client + booking type), a sample,
   * and one test line per catalog item picked — priced from the catalog. */
  createBooking({ clientId, bookingType, patients }) {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace("T", " ");
    const created = [];

    (patients || []).forEach((p, i) => {
      const patient = this.addPatient({
        name: p.name,
        mobile: p.mobile || "",
        mrn: p.referenceMrn || "",
        dob: p.dob || "",
        gender: p.gender || "",
        nationality: p.nationality || "",
        passportNo: p.passportNo || "",
        identityType: p.identityType || "",
        idNo: p.idNo || "",
        reasonOfTesting: p.reasonOfTesting || "",
        email: p.email || "",
      });

      const reservation = this.addReservation({
        patientId: patient.id,
        type: bookingType || "Normal Booking",
        clientId: clientId || null,
        date: now.toISOString().slice(0, 10),
        status: "Confirmed",
      });

      const sample = this.addSample({
        id: `${Date.now()}${i}${Math.floor(Math.random() * 100)}`,
        patientId: patient.id,
        reservationId: reservation.id,
        branch: p.branch || "Main Lab",
        collectionDate: stamp,
      });

      const tests = (p.testIds || []).map((testId, j) => {
        const item = (this.data.catalog || []).find((c) => c.id === testId);
        const line = {
          id: `r_${Date.now()}_${i}_${j}_${Math.random().toString(36).slice(2, 6)}`,
          sampleId: sample.id,
          testId: item ? item.code : String(testId),
          testName: item ? item.name : "Unknown test",
          result: null,
          unit: "-",
          min: null,
          max: null,
          expected: null,
          instrumentId: null,
          branch: sample.branch,
          live: false,
          testStatus: "Order Confirmed",
          isOnHold: false,
          registeredAt: stamp,
          collectedAt: null,
          receivedAt: null,
          price: item ? item.price : 0,
        };
        this.data.results.push(line);
        return line;
      });

      this._save();
      created.push({ patient, reservation, sample, tests });
    });

    return created;
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

  /** All the Dashboard statistic reports, computed from live data.
   * Each returns { columns, rows, note? } so the UI can render them uniformly. */
  statisticsReports() {
    const samples = this.getSamples();
    const results = this.data.results || [];
    const catalog = this.getCatalog();
    const withValue = results.filter((r) => r.result !== null && r.result !== undefined);
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

    // --- counting helpers ---
    const countBy = (list, keyFn) => {
      const map = new Map();
      list.forEach((item) => {
        const k = keyFn(item) || "—";
        map.set(k, (map.get(k) || 0) + 1);
      });
      return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    };

    // 1. Processing Branch Statistic
    const processingBranch = {
      columns: ["Branch", "Tests", "Share"],
      rows: countBy(results, (r) => r.branch).map(([branch, n]) => [branch, n, `${pct(n, results.length)}%`]),
    };

    // 2. Total Sample Statistic
    const totalSample = {
      columns: ["Sample status", "Samples", "Share"],
      rows: countBy(samples, (s) => s.status).map(([status, n]) => [status, n, `${pct(n, samples.length)}%`]),
    };

    // 3. Results Statistic
    const resultsStat = {
      columns: ["Metric", "Count", "Share"],
      rows: [
        ["Total test lines", results.length, "100%"],
        ["Resulted", withValue.length, `${pct(withValue.length, results.length)}%`],
        ["Still pending", results.length - withValue.length, `${pct(results.length - withValue.length, results.length)}%`],
        ["On hold", results.filter((r) => r.isOnHold).length, `${pct(results.filter((r) => r.isOnHold).length, results.length)}%`],
      ],
    };

    // 4. System / Manual Results Statistic — live = came from an instrument via HL7
    const auto = withValue.filter((r) => r.live).length;
    const manual = withValue.length - auto;
    const systemManual = {
      columns: ["Source", "Results", "Share"],
      rows: [
        ["System (instrument / HL7)", auto, `${pct(auto, withValue.length)}%`],
        ["Manual entry", manual, `${pct(manual, withValue.length)}%`],
      ],
    };

    // 5. TAT Results Statistic — received → resulted, against the expected time
    const tatRows = [];
    let onTime = 0, delayed = 0, unknown = 0;
    withValue.forEach((r) => {
      if (!r.receivedAt || !r.expected) { unknown++; return; }
      if (new Date(r.receivedAt) <= new Date(r.expected)) onTime++; else delayed++;
    });
    tatRows.push(["On time", onTime, `${pct(onTime, withValue.length)}%`]);
    tatRows.push(["Delayed", delayed, `${pct(delayed, withValue.length)}%`]);
    tatRows.push(["No TAT target set", unknown, `${pct(unknown, withValue.length)}%`]);
    const tat = { columns: ["TAT", "Results", "Share"], rows: tatRows };

    // 6. Rejection Rate Statistic
    const cancelled = results.filter((r) => r.testStatus === "Cancelled").length;
    const rejection = {
      columns: ["Metric", "Count", "Rate"],
      rows: [
        ["Cancelled / rejected tests", cancelled, `${pct(cancelled, results.length)}%`],
        ["Accepted tests", results.length - cancelled, `${pct(results.length - cancelled, results.length)}%`],
      ],
    };

    // 7. Critical Results Rate Statistic — resulted values outside the reference range
    const critical = withValue.filter((r) => {
      const v = parseFloat(r.result);
      if (Number.isNaN(v)) return false;
      return (r.min !== null && r.min !== undefined && v < r.min) || (r.max !== null && r.max !== undefined && v > r.max);
    });
    const criticalStat = {
      columns: ["Metric", "Count", "Rate"],
      rows: [
        ["Outside reference range", critical.length, `${pct(critical.length, withValue.length)}%`],
        ["Within range", withValue.length - critical.length, `${pct(withValue.length - critical.length, withValue.length)}%`],
      ],
    };

    // 8. Changed Results Rate Statistic
    const amended = results.filter((r) => (r.amendCount || 0) > 0);
    const changed = {
      columns: ["Metric", "Count", "Rate"],
      rows: [
        ["Amended results", amended.length, `${pct(amended.length, withValue.length)}%`],
        ["Total amendments", amended.reduce((s, r) => s + (r.amendCount || 0), 0), "—"],
      ],
    };

    // 9. QC Results Statistic — now backed by real QC runs
    const qcRuns = this.data.qcRuns || [];
    const qcFail = qcRuns.filter((r) => r.flag.startsWith("Fail")).length;
    const qcWarn = qcRuns.filter((r) => r.flag.startsWith("Warning")).length;
    const qcPass = qcRuns.length - qcFail - qcWarn;
    const qc = qcRuns.length
      ? {
          columns: ["Result", "Count", "Rate"],
          rows: [
            ["Pass", qcPass, `${pct(qcPass, qcRuns.length)}%`],
            ["Warning (1-2s)", qcWarn, `${pct(qcWarn, qcRuns.length)}%`],
            ["Fail (1-3s)", qcFail, `${pct(qcFail, qcRuns.length)}%`],
          ],
        }
      : { columns: ["Metric", "Value"], rows: [], note: "No QC runs recorded yet — log one from the QC tab and this report fills in." };

    // 10. Best Performing Tests Statistic — most ordered, with revenue from the catalog
    const bestTests = {
      columns: ["Test", "Times ordered", "Revenue"],
      rows: countBy(results, (r) => r.testName).slice(0, 15).map(([name, n]) => {
        const item = catalog.find((c) => c.name === name);
        const unitPrice = item ? Number(item.price || 0) : 0;
        return [name, n, `${(unitPrice * n).toLocaleString()} SAR`];
      }),
    };

    return {
      "processing-branch": { title: "Processing Branch Statistic", ...processingBranch },
      "total-sample": { title: "Total Sample Statistic", ...totalSample },
      results: { title: "Results Statistic", ...resultsStat },
      "system-manual": { title: "System / Manual Results Statistic", ...systemManual },
      tat: { title: "TAT Results Statistic", ...tat },
      rejection: { title: "Rejection Rate Statistic", ...rejection },
      critical: { title: "Critical Results Rate Statistic", ...criticalStat },
      changed: { title: "Changed Results Rate Statistic", ...changed },
      qc: { title: "QC Results Statistic", ...qc },
      "best-tests": { title: "Best Performing Tests Statistic", ...bestTests },
    };
  }

  // ---- Quality Control ----
  getQcLots() {
    return this.data.qcLots || [];
  }

  addQcLot(lot) {
    if (!this.data.qcLots) this.data.qcLots = [];
    const record = {
      id: "qc_" + Date.now(),
      testName: lot.testName,
      level: lot.level || "Level 1",
      lotNumber: lot.lotNumber || "",
      unit: lot.unit || "",
      mean: Number(lot.mean) || 0,
      sd: Number(lot.sd) || 0,
      expiryDate: lot.expiryDate || "",
      instrumentId: lot.instrumentId || null,
    };
    this.data.qcLots.push(record);
    this._save();
    return record;
  }

  removeQcLot(id) {
    this.data.qcLots = (this.data.qcLots || []).filter((l) => l.id !== id);
    this.data.qcRuns = (this.data.qcRuns || []).filter((r) => r.lotId !== id);
    this._save();
  }

  /** Westgard-lite: flags a single point by how many SDs it sits from the lot mean.
   * (1-2s = Warning, 1-3s = Fail — the two single-run rules every LIS shows first;
   * multi-run rules like 2-2s/R-4s need the run history and aren't done here.) */
  addQcRun({ lotId, value, comment, userName }) {
    const lot = (this.data.qcLots || []).find((l) => l.id === lotId);
    if (!lot) return null;
    const v = Number(value);
    const z = lot.sd ? (v - lot.mean) / lot.sd : 0;
    const az = Math.abs(z);
    const flag = az >= 3 ? "Fail (1-3s)" : az >= 2 ? "Warning (1-2s)" : "Pass";
    const run = {
      id: "qcr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      lotId,
      testName: lot.testName,
      level: lot.level,
      value: v,
      z: Math.round(z * 100) / 100,
      flag,
      comment: comment || "",
      userName: userName || "—",
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    if (!this.data.qcRuns) this.data.qcRuns = [];
    this.data.qcRuns.unshift(run);
    this._save();
    return run;
  }

  getQcRuns(lotId) {
    const all = this.data.qcRuns || [];
    return lotId ? all.filter((r) => r.lotId === lotId) : all;
  }

  // ---- Warehouse / inventory ----
  /** Items with derived status: OK, Low stock, Out of stock, Expiring soon, Expired. */
  getInventory() {
    const today = new Date();
    const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    return (this.data.inventory || []).map((item) => {
      const expiry = item.expiryDate ? new Date(item.expiryDate) : null;
      const flags = [];
      if (Number(item.quantity) <= 0) flags.push("Out of stock");
      else if (Number(item.quantity) <= Number(item.reorderLevel || 0)) flags.push("Low stock");
      if (expiry && expiry < today) flags.push("Expired");
      else if (expiry && expiry <= in30Days) flags.push("Expiring soon");
      return { ...item, flags, status: flags[0] || "OK" };
    });
  }

  addInventoryItem(item) {
    if (!this.data.inventory) this.data.inventory = [];
    const record = {
      id: "inv_" + Date.now(),
      code: item.code || "",
      name: item.name,
      category: item.category || "Reagent",
      unit: item.unit || "box",
      quantity: Number(item.quantity) || 0,
      reorderLevel: Number(item.reorderLevel) || 0,
      lotNumber: item.lotNumber || "",
      expiryDate: item.expiryDate || "",
      supplier: item.supplier || "",
      branch: item.branch || "",
    };
    this.data.inventory.push(record);
    this._save();
    return record;
  }

  removeInventoryItem(id) {
    this.data.inventory = (this.data.inventory || []).filter((i) => i.id !== id);
    this.data.stockMovements = (this.data.stockMovements || []).filter((m) => m.itemId !== id);
    this._save();
  }

  /** Receive / Issue / Adjust / Waste — the movement is what changes the quantity. */
  recordStockMovement({ itemId, type, qty, reason, userName }) {
    const item = (this.data.inventory || []).find((i) => i.id === itemId);
    if (!item) return null;
    const amount = Number(qty) || 0;
    const delta = type === "Receive" ? amount : type === "Adjust" ? amount - Number(item.quantity) : -amount;
    const newQty = Number(item.quantity) + delta;
    if (newQty < 0) return { error: "That would put the stock below zero." };

    item.quantity = newQty;
    if (!this.data.stockMovements) this.data.stockMovements = [];
    const movement = {
      id: "mv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      itemId,
      itemName: item.name,
      type,
      qty: amount,
      delta,
      balanceAfter: newQty,
      reason: reason || "",
      userName: userName || "—",
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    this.data.stockMovements.unshift(movement);
    this._save();
    return { item, movement };
  }

  getStockMovements(itemId) {
    const all = this.data.stockMovements || [];
    return itemId ? all.filter((m) => m.itemId === itemId) : all.slice(0, 100);
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
      // An instrument re-sending a different value for a test that already had one
      // is an amended result — counted by the "Changed Results Rate" report.
      const hadValue = existing.result !== null && existing.result !== undefined;
      if (hadValue && String(existing.result) !== String(result)) {
        existing.amendCount = (existing.amendCount || 0) + 1;
      }
      existing.result = result;
      existing.unit = unit || existing.unit;
      if (min !== null) existing.min = min;
      if (max !== null) existing.max = max;
      existing.live = true;
      existing.instrumentId = instrumentId || existing.instrumentId;
      existing.receivedAt = stamp;
      if (!existing.testStatus || existing.testStatus === "Pending") existing.testStatus = "Ready";
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

  // ---- Reporting ----
  /** Samples that have at least one resulted test line and no report generated yet
   * (or with newer results than their last report) — what Reporting should show to release. */
  reportableSamples() {
    const rows = this.reportRows();
    const bySample = new Map();
    rows.forEach((r) => {
      if (r.result === null || r.result === undefined) return;
      if (!bySample.has(r.sampleId)) bySample.set(r.sampleId, { sample: r.sample, patient: r.patient, reservation: r.reservation, tests: [] });
      bySample.get(r.sampleId).tests.push(r);
    });
    const lastReportBySample = new Map();
    (this.data.reports || []).forEach((rep) => {
      const prev = lastReportBySample.get(rep.sampleId);
      if (!prev || rep.generatedAt > prev) lastReportBySample.set(rep.sampleId, rep.generatedAt);
    });
    return Array.from(bySample.values()).map((g) => ({ ...g, lastReportAt: lastReportBySample.get(g.sample ? g.sample.id : null) || null }));
  }

  addReport({ sampleId, releasedBy }) {
    const groups = this.reportableSamples();
    const group = groups.find((g) => g.sample && g.sample.id === sampleId);
    if (!group) return null;
    if (!this.data.reports) this.data.reports = [];
    const record = {
      id: "rpt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      sampleId,
      patientId: group.patient ? group.patient.id : null,
      patientName: group.patient ? group.patient.name : "Unknown patient",
      reservationId: group.reservation ? group.reservation.id : null,
      branch: group.sample ? group.sample.branch : "",
      generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
      generatedBy: releasedBy || "—",
      status: "Draft",
      releasedAt: null,
      releasedBy: null,
      // Snapshot the test lines now, so a later edit to `results` doesn't rewrite history.
      tests: group.tests.map((t) => ({
        testName: t.testName, result: t.result, unit: t.unit, min: t.min, max: t.max,
        flag: (t.min !== null && t.min !== undefined && Number(t.result) < t.min) || (t.max !== null && t.max !== undefined && Number(t.result) > t.max) ? "Critical" : "Normal",
      })),
    };
    this.data.reports.push(record);
    this._save();
    return record;
  }

  getReports() {
    return (this.data.reports || []).slice().sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
  }

  releaseReport(id, releasedBy) {
    const r = (this.data.reports || []).find((x) => x.id === id);
    if (!r) return null;
    r.status = "Released";
    r.releasedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
    r.releasedBy = releasedBy || "—";
    this._save();
    return r;
  }
}

module.exports = { JsonDb, TEST_STATUSES };
