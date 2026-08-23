/**
 * gate.js — H-pattern gear gate geometry and constraint.
 *
 * The maths behind a shift lever you drag with a thumb. No DOM, no audio: it
 * maps a pointer position onto a gate and tells you which gear that means, so
 * it can be unit tested in Node instead of only being exercisable by poking a
 * browser. (It was written the other way round first, inline in the page, and
 * a real bug hid in it precisely because it could not be tested cheaply.)
 *
 * Coordinates are a 0..100 square, matching an SVG viewBox. The caller renders;
 * this module only decides.
 *
 *   1   3   5        gears pair up into columns: odd on top, even below,
 *   |   |   |        neutral along the centre channel. A 7-speed puts 7 alone
 *   +---+---+---N    at the top of a fourth column, exactly as a real gate is
 *   |   |   |        drawn. Gear count varies with the chassis (5, 6 or 7).
 *   2   4   6
 *
 * The constraint is the whole point. In the channel the lever moves sideways
 * only; to leave it you must pull into a column, and you are then locked to
 * that column until you come back. That is the path a real H-gate forces your
 * hand along, and it is why you can find a gear without looking at it.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Gate layout constants, in the 0..100 square. */
export const GATE_TOP = 20;
export const GATE_BOT = 80;
export const GATE_MID = 50;
/** Half-height of the neutral channel — also the column capture tolerance. */
export const GATE_CHAN = 9;

/**
 * @param {number} gearCount forward gears, 1..n (no reverse; the sim has none)
 * @returns {{cols:number[], slots:Array<{gear:number,col:number,x:number,y:number}>}}
 */
export function buildGate(gearCount) {
  const n = Math.max(1, Math.round(gearCount) || 1);
  const nCols = Math.ceil(n / 2);
  // Inset so a knob drawn at the slot never overhangs the panel edge.
  const x0 = 20, x1 = 80;
  const cols = nCols === 1
    ? [(x0 + x1) / 2]
    : Array.from({ length: nCols }, (_, i) => x0 + (x1 - x0) * i / (nCols - 1));

  const slots = [];
  for (let g = 1; g <= n; g++) {
    const col = Math.floor((g - 1) / 2);
    slots.push({
      gear: g,
      col,
      x: cols[col],
      y: (g - 1) % 2 === 0 ? GATE_TOP : GATE_BOT,
    });
  }
  return { cols, slots };
}

/** Does this column have a slot on the given side? */
function hasSlot(geom, col, y) {
  return geom.slots.some(s => s.col === col && s.y === y);
}

/**
 * Advance the lever to follow a pointer, honouring the gate.
 *
 * @param {{x:number,y:number,col:number}} knob current lever state; `col` is
 *        the captured column index, or -1 for "in the neutral channel"
 * @param {{x:number,y:number}} p pointer position in gate space
 * @param {object} geom from buildGate()
 * @returns {{x:number,y:number,col:number}} the new lever state
 */
export function moveGate(knob, p, geom) {
  let col = knob.col;

  // Capture FIRST, then position, in one pass.
  //
  // Doing the capture inside the channel branch and returning left the lever at
  // the channel's height for that whole event, only picking up the finger's y
  // on the NEXT move. Drag slowly and you never notice; flick into a gear and
  // release and the lever was still at neutral height, so it selected neutral
  // instead of the gear you had just pulled.
  if (col < 0 && Math.abs(p.y - GATE_MID) > GATE_CHAN) {
    let best = -1, bd = Infinity;
    geom.cols.forEach((cx, i) => {
      const d = Math.abs(p.x - cx);
      if (d < bd) { bd = d; best = i; }
    });
    const wanted = p.y < GATE_MID ? GATE_TOP : GATE_BOT;
    if (bd <= GATE_CHAN * 1.6 && hasSlot(geom, best, wanted)) col = best;
  }

  if (col < 0) {
    // Neutral channel: sideways only.
    return {
      x: clamp(p.x, geom.cols[0], geom.cols[geom.cols.length - 1]),
      y: GATE_MID,
      col: -1,
    };
  }

  // In a column: up and down only, and only as far as that column has slots —
  // a five-speed's last column has no bottom gear to reach.
  const lo = hasSlot(geom, col, GATE_TOP) ? GATE_TOP : GATE_MID;
  const hi = hasSlot(geom, col, GATE_BOT) ? GATE_BOT : GATE_MID;
  const y = clamp(p.y, lo, hi);
  // Returned to the channel: let go of the column so the lever can slide again.
  if (Math.abs(y - GATE_MID) <= GATE_CHAN * 0.55) {
    return { x: clamp(p.x, geom.cols[0], geom.cols[geom.cols.length - 1]), y: GATE_MID, col: -1 };
  }
  return { x: geom.cols[col], y, col };
}

/**
 * Which gear the lever is in if released here. 0 = neutral.
 * A lever hovering half out of the channel has not engaged anything.
 */
export function gateSelection(knob, geom) {
  if (knob.col < 0) return 0;
  const reach = (GATE_BOT - GATE_MID) * 0.55;
  for (const s of geom.slots) {
    if (s.col === knob.col && Math.abs(knob.y - s.y) < reach) return s.gear;
  }
  return 0;
}

/** Resting position of the lever for a given gear. 0 = neutral. */
export function gatePosition(gear, geom) {
  const s = geom.slots.find(x => x.gear === gear);
  if (s) return { x: s.x, y: s.y, col: s.col };
  return { x: (geom.cols[0] + geom.cols[geom.cols.length - 1]) / 2, y: GATE_MID, col: -1 };
}
