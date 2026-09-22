import { describe, it, expect } from 'vitest'
import {
  scoreFrame, nextFrameFirst, checkMatch,
  advanceThrow, isFrameOver, advanceFrame,
} from './rules.js'
import type { FrameState, MatchConfig } from './types.js'

function makeFrame(overrides: Partial<FrameState> = {}): FrameState {
  return {
    frameIndex:  0,
    throwsLeft:  [4, 4],
    activeTeam:  0,
    firstThrown: 0,
    scores:      [0, 0],
    boardState:  { bags: [] },
    roundHoles:  [],
    ...overrides,
  }
}

// ── scoreFrame ────────────────────────────────────────────────────────────────

describe('scoreFrame', () => {
  it('cancellation: team0 leads, difference carries', () => {
    const board = { bags: [{ id: 'a', teamId: 0 as const, x: 0, y: 50, side: 'fast' as const }] }
    const holes = [{ teamId: 0 as const }, { teamId: 0 as const }, { teamId: 1 as const }]
    const { framePts, netPts } = scoreFrame(board, holes)
    // team0: 2 holes=6 + 1 board=1 = 7; team1: 1 hole=3; diff=4
    expect(framePts).toEqual([7, 3])
    expect(netPts).toEqual([4, 0])
  })

  it('cancellation: equal points, nobody nets', () => {
    const board = { bags: [] }
    const holes = [{ teamId: 0 as const }, { teamId: 1 as const }]
    const { netPts } = scoreFrame(board, holes)
    expect(netPts).toEqual([0, 0])
  })

  it('only team1 scores from board bags', () => {
    const board = {
      bags: [
        { id: 'a', teamId: 1 as const, x: 0, y: 50, side: 'fast' as const },
        { id: 'b', teamId: 1 as const, x: 5, y: 60, side: 'fast' as const },
      ],
    }
    const { framePts, netPts } = scoreFrame(board, [])
    expect(framePts).toEqual([0, 2])
    expect(netPts).toEqual([0, 2])
  })

  it('empty frame, no points', () => {
    const { framePts, netPts } = scoreFrame({ bags: [] }, [])
    expect(framePts).toEqual([0, 0])
    expect(netPts).toEqual([0, 0])
  })

  it('hole is worth 3, board bag is worth 1', () => {
    const board = { bags: [{ id: 'x', teamId: 0 as const, x: 0, y: 50, side: 'fast' as const }] }
    const holes = [{ teamId: 0 as const }]
    const { framePts } = scoreFrame(board, holes)
    expect(framePts[0]).toBe(4)  // 3 + 1
  })
})

// ── nextFrameFirst ────────────────────────────────────────────────────────────

describe('nextFrameFirst', () => {
  it('team0 nets → team0 goes first', () => {
    expect(nextFrameFirst([3, 0], 1)).toBe(0)
  })
  it('team1 nets → team1 goes first', () => {
    expect(nextFrameFirst([0, 2], 0)).toBe(1)
  })
  it('nobody nets → keep current first', () => {
    expect(nextFrameFirst([0, 0], 0)).toBe(0)
    expect(nextFrameFirst([0, 0], 1)).toBe(1)
  })
})

// ── checkMatch ────────────────────────────────────────────────────────────────

describe('checkMatch', () => {
  const cfg: MatchConfig = { targetScore: 21, mustExact: false, winBy: 1 }

  it('team0 reaches target with lead → wins', () => {
    const r = checkMatch([21, 15], cfg)
    expect(r.over).toBe(true)
    expect(r.winner).toBe(0)
  })
  it('team1 reaches target with lead → wins', () => {
    const r = checkMatch([15, 21], cfg)
    expect(r.over).toBe(true)
    expect(r.winner).toBe(1)
  })
  it('both below target → not over', () => {
    expect(checkMatch([20, 18], cfg).over).toBe(false)
  })
  it('both at target (tied) with winBy=1 → not over', () => {
    expect(checkMatch([21, 21], cfg).over).toBe(false)
  })
  it('above target still wins when mustExact=false', () => {
    const r = checkMatch([25, 10], cfg)
    expect(r.over).toBe(true)
    expect(r.winner).toBe(0)
  })

  describe('mustExact=true', () => {
    const exact: MatchConfig = { targetScore: 21, mustExact: true, winBy: 1 }
    it('overshoot → not over', () => {
      expect(checkMatch([22, 10], exact).over).toBe(false)
    })
    it('exact hit → wins', () => {
      const r = checkMatch([21, 10], exact)
      expect(r.over).toBe(true)
      expect(r.winner).toBe(0)
    })
  })

  describe('winBy=2', () => {
    const wb2: MatchConfig = { targetScore: 21, mustExact: false, winBy: 2 }
    it('one-point lead at target → not over', () => {
      expect(checkMatch([21, 20], wb2).over).toBe(false)
    })
    it('two-point lead → wins', () => {
      const r = checkMatch([22, 20], wb2)
      expect(r.over).toBe(true)
      expect(r.winner).toBe(0)
    })
  })

  describe('targetScore=11 (short game)', () => {
    const short: MatchConfig = { targetScore: 11, mustExact: false, winBy: 1 }
    it('team1 hits 11 first', () => {
      const r = checkMatch([8, 11], short)
      expect(r.over).toBe(true)
      expect(r.winner).toBe(1)
    })
  })
})

