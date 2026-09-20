import { ENGINE_HASH } from './config.js'
import { GameState, ThrowParams, ThrowResult, BagState, BagOutcome, FrameState } from './types.js'
import { simulateThrow } from './physics.js'

const BAGS_PER_TEAM = 4

function scoreFor(outcome: BagOutcome): number {
  if (outcome === 'hole') return 3
  if (outcome === 'board') return 1
  return 0
}

export function createInitialState(): GameState {
  return {
    engineHash: ENGINE_HASH,
    totalScore0: 0,
    totalScore1: 0,
    currentFrame: 1,
    frames: [],
    throwsThisFrame: 0,
    currentTeam: 0,
    phase: 'playing',
  }
}

export function applyThrow(
  state: GameState,
  params: ThrowParams,
  seed: number,
): ThrowResult {
  if (state.phase === 'finished') {
    return { state, trajectory: [], outcome: 'miss', landing: { x: 0.5, y: 0.5 } }
  }

  const { trajectory, outcome, landingX, landingY } = simulateThrow(params, seed)

  const next: GameState = structuredClone(state)

  const bag: BagState = {
    id: `f${state.currentFrame}-${state.currentTeam}-${state.throwsThisFrame}`,
    teamId: state.currentTeam,
    outcome,
    landingX,
    landingY,
  }

  let frame = next.frames.find(f => f.frameNumber === next.currentFrame)
  if (!frame) {
    const newFrame: FrameState = {
      frameNumber: next.currentFrame,
      bags: [],
      score0: 0,
      score1: 0,
    }
    next.frames.push(newFrame)
    frame = newFrame
  }
  frame.bags.push(bag)
  next.throwsThisFrame++

  if (next.throwsThisFrame === BAGS_PER_TEAM) {
    next.currentTeam = 1
  } else if (next.throwsThisFrame >= BAGS_PER_TEAM * 2) {
    // Frame abgeschlossen: Cancellation-Scoring
    const s0 = frame.bags
      .filter(b => b.teamId === 0)
      .reduce((sum, b) => sum + scoreFor(b.outcome), 0)
    const s1 = frame.bags
      .filter(b => b.teamId === 1)
      .reduce((sum, b) => sum + scoreFor(b.outcome), 0)

    const diff = s0 - s1
    if (diff > 0) {
      frame.score0 = diff
      next.totalScore0 += diff
    } else if (diff < 0) {
      frame.score1 = -diff
      next.totalScore1 += -diff
    }

    if (next.totalScore0 >= 21 || next.totalScore1 >= 21) {
      next.phase = 'finished'
      next.winner = next.totalScore0 > next.totalScore1 ? 0 : 1
    } else {
      next.currentFrame++
      next.throwsThisFrame = 0
      next.currentTeam = 0
    }
  }

  return { state: next, trajectory, outcome, landing: { x: landingX, y: landingY } }
}
