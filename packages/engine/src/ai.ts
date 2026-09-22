import { BOARD } from './config.js'
import type { AiStyle, Rng, ThrowInput } from './types.js'

// Blocker zone: in front of the hole, bags accumulate points and block the path
const BLOCKER_TARGET_Y = BOARD.holeY - 22

export function aiThrow(
  style: AiStyle,
  scores: [number, number],  // [player, ai]
  rng: Rng,
): ThrowInput {
  const teamId = 1 as const

  if (style === 'blocker') {
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

  // nervenbundel: high accuracy, degrades under pressure
  const trailing   = Math.max(0, scores[0] - scores[1])  // positive = AI losing
  const skillLevel = trailing > 6 ? 0.45 : 0.82
  const focus      = trailing > 6 ? 0.50 : 0.86
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
