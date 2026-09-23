export type Rng = () => number

// ---- Tunable physics config (injected into simulateThrow) ----
export interface PhysicsConfig {
  apexRoll:           number  // cm, trajectory apex for roll
  apexFlat:           number  // cm, trajectory apex for flat/slide
  apexAirmail:        number  // cm, trajectory apex for airmail
  slideVRoll:         number  // cm/s, base slide speed for roll
  slideVFlat:         number  // cm/s, base slide speed for flat/slide
  slideVAirmail:      number  // cm/s, base slide speed for airmail
  collisionTransfer:  number  // 0–1, momentum fraction transferred on bag impact
  pushFriction:       number  // cm/s², deceleration for the thrown bag
  pushedFriction:     number  // cm/s², deceleration for bags that were pushed
  spinCurvature:      number  // cm, max mid-flight lateral bow at spin=±1
}

// ---- Point / Trajectory ----
export interface Point {
  x: number  // cm
  y: number  // cm
  z: number  // cm (height above board surface)
  t: number  // s
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

// ---- Match / Frame types ----

export type AiStyle = 'blocker' | 'airmailer' | 'nervenbundel'

export interface MatchConfig {
  targetScore: number
  mustExact: boolean  // must hit targetScore exactly; overshoot doesn't win
  winBy: number       // minimum margin to win (1 = first to target wins)
}

export interface FrameState {
  frameIndex: number
  throwsLeft: [number, number]
  activeTeam: 0|1
  firstThrown: 0|1
  scores: [number, number]
  boardState: BoardState
  roundHoles: Array<{ teamId: 0|1 }>
}

export interface FrameResult {
  framePts: [number, number]
  netPts: [number, number]
}

export interface MatchStatus {
  over: boolean
  winner?: 0|1
}
