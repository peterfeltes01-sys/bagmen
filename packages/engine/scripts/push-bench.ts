/**
 * push-bench.ts — Parameter-Sweep fuer den Push-Wurf
 * Ausfuehren: pnpm --filter @cornhole/engine bench:push
 *
 * Nur messen — Engine-Code und config.ts bleiben unveraendert.
 *
 * Sweep: slideVFlat × slideVRoll × pushFriction (4×4×4 = 64 Kombos)
 * Szenarien je Kombo:
 *   slide-scat   : flat, kein Blocker, Streuung guter Spieler
 *   push25-no    : roll (weich), Blocker 25 cm vor Loch, sigma=0 (deterministisch)
 *   push25-scat  : roll, Blocker 25 cm, Streuung
 *   push35-no    : flat (fest), Blocker 35 cm vor Loch, sigma=0
 *   push35-scat  : flat, Blocker 35 cm, Streuung
 */

import { createRng }                               from '../src/rng.js'
import { BOARD, PHYSICS_DEFAULTS, SCATTER, SLIDE } from '../src/config.js'
import type { BagOnBoard, SackOutcome }             from '../src/types.js'

// ── Sweep-Gitter ──────────────────────────────────────────────────────────────
const VFLAT_GRID    = [80, 120, 180, 250] as const   // slideVFlat  cm/s
const VROLL_GRID    = [80, 120, 180, 250] as const   // slideVRoll  cm/s
const FRICTION_GRID = [250, 320, 390, 450] as const  // pushFriction cm/s²

const N_THROWS  = 200   // Würfe pro Scatter-Szenario
const THROW_PWR = 0.8   // Standard-Wurfstärke

// ── Typen ─────────────────────────────────────────────────────────────────────

interface Po { slideVFlat: number; slideVRoll: number; pushFriction: number }
interface Mv { id: string; x: number; y: number; vx: number; vy: number; friction: number }
interface Gp { tx: number; ty: number; pw: number }

interface SimResult {
  thrownOutcome: SackOutcome
  pushedOutcome: SackOutcome | null
  contacted:     boolean
  pushedDy:      number   // Δy des geschobenen Sacks (cm)
}

interface RunStats {
  inRate:      number
  offRate:     number
  onRate:      number
  contactRate: number
  avgPushDy:   number
}

interface ComboResult {
  vFlat:       number
  vRoll:       number
  friction:    number
  slideFlat:   number      // analytische Rutschweite, flat, power=0.8 (cm)
  slideScat:   RunStats    // slide-Szenario mit Streuung
  push25Gp:    Gp
  push25No:    SimResult   // deterministisch (sigma=0)
  push25Scat:  RunStats
  push35Gp:    Gp
  push35No:    SimResult
  push35Scat:  RunStats
  score:       number      // max 13
}

// ── Slide-Simulation ──────────────────────────────────────────────────────────
// Vereinfachte Version der Engine-Logik (keine CCD), fuer Messzwecke.
// pushedFriction und collisionTransfer kommen aus PHYSICS_DEFAULTS.

function runSlide(
  thrown:  Mv,
  statics: readonly BagOnBoard[],
  po:      Po,
): Map<string, { x: number; y: number }> {
  const movers: Mv[] = [{ ...thrown }]
  const stat   = new Map(statics.map(b => [b.id, { x: b.x, y: b.y }]))
  const R2     = BOARD.bagDiameter * BOARD.bagDiameter
  const pf     = PHYSICS_DEFAULTS.pushedFriction
  const ct     = PHYSICS_DEFAULTS.collisionTransfer

  for (let step = 0; step < SLIDE.maxSteps; step++) {
    // Reibung + Bewegung
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      const fac = Math.max(0, spd - m.friction * SLIDE.dt) / spd
      m.vx *= fac; m.vy *= fac
      m.x  += m.vx * SLIDE.dt
      m.y  += m.vy * SLIDE.dt
    }

    // Kollisionserkennung
    const spawned: Mv[] = []
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      for (const [sid, sp] of stat) {
        const dx = sp.x - m.x, dy = sp.y - m.y
        if (dx * dx + dy * dy >= R2) continue
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < 0.001) { stat.delete(sid); break }
        const nx = dx / d, ny = dy / d
        const dot = m.vx * nx + m.vy * ny
        if (dot > 0) {
          // Normale Kollision
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: dot*nx*ct, vy: dot*ny*ct, friction: pf })
          m.vx -= dot * nx; m.vy -= dot * ny
        } else if (m.y > sp.y && m.vy > 0) {
          // Overshoot-Branch
          const dr = -dot
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: -dr*nx*ct, vy: -dr*ny*ct, friction: pf })
          m.vx += dr * nx; m.vy += dr * ny
        } else continue
        stat.delete(sid); break
      }
    }
    movers.push(...spawned)
    if (movers.every(m => Math.hypot(m.vx, m.vy) < 0.01)) break
  }
  return new Map(movers.map(m => [m.id, { x: m.x, y: m.y }]))
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const ih = (x: number, y: number) =>
  (x - BOARD.holeX) ** 2 + (y - BOARD.holeY) ** 2 < BOARD.holeRadius ** 2
