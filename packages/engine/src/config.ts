export const ENGINE_HASH = '0.1.0'

export const PHYSICS = {
  // Gravitationskonstante
  gravity: 9.81,           // m/s²
  airResistance: 0.025,    // Luftwiderstandskoeffizient

  // Brettkonfiguration (Standard-Cornhole)
  boardWidth: 0.6096,      // m (2 Fuß)
  boardLength: 1.2192,     // m (4 Fuß)
  boardAngle: 12,          // Grad (Neigungswinkel des Bretts)

  // Loch
  holeRadius: 0.0762,      // m (6-Zoll-Durchmesser → 3-Zoll-Radius)
  holeX: 0.5,              // normalisiert: Mitte des Bretts
  holeY: 0.8125,           // normalisiert: 9 Zoll vom fernen Ende (1 - 9/48)
  holeTolerance: 0.015,    // extra Toleranz für Loch-Detektion (normalisiert)

  // Sack
  bagMass: 0.4536,         // kg (1 Pfund)
  bagDiameter: 0.1524,     // m (6 Zoll)

  // Wurfparameter
  minSpeed: 3.0,           // m/s
  maxSpeed: 8.0,           // m/s
  throwingDistance: 4.0,   // m vom Spieler zur Nahkante des Bretts

  // Simulation
  trajectorySteps: 120,
  dt: 0.016,               // s pro Schritt (~60 fps)
} as const

export type PhysicsConfig = typeof PHYSICS
