// 2.5D perspective projection for cornhole board
// Coordinate system: x cm (left=negative), y cm (0=board front, 120=board back), z cm (0=surface)

export interface Layout {
  cssW: number
  cssH: number
  // Board trapezoid corners in CSS pixels (ty=0=front=LOWER on screen, ty=1=back=HIGHER)
  frontLeft:  { x: number; y: number }
  frontRight: { x: number; y: number }
  backLeft:   { x: number; y: number }
  backRight:  { x: number; y: number }
  throwZoneY: number  // CSS y where throw zone starts
  hudH: number
}

export function makeLayout(w: number, h: number): Layout {
  const hudH   = Math.max(52, h * 0.075)
  const frontY = h * 0.68
  const backY  = h * 0.13
  const cx     = w * 0.50

  // Board dimensions derived from HEIGHT so the board always appears
  // roughly 2× deeper than wide (matching the real 120 cm : 60 cm ratio).
  //   screen_depth = frontY − backY ≈ 0.55 × h
  //   desired front_width ≈ screen_depth / 2
  //   → fhw = screen_depth / 4
  const depth = frontY - backY
  const fhw   = depth * 0.26    // front half-width  (≈ front_width = depth/2)
  const bhw   = fhw   * 0.38    // back half-width  (strong perspective taper)

  const throwY = h * 0.76

  return {
    cssW: w, cssH: h, hudH,
    frontLeft:  { x: cx - fhw, y: frontY },
    frontRight: { x: cx + fhw, y: frontY },
    backLeft:   { x: cx - bhw, y: backY },
    backRight:  { x: cx + bhw, y: backY },
    throwZoneY: throwY,
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// Bilinear interpolation on the board trapezoid — extrapolates outside [0,1]
function bilinear(lt: Layout, tx: number, ty: number): { x: number; y: number } {
  const botX = lerp(lt.frontLeft.x, lt.frontRight.x, tx)
  const topX = lerp(lt.backLeft.x,  lt.backRight.x,  tx)
  return {
    x: lerp(botX, topX, ty),
    y: lerp(lt.frontLeft.y, lt.backLeft.y, ty),
  }
}

// px/cm horizontal scale at depth ty (clamped to board range)
export function pxPerCm(ty: number, lt: Layout): number {
  const fw = lt.frontRight.x - lt.frontLeft.x
  const bw = lt.backRight.x  - lt.backLeft.x
  return lerp(fw, bw, clamp01(ty)) / 60   // 60 = board width in cm
}

// World point (wx cm, wy cm from board front, wz cm above surface) → CSS px
// Extrapolates for wy outside [0,120].
export function worldPt(wx: number, wy: number, wz: number, lt: Layout): { x: number; y: number } {
  const tx  = (wx + 30) / 60
  const ty  = wy / 120
  const { x, y } = bilinear(lt, tx, ty)
  const scale = pxPerCm(ty, lt)
  return { x, y: y - wz * scale }
}

// Bag on board surface (z=0)
export function bagPos(bx: number, by: number, lt: Layout): { x: number; y: number } {
  return worldPt(bx, by, 0, lt)
}

// Half-size of bag square in px at depth ty  (bag = 15 cm × 15 cm)
export function bagHalfSize(ty: number, lt: Layout): number {
  return Math.max(3, pxPerCm(ty, lt) * 7.5)   // 7.5 cm = half of 15 cm side
}

// Hole visual radius in px at depth ty  (hole ∅ 15.2 cm → r = 7.6 cm)
export function holeRadius(ty: number, lt: Layout): number {
  return Math.max(3, pxPerCm(ty, lt) * 7.6)
}

// CSS pixel → board cm; null if outside board rectangle
export function canvasToBoard(sx: number, sy: number, lt: Layout): { bx: number; by: number } | null {
  const frontY = lt.frontLeft.y
  const backY  = lt.backLeft.y
  const ty = (frontY - sy) / (frontY - backY)
  if (ty < 0 || ty > 1) return null
  const fw = lt.frontRight.x - lt.frontLeft.x
  const bw = lt.backRight.x  - lt.backLeft.x
  const halfW = lerp(fw, bw, ty) / 2
  const cx    = lerp(
    (lt.frontLeft.x  + lt.frontRight.x) / 2,
    (lt.backLeft.x   + lt.backRight.x)  / 2,
    ty,
  )
  const tx = (sx - (cx - halfW)) / (halfW * 2)
  if (tx < 0 || tx > 1) return null
  return { bx: tx * 60 - 30, by: ty * 120 }
}
