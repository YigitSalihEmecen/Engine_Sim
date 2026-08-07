/**
 * world.js — geometry for the night drive.
 *
 * Everything is built as interleaved [pos(3), normal(3), uv(2), color(3)]
 * vertices so a single vertex format covers the whole scene, and every repeated
 * object (cars, lamps, posts, buildings) is drawn instanced.
 */

/** Small helper that accumulates vertices/indices in the shared format. */
export class MeshBuilder {
  constructor() { this.v = []; this.i = []; this.n = 0; }

  vert(p, n, uv, c) {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], c[0], c[1], c[2]);
    return this.n++;
  }

  /**
   * Emits a quad, orienting the winding to agree with the supplied normal.
   *
   * This is not defensive padding — it is a real bug fix. The road and ground
   * were specified corner-order (-x,z0) (+x,z0) (+x,z1) (-x,z1), whose geometric
   * normal is -Y while the declared normal is +Y, so every road surface in the
   * scene was back-face culled and the whole world rendered black. Deriving the
   * winding from the normal makes the call sites impossible to get wrong.
   */
  quad(a, b, c, d, normal, color, uvScale = 1) {
    const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const gx = e1[1]*e2[2] - e1[2]*e2[1];
    const gy = e1[2]*e2[0] - e1[0]*e2[2];
    const gz = e1[0]*e2[1] - e1[1]*e2[0];
    const flip = (gx*normal[0] + gy*normal[1] + gz*normal[2]) < 0;

    const i0 = this.vert(a, normal, [0, 0], color);
    const i1 = this.vert(b, normal, [uvScale, 0], color);
    const i2 = this.vert(c, normal, [uvScale, uvScale], color);
    const i3 = this.vert(d, normal, [0, uvScale], color);
    if (flip) this.i.push(i0, i2, i1, i0, i3, i2);
    else this.i.push(i0, i1, i2, i0, i2, i3);
  }

  /** Axis-aligned box centred on `c` with half-extents `h`. */
  box(c, h, color) {
    const [x, y, z] = c, [hx, hy, hz] = h;
    const P = (dx, dy, dz) => [x + dx * hx, y + dy * hy, z + dz * hz];
    this.quad(P(-1,-1, 1), P( 1,-1, 1), P( 1, 1, 1), P(-1, 1, 1), [0,0,1], color);
    this.quad(P( 1,-1,-1), P(-1,-1,-1), P(-1, 1,-1), P( 1, 1,-1), [0,0,-1], color);
    this.quad(P( 1,-1, 1), P( 1,-1,-1), P( 1, 1,-1), P( 1, 1, 1), [1,0,0], color);
    this.quad(P(-1,-1,-1), P(-1,-1, 1), P(-1, 1, 1), P(-1, 1,-1), [-1,0,0], color);
    this.quad(P(-1, 1, 1), P( 1, 1, 1), P( 1, 1,-1), P(-1, 1,-1), [0,1,0], color);
    this.quad(P(-1,-1,-1), P( 1,-1,-1), P( 1,-1, 1), P(-1,-1, 1), [0,-1,0], color);
  }

  /** Tapered box — lets a car body narrow toward the roof without a modeller. */
  taperBox(c, hBot, hTop, hy, color) {
    const [x, y, z] = c;
    const B = (dx, dz) => [x + dx * hBot[0], y - hy, z + dz * hBot[1]];
    const T = (dx, dz) => [x + dx * hTop[0], y + hy, z + dz * hTop[1]];
    this.quad(B(-1, 1), B( 1, 1), T( 1, 1), T(-1, 1), [0, 0.35, 0.94], color);
    this.quad(B( 1,-1), B(-1,-1), T(-1,-1), T( 1,-1), [0, 0.35,-0.94], color);
    this.quad(B( 1, 1), B( 1,-1), T( 1,-1), T( 1, 1), [0.94, 0.35, 0], color);
    this.quad(B(-1,-1), B(-1, 1), T(-1, 1), T(-1,-1), [-0.94, 0.35, 0], color);
    this.quad(T(-1, 1), T( 1, 1), T( 1,-1), T(-1,-1), [0,1,0], color);
    this.quad(B(-1,-1), B( 1,-1), B( 1, 1), B(-1, 1), [0,-1,0], color);
  }

  cylinder(centre, radius, height, seg, color, axis = 'y') {
    const [cx, cy, cz] = centre;
    const ringTop = [], ringBot = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      let nrm, pT, pB;
      if (axis === 'y') {
        nrm = [ca, 0, sa];
        pT = [cx + ca*radius, cy + height/2, cz + sa*radius];
        pB = [cx + ca*radius, cy - height/2, cz + sa*radius];
      } else { // x-axis (wheels)
        nrm = [0, ca, sa];
        pT = [cx + height/2, cy + ca*radius, cz + sa*radius];
        pB = [cx - height/2, cy + ca*radius, cz + sa*radius];
      }
      ringTop.push(this.vert(pT, nrm, [s/seg, 1], color));
      ringBot.push(this.vert(pB, nrm, [s/seg, 0], color));
    }
    for (let s = 0; s < seg; s++) {
      const n2 = (s + 1) % seg;
      this.i.push(ringBot[s], ringBot[n2], ringTop[n2], ringBot[s], ringTop[n2], ringTop[s]);
    }
    // caps
    const capN = axis === 'y' ? [0,1,0] : [1,0,0];
    const cT = this.vert(axis === 'y' ? [cx, cy+height/2, cz] : [cx+height/2, cy, cz], capN, [0.5,0.5], color);
    const cB = this.vert(axis === 'y' ? [cx, cy-height/2, cz] : [cx-height/2, cy, cz],
                         [-capN[0],-capN[1],-capN[2]], [0.5,0.5], color);
    for (let s = 0; s < seg; s++) {
      const n2 = (s + 1) % seg;
      this.i.push(cT, ringTop[s], ringTop[n2]);
      this.i.push(cB, ringBot[n2], ringBot[s]);
    }
  }

  /**
   * Smooth Torus generator for steering wheel rims, rings, and curved tubing.
   * Uses analytical smooth vertex normals.
   */
  torus(centre, R, r, segR = 32, segP = 16, color) {
    const [cx, cy, cz] = centre;
    const grid = [];
    for (let i = 0; i <= segR; i++) {
      const u = (i / segR) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      const row = [];
      for (let j = 0; j <= segP; j++) {
        const v = (j / segP) * Math.PI * 2;
        const cv = Math.cos(v), sv = Math.sin(v);
        const nrm = [cu * cv, su * cv, sv];
        const pos = [
          cx + (R + r * cv) * cu,
          cy + (R + r * cv) * su,
          cz + r * sv
        ];
        const uv = [i / segR, j / segP];
        row.push(this.vert(pos, nrm, uv, color));
      }
      grid.push(row);
    }
    for (let i = 0; i < segR; i++) {
      for (let j = 0; j < segP; j++) {
        const i0 = grid[i][j], i1 = grid[i + 1][j];
        const i2 = grid[i + 1][j + 1], i3 = grid[i][j + 1];
        this.i.push(i0, i1, i2, i0, i2, i3);
      }
    }
  }

  /** Curved Arch Shroud for binnacle hoods and dashboard covers */
  curvedShroud(centre, width, height, depth, color) {
    const [cx, cy, cz] = centre;
    const segs = 16;
    const topRing = [], botRing = [];
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI; // 0 to PI arc
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = cx - ca * (width * 0.5);
      const y = cy + sa * height;
      const nrm = [-ca, sa, 0.2];
      topRing.push(this.vert([x, y, cz - depth * 0.5], nrm, [s / segs, 1], color));
      botRing.push(this.vert([x, y, cz + depth * 0.5], nrm, [s / segs, 0], color));
    }
    for (let s = 0; s < segs; s++) {
      this.i.push(botRing[s], botRing[s + 1], topRing[s + 1], botRing[s], topRing[s + 1], topRing[s]);
    }
  }

  build() {
    return { data: new Float32Array(this.v), indices: new Uint32Array(this.i) };
  }
}

