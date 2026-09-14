/**
 * Westgard multirule QC evaluation — the standard rule set labs use to decide
 * whether a QC run is in control. Real math, not a canned status: each new
 * result is scored against the lot's mean/SD, and (where relevant) against
 * the previous result for the same analyzer+QC+lot+test, exactly like a real
 * L-J chart review would.
 *
 * Rules implemented:
 *   1_3s  — single result beyond ±3 SD              → REJECT (hard fail)
 *   2_2s  — this and the previous result both beyond ±2 SD, same side → REJECT
 *   R_4s  — this and the previous result are >4 SD apart (opposite sides)  → REJECT
 *   1_2s  — single result beyond ±2 SD (no 2nd rule triggered)            → WARNING
 *   none of the above                                                    → PASS
 */
function evaluate({ mean, sd, result, previous }) {
  if (!sd || sd === 0) return { z: null, rule: null, level: null, status: "Pass" };
  const z = (result - mean) / sd;
  const level = `${z >= 0 ? "+" : "-"}${Math.min(Math.abs(z), 3.99).toFixed(1)}SD`;

  if (Math.abs(z) > 3) return { z, rule: "1_3s", level: "+3SD".replace("+", z >= 0 ? "+" : "-"), status: "Fail" };

  if (previous && previous.sd) {
    const zPrev = (previous.result - previous.mean) / previous.sd;
    if (Math.abs(z) > 2 && Math.abs(zPrev) > 2 && Math.sign(z) === Math.sign(zPrev)) {
      return { z, rule: "2_2s", level, status: "Fail" };
    }
    if (Math.abs(z) > 2 && Math.abs(zPrev) > 2 && Math.sign(z) !== Math.sign(zPrev) && Math.abs(z - zPrev) > 4) {
      return { z, rule: "R_4s", level, status: "Fail" };
    }
  }

  if (Math.abs(z) > 2) return { z, rule: "1_2s", level, status: "Warning" };

  return { z, rule: null, level, status: "Pass" };
}

module.exports = { evaluate };
