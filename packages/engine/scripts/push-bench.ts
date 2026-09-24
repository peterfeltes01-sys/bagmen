/**
 * push-bench.ts -- Messskript fuer den Push-Wurf
 * Ausfuehren: pnpm --filter @cornhole/engine bench:push
 *
 * Misst nur -- kein Code der Engine wird veraendert.
 */

import { createRng }       from '../src/rng.js'
import { BOARD, PHYSICS_DEFAULTS, SCATTER, SLIDE } from '../src/config.js'
import type {
  BagOnBoard, BagSide, SackOutcome,
} from '../src/types.js'

// --------------------------------------------------------------------------
// Typen
// --------------------------------------------------------------------------

interface CollisionEvent {
  step:               number
  throwerId:          string
  targetId:           string
  throwerSpeedBefore: number  // cm/s
  pushedSpeedAfter:   number  // cm/s
  dot:                number
  branch:             'normal' | 'overshoot' | 'skipped_d0'
}

interface StepLog {
  step:    number
  movers:  Array<{ id: string; x: number; y: number; vx: number; vy: number }>
}

interface SlideResult {
  finalPos:   Map<string, { x: number; y: number }>
  collisions: CollisionEvent[]
  steps:      StepLog[]
}

interface ThrowMeasurement {
  thrownOutcome: SackOutcome
  pushedOutcome: SackOutcome | null
  double:        boolean
  collisions:    CollisionEvent[]
  pushDistance:  number
  finalPushedX:  number
  finalPushedY:  number
}

// --------------------------------------------------------------------------
// Instrumentiertes runSlide (spiegelt Engine-Logik, sammelt Kollisionsdaten)
// --------------------------------------------------------------------------

interface Mover { id: string; x: number; y: number; vx: number; vy: number; friction: number }

function runSlideInstrumented(
  thrown:            Mover,
  lyingBags:         readonly BagOnBoard[],
  pushedFriction:    number,
  collisionTransfer: number,
  verboseLog:        boolean,
  logFromStep:       number,
): SlideResult {
  const movers: Mover[] = [{ ...thrown }]
  const statics = new Map(lyingBags.map(b => [b.id, { x: b.x, y: b.y }]))
  const bagD2 = BOARD.bagDiameter * BOARD.bagDiameter
  const collisions: CollisionEvent[] = []
  const steps: StepLog[] = []

  for (let step = 0; step < SLIDE.maxSteps; step++) {
    for (const m of movers) {
      const spd = Math.sqrt(m.vx * m.vx + m.vy * m.vy)
      if (spd < 0.01) continue
      const newSpd = Math.max(0, spd - m.friction * SLIDE.dt)
      const scale  = newSpd / spd
      m.vx *= scale
      m.vy *= scale
      m.x  += m.vx * SLIDE.dt
      m.y  += m.vy * SLIDE.dt
    }

    const spawned: Mover[] = []
    for (const m of movers) {
      const spd = Math.sqrt(m.vx * m.vx + m.vy * m.vy)
      if (spd < 0.01) continue
      for (const [sid, sp] of statics) {
        const dx = sp.x - m.x
        const dy = sp.y - m.y
        if (dx * dx + dy * dy >= bagD2) continue
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < 0.001) {
          collisions.push({ step, throwerId: m.id, targetId: sid,
            throwerSpeedBefore: spd, pushedSpeedAfter: 0, dot: 0,
            branch: 'skipped_d0' })
          continue
        }
        const nx  = dx / d
        const ny  = dy / d
        const dot = m.vx * nx + m.vy * ny
        if (dot <= 0) {
          if (m.y > sp.y && m.vy > 0) {
            const dotR = -dot
            const pushedSpd = dotR * collisionTransfer
            collisions.push({ step, throwerId: m.id, targetId: sid,
              throwerSpeedBefore: spd, pushedSpeedAfter: pushedSpd, dot,
              branch: 'overshoot' })
            spawned.push({
              id: sid, x: sp.x, y: sp.y,
              vx: -dotR * nx * collisionTransfer,
              vy: -dotR * ny * collisionTransfer,
              friction: pushedFriction,
            })
            m.vx += dotR * nx
            m.vy += dotR * ny
            statics.delete(sid)
            break
          }
          continue
        }
        const pushedSpd = dot * collisionTransfer
        collisions.push({ step, throwerId: m.id, targetId: sid,
          throwerSpeedBefore: spd, pushedSpeedAfter: pushedSpd, dot,
          branch: 'normal' })
        spawned.push({
          id: sid, x: sp.x, y: sp.y,
          vx: dot * nx * collisionTransfer,
          vy: dot * ny * collisionTransfer,
          friction: pushedFriction,
        })
        m.vx -= dot * nx
        m.vy -= dot * ny
        statics.delete(sid)
        break
      }
    }
    movers.push(...spawned)

    if (verboseLog && step >= logFromStep) {
      steps.push({
        step,
        movers: movers.map(m => ({ id: m.id, x: m.x, y: m.y, vx: m.vx, vy: m.vy })),
      })
    }

    if (movers.every(m => Math.sqrt(m.vx * m.vx + m.vy * m.vy) < 0.01)) break
  }

  return {
    finalPos: new Map(movers.map(m => [m.id, { x: m.x, y: m.y }])),
    collisions,
    steps,
  }
}