// ---------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------

export const ROAD_HALF = 7.4;          // metres of tarmac either side of centre
export const LANE = 3.5;
export const SEG_LEN = 4;              // road tessellation, metres

/**
 * Road slab plus shoulders and painted markings, as one long tiled strip.
 * Built once and re-instanced along Z, so the world is effectively endless.
 */
export function buildRoadTile(length = 120) {
  const b = new MeshBuilder();
  const tar = [0.055, 0.056, 0.062];
  const shoulder = [0.045, 0.043, 0.040];
  const paint = [0.62, 0.60, 0.52];
  const half = ROAD_HALF;

  const segs = Math.round(length / SEG_LEN);
  for (let s = 0; s < segs; s++) {
    const z0 = s * SEG_LEN, z1 = z0 + SEG_LEN;
    // tarmac
    b.quad([-half, 0, z0], [half, 0, z0], [half, 0, z1], [-half, 0, z1], [0,1,0], tar, 4);
    // shoulders, very slightly lower so there is a visible lip
    b.quad([-half-4, -0.10, z0], [-half, 0, z0], [-half, 0, z1], [-half-4, -0.10, z1], [0,1,0], shoulder, 2);
    b.quad([half, 0, z0], [half+4, -0.10, z0], [half+4, -0.10, z1], [half, 0, z1], [0,1,0], shoulder, 2);

    // edge lines, continuous
    for (const sgn of [-1, 1]) {
      const x = sgn * (half - 0.35);
      b.quad([x-0.09, 0.006, z0], [x+0.09, 0.006, z0], [x+0.09, 0.006, z1], [x-0.09, 0.006, z1], [0,1,0], paint, 1);
    }
    // lane dashes: 4 m painted, 8 m gap
    if (s % 3 === 0) {
      for (const x of [-LANE, LANE]) {
        b.quad([x-0.08, 0.006, z0], [x+0.08, 0.006, z0], [x+0.08, 0.006, z1], [x-0.08, 0.006, z1], [0,1,0], paint, 1);
      }
    }
    // double centre line
    for (const x of [-0.16, 0.16]) {
      b.quad([x-0.07, 0.006, z0], [x+0.07, 0.006, z0], [x+0.07, 0.006, z1], [x-0.07, 0.006, z1],
             [0,1,0], [0.58, 0.52, 0.22], 1);
    }
  }
  return b.build();
}

