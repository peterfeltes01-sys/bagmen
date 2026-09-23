import { BOARD } from './config.js'
import type { AiStyle, Rng, ThrowInput, BoardState } from './types.js'

const BLOCKER_TARGET_Y = BOARD.holeY - 22

function pathToHoleBlocked(boardState: BoardState): boolean {
  return boardState.bags.some(b =>
    b.teamId === 0 &&
    Math.abs(b.x - BOARD.holeX) < BOARD.bagDiameter * 1.2 &&
    b.y >= BOARD.holeY - 30 &&
    b.y < BOARD.holeY
  )
}

export function aiThrow(
  style: AiStyle,
  scores: [number, number],
  rng: Rng,
  boardState: BoardState,
): ThrowInput {
  const teamId     = 1 as const
  const pathBlocked = pathToHoleBlocked(boardState)

  if (style === 'blocker') {
    if (pathBlocked) {
      return {
        teamId,
        targetX:    BOARD.holeX + (rng() - 0.5) * 14,
        targetY:    BOARD.holeY,
        power:      0.55,
        spin:       0,
        flightType: 'airmail',
        skillLevel: 0.60,
        focus:      0.68,
      }
    }
    return {
      teamId,
      targetX:    (rng() - 0.5) * 8,
      targetY:    BLOCKER_TARGET_Y,
      power:      0.70,
      spin:       0,
      flightType: 'flat',
      skillLevel: 0.74,
      focus:      0.80,
    }
  }

  if (style === 'airmailer') {
    return {
      teamId,
      targetX:    BOARD.holeX + (rng() - 0.5) * 10,
      targetY:    BOARD.holeY,
      power:      0.50,
      spin:       0,
      flightType: 'airmail',
      skillLevel: 0.54,
      focus:      0.60,
    }
  }

  // nervenbundel: high accuracy, degrades under pressure; adapts when path is blocked
  const trailing   = Math.max(0, scores[0] - scores[1])
  const skillLevel = trailing > 6 ? 0.45 : 0.82
  const focus      = trailing > 6 ? 0.50 : 0.86
  if (pathBlocked) {
    return {
      teamId,
      targetX:    BOARD.holeX + (rng() - 0.5) * 6,
      targetY:    BOARD.holeY,
      power:      0.65,
      spin:       0,
      flightType: trailing > 6 ? 'airmail' : 'roll',
      skillLevel: Math.max(0.40, skillLevel - 0.05),
      focus:      Math.max(0.45, focus - 0.05),
    }
  }
  return {
    teamId,
    targetX:    BOARD.holeX + (rng() - 0.5) * 4,
    targetY:    BOARD.holeY,
    power:      0.65,
    spin:       0,
    flightType: 'flat',
    skillLevel,
    focus,
  }
}