// --------------------------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------------------------

function inHole(x: number, y: number): boolean {
  const dx = x - BOARD.holeX
  const dy = y - BOARD.holeY
  return dx * dx + dy * dy < BOARD.holeRadius * BOARD.holeRadius
}

function onBoard(x: number, y: number): boolean {
  return x >= -BOARD.halfWidth && x <= BOARD.halfWidth && y >= 0 && y <= BOARD.length
}

function resolveOutcome(x: number, y: number): SackOutcome {
  if (inHole(x, y))  return 'in'
  if (onBoard(x, y)) return 'on'
  return 'off'
}

function throwSigma(skillLevel: number, focus: number): number {
  return SCATTER.min + SCATTER.spread * (1 - skillLevel) * (1 - focus * 0.5)
}

// flightVariant: 'roll' (weich, hohe baseV) oder 'flat' (fest/direkt)
function measureThrow(
  blockerBag:    BagOnBoard,
  targetX:       number,
  targetY:       number,
  power:         number,
  offsetX:       number,
  offsetY:       number,
  flightVariant: 'roll' | 'flat' = 'flat',
  verboseLog:    boolean = false,
  logFromStep:   number  = 0,
): ThrowMeasurement & { slideResult: SlideResult } {
  const physics = PHYSICS_DEFAULTS
  const landX   = targetX + offsetX
  const landY   = targetY + offsetY
  const bagId   = 'thrown'

  if (inHole(landX, landY)) {
    return {
      thrownOutcome: 'in', pushedOutcome: null, double: false,
      collisions: [], pushDistance: 0, finalPushedX: blockerBag.x, finalPushedY: blockerBag.y,
      slideResult: { finalPos: new Map(), collisions: [], steps: [] },
    }
  }
  if (!onBoard(landX, landY)) {
    return {
      thrownOutcome: 'off', pushedOutcome: null, double: false,
      collisions: [], pushDistance: 0, finalPushedX: blockerBag.x, finalPushedY: blockerBag.y,
      slideResult: { finalPos: new Map(), collisions: [], steps: [] },
    }
  }

  const baseV = flightVariant === 'roll' ? physics.slideVRoll : physics.slideVFlat
  const v0    = power * baseV
  const thrown: Mover = { id: bagId, x: landX, y: landY, vx: 0, vy: v0, friction: physics.pushFriction }

  const slideResult = runSlideInstrumented(
    thrown, [blockerBag], physics.pushedFriction, physics.collisionTransfer, verboseLog, logFromStep,
  )

  const thrownFinal  = slideResult.finalPos.get(bagId)!
  const blockerFinal = slideResult.finalPos.get(blockerBag.id) ?? { x: blockerBag.x, y: blockerBag.y }

  const thrownOutcome  = resolveOutcome(thrownFinal.x,  thrownFinal.y)
  const pushedOutcome  = resolveOutcome(blockerFinal.x, blockerFinal.y)
  const double         = thrownOutcome === 'in' && pushedOutcome === 'in'
  const pushDistance   = blockerFinal.y - blockerBag.y

  return {
    thrownOutcome, pushedOutcome, double,
    collisions: slideResult.collisions,
    pushDistance,
    finalPushedX: blockerFinal.x,
    finalPushedY: blockerFinal.y,
    slideResult,
  }
}

