export const ENGINE_HASH = '0.1.0'

export const PHYSICS = {
  gravity: 9.81,
  airResistance: 0.025,
  boardWidth: 0.6096,
  boardLength: 1.2192,
  boardAngle: 12,
  holeRadius: 0.0762,
  holeX: 0.5,
  holeY: 0.8125,
  holeTolerance: 0.015,
  bagMass: 0.4536,
  bagDiameter: 0.1524,
  minSpeed: 3.0,
  maxSpeed: 8.0,
  throwingDistance: 4.0,
  trajectorySteps: 120,
  dt: 0.016,
} as const

export type PhysicsConfig = typeof PHYSICS

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

// ---- Slide physics ----
export const SLIDE = {
  // Base slide speed (cm/s) multiplied by power
  flatV: 60,
  rollV: 120,
  airmailV: 20,
  // Friction deceleration (cm/s²)
  fastFriction: 200,  // fast-side-down (slippery)
  slowFriction: 400,  // slow-side-down (rough)
  maxSteps: 400,
  dt: 0.016, // s
} as const
