import type { PhysicsConfig, MatchConfig } from './types.js'

// ---- Board geometry (cm, origin = centre of front edge) ----
export const BOARD = {
  halfWidth: 30,     // cm  (60 cm total)
  length: 120,       // cm
  holeX: 0,          // cm from centre axis
  holeY: 97,         // cm from front edge  (120 - 23)
  holeRadius: 7.5,   // cm  (15 cm hole)
  bagRadius: 7.5,    // cm  (15 cm bag)
  bagDiameter: 15,   // cm
  throwLineY: -820,  // cm from front edge  (8.2 m)
  releaseZ: 150,     // cm release height
} as const

// ---- Gaussian scatter model ----
// sigma = SCATTER.min + SCATTER.spread * (1 - skillLevel) * (1 - focus * 0.5)
// Good player (skill 0.9, focus 0.8) → sigma ≈ 7.4 cm → P(in hole) ≈ 40 %
export const SCATTER = {
  min: 6.0,     // cm irreducible floor
  spread: 23.7, // cm extra for low skill/focus
} as const

// ---- Slide simulation constants (not tunable at runtime) ----
export const SLIDE = {
  maxSteps: 400,
  dt: 0.016,  // s
} as const

// ---- Default physics config ----
export const PHYSICS_DEFAULTS: PhysicsConfig = {
  apexRoll:          40,
  apexFlat:          80,
  apexAirmail:       300,
  slideVRoll:        120,
  slideVFlat:        60,
  slideVAirmail:     20,
  collisionTransfer: 1.0,
  pushFriction:      200,
  spinCurvature:     20,
}

// ENGINE_HASH is derived from default physics values so it updates automatically
// when any default changes, keeping seeded replays reproducible.
function fnv1a(vals: number[]): string {
  let h = 0x811c9dc5 >>> 0
  for (const v of vals) {
    const n = Math.round(v * 1000) >>> 0
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (i * 8)) & 0xff
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h.toString(16).padStart(8, '0')
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  targetScore: 21,
  mustExact: false,
  winBy: 1,
}

export const ENGINE_HASH = fnv1a([
  PHYSICS_DEFAULTS.apexRoll,          PHYSICS_DEFAULTS.apexFlat,
  PHYSICS_DEFAULTS.apexAirmail,       PHYSICS_DEFAULTS.slideVRoll,
  PHYSICS_DEFAULTS.slideVFlat,        PHYSICS_DEFAULTS.slideVAirmail,
  PHYSICS_DEFAULTS.collisionTransfer, PHYSICS_DEFAULTS.pushFriction,
  PHYSICS_DEFAULTS.spinCurvature,
])
