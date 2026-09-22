import type { FrameResult, FrameState, MatchConfig, MatchStatus } from './types.js'

export function scoreFrame(
  boardState: { bags: Array<{ teamId: 0|1 }> },
  roundHoles: Array<{ teamId: 0|1 }>,
): FrameResult {
  const on0 = boardState.bags.filter(b => b.teamId === 0).length
  const on1 = boardState.bags.filter(b => b.teamId === 1).length
  const h0  = roundHoles.filter(h => h.teamId === 0).length
  const h1  = roundHoles.filter(h => h.teamId === 1).length
  const pts0 = h0 * 3 + on0
  const pts1 = h1 * 3 + on1
  const diff = pts0 - pts1
  const netPts: [number, number] = diff > 0 ? [diff, 0] : diff < 0 ? [0, -diff] : [0, 0]
  return { framePts: [pts0, pts1], netPts }
}

export function nextFrameFirst(netPts: [number, number], currentFirst: 0|1): 0|1 {
  if (netPts[0] > 0) return 0
  if (netPts[1] > 0) return 1
  return currentFirst
}

export function checkMatch(scores: [number, number], config: MatchConfig): MatchStatus {
  for (const t of [0, 1] as const) {
    const s     = scores[t]
    const other = scores[(1 - t) as 0|1]
    if (s < config.targetScore) continue
    if (config.mustExact && s !== config.targetScore) continue
    if (s - other >= config.winBy) return { over: true, winner: t }
  }
  return { over: false }
}

export function advanceThrow(state: FrameState): FrameState {
  const newLeft: [number, number] = [state.throwsLeft[0], state.throwsLeft[1]]
  newLeft[state.activeTeam]--
  const other    = (1 - state.activeTeam) as 0|1
  const nextTeam = newLeft[other] > 0 ? other : state.activeTeam
  return { ...state, throwsLeft: newLeft, activeTeam: nextTeam }
}

export function isFrameOver(state: FrameState): boolean {
  return state.throwsLeft[0] === 0 && state.throwsLeft[1] === 0
}

export function advanceFrame(state: FrameState, netPts: [number, number]): FrameState {
  const newScores: [number, number] = [state.scores[0] + netPts[0], state.scores[1] + netPts[1]]
  const first = nextFrameFirst(netPts, state.firstThrown)
  return {
    frameIndex:  state.frameIndex + 1,
    throwsLeft:  [4, 4],
    activeTeam:  first,
    firstThrown: first,
    scores:      newScores,
    boardState:  { bags: [] },
    roundHoles:  [],
  }
}