const ob = (x: number, y: number) =>
  x >= -BOARD.halfWidth && x <= BOARD.halfWidth && y >= 0 && y <= BOARD.length
const oc = (x: number, y: number): SackOutcome =>
  ih(x, y) ? 'in' : ob(x, y) ? 'on' : 'off'

function throwSigma(): number {
  // skill=0.9, focus=1.0
  return SCATTER.min + SCATTER.spread * (1 - 0.9) * (1 - 1.0 * 0.5)
}

function boxMuller(rng: () => number, sig: number): [number, number] {
  const u1 = Math.max(rng(), 1e-10), u2 = rng()
  const r   = Math.sqrt(-2 * Math.log(u1))
  return [r * Math.cos(2 * Math.PI * u2) * sig, r * Math.sin(2 * Math.PI * u2) * sig]
}

function numRange(from: number, to: number, step: number): number[] {
  const a: number[] = []
  for (let v = from; v <= to + 1e-9; v += step) a.push(+(v.toFixed(4)))
  return a
}

function avgArr(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
}

// ── Einzelwurf ───────────────────────────────────────────────────────────────

function sim(
  statics: BagOnBoard[],
  lx: number, ly: number,
  pw: number,
  fl: 'flat' | 'roll',
  po: Po,
): SimResult {
  if (ih(lx, ly))  return { thrownOutcome: 'in',  pushedOutcome: null, contacted: false, pushedDy: 0 }
  if (!ob(lx, ly)) return { thrownOutcome: 'off', pushedOutcome: null, contacted: false, pushedDy: 0 }

  const v0    = pw * (fl === 'roll' ? po.slideVRoll : po.slideVFlat)
  const mover: Mv = { id: 'T', x: lx, y: ly, vx: 0, vy: v0, friction: po.pushFriction }
  const fin   = runSlide(mover, statics, po)
  const tf    = fin.get('T') ?? { x: lx, y: ly }

  if (statics.length === 0) {
    return { thrownOutcome: oc(tf.x, tf.y), pushedOutcome: null, contacted: false, pushedDy: tf.y - ly }
  }

  const b   = statics[0]
  const bf  = fin.get(b.id)
  return {
    thrownOutcome: oc(tf.x, tf.y),
    pushedOutcome: oc((bf ?? b).x, (bf ?? b).y),
    contacted:     bf !== undefined,
    pushedDy:      bf ? bf.y - b.y : 0,
  }
}

// ── Grid-Suche ────────────────────────────────────────────────────────────────

function gridSearch(blocker: BagOnBoard, fl: 'flat' | 'roll', po: Po): Gp {
  const bY = blocker.y, bX = blocker.x
  // roll/weich: Landung 40-60cm vor Blocker; flat/fest: 5-15cm vor Blocker
  const tyRange = fl === 'roll'
    ? numRange(bY - 60, bY - 40, 5)
    : numRange(bY - 15, bY - 5,  2)
  const txRange = numRange(bX - 10, bX + 10, 5)
  const pwRange = numRange(0.3, 1.0, 0.1)

  let best: Gp = { tx: bX, ty: bY - 20, pw: 0.6 }
  let bestIn = -1, bestDy = -1

  for (const ty of tyRange) for (const tx of txRange) for (const pw of pwRange) {
    const r   = sim([blocker], tx, ty, pw, fl, po)
    const inR = r.pushedOutcome === 'in' ? 1 : 0
    if (inR > bestIn || (inR === bestIn && r.pushedDy > bestDy)) {
      best = { tx, ty, pw }; bestIn = inR; bestDy = r.pushedDy
    }
  }
  return best
}