// --------------------------------------------------------------------------
// Box-Muller (engine-kompatibel)
// --------------------------------------------------------------------------

function boxMullerOffset(rng: () => number, sigma: number): [number, number] {
  const u1 = Math.max(rng(), 1e-10)
  const u2 = rng()
  const r  = Math.sqrt(-2 * Math.log(u1))
  const theta = 2 * Math.PI * u2
  return [r * Math.cos(theta) * sigma, r * Math.sin(theta) * sigma]
}

// --------------------------------------------------------------------------
// Gittersuche
// --------------------------------------------------------------------------

interface GridPoint { targetX: number; targetY: number; power: number }
interface GridResult { params: GridPoint; inRate: number; onRate: number; offRate: number; avgPushDist: number }

function gridSearch(
  blocker:  BagOnBoard,
  variant:  'weich' | 'fest' | 'direkt',
): GridResult {
  const bY = blocker.y
  const bX = blocker.x

  // weich: roll-Flug (hohe Slide-Geschwindigkeit), landet 40-60cm vor Blocker
  // fest:  flat-Flug, 5-15cm vor Blocker, hoehere Power
  // direkt: flat-Flug, Landung auf Blocker
  const flight: 'roll' | 'flat' = variant === 'weich' ? 'roll' : 'flat'

  const targetYRange: number[] =
    variant === 'weich'   ? range(bY - 60, bY - 40, 5) :
    variant === 'fest'    ? range(bY - 15, bY - 5,  2) :
    [bY]

  const targetXRange = range(bX - 10, bX + 10, 5)
  const powerRange   = range(0.3, 1.0, 0.1)

  let best: GridResult = {
    params: { targetX: bX, targetY: bY - 20, power: 0.6 },
    inRate: -1, onRate: 0, offRate: 0, avgPushDist: -1,
  }

  for (const tY of targetYRange) {
    for (const tX of targetXRange) {
      for (const pw of powerRange) {
        // Offset=0: deterministisch, eine Pruefung pro Gitterpunkt
        const m = measureThrow(blocker, tX, tY, pw, 0, 0, flight)
        const inR   = m.pushedOutcome === 'in'  ? 1 : 0
        const onR   = m.pushedOutcome === 'on'  ? 1 : 0
        const offR  = m.pushedOutcome === 'off' ? 1 : 0
        const pushD = m.pushDistance
        if (
          inR > best.inRate ||
          (inR === best.inRate && pushD > best.avgPushDist)
        ) {
          best = { params: { targetX: tX, targetY: tY, power: pw }, inRate: inR, onRate: onR, offRate: offR, avgPushDist: pushD }
        }
      }
    }
  }
  return best
}

// --------------------------------------------------------------------------
// Streuungs-Lauf
// --------------------------------------------------------------------------

interface ScatterStats {
  pushed:  { in: number; on: number; off: number; noContact: number }
  thrown:  { in: number; on: number; off: number }
  doubles: number
  n:       number
  throwerSpeedAtContact:   number[]
  pushedSpeedAfterContact: number[]
  pushDistances:           number[]
}

