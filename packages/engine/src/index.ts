export { createInitialState, applyThrow } from './state.js'
export { simulateThrow as simulateThrowLegacy } from './physics.js'
export { simulateThrow } from './simulate.js'
export { createRng } from './rng.js'
export { PHYSICS, BOARD, SCATTER, SLIDE, ENGINE_HASH } from './config.js'
export type { PhysicsConfig } from './config.js'
export type {
  // legacy
  GameState,
  ThrowParams,
  ApplyThrowResult,
  BagState,
  FrameState,
  BagOutcome,
  Trajectory,
  Point,
  // new board simulation
  Rng,
  BoardState,
  BagOnBoard,
  BagSide,
  FlightType,
  ThrowInput,
  ThrowResult,
  BagResult,
  SackOutcome,
} from './types.js'