// ── Scatter-Lauf ─────────────────────────────────────────────────────────────

function scatterRun(
  statics: BagOnBoard[],
  gp:     Gp,
  fl:     'flat' | 'roll',
  sig:    number,
  po:     Po,
): RunStats {
  let inn = 0, off = 0, on = 0, contact = 0
  const dyArr: number[] = []

  for (let seed = 0; seed < N_THROWS; seed++) {
    const rng       = createRng(seed)
    rng()           // bag-ID draw (spiegelt simulateThrow)
    const [ox, oy]  = boxMuller(rng, sig)
    const r         = sim(statics, gp.tx + ox, gp.ty + oy, gp.pw, fl, po)

    // slide-Szenario: thrownOutcome messen; push-Szenario: pushedOutcome
    const out = statics.length === 0 ? r.thrownOutcome : r.pushedOutcome
    if      (out === 'in')  inn++
    else if (out === 'on')  on++
    else if (out === 'off') off++

    if (r.contacted) { contact++; dyArr.push(r.pushedDy) }
  }
  return {
    inRate:      inn     / N_THROWS,
    offRate:     off     / N_THROWS,
    onRate:      on      / N_THROWS,
    contactRate: contact / N_THROWS,
    avgPushDy:   avgArr(dyArr),
  }
}

// ── Kombo-Berechnung ──────────────────────────────────────────────────────────

const BLOCKER25: BagOnBoard = { id: 'B25', teamId: 1, x: 0, y: BOARD.holeY - 25, side: 'slow' }
const BLOCKER35: BagOnBoard = { id: 'B35', teamId: 1, x: 0, y: BOARD.holeY - 35, side: 'slow' }