function scatterRun(
  blocker:    BagOnBoard,
  params:     GridPoint,
  variant:    'weich' | 'fest' | 'direkt',
  nThrows:    number,
  skillLevel: number,
  focus:      number,
): ScatterStats {
  const flight: 'roll' | 'flat' = variant === 'weich' ? 'roll' : 'flat'
  const stats: ScatterStats = {
    pushed:  { in: 0, on: 0, off: 0, noContact: 0 },
    thrown:  { in: 0, on: 0, off: 0 },
    doubles: 0,
    n:       nThrows,
    throwerSpeedAtContact:   [],
    pushedSpeedAfterContact: [],
    pushDistances:           [],
  }
  const sigma = throwSigma(skillLevel, focus)

  for (let seed = 0; seed < nThrows; seed++) {
    const rng = createRng(seed)
    rng()  // bag-ID draw (mirrors simulateThrow)
    const [ox, oy] = boxMullerOffset(rng, sigma)
    const m = measureThrow(blocker, params.targetX, params.targetY, params.power, ox, oy, flight)

    if      (m.thrownOutcome === 'in')  stats.thrown.in++
    else if (m.thrownOutcome === 'on')  stats.thrown.on++
    else                                stats.thrown.off++

    if (m.pushedOutcome === null)       stats.pushed.noContact++
    else if (m.pushedOutcome === 'in')  stats.pushed.in++
    else if (m.pushedOutcome === 'on')  stats.pushed.on++
    else                                stats.pushed.off++

    if (m.double) stats.doubles++

    const firstCol = m.collisions.find(c => c.branch !== 'skipped_d0' && c.pushedSpeedAfter > 0)
    if (firstCol) {
      stats.throwerSpeedAtContact.push(firstCol.throwerSpeedBefore)
      stats.pushedSpeedAfterContact.push(firstCol.pushedSpeedAfter)
      stats.pushDistances.push(m.pushDistance)
    }
  }
  return stats
}

// --------------------------------------------------------------------------
// Formatierung
// --------------------------------------------------------------------------

function pct(n: number, total: number): string {
  return total === 0 ? ' n/a ' : `${((n / total) * 100).toFixed(1).padStart(5)}%`
}

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length
}

function range(from: number, to: number, step: number): number[] {
  const r: number[] = []
  for (let v = from; v <= to + 1e-9; v += step) r.push(Math.round(v * 1000) / 1000)
  return r
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals)
}

// --------------------------------------------------------------------------
// Szenarien
// --------------------------------------------------------------------------

interface Scenario {
  blockerDist:   number
  lateralOffset: number
  bagSide:       BagSide
}

const SCENARIOS: Scenario[] = [
  { blockerDist: 15, lateralOffset:  0, bagSide: 'fast' },
  { blockerDist: 15, lateralOffset:  0, bagSide: 'slow' },
  { blockerDist: 15, lateralOffset:  5, bagSide: 'fast' },
  { blockerDist: 15, lateralOffset:  5, bagSide: 'slow' },
  { blockerDist: 15, lateralOffset: -5, bagSide: 'fast' },
  { blockerDist: 15, lateralOffset: -5, bagSide: 'slow' },
  { blockerDist: 25, lateralOffset:  0, bagSide: 'fast' },
  { blockerDist: 25, lateralOffset:  0, bagSide: 'slow' },
  { blockerDist: 25, lateralOffset:  5, bagSide: 'fast' },
  { blockerDist: 25, lateralOffset:  5, bagSide: 'slow' },
  { blockerDist: 25, lateralOffset: -5, bagSide: 'fast' },
  { blockerDist: 25, lateralOffset: -5, bagSide: 'slow' },
  { blockerDist: 35, lateralOffset:  0, bagSide: 'fast' },
  { blockerDist: 35, lateralOffset:  0, bagSide: 'slow' },
  { blockerDist: 35, lateralOffset:  5, bagSide: 'fast' },
  { blockerDist: 35, lateralOffset:  5, bagSide: 'slow' },
  { blockerDist: 35, lateralOffset: -5, bagSide: 'fast' },
  { blockerDist: 35, lateralOffset: -5, bagSide: 'slow' },
]

const VARIANTS = ['weich', 'fest', 'direkt'] as const
type Variant = typeof VARIANTS[number]