// ── advanceThrow ──────────────────────────────────────────────────────────────

describe('advanceThrow', () => {
  it('alternates teams while both have throws remaining', () => {
    const s0 = makeFrame({ throwsLeft: [4, 4], activeTeam: 0 })
    const s1 = advanceThrow(s0)
    expect(s1.throwsLeft).toEqual([3, 4])
    expect(s1.activeTeam).toBe(1)

    const s2 = advanceThrow(s1)
    expect(s2.throwsLeft).toEqual([3, 3])
    expect(s2.activeTeam).toBe(0)
  })

  it('stays with current team when other has no throws left', () => {
    const s = makeFrame({ throwsLeft: [1, 0], activeTeam: 0 })
    const s1 = advanceThrow(s)
    expect(s1.throwsLeft).toEqual([0, 0])
    expect(s1.activeTeam).toBe(0)
  })

  it('switches to other team when current exhausted mid-alternation', () => {
    const s = makeFrame({ throwsLeft: [0, 2], activeTeam: 1 })
    const s1 = advanceThrow(s)
    expect(s1.throwsLeft).toEqual([0, 1])
    expect(s1.activeTeam).toBe(1)
  })

  it('full 8-throw sequence follows 0,1,0,1,0,1,0,1', () => {
    let s = makeFrame()
    const order: number[] = []
    for (let i = 0; i < 8; i++) {
      order.push(s.activeTeam)
      s = advanceThrow(s)
    }
    expect(order).toEqual([0, 1, 0, 1, 0, 1, 0, 1])
  })
})

// ── isFrameOver ───────────────────────────────────────────────────────────────

describe('isFrameOver', () => {
  it('both zero → true', () => {
    expect(isFrameOver(makeFrame({ throwsLeft: [0, 0] }))).toBe(true)
  })
  it('any nonzero → false', () => {
    expect(isFrameOver(makeFrame({ throwsLeft: [1, 0] }))).toBe(false)
    expect(isFrameOver(makeFrame({ throwsLeft: [0, 1] }))).toBe(false)
    expect(isFrameOver(makeFrame({ throwsLeft: [4, 4] }))).toBe(false)
  })
})

// ── advanceFrame ──────────────────────────────────────────────────────────────

describe('advanceFrame', () => {
  it('applies net points and increments frameIndex', () => {
    const s  = makeFrame({ frameIndex: 2, scores: [10, 8] })
    const s1 = advanceFrame(s, [3, 0])
    expect(s1.scores).toEqual([13, 8])
    expect(s1.frameIndex).toBe(3)
  })

  it('team that scored throws first next frame', () => {
    const s  = makeFrame({ scores: [5, 5], firstThrown: 0 })
    const s1 = advanceFrame(s, [0, 2])
    expect(s1.firstThrown).toBe(1)
    expect(s1.activeTeam).toBe(1)
  })

  it('nobody scored → keeps current first', () => {
    const s  = makeFrame({ firstThrown: 1 })
    const s1 = advanceFrame(s, [0, 0])
    expect(s1.firstThrown).toBe(1)
    expect(s1.activeTeam).toBe(1)
  })

  it('resets throws, board and holes', () => {
    const s  = makeFrame({
      throwsLeft: [0, 0],
      boardState: { bags: [{ id: 'x', teamId: 0, x: 0, y: 50, side: 'fast' }] },
      roundHoles: [{ teamId: 0 }],
    })
    const s1 = advanceFrame(s, [0, 0])
    expect(s1.throwsLeft).toEqual([4, 4])
    expect(s1.boardState.bags).toHaveLength(0)
    expect(s1.roundHoles).toHaveLength(0)
  })
})