function runCombo(po: Po): ComboResult {
  const sig = throwSigma()

  // Analytische Rutschweite flat, power=0.8 (kein Blocker, kein Streuung)
  const slideFlat = (THROW_PWR * po.slideVFlat) ** 2 / (2 * po.pushFriction)

  // slide-scat: Ziel = Loch, flat, Streuung
  const slideGp: Gp  = { tx: BOARD.holeX, ty: BOARD.holeY, pw: THROW_PWR }
  const slideScat    = scatterRun([], slideGp, 'flat', sig, po)

  // push25: roll (weich), Blocker 25 cm vor Loch
  const push25Gp   = gridSearch(BLOCKER25, 'roll', po)
  const push25No   = sim([BLOCKER25], push25Gp.tx, push25Gp.ty, push25Gp.pw, 'roll', po)
  const push25Scat = scatterRun([BLOCKER25], push25Gp, 'roll', sig, po)

  // push35: flat (fest), Blocker 35 cm vor Loch
  const push35Gp   = gridSearch(BLOCKER35, 'flat', po)
  const push35No   = sim([BLOCKER35], push35Gp.tx, push35Gp.ty, push35Gp.pw, 'flat', po)
  const push35Scat = scatterRun([BLOCKER35], push35Gp, 'flat', sig, po)

  const base = {
    vFlat: po.slideVFlat, vRoll: po.slideVRoll, friction: po.pushFriction,
    slideFlat, slideScat,
    push25Gp, push25No, push25Scat,
    push35Gp, push35No, push35Scat,
  }
  return { ...base, score: calcScore(base as ComboResult) }
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// Max 13 Punkte

function calcScore(r: ComboResult): number {
  let s = 0
  // slide-scat In-Rate 30–50 %
  if (r.slideScat.inRate  >= 0.30 && r.slideScat.inRate  <= 0.50) s += 2
  // Rutschweite 30–60 cm
  if (r.slideFlat          >= 30   && r.slideFlat          <= 60)   s += 1
  // push25 ohne Streuung: Blocker landet im Loch
  if (r.push25No.pushedOutcome === 'in')                            s += 2
  // push25 mit Streuung: In-Rate 20–40 %
  if (r.push25Scat.inRate >= 0.20 && r.push25Scat.inRate  <= 0.40) s += 2
  // push35 ohne Streuung
  if (r.push35No.pushedOutcome === 'in')                            s += 2
  // push35 mit Streuung: In-Rate 15–35 %
  if (r.push35Scat.inRate >= 0.15 && r.push35Scat.inRate  <= 0.35) s += 2
  // push35 mit Streuung: Off-Rate 10–25 %
  if (r.push35Scat.offRate >= 0.10 && r.push35Scat.offRate <= 0.25) s += 1
  // weich schiebt seltener vom Brett als fest
  if (r.push25Scat.offRate < r.push35Scat.offRate)                  s += 1
  return s
}

// ── Ausgabe ───────────────────────────────────────────────────────────────────

const p  = (r: number)             => (r * 100).toFixed(1) + '%'
const f  = (n: number, d = 1)      => n.toFixed(d)
const yn = (b: boolean)            => b ? '✓' : '✗'

function printTable(results: ComboResult[]): void {
  const top = [...results].sort((a, b) => b.score - a.score).slice(0, 5)

  const SEP = '─'.repeat(116)
  console.log('\n' + '='.repeat(116))
  console.log('TOP 5 KOMBINATIONEN  (Zielwerte: slide 30–50 %; slide_cm 30–60; push25-no ✓ >60%; push25-scat 20–40%; push35-no ✓ >50%; push35-scat 15–35%; push35-off 10–25%)')
  console.log('='.repeat(116))
  console.log(
    'Rk | vFlat | vRoll | Fric |  slide_cm | slide-scat | push25-no | push25-sc | push25-off | push35-no | push35-sc | push35-off | Pkt'
  )
  console.log(SEP)

  for (let i = 0; i < top.length; i++) {
    const r = top[i]
    console.log(
      ` ${i + 1} |` +
      `  ${String(r.vFlat).padStart(4)} |` +
      `  ${String(r.vRoll).padStart(4)} |` +
      ` ${String(r.friction).padStart(4)} |` +
      ` ${f(r.slideFlat, 1).padStart(8)}cm |` +
      `    ${p(r.slideScat.inRate).padStart(6)} |` +
      `       ${yn(r.push25No.pushedOutcome === 'in')} |` +
      `   ${p(r.push25Scat.inRate).padStart(6)} |` +
      `     ${p(r.push25Scat.offRate).padStart(6)} |` +
      `       ${yn(r.push35No.pushedOutcome === 'in')} |` +
      `   ${p(r.push35Scat.inRate).padStart(6)} |` +
      `     ${p(r.push35Scat.offRate).padStart(6)} |` +
      `  ${r.score}`
    )
    console.log(
      `   |       |       |      |` +
      `  push25 best: tX=${f(r.push25Gp.tx)} tY=${f(r.push25Gp.ty)} pw=${f(r.push25Gp.pw, 2)}` +
      `  |  push35 best: tX=${f(r.push35Gp.tx)} tY=${f(r.push35Gp.ty)} pw=${f(r.push35Gp.pw, 2)}`
    )
  }
  console.log('='.repeat(116))
}

function printJson(results: ComboResult[]): void {
  const top = [...results].sort((a, b) => b.score - a.score).slice(0, 5)
  console.log('\n── JSON (Debug-Panel-Export) ──────────────────────────────────────────')
  const out = top.map((r, i) => ({
    _rank:        i + 1,
    _score:       r.score,
    _slideCm:     +f(r.slideFlat),
    _slideScatIn: p(r.slideScat.inRate),
    _p25ScatIn:   p(r.push25Scat.inRate),
    _p35ScatIn:   p(r.push35Scat.inRate),
    ...PHYSICS_DEFAULTS,
    slideVFlat:   r.vFlat,
    slideVRoll:   r.vRoll,
    pushFriction: r.friction,
  }))
  console.log(JSON.stringify(out, null, 2))
}

// ── Instrumentierte Slide-Simulation für Detailanalyse ───────────────────────

interface ContactCapture {
  seed:          number
  landX:         number
  landY:         number
  lateralOff:    number   // m.x − blocker.x am Kontaktpunkt (vx=0 → konstant = landX−blockerX)
  thrownYContact: number  // y der geworfenen Tasche am Kontaktmoment
  dot:           number   // Geschwindigkeit in Normalrichtung (Schubkomponente)
  pushAngleDeg:  number   // Winkel Schubrichtung von "geradeaus" in °  (0=vorwärts, 90=seitlich)
  initPushSpd:   number   // Anfangsschubgeschwindigkeit des Blockers (cm/s)
  finalPushedX:  number
  finalPushedY:  number
  pushedDy:      number   // Δy des Blockers (cm)
  outcome:       SackOutcome
}

function runSlideCapture(
  thrown:  Mv,
  blocker: BagOnBoard,
  po:      Po,
): ContactCapture | null {
  const movers: Mv[] = [{ ...thrown }]
  const stat   = new Map([[blocker.id, { x: blocker.x, y: blocker.y }]])
  const R2     = BOARD.bagDiameter * BOARD.bagDiameter
  const pf     = PHYSICS_DEFAULTS.pushedFriction
  const ct     = PHYSICS_DEFAULTS.collisionTransfer
  let cap: ContactCapture | null = null

  for (let step = 0; step < SLIDE.maxSteps; step++) {
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      const fac = Math.max(0, spd - m.friction * SLIDE.dt) / spd
      m.vx *= fac; m.vy *= fac
      m.x  += m.vx * SLIDE.dt; m.y += m.vy * SLIDE.dt
    }

    const spawned: Mv[] = []
    for (const m of movers) {
      const spd = Math.hypot(m.vx, m.vy)
      if (spd < 0.01) continue
      for (const [sid, sp] of stat) {
        const dx = sp.x - m.x, dy = sp.y - m.y
        if (dx * dx + dy * dy >= R2) continue
        const d  = Math.sqrt(dx * dx + dy * dy)
        if (d < 0.001) { stat.delete(sid); break }
        const nx = dx / d, ny = dy / d
        const dot = m.vx * nx + m.vy * ny

        // Erstkontakt festhalten
        if (cap === null) {
          // Winkel von "geradeaus" (y-Achse, Richtung Loch)
          // |nx| = Seitenkomponente, ny = Vorwärtskomponente
          const angleDeg = Math.atan2(Math.abs(nx), Math.abs(ny)) * 180 / Math.PI
          cap = {
            seed: -1,
            landX: thrown.x, landY: thrown.y,
            lateralOff:    m.x - blocker.x,
            thrownYContact: m.y,
            dot: Math.max(dot, -dot),   // Betrag, da beide Branches moeglich
            pushAngleDeg:  angleDeg,
            initPushSpd:   0,
            finalPushedX:  blocker.x,
            finalPushedY:  blocker.y,
            pushedDy:      0,
            outcome:       'on',
          }
        }

        if (dot > 0) {
          if (cap.initPushSpd === 0) cap.initPushSpd = dot * ct
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: dot*nx*ct, vy: dot*ny*ct, friction: pf })
          m.vx -= dot * nx; m.vy -= dot * ny
        } else if (m.y > sp.y && m.vy > 0) {
          const dr = -dot
          if (cap.initPushSpd === 0) cap.initPushSpd = dr * ct
          spawned.push({ id: sid, x: sp.x, y: sp.y, vx: -dr*nx*ct, vy: -dr*ny*ct, friction: pf })
          m.vx += dr * nx; m.vy += dr * ny
        } else continue
        stat.delete(sid); break
      }
    }
    movers.push(...spawned)
    if (movers.every(m => Math.hypot(m.vx, m.vy) < 0.01)) break
  }

  if (cap === null) return null

  const finalPos = new Map(movers.map(m => [m.id, { x: m.x, y: m.y }]))
  const bf = finalPos.get(blocker.id) ?? { x: blocker.x, y: blocker.y }
  cap.finalPushedX = bf.x
  cap.finalPushedY = bf.y
  cap.pushedDy     = bf.y - blocker.y
  cap.outcome      = oc(bf.x, bf.y)
  return cap
}

