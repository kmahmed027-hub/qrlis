/**
 * QR LIS — roles and the app modules each role is allowed to see/use.
 * A "module" here is a nav section: dashboard, booking, patient360,
 * reservations, samples, pcr, processing, admin (Administration), connection.
 * "admin" also gates Staff, Branches and User Accounts management.
 *
 * To add a role: add it here with its module list, then it appears
 * automatically in the "Role" dropdown when creating a login account.
 */
const ROLE_PERMISSIONS = {
  Admin: ["dashboard", "booking", "patient360", "reservations", "samples", "pcr", "processing", "warehouse", "qc", "reporting", "admin", "connection"],
  Receptionist: ["dashboard", "booking", "patient360", "reservations", "samples", "connection"],
  "Lab Technician": ["dashboard", "patient360", "samples", "processing", "pcr", "warehouse", "qc", "connection"],
  Pathologist: ["dashboard", "patient360", "reservations", "samples", "pcr", "qc", "reporting", "connection"],
};

const ROLES = Object.keys(ROLE_PERMISSIONS);

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

module.exports = { ROLE_PERMISSIONS, ROLES, permissionsForRole };
