import { PHYSICS, PhysicsConfig } from './config.js'
import { ThrowParams, Trajectory, BagOutcome } from './types.js'
import { createRng } from './rng.js'

interface SimResult {
  trajectory: Trajectory
  outcome: BagOutcome
  landingX: number
  landingY: number
}

export function simulateThrow(
  params: ThrowParams,
  seed: number,
  config: PhysicsConfig = PHYSICS,
): SimResult {
  const rng = createRng(seed)
  const jitter = (scale: number) => (rng() - 0.5) * scale

  const speed = config.minSpeed + params.speed * (config.maxSpeed - config.minSpeed)
  const ha = params.angle + jitter(0.04)
  const la = (0.3 + params.loft * 0.4) * (Math.PI / 2)

  let vx = speed * Math.sin(ha)
  let vy = speed * Math.cos(ha) * Math.cos(la)
  let vz = speed * Math.sin(la)

  // Weltkoordinaten: Spieler bei y=0, Brettnähkante bei y=throwingDistance
  let px = jitter(0.05)
  let py = 0.0
  let pz = 1.0

  const trajectory: Trajectory = [{ x: px, y: py, z: pz, t: 0 }]

  for (let i = 1; i <= config.trajectorySteps; i++) {
    const t = i * config.dt
    const spd = Math.sqrt(vx * vx + vy * vy + vz * vz)
    const drag = config.airResistance * spd

    vx -= drag * vx * config.dt
    vy -= drag * vy * config.dt
    vz -= (config.gravity + drag * vz) * config.dt

    px += vx * config.dt
    py += vy * config.dt
    pz += vz * config.dt

    trajectory.push({ x: px, y: py, z: pz, t })

    if (pz <= 0.02 && i > 5) break
  }

  const last = trajectory[trajectory.length - 1]

  // Brett: y ∈ [throwingDistance, throwingDistance + boardLength]
  //        x ∈ [-boardWidth/2, boardWidth/2]
  const bY0 = config.throwingDistance
  const bY1 = config.throwingDistance + config.boardLength

  const xNorm = (last.x + config.boardWidth / 2) / config.boardWidth
  const yNorm = (last.y - bY0) / (bY1 - bY0)

  const onBoard = xNorm >= 0 && xNorm <= 1 && yNorm >= 0 && yNorm <= 1

  const dx = xNorm - config.holeX
  const dy = yNorm - config.holeY
  const holeRNorm = config.holeRadius / config.boardWidth
  const distToHole = Math.sqrt(dx * dx + dy * dy)

  let outcome: BagOutcome
  if (onBoard && distToHole < holeRNorm + config.holeTolerance) {
    outcome = 'hole'
  } else if (onBoard) {
    outcome = 'board'
  } else {
    outcome = 'miss'
  }

  return {
    trajectory,
    outcome,
    landingX: Math.max(0, Math.min(1, xNorm)),
    landingY: Math.max(0, Math.min(1, yNorm)),
  }
}