/** Flat ground plane well beyond the shoulders, so the world has a floor. */
export function buildGround(size = 900) {
  const b = new MeshBuilder();
  const c = [0.020, 0.023, 0.020];
  b.quad([-size, -0.12, -size], [size, -0.12, -size], [size, -0.12, size], [-size, -0.12, size], [0,1,0], c, 60);
  return b.build();
}

/** A generic saloon: body, greenhouse, wheels. Origin at road level, +Z front. */
export function buildCar(bodyColor = [0.20, 0.21, 0.26]) {
  const b = new MeshBuilder();
  const dark = [0.03, 0.03, 0.035];
  const glass = [0.02, 0.03, 0.045];
  const tailRed = [0.85, 0.08, 0.04];
  const headWhite = [0.92, 0.92, 0.85];

  b.taperBox([0, 0.72, 0], [0.95, 2.25], [0.90, 2.10], 0.34, bodyColor);   // lower body
  b.taperBox([0, 1.26, -0.15], [0.86, 1.30], [0.60, 0.95], 0.24, glass);   // greenhouse
  b.box([0, 0.44, 0], [0.99, 0.12, 2.28], dark);                            // sills / bumpers

  // Headlights (front +Z)
  for (const sx of [-0.72, 0.72]) {
    b.box([sx, 0.70, 2.26], [0.18, 0.08, 0.03], headWhite);
  }
  // Taillights / brake lights (rear -Z)
  for (const sx of [-0.74, 0.74]) {
    b.box([sx, 0.74, -2.26], [0.18, 0.09, 0.03], tailRed);
  }

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.cylinder([sx * 0.86, 0.34, sz * 1.48], 0.34, 0.22, 12, [0.025, 0.025, 0.028], 'x');
  }
  return b.build();
}

/** Quad particle for collision sparks / flashes */
export function buildSpark() {
  const b = new MeshBuilder();
  b.quad([-0.25, -0.25, 0], [0.25, -0.25, 0], [0.25, 0.25, 0], [-0.25, 0.25, 0],
         [0, 0, 1], [1.0, 0.75, 0.20], 1);
  return b.build();
}

/** Sodium street lamp: column + curved arm + a glowing head. */
export function buildLamp() {
  const b = new MeshBuilder();
  const metal = [0.10, 0.10, 0.11];
  b.cylinder([0, 4.2, 0], 0.11, 8.4, 8, metal, 'y');
  b.box([0.9, 8.3, 0], [1.0, 0.09, 0.09], metal);
  b.box([1.8, 8.15, 0], [0.34, 0.10, 0.20], [1.0, 0.62, 0.22]);   // emissive head
  return b.build();
}

/** Crash barrier post + rail segment. */
export function buildBarrier() {
  const b = new MeshBuilder();
  const steel = [0.16, 0.17, 0.19];
  b.box([0, 0.42, 0], [0.06, 0.42, 0.06], [0.10, 0.10, 0.11]);
  b.box([0, 0.72, 0], [0.04, 0.16, 2.0], steel);
  return b.build();
}

