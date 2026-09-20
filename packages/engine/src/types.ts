export type BagOutcome = 'hole' | 'board' | 'miss'

export interface Point {
  x: number  // Weltkoordinaten lateral (m)
  y: number  // Weltkoordinaten longitudinal (m)
  z: number  // Höhe (m)
  t: number  // Zeit (s)
}

export type Trajectory = Point[]

export interface BagState {
  id: string
  teamId: 0 | 1
  outcome: BagOutcome
  landingX: number  // normalisiert 0-1 auf Brettbreite
  landingY: number  // normalisiert 0-1 auf Brettlänge
}

export interface FrameState {
  frameNumber: number
  bags: BagState[]
  score0: number  // Nettopunkte Team 0 in dieser Runde
  score1: number  // Nettopunkte Team 1 in dieser Runde
}

export interface GameState {
  engineHash: string
  totalScore0: number
  totalScore1: number
  currentFrame: number
  frames: FrameState[]
  throwsThisFrame: number  // 0-7 (4 pro Team, 8 gesamt pro Frame)
  currentTeam: 0 | 1
  phase: 'playing' | 'finished'
  winner?: 0 | 1
}

export interface ThrowParams {
  speed: number  // 0-1 normalisiert
  angle: number  // horizontale Abweichung in Radian
  spin: number   // -1 bis 1
  loft: number   // 0-1 normalisiert (Bogenhöhe)
}

export interface ThrowResult {
  state: GameState
  trajectory: Trajectory
  outcome: BagOutcome
  landing: { x: number; y: number }  // normalisiert auf Brett
}