// ── Detailanalyse ─────────────────────────────────────────────────────────────

function bar(n: number, total: number, width = 30): string {
  const filled = total > 0 ? Math.round((n / total) * width) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function detailedAnalysis(po: Po): void {
  const sig = throwSigma()
  console.log('\n' + '='.repeat(80))
  console.log('DETAILANALYSE  —  Beste Kombo')
  console.log(`vFlat=${po.slideVFlat}  vRoll=${po.slideVRoll}  pushFriction=${po.pushFriction}  sigma=${f(sig)} cm`)
  console.log(`Board: Loch y=${BOARD.holeY} cm  Hinterkante y=${BOARD.length} cm  bagDiameter=${BOARD.bagDiameter} cm`)
  console.log('='.repeat(80))

  const scenarios: Array<{ label: string; blocker: BagOnBoard; fl: 'flat' | 'roll' }> = [
    { label: 'push25-scat  (roll / weich, Blocker 25 cm vor Loch)', blocker: BLOCKER25, fl: 'roll' },
    { label: 'push35-scat  (flat / fest, Blocker 35 cm vor Loch)', blocker: BLOCKER35, fl: 'flat' },
  ]

  for (const { label, blocker, fl } of scenarios) {
    const gp = gridSearch(blocker, fl, po)

    // ── 200 Seeds mit Streuung, Kontakt instrumentiert ────────────────────
    const captures: ContactCapture[]         = []
    let total = 0, directIn = 0, directOff = 0

    for (let seed = 0; seed < N_THROWS; seed++) {
      total++
      const rng       = createRng(seed)
      rng()
      const [ox, oy]  = boxMuller(rng, sig)
      const landX     = gp.tx + ox
      const landY     = gp.ty + oy

      // Landung direkt im Loch oder ausserhalb Board → kein Kontakt moeglich
      if (ih(landX, landY))  { directIn++;  continue }
      if (!ob(landX, landY)) { directOff++; continue }

      const v0    = gp.pw * (fl === 'roll' ? po.slideVRoll : po.slideVFlat)
      const mover: Mv = { id: 'T', x: landX, y: landY, vx: 0, vy: v0, friction: po.pushFriction }
      const cap   = runSlideCapture(mover, blocker, po)
      if (cap !== null) { cap.seed = seed; captures.push(cap) }
    }

    const nContact  = captures.length
    const noContact = total - nContact - directIn - directOff
    const inC  = captures.filter(c => c.outcome === 'in').length
    const onC  = captures.filter(c => c.outcome === 'on').length
    const offC = captures.filter(c => c.outcome === 'off').length

    console.log(`\n╔══ ${label}`)
    console.log(`║   Bester Zielpunkt: tX=${f(gp.tx)} tY=${f(gp.ty)} pw=${f(gp.pw, 2)}`)
    console.log(`║   Blocker: y=${blocker.y} cm  Loch: y=${BOARD.holeY} cm  Abstand=${blocker.y - BOARD.holeY < 0 ? BOARD.holeY - blocker.y : blocker.y - BOARD.holeY} cm`)
    console.log('╠══')

    // 1. Kontaktrate
    console.log('║ 1) KONTAKT')
    console.log(`║    Gesamt Würfe    : ${total}`)
    console.log(`║    Direkt ins Loch : ${directIn}  (landen auf Loch, kein Rutsch nötig)`)
    console.log(`║    Direkt off-Board: ${directOff}`)
    console.log(`║    Kein Kontakt    : ${noContact}  (Tasche kommt nicht bis zum Blocker)`)
    console.log(`║    Mit Kontakt     : ${nContact} / ${total} = ${p(nContact / total)}`)

    if (nContact === 0) { console.log('╚══ kein Kontakt in allen Würfen'); continue }

    // 2. Outcome bedingt auf Kontakt
    console.log('╠══')
    console.log('║ 2) OUTCOME  (bedingt auf Kontakt)')
    console.log(`║    in : ${String(inC).padStart(3)} / ${nContact} = ${p(inC / nContact)}`)
    console.log(`║    on : ${String(onC).padStart(3)} / ${nContact} = ${p(onC / nContact)}`)
    console.log(`║    off: ${String(offC).padStart(3)} / ${nContact} = ${p(offC / nContact)}`)

    // 3. Seitlicher Versatz & Schubrichtung
    const offsets   = captures.map(c => c.lateralOff)
    const angles    = captures.map(c => c.pushAngleDeg)
    const initVs    = captures.map(c => c.initPushSpd)
    const pushDys   = captures.map(c => c.pushedDy)

    const meanOff   = avgArr(offsets)
    const stdOff    = Math.sqrt(avgArr(offsets.map(o => (o - meanOff) ** 2)))
    const meanAngle = avgArr(angles)
    const meanInitV = avgArr(initVs)
    const meanPushDy = avgArr(pushDys)
    const maxPushDy  = Math.max(...pushDys)

    console.log('╠══')
    console.log('║ 3) SEITLICHER VERSATZ AM KONTAKTPUNKT & SCHUBRICHTUNG')
    console.log(`║    lateralOff  MW=${f(meanOff, 1)} cm  σ=${f(stdOff, 1)} cm  (+ = Wurf rechts vom Blocker)`)
    console.log(`║    pushAngle   MW=${f(meanAngle, 1)}°  (0°=geradeaus → Loch, 90°=seitlich)`)
    console.log(`║    initPushSpd MW=${f(meanInitV, 1)} cm/s  →  max Schubweg ${f(meanInitV**2/(2*PHYSICS_DEFAULTS.pushedFriction), 1)} cm`)
    console.log(`║    pushedDy    MW=${f(meanPushDy, 1)} cm  MAX=${f(maxPushDy, 1)} cm`)
    console.log('║')
    console.log('║    |lateralOff| Verteilung                       In-Quote bei Kontakt')

    const offBuckets: Array<[number, number]> = [[0,3],[3,6],[6,9],[9,12],[12,Infinity]]
    for (const [lo, hi] of offBuckets) {
      const bucket = captures.filter(c => Math.abs(c.lateralOff) >= lo && Math.abs(c.lateralOff) < hi)
      const inB    = bucket.filter(c => c.outcome === 'in').length
      const tag    = hi === Infinity ? `≥${lo} cm  ` : `${lo}–${hi} cm `
      const bStr   = bar(bucket.length, nContact)
      const inStr  = bucket.length > 0 ? `${inB}/${bucket.length} = ${p(inB/bucket.length)}` : '—'
      console.log(`║    ${tag}  ${bStr}  ${String(bucket.length).padStart(3)}  |  ${inStr}`)
    }

    console.log('║')
    console.log('║    Schubwinkel-Verteilung  (0° = geradeaus)')
    const angBuckets: Array<[number, number]> = [[0,10],[10,20],[20,30],[30,45],[45,90]]
    for (const [lo, hi] of angBuckets) {
      const bucket = captures.filter(c => c.pushAngleDeg >= lo && c.pushAngleDeg < hi)
      const inB    = bucket.filter(c => c.outcome === 'in').length
      const tag    = `${lo}–${hi < 90 ? hi : 90}° `
      const bStr   = bar(bucket.length, nContact)
      const inStr  = bucket.length > 0 ? `in ${inB}/${bucket.length} = ${p(inB/bucket.length)}` : '—'
      console.log(`║    ${tag.padEnd(8)}  ${bStr}  ${String(bucket.length).padStart(3)}  |  ${inStr}`)
    }

    // 4. Off-Analyse
    console.log('╠══')
    console.log('║ 4) OFF-ANALYSE')
    const backEdge = BOARD.length   // 120 cm
    const maxFinalY = Math.max(...captures.map(c => c.finalPushedY))
    const minDistToBack = backEdge - maxFinalY
    const holeNearMiss  = captures
      .filter(c => c.outcome === 'on')
      .map(c => Math.hypot(c.finalPushedX - BOARD.holeX, c.finalPushedY - BOARD.holeY))
    const closestMiss = holeNearMiss.length > 0 ? Math.min(...holeNearMiss) : Infinity

    if (offC === 0) {
      console.log(`║    off=0 — Blocker verlässt das Brett in keinem der ${nContact} Kontaktwürfe.`)
      console.log(`║    Max. Blocker-Endposition : y=${f(maxFinalY)} cm`)
      console.log(`║    Abstand zur Hinterkante  : ${f(minDistToBack)} cm  (Brett endet bei y=${backEdge} cm)`)
      console.log(`║    Knappster Fehlwurf (on)  : ${f(closestMiss)} cm vom Lochzentrum  (Lochradius=${BOARD.holeRadius} cm)`)
    } else {
      console.log(`║    off=${offC} / ${nContact} Kontaktwürfe`)
      const offCaptures = captures.filter(c => c.outcome === 'off')
      for (const cap of offCaptures.slice(0, 8)) {
        console.log(
          `║      Seed ${String(cap.seed).padStart(3)}: lateralOff=${f(cap.lateralOff, 1)} cm` +
          `  pushAngle=${f(cap.pushAngleDeg, 1)}°  initV=${f(cap.initPushSpd, 1)} cm/s` +
          `  Dy=${f(cap.pushedDy, 1)} cm  finalY=${f(cap.finalPushedY, 1)} cm`
        )
      }
      console.log(`║    Max. finalY: ${f(maxFinalY)} cm  |  Min. Abstand Hinterkante: ${f(minDistToBack)} cm`)
    }
    console.log('╚══')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const sig = throwSigma()
  console.log('='.repeat(80))
  console.log('PUSH-BENCH  —  Parameter-Sweep')
  console.log(`Loch: y=${BOARD.holeY} cm, r=${BOARD.holeRadius} cm  |  sigma=${f(sig)} cm  |  N=${N_THROWS}`)
  console.log(`Sweep: vFlat=[${VFLAT_GRID.join(',')}]  vRoll=[${VROLL_GRID.join(',')}]  friction=[${FRICTION_GRID.join(',')}]`)
  console.log('='.repeat(80))

  // Alle 64 Kombinationen aufbauen
  const allPo: Po[] = []
  for (const vFlat of VFLAT_GRID)
    for (const vRoll of VROLL_GRID)
      for (const friction of FRICTION_GRID)
        allPo.push({ slideVFlat: vFlat, slideVRoll: vRoll, pushFriction: friction })

  // ── Zeitschätzung ──────────────────────────────────────────────────────────
  const PROBE = 5
  console.log(`\nZeitschätzung (${PROBE} Probe-Kombos) …`)
  const t0    = Date.now()
  for (let i = 0; i < PROBE; i++) runCombo(allPo[i])
  const probeMs  = Date.now() - t0
  const totalMs  = (probeMs / PROBE) * allPo.length
  const totalMin = totalMs / 60_000
  console.log(`  ${PROBE} Kombos in ${probeMs} ms  →  ${allPo.length} Kombos geschätzt: ~${totalMin.toFixed(1)} min`)

  if (totalMs > 10 * 60_000) {
    console.log('\nWARNUNG: Schätzung > 10 Minuten!')
    console.log('Bitte VFLAT_GRID / VROLL_GRID / FRICTION_GRID auf je 3 Werte verkleinern (→ 27 Kombos).')
    process.exit(1)
  }
  console.log()

  // ── Sweep ──────────────────────────────────────────────────────────────────
  const results: ComboResult[] = []

  for (let i = 0; i < allPo.length; i++) {
    const po = allPo[i]
    const r  = runCombo(po)
    results.push(r)

    const p25ok = yn(r.push25No.pushedOutcome === 'in')
    const p35ok = yn(r.push35No.pushedOutcome === 'in')
    console.log(
      `[${String(i + 1).padStart(2)}/${allPo.length}]` +
      ` vF=${String(po.slideVFlat).padStart(3)} vR=${String(po.slideVRoll).padStart(3)} fr=${po.pushFriction}` +
      `  slide=${p(r.slideScat.inRate)} sl=${f(r.slideFlat)}cm` +
      `  p25=${p25ok}/${p(r.push25Scat.inRate)}` +
      `  p35=${p35ok}/${p(r.push35Scat.inRate)}` +
      `  score=${r.score}/13`
    )
  }

  printTable(results)
  printJson(results)

  // Detailanalyse für die beste Kombination
  const best = [...results].sort((a, b) => b.score - a.score)[0]
  detailedAnalysis({ slideVFlat: best.vFlat, slideVRoll: best.vRoll, pushFriction: best.friction })

  console.log('\nFERTIG')
}

main()
