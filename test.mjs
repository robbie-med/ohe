// node test.mjs
// Covers the one piece of real logic: turning whatever the model actually
// emits into a shape the renderer can't crash on.
import assert from "node:assert/strict";
import { parseScript } from "./src/index.js";

const answer = {
  bottom_line: "Likely fluid overload — stop IV fluids and diurese.",
  because: "800 mL/day (0.47 mL/kg/hr) on ongoing NS with no diuretic, Cr rising.",
  do_now: [
    { action: "Stop all IV fluids", detail: "" },
    { action: "Furosemide 80-100 mg IV bolus", detail: "higher dose needed at CrCl 17; monitor 2h and 6h UOP" },
  ],
  avoid: [{ what: "RRT", why: "not indicated yet — K 4.7, bicarb improving, still making urine" }],
  unresolved: ["Charted vs delivered NS volume not reconciled."],
};
const body = JSON.stringify(answer);

// Bare JSON, fenced, fenced with preamble, and trailing chatter all land the same.
for (const [name, raw] of [
  ["bare", body],
  ["fenced", "```json\n" + body + "\n```"],
  ["preamble", "Here is the answer:\n\n```json\n" + body + "\n```"],
  ["trailing", body + "\n\nLet me know if you'd like more detail."],
]) {
  const out = parseScript(raw);
  assert.equal(out.bottom_line, answer.bottom_line, name);
  // Doses must survive the round trip character for character.
  assert.equal(out.do_now[1].action, "Furosemide 80-100 mg IV bolus", `${name}: dose verbatim`);
  assert.equal(out.avoid[0].what, "RRT", `${name}: avoid preserved`);
}

// Missing sections become empty arrays, never undefined — the renderer reads
// .length on all three without guarding.
const sparse = parseScript('{"bottom_line":"x"}');
for (const k of ["do_now", "avoid", "unresolved"]) {
  assert.deepEqual(sparse[k], [], `${k} defaults to []`);
}
assert.equal(sparse.because, "", "because defaults to empty string");

// Wrong types must not reach the renderer as-is.
const wrong = parseScript('{"bottom_line":42,"do_now":"not an array"}');
assert.equal(wrong.bottom_line, "");
assert.deepEqual(wrong.do_now, []);

// No JSON at all is an error, not a silently empty answer — an empty answer
// would render as "nothing to do", which is a clinical lie.
assert.throws(() => parseScript("I cannot help with that."), /did not return JSON/);

console.log("ok");