const SCATTER_N   = 1000
const SKILL_LEVEL = 0.9
const FOCUS       = 1.0

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
  const ph = PHYSICS_DEFAULTS
  const maxSlideFlat = ph.slideVFlat  * ph.slideVFlat  / (2 * ph.pushFriction)
  const maxSlideRoll = ph.slideVRoll  * ph.slideVRoll  / (2 * ph.pushFriction)

  console.log('='.repeat(80))
  console.log('PUSH-BENCH  --  Cornhole Engine Messskript')
  console.log(`Board: Loch bei y=${BOARD.holeY}cm, x=${BOARD.holeX}cm  |  bagDiameter=${BOARD.bagDiameter}cm`)
  console.log(`Scatter: ${SCATTER_N} Wuerfe, skill=${SKILL_LEVEL}, focus=${FOCUS}, sigma=${throwSigma(SKILL_LEVEL,FOCUS).toFixed(1)}cm`)
  console.log(`Max Slide: flat @ pw=1.0 -> ${maxSlideFlat.toFixed(0)}cm  |  roll @ pw=1.0 -> ${maxSlideRoll.toFixed(0)}cm`)
  console.log(`  weich=roll, fest=flat, direkt=flat`)
  console.log('='.repeat(80))
  console.log()

  let bestWeichCombo: { blocker: BagOnBoard; params: GridPoint; avgPushDist: number } | null = null
  const anomalies: string[] = []

  for (const sc of SCENARIOS) {
    const blockerY = BOARD.holeY - sc.blockerDist
    const blockerX = sc.lateralOffset
    const blocker: BagOnBoard = {
      id: 'blocker', teamId: 1, x: blockerX, y: blockerY, side: sc.bagSide,
    }

    const header = `dist=${sc.blockerDist}cm  offset=${sc.lateralOffset >= 0 ? '+' : ''}${sc.lateralOffset}cm  side=${sc.bagSide}  |  blockery=${blockerY}cm`
    console.log('+' + '-'.repeat(79))
    console.log(`| Szenario: ${header}`)
    console.log('+' + '-'.repeat(79))
    console.log('| Variante | pushed in/on/off        | thrown in/on/off        | double | v_throw | v_push | ratio | Dy cm')
    console.log('+' + '-'.repeat(79))

    for (const variant of VARIANTS) {
      const grid = gridSearch(blocker, variant)
      const ss   = scatterRun(blocker, grid.params, variant, SCATTER_N, SKILL_LEVEL, FOCUS)

      const noContact = ss.pushed.noContact

      const pushedIn  = pct(ss.pushed.in,  SCATTER_N)
      const pushedOn  = pct(ss.pushed.on,  SCATTER_N)
      const pushedOff = pct(ss.pushed.off, SCATTER_N)
      const thrownIn  = pct(ss.thrown.in,  SCATTER_N)
      const thrownOn  = pct(ss.thrown.on,  SCATTER_N)
      const thrownOff = pct(ss.thrown.off, SCATTER_N)
      const dbl       = pct(ss.doubles,    SCATTER_N)

      const vThrow   = avg(ss.throwerSpeedAtContact)
      const vPush    = avg(ss.pushedSpeedAfterContact)
      const ratio    = vThrow > 0 ? vPush / vThrow : 0
      const avgDelta = avg(ss.pushDistances)

      const p = grid.params
      console.log(
        `| ${variant.padEnd(7)}  |` +
        ` in=${pushedIn} on=${pushedOn} off=${pushedOff} |` +
        ` in=${thrownIn} on=${thrownOn} off=${thrownOff} |` +
        ` ${dbl} |` +
        ` ${fmt(vThrow).padStart(6)} |` +
        ` ${fmt(vPush).padStart(5)} |` +
        ` ${fmt(ratio, 2).padStart(5)} |` +
        ` ${fmt(avgDelta).padStart(5)}`
      )
      console.log(
        `|          |  (kein Kontakt: ${noContact}/${SCATTER_N})` +
        `  beste Params: tX=${fmt(p.targetX)} tY=${fmt(p.targetY)} pw=${fmt(p.power,2)}`
      )

      if (noContact > SCATTER_N * 0.5) {
        anomalies.push(`[${sc.blockerDist}/${sc.lateralOffset}/${sc.bagSide}/${variant}] Kein Kontakt in ${noContact}/${SCATTER_N} Wuerfen`)
      }
      if (vThrow > 5 && ratio < 0.1) {
        anomalies.push(`[${sc.blockerDist}/${sc.lateralOffset}/${sc.bagSide}/${variant}] Impuls verpufft: v_throw=${fmt(vThrow)} cm/s -> v_push=${fmt(vPush)} cm/s`)
      }
      const totalPushed = SCATTER_N - noContact
      if (ss.pushed.in === 0 && totalPushed > SCATTER_N * 0.2) {
        anomalies.push(`[${sc.blockerDist}/${sc.lateralOffset}/${sc.bagSide}/${variant}] Blocker bewegt (${totalPushed}x) aber nie ins Loch`)
      }

      if (variant === 'weich') {
        const pushDist = avg(ss.pushDistances)
        if (bestWeichCombo === null || pushDist > bestWeichCombo.avgPushDist) {
          bestWeichCombo = { blocker, params: grid.params, avgPushDist: pushDist }
        }
      }
    }

    console.log('+' + '-'.repeat(79))
    console.log()
  }

  // --- Auffaelligkeiten ---

  console.log('='.repeat(80))
  console.log('AUFFAELLIGKEITEN')
  console.log('='.repeat(80))
  if (anomalies.length === 0) {
    console.log('  Keine erkannt.')
  } else {
    for (const a of anomalies) console.log('  !!  ' + a)
  }
  console.log()

  // --- Kollisions-Branch-Analyse ---

  console.log('='.repeat(80))
  console.log('KOLLISIONS-BRANCH-ANALYSE (100 Seeds, beste Params)')
  console.log('  Zeigt nur Szenarien mit Overshoot- oder d0-Treffer.')
  console.log('='.repeat(80))
  let branchFound = false
  for (const sc of SCENARIOS.filter(s => s.bagSide === 'fast')) {
    const blockerY = BOARD.holeY - sc.blockerDist
    const blocker: BagOnBoard = { id: 'blocker', teamId: 1, x: sc.lateralOffset, y: blockerY, side: sc.bagSide }
    for (const variant of VARIANTS) {
      const grid = gridSearch(blocker, variant)
      const flight: 'roll' | 'flat' = variant === 'weich' ? 'roll' : 'flat'
      let normal = 0, overshoot = 0, skipped = 0, noCol = 0
      const sigma = throwSigma(SKILL_LEVEL, FOCUS)
      for (let seed = 0; seed < 100; seed++) {
        const rng = createRng(seed)
        rng()
        const [ox, oy] = boxMullerOffset(rng, sigma)
        const m = measureThrow(blocker, grid.params.targetX, grid.params.targetY, grid.params.power, ox, oy, flight)
        if (m.collisions.length === 0) { noCol++; continue }
        const first = m.collisions[0]
        if      (first.branch === 'normal')    normal++
        else if (first.branch === 'overshoot') overshoot++
        else                                   skipped++
      }
      if (overshoot > 0 || skipped > 0) {
        branchFound = true
        console.log(`  dist=${sc.blockerDist}cm off=${sc.lateralOffset} ${variant}: normal=${normal} overshoot=${overshoot} skipped_d0=${skipped} noContact=${noCol}`)
      }
    }
  }
  if (!branchFound) console.log('  (kein Overshoot- oder d0-Branch gefeuert)')
  console.log()

  // --- Debug: 10 Einzelwuerfe bester weich-Kombination ---

  if (!bestWeichCombo) {
    console.log('(kein weich-Treffer gefunden)')
    return
  }

  const { blocker: dbBlocker, params: dbParams } = bestWeichCombo
  const sigma = throwSigma(SKILL_LEVEL, FOCUS)
  const flight: 'roll' | 'flat' = 'roll'
  const baseVDebug = PHYSICS_DEFAULTS.slideVRoll

  console.log('='.repeat(80))
  console.log('DEBUG: 10 Einzelwuerfe -- beste weich-Kombination (roll)')
  console.log(`  Blocker: y=${dbBlocker.y}cm x=${dbBlocker.x}cm side=${dbBlocker.side}`)
  console.log(`  Params:  targetX=${fmt(dbParams.targetX)} targetY=${fmt(dbParams.targetY)} power=${fmt(dbParams.power,2)}  (v0=${fmt(dbParams.power*baseVDebug)} cm/s)`)
  console.log(`  sigma=${sigma.toFixed(1)}cm  maxSlide=${fmt(dbParams.power*baseVDebug*(dbParams.power*baseVDebug)/(2*PHYSICS_DEFAULTS.pushFriction))}cm`)
  console.log('='.repeat(80))

  for (let seed = 0; seed < 10; seed++) {
    const rng = createRng(seed)
    rng()
    const [ox, oy] = boxMullerOffset(rng, sigma)
    const landX = dbParams.targetX + ox
    const landY = dbParams.targetY + oy

    const approxContactStep = Math.max(0,
      Math.floor((dbBlocker.y - landY - BOARD.bagDiameter) / (dbParams.power * baseVDebug * SLIDE.dt)) - 3
    )

    if (!onBoard(landX, landY)) {
      console.log(`  Wurf ${seed}: Landung ausserhalb Board (${fmt(landX)},${fmt(landY)}) -- uebersprungen`)
      continue
    }

    const v0 = dbParams.power * baseVDebug
    const thrown: Mover = { id: 'thrown', x: landX, y: landY, vx: 0, vy: v0, friction: PHYSICS_DEFAULTS.pushFriction }
    const sr = runSlideInstrumented(
      thrown, [dbBlocker], PHYSICS_DEFAULTS.pushedFriction, PHYSICS_DEFAULTS.collisionTransfer,
      true, approxContactStep,
    )

    const thrownFinal  = sr.finalPos.get('thrown')  ?? { x: landX, y: landY }
    const blockerFinal = sr.finalPos.get('blocker') ?? { x: dbBlocker.x, y: dbBlocker.y }
    const thrownOc     = resolveOutcome(thrownFinal.x,  thrownFinal.y)
    const pushedOc     = resolveOutcome(blockerFinal.x, blockerFinal.y)

    console.log()
    console.log(`  -- Wurf ${seed}  Landung=(${fmt(landX)},${fmt(landY)})  thrown=${thrownOc}  pushed=${pushedOc}  Dy=${fmt(blockerFinal.y - dbBlocker.y)}cm --`)

    if (sr.collisions.length === 0) {
      console.log(`     !! KEIN Kollisionsevent`)
    } else {
      for (const c of sr.collisions) {
        console.log(`     Kollision step=${c.step} branch=${c.branch} dot=${fmt(c.dot,2)} v_throw_before=${fmt(c.throwerSpeedBefore)} v_push_after=${fmt(c.pushedSpeedAfter)}`)
      }
    }

    for (const sl of sr.steps.slice(0, 20)) {
      const thr = sl.movers.find(m => m.id === 'thrown')
      const psh = sl.movers.find(m => m.id === 'blocker')
      const dist = (thr && psh)
        ? ` d=${fmt(Math.hypot(psh.x-thr.x, psh.y-thr.y),1)}cm`
        : ''
      if (thr) console.log(`     step ${String(sl.step).padStart(3)}: thrown pos=(${fmt(thr.x,1)},${fmt(thr.y,1)}) v=(${fmt(thr.vx,1)},${fmt(thr.vy,1)}) spd=${fmt(Math.hypot(thr.vx,thr.vy),1)}${dist}`)
      if (psh) console.log(`            pushed pos=(${fmt(psh.x,1)},${fmt(psh.y,1)}) v=(${fmt(psh.vx,1)},${fmt(psh.vy,1)}) spd=${fmt(Math.hypot(psh.vx,psh.vy),1)}`)
    }

    const lastLog = sr.steps[sr.steps.length - 1]
    if (lastLog) {
      for (const m of lastLog.movers) {
        const spd = Math.hypot(m.vx, m.vy)
        const reason = spd < 0.01 ? 'gestoppt (v<0.01)' : !onBoard(m.x,m.y) ? 'off-Board' : inHole(m.x,m.y) ? 'im Loch' : 'maxSteps?'
        console.log(`     END ${m.id}: pos=(${fmt(m.x,1)},${fmt(m.y,1)}) spd=${fmt(spd,2)} -> ${reason}`)
      }
    }
  }

  console.log()
  console.log('='.repeat(80))
  console.log('FERTIG')
  console.log('='.repeat(80))
}

main()
