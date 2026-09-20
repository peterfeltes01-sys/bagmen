export type Rng = () => number

// ---- Point / Trajectory ----
export interface Point {
  x: number  // cm
  y: number  // cm
  z: number  // cm (height above board surface)
  t: number  // s
}
export type Trajectory = Point[]

// ---- Legacy types (used by GameState / applyThrow) ----
export type BagOutcome = 'hole' | 'board' | 'miss'

export interface BagState {
  id: string
  teamId: 0 | 1
  outcome: BagOutcome
  landingX: number  // normalised 0-1 on board width
  landingY: number  // normalised 0-1 on board length
}

export interface FrameState {
  frameNumber: number
  bags: BagState[]
  score0: number
  score1: number
}

export interface GameState {
  engineHash: string
  totalScore0: number
  totalScore1: number
  currentFrame: number
  frames: FrameState[]
  throwsThisFrame: number
  currentTeam: 0 | 1
  phase: 'playing' | 'finished'
  winner?: 0 | 1
}

export interface ThrowParams {
  speed: number
  angle: number
  spin: number
  loft: number
}

export interface ApplyThrowResult {
  state: GameState
  trajectory: Trajectory
  outcome: BagOutcome
  landing: { x: number; y: number }
}

// ---- Board simulation types ----
export type SackOutcome = 'in' | 'on' | 'off'
export type FlightType = 'flat' | 'airmail' | 'roll'
export type BagSide = 'fast' | 'slow'

export interface BagOnBoard {
  id: string
  teamId: 0 | 1
  x: number   // cm from board centre-left axis
  y: number   // cm from board front edge
  side: BagSide
}

export interface BoardState {
  bags: BagOnBoard[]
}

export interface ThrowInput {
  teamId: 0 | 1
  targetX: number    // cm aim point
  targetY: number    // cm aim point
  power: number      // 0..1
  spin: number       // -1..1  (>0 = fast-side down = more slide)
  flightType: FlightType
  skillLevel: number // 0..1
  focus: number      // 0..1
}

export interface BagResult {
  id: string
  outcome: SackOutcome
  finalX: number  // cm
  finalY: number  // cm
}

export interface ThrowResult {
  thrownBag: BagResult
  pushedBags: BagResult[]
}