/** Distant blocky buildings to break the horizon. */
export function buildBuilding() {
  const b = new MeshBuilder();
  b.box([0, 0.5, 0], [1, 0.5, 1], [0.035, 0.037, 0.048]);
  return b.build();
}

/** Reflective delineator on a stick — catches the headlights beautifully. */
export function buildMarkerPost() {
  const b = new MeshBuilder();
  b.box([0, 0.5, 0], [0.05, 0.5, 0.05], [0.55, 0.55, 0.58]);
  b.box([0, 0.82, 0.052], [0.045, 0.10, 0.012], [1.0, 0.45, 0.10]);
  return b.build();
}

/**
 * High-detail, smooth curved Cockpit for Left-Hand Drive (LHD).
 */
export function buildCockpit() {
  const b = new MeshBuilder();
  const dash = [0.22, 0.23, 0.26];
  const trim = [0.35, 0.36, 0.40];
  const pill = [0.18, 0.19, 0.22];
  const chrome = [0.85, 0.85, 0.90];

  // Main contoured dashboard slab
  b.box([0, -0.52, -0.85], [1.25, 0.15, 0.38], dash);
  b.box([0, -0.78, -0.68], [1.25, 0.18, 0.18], trim);

  // Smooth curved binnacle hood over instruments on DRIVER'S LEFT SIDE (x = -0.38)
  b.curvedShroud([-0.38, -0.38, -0.80], 0.52, 0.22, 0.32, dash);

  // Metallic accent trim strip running across dashboard
  b.box([0, -0.44, -0.58], [1.25, 0.014, 0.014], [1.0, 0.55, 0.10]);
  b.box([0, -0.455, -0.575], [1.25, 0.008, 0.010], chrome);

  // Centre console & HVAC air vents
  b.box([0.08, -0.72, -0.60], [0.22, 0.18, 0.24], trim);
  for (const sx of [-0.08, 0.24]) {
    b.cylinder([sx, -0.46, -0.60], 0.045, 0.02, 16, chrome, 'z');
  }

  // Slanted A-Pillars & header rail
  for (const sx of [-1, 1]) {
    b.box([sx * 1.08, 0.20, -0.62], [0.05, 0.65, 0.05], pill);
  }
  b.box([0, 0.78, -0.58], [1.12, 0.06, 0.16], pill);

  // Door armrests
  for (const sx of [-1, 1]) b.box([sx * 1.18, -0.48, -0.10], [0.06, 0.10, 0.75], trim);

  return b.build();
}

/**
 * Smooth 3D Steering wheel built with analytical Torus rim, cylinder column & hub,
 * and 3 brushed-metallic spokes.
 */
export function buildWheel() {
  const b = new MeshBuilder();
  const leather = [0.12, 0.12, 0.14];
  const hubMetal = [0.25, 0.26, 0.30];
  const chrome = [0.75, 0.76, 0.82];

  // 1. Smooth Torus rim
  b.torus([0, 0, 0], 0.185, 0.024, 36, 16, leather);

  // 2. Center horn hub cylinder
  b.cylinder([0, 0, -0.015], 0.055, 0.04, 24, hubMetal, 'z');
  b.cylinder([0, 0, 0.006], 0.032, 0.01, 20, [1.0, 0.55, 0.10], 'z'); // center emblem

  // 3. Three metallic spokes (bottom, bottom-left, bottom-right)
  const angles = [Math.PI * 1.5, Math.PI * 0.26, Math.PI * 0.74];
  for (const a of angles) {
    const ca = Math.cos(a), sa = Math.sin(a);
    const mid = [ca * 0.095, sa * 0.095, -0.008];
    const width = Math.abs(ca) * 0.06 + 0.022;
    const height = Math.abs(sa) * 0.06 + 0.022;
    b.box(mid, [width, height, 0.012], chrome);
  }

  // 4. Steering column shroud behind wheel
  b.cylinder([0, 0, -0.12], 0.075, 0.18, 20, [0.10, 0.11, 0.13], 'z');

  return b.build();
}

/** Flat panel the gauge canvas is projected onto. */
export function buildPanel(w, h) {
  const b = new MeshBuilder();
  b.quad([-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0], [0, 0, 1], [1, 1, 1], 1);
  return b.build();
}

/** Camera-facing quad used for rain streaks. */
export function buildRainQuad() {
  const b = new MeshBuilder();
  b.quad([-0.012, -0.5, 0], [0.012, -0.5, 0], [0.012, 0.5, 0], [-0.012, 0.5, 0],
         [0, 0, 1], [0.55, 0.68, 0.95], 1);
  return b.build();
}
