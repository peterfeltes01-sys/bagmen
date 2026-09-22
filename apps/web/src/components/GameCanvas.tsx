'use client'

import { useRef, useEffect } from 'react'
import {
  simulateThrow, createRng, BOARD, PHYSICS_DEFAULTS, DEFAULT_MATCH_CONFIG,
  scoreFrame, advanceThrow, isFrameOver, advanceFrame, checkMatch, aiThrow,
} from '@cornhole/engine'
import type {
  BoardState, ThrowInput, ThrowResult, BagOnBoard, Point, FlightType,
  PhysicsConfig, FrameState, FrameResult, MatchConfig, AiStyle,
} from '@cornhole/engine'
import {
  makeLayout, worldPt, bagPos, bagHalfSize, holeRadius,
  canvasToBoard, pxPerCm, lerp,
  CAM_DEFAULTS,
} from '@/lib/projection'
import type { Layout, CameraParams } from '@/lib/projection'

// ---- Constants ----

const TEAM_COLOR    = ['#ef4444', '#3b82f6'] as const
const TEAM_DARK     = ['#7f1d1d', '#1e3a8a'] as const
const TEAM_LIGHT    = ['#fecaca', '#bfdbfe'] as const

const BAG_COLORS      = ['#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#f97316','#ec4899','#14b8a6']
const BAG_COLOR_NAMES = ['Rot','Blau','Grün','Gelb','Lila','Orange','Pink','Türkis']
const BAG_PATTERNS    = ['uni','stripes','checker','dots','logo'] as const
const BAG_PATTERN_NAMES: Record<string, string> = { uni:'Uni', stripes:'Streifen', checker:'Karo', dots:'Punkte', logo:'Logo' }
const CONTRAST_COLORS: Record<string, string> = {
  '#ef4444': '#3b82f6',
  '#3b82f6': '#ef4444',
  '#22c55e': '#a855f7',
  '#eab308': '#3b82f6',
  '#a855f7': '#22c55e',
  '#f97316': '#3b82f6',
  '#ec4899': '#22c55e',
  '#14b8a6': '#ef4444',
}
const SLIDE_MS      = 480
const BAGS_PER_TEAM = 4
const AI_THROW_DELAY_MS  = 400
const FRAME_SUMMARY_MS   = 1200

const MIN_LAND_Y    = -40
const MAX_LAND_Y    = 170

const BAG_Y_FRAC    = 0.38

const FLIGHT_TYPES: FlightType[] = ['roll', 'flat', 'airmail']
const FLIGHT_LABELS: Record<FlightType, string> = { roll: 'Roll', flat: 'Slide', airmail: 'Airmail' }

const AI_STYLE_LABELS: Record<AiStyle, string> = {
  blocker:      'Blocker',
  airmailer:    'Airmailer',
  nervenbundel: 'Nervenbündel',
}
const AI_STYLE_DESCS: Record<AiStyle, string> = {
  blocker:      'Spielt defensiv vor dem Loch',
  airmailer:    'Wirft hoch, geringere Konsistenz',
  nervenbundel: 'Präzise, bricht bei Rückstand ein',
}

const POPUP_DURATION = 900

// ---- Types ----

type Phase      = 'idle' | 'charging' | 'flying' | 'sliding' | 'settled'
type UiPhase    = 'setup' | 'playing' | 'frameSummary' | 'matchOver'
type BagPattern = 'uni' | 'stripes' | 'checker' | 'dots' | 'logo'

interface BagDesign { color: string; pattern: BagPattern }

/** Stored in bagDeforms map — parameters for time-based spring animation */
interface BagDeform {
  landedAt:  number  // performance.now() at landing
  squashAmp: number  // peak squash depth (0–0.4)
  wobbleAmp: number  // lateral wobble amplitude (normalised, 0–1)
}

/** Computed per-frame from BagDeform — passed to draw functions */
interface BagDeformState {
  squashY: number; squashX: number; bulge: number; wobble: number; droop: number
}

interface Popup {
  bx: number; by: number; text: string; startT: number; teamId: 0|1
}

interface MatchStats {
  frames:      number
  holesTotal:  [number, number]
  ptsTotal:    [number, number]
  fourBaggers: [number, number]
}

interface SlideAnim {
  id: string; teamId: 0|1
  x0: number; y0: number; x1: number; y1: number
  outcome: 'in' | 'on' | 'off'
  spinAngle: number
  spinVelocity: number
  spinType: 'yaw' | 'tumble'
}

interface PendingThrow {
  result: ThrowResult
  newBoardState: BoardState
  prevBoardBags: readonly BagOnBoard[]
  trajectory: Point[]
  thrownTeam: 0|1
  thrownFlightType: FlightType
}

interface OverlayButton {
  x: number; y: number; w: number; h: number; tag: string
}

interface GameData {
  layout: Layout
  camParams: CameraParams
  physicsConfig: PhysicsConfig
  matchConfig: MatchConfig
  frameState: FrameState
  aiStyle: AiStyle
  uiPhase: UiPhase
  frameSummaryInfo: FrameResult | null
  frameSummaryAt: number
  matchWinner: 0|1 | null
  aiThrowAt: number
  overlayButtons: OverlayButton[]
  playerDesign: BagDesign
  opponentDesign: BagDesign
  matchStats: MatchStats
  // tunable gameplay values (all exposed as debug sliders)
  trajSlow: number
  settledMs: number
  playerSkill: number
  idealZoneWidth: number
  pullPowerRatio: number
  aimSensitivity: number
  spinRateFlat: number
  spinRateAirmail: number
  spinRateRoll: number
  seed: number
  aim: { bx: number; by: number }
  aimDragOrigin: { bx: number; by: number; sx: number; sy: number } | null
  flightType: FlightType
  phase: Phase
  chargeOrig: { sx: number; sy: number } | null
  chargeCurr: { sx: number; sy: number } | null
  chargePts: Array<{ sx: number; sy: number }>
  previewTraj: Point[] | null
  pending: PendingThrow | null
  flyStart: number
  flyDur: number
  slides: SlideAnim[]
  slideStart: number
  settledAt: number
  lastOutcome: 'in' | 'on' | 'off' | null
  muted: boolean
  popups: Popup[]
  soundQueue: string[]
  camZoom: number
  deformStrength: number
  shadowOpacity: number
  cameraZoomStr: number
  sndVolImpact:    number
  sndVolFriction:  number
  sndVolHole:      number
  sndVolMiss:      number
  sndVolCollision: number
  debugMode: boolean
}

function makeFrameState(): FrameState {
  return {
    frameIndex:  0,
    throwsLeft:  [4, 4],
    activeTeam:  0,
    firstThrown: 0,
    scores:      [0, 0],
    boardState:  { bags: [] },
    roundHoles:  [],
  }
}

function makeMatchStats(): MatchStats {
  return { frames: 0, holesTotal: [0, 0], ptsTotal: [0, 0], fourBaggers: [0, 0] }
}

function loadDesignFromStorage(): BagDesign {
  try {
    const raw = localStorage.getItem('cornhole-bag-design')
    if (raw) {
      const d = JSON.parse(raw) as BagDesign
      if (BAG_COLORS.includes(d.color) && (BAG_PATTERNS as readonly string[]).includes(d.pattern)) return d
    }
  } catch {}
  return { color: '#ef4444', pattern: 'uni' }
}

function saveDesignToStorage(d: BagDesign) {
  try { localStorage.setItem('cornhole-bag-design', JSON.stringify(d)) } catch {}
}

function contrastDesign(pd: BagDesign): BagDesign {
  const color   = CONTRAST_COLORS[pd.color] ?? '#3b82f6'
  const patIdx  = BAG_PATTERNS.indexOf(pd.pattern as typeof BAG_PATTERNS[number])
  const pattern = BAG_PATTERNS[(patIdx + 2) % BAG_PATTERNS.length]
  return { color, pattern }
}

function makeGameData(): GameData {
  return {
    layout:          makeLayout(390, 844),
    camParams:       { ...CAM_DEFAULTS },
    physicsConfig:   { ...PHYSICS_DEFAULTS },
    matchConfig:     { ...DEFAULT_MATCH_CONFIG },
    frameState:      makeFrameState(),
    aiStyle:         'blocker',
    uiPhase:         'setup',
    frameSummaryInfo: null,
    frameSummaryAt:  0,
    matchWinner:     null,
    aiThrowAt:       0,
    overlayButtons:  [],
    playerDesign:    loadDesignFromStorage(),
    opponentDesign:  contrastDesign(loadDesignFromStorage()),
    matchStats:      makeMatchStats(),
    trajSlow:        1.0,
    settledMs:       600,
    playerSkill:     0.72,
    idealZoneWidth:  0.10,
    pullPowerRatio:  0.58,
    aimSensitivity:  0.40,
    spinRateFlat:    5.5,
    spinRateAirmail: 4.5,
    spinRateRoll:    9.0,
    seed:            (Date.now() * 0x9e3779b9) >>> 0,
    aim:             { bx: BOARD.holeX, by: BOARD.holeY },
    aimDragOrigin:   null,
    flightType:      'flat',
    phase:           'idle',
    chargeOrig:      null,
    chargeCurr:      null,
    chargePts:       [],
    previewTraj:     null,
    pending:         null,
    flyStart:        0,
    flyDur:          1200,
    slides:          [],
    slideStart:      0,
    settledAt:       0,
    lastOutcome:     null,
    muted:           false,
    popups:          [],
    soundQueue:      [],
    camZoom:         1.0,
    deformStrength:  0.70,
    shadowOpacity:   0.80,
    cameraZoomStr:   0.60,
    sndVolImpact:    0.60,
    sndVolFriction:  0.30,
    sndVolHole:      0.55,
    sndVolMiss:      0.25,
    sndVolCollision: 0.40,
    debugMode:       false,
  }
}

function computeDeform(d: BagDeform, ts: number): BagDeformState {
  const t      = Math.max(0, (ts - d.landedAt) / 1000)
  const spring = 1 - d.squashAmp * Math.cos(t * 22) * Math.exp(-t * 6)
  const squashY = Math.max(0.35, Math.min(1.06, spring))
  const squashX = 1 + Math.max(0, 1 - squashY) * 0.55
  const bulge   = Math.max(0, 1 - squashY) * 0.45
  const wobble  = d.wobbleAmp * Math.exp(-t * 3.8) * Math.sin(t * 14)
  return { squashY, squashX, bulge, wobble, droop: 0 }
}

// ---- Helpers ----

function bagRestCenter(lt: Layout): { x: number; y: number } {
  const zh = lt.cssH - lt.throwZoneY
  return { x: lt.cssW / 2, y: lt.throwZoneY + zh * BAG_Y_FRAC }
}

function computeIdealPower(by: number): number {
  return Math.max(0, Math.min(1, (by - MIN_LAND_Y) / (MAX_LAND_Y - MIN_LAND_Y)))
}

// ---- Gesture → ThrowInput ----

function computeThrowInput(g: GameData): ThrowInput | null {
  const { chargeOrig: o, chargeCurr: c, aim, flightType } = g
  if (!o || !c) return null
  const dy = c.sy - o.sy
  if (dy < 8) return null

  const lt      = g.layout
  const maxPull = (lt.cssH - lt.throwZoneY) * g.pullPowerRatio
  const power   = Math.min(dy / maxPull, 1)
  const dx      = c.sx - o.sx
  const lateralAngle = Math.atan2(dx, Math.max(1, dy))

  const targetY  = MIN_LAND_Y + power * (MAX_LAND_Y - MIN_LAND_Y)
  const targetX  = Math.max(-BOARD.halfWidth,
    Math.min(BOARD.halfWidth, aim.bx + Math.sin(lateralAngle) * 14))
  const idealP   = computeIdealPower(aim.by)
  const inZone   = Math.abs(power - idealP) <= g.idealZoneWidth
  const baseFocus = Math.max(0.3, 0.85 - Math.abs(lateralAngle) / (Math.PI / 4) * 0.55)
  const focus    = inZone ? Math.min(1.0, baseFocus + 0.12) : baseFocus

  return {
    teamId:     0,
    targetX,
    targetY,
    power,
    spin:       0,
    flightType,
    skillLevel: g.playerSkill,
    focus,
  }
}

// ---- Trajectory interpolation ----

function sampleTraj(traj: Point[], tNorm: number): { x: number; y: number; z: number } {
  if (traj.length === 0) return { x: 0, y: 0, z: 0 }
  if (tNorm <= 0) return { ...traj[0] }
  if (tNorm >= 1) return { ...traj[traj.length - 1] }
  const total  = traj[traj.length - 1].t
  const target = tNorm * total
  let lo = 0, hi = traj.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (traj[mid].t <= target) lo = mid; else hi = mid
  }
  const a = traj[lo], b = traj[hi]
  const f = b.t > a.t ? (target - a.t) / (b.t - a.t) : 0
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f) }
}

// ---- Game update ----

function triggerAiThrow(g: GameData, ts: number) {
  const rngAi  = createRng(g.seed ^ 0xdeadbeef)
  const input  = aiThrow(g.aiStyle, g.frameState.scores, rngAi)
  const prevBags = [...g.frameState.boardState.bags]
  const { state: newBoardState, trajectory, result } = simulateThrow(
    g.frameState.boardState, input, createRng(g.seed), g.physicsConfig,
  )
  g.pending  = { result, newBoardState, prevBoardBags: prevBags, trajectory, thrownTeam: 1, thrownFlightType: input.flightType }
  g.flyStart = ts
  g.flyDur   = trajectory[trajectory.length - 1].t * g.trajSlow * 1000
  g.phase    = 'flying'
  g.aiThrowAt = 0
}

function update(g: GameData, ts: number) {
  if (g.uiPhase === 'setup' || g.uiPhase === 'matchOver') return

  if (g.uiPhase === 'frameSummary') {
    if (ts - g.frameSummaryAt >= FRAME_SUMMARY_MS) {
      if (g.matchWinner !== null) {
        g.uiPhase = 'matchOver'
      } else {
        g.uiPhase = 'playing'
        if (g.frameState.activeTeam === 1) g.aiThrowAt = ts + AI_THROW_DELAY_MS
      }
    }
    return
  }

  const zoomTarget = (g.phase === 'idle' || g.phase === 'charging' || g.phase === 'settled')
    ? 1 + 0.06 * g.cameraZoomStr : 1.0
  g.camZoom = g.camZoom + (zoomTarget - g.camZoom) * 0.08

  if (g.popups.length > 0) g.popups = g.popups.filter(p => ts - p.startT < POPUP_DURATION)

  // Flying
  if (g.phase === 'flying' && g.pending) {
    if (ts - g.flyStart >= g.flyDur) {
      const { result: r, prevBoardBags, trajectory, thrownTeam, thrownFlightType } = g.pending
      const land      = trajectory[trajectory.length - 1]
      const spinRate  = thrownFlightType === 'flat'    ? g.spinRateFlat
                      : thrownFlightType === 'airmail' ? g.spinRateAirmail
                      : g.spinRateRoll
      const spinType: 'yaw' | 'tumble' = thrownFlightType === 'roll' ? 'tumble' : 'yaw'
      const landingAngle = (g.flyDur / 1000) * spinRate
      g.slides = [
        {
          id: r.thrownBag.id, teamId: thrownTeam,
          x0: land.x, y0: land.y,
          x1: r.thrownBag.finalX, y1: r.thrownBag.finalY,
          outcome: r.thrownBag.outcome,
          spinAngle: landingAngle, spinVelocity: spinRate, spinType,
        },
        ...r.pushedBags.map(pb => {
          const orig = prevBoardBags.find(b => b.id === pb.id)!
          return {
            id: pb.id, teamId: orig.teamId,
            x0: orig.x, y0: orig.y,
            x1: pb.finalX, y1: pb.finalY,
            outcome: pb.outcome,
            spinAngle: 0, spinVelocity: 0, spinType: 'yaw' as const,
          }
        }),
      ]
      g.phase      = 'sliding'
      g.slideStart = ts
      g.soundQueue.push('impact')
      if (r.pushedBags.length > 0) g.soundQueue.push('collision')
    }
    return
  }

  // Sliding
  if (g.phase === 'sliding') {
    if (ts - g.slideStart >= SLIDE_MS) {
      const r = g.pending!.result
      g.frameState.boardState = g.pending!.newBoardState
      if (r.thrownBag.outcome === 'in')
        g.frameState.roundHoles.push({ teamId: g.pending!.thrownTeam })
      for (const pb of r.pushedBags) {
        if (pb.outcome === 'in') {
          const orig = g.pending!.prevBoardBags.find(b => b.id === pb.id)
          if (orig) g.frameState.roundHoles.push({ teamId: orig.teamId })
        }
      }
      g.lastOutcome = r.thrownBag.outcome
      g.phase       = 'settled'
      g.settledAt   = ts
      const snd = r.thrownBag.outcome === 'in' ? 'hole' : r.thrownBag.outcome === 'on' ? 'friction' : 'miss'
      g.soundQueue.push(snd)
      if (r.thrownBag.outcome === 'in') {
        g.popups.push({ bx: BOARD.holeX, by: BOARD.holeY, text: '+3', startT: ts, teamId: g.pending!.thrownTeam })
      } else if (r.thrownBag.outcome === 'on') {
        g.popups.push({ bx: r.thrownBag.finalX, by: r.thrownBag.finalY, text: '+1', startT: ts, teamId: g.pending!.thrownTeam })
      }
    }
    return
  }

  // Settled
  if (g.phase === 'settled') {
    if (ts - g.settledAt < g.settledMs) return

    g.frameState  = advanceThrow(g.frameState)
    g.pending     = null
    g.lastOutcome = null
    g.seed        = ((g.seed * 0x19660d + 0x3c6ef35f) >>> 0)

    if (isFrameOver(g.frameState)) {
      const scoring = scoreFrame(g.frameState.boardState, g.frameState.roundHoles)
      // accumulate match stats before roundHoles is cleared by advanceFrame
      for (let t = 0; t < 2; t++) {
        const holes = g.frameState.roundHoles.filter(h => h.teamId === t).length
        g.matchStats.holesTotal[t]  += holes
        g.matchStats.ptsTotal[t]    += scoring.framePts[t]
        if (holes === BAGS_PER_TEAM) g.matchStats.fourBaggers[t]++
      }
      g.matchStats.frames++
      g.frameSummaryInfo = scoring
      g.frameState       = advanceFrame(g.frameState, scoring.netPts)
      const status       = checkMatch(g.frameState.scores, g.matchConfig)
      if (status.over) g.matchWinner = status.winner!
      g.frameSummaryAt   = ts
      g.uiPhase          = 'frameSummary'
      g.phase            = 'idle'
    } else {
      g.phase = 'idle'
      if (g.frameState.activeTeam === 1) g.aiThrowAt = ts + AI_THROW_DELAY_MS
    }
    return
  }

  // Idle: AI auto-throw
  if (g.phase === 'idle' && g.frameState.activeTeam === 1 && g.aiThrowAt > 0 && ts >= g.aiThrowAt) {
    triggerAiThrow(g, ts)
  }
}

// ---- Rendering ----

const GRASS_TOP  = '#1a3d12'
const GRASS_BOT  = '#2d5a1f'
const SKY_TOP    = '#3a6faa'
const SKY_HOR    = '#6ba3d0'
const WOOD_NEAR  = '#c78b3a'
const WOOD_FAR   = '#a06520'
const WOOD_FRAME = '#5c300a'
const HOLE_RIM   = '#3a1e08'

function drawBackground(ctx: CanvasRenderingContext2D, lt: Layout) {
  const { cssW: W, cssH: H } = lt
  const backY   = lt.backLeft.y
  const skyFrac = Math.max(0.02, Math.min(0.45, (backY - lt.hudH) / (H - lt.hudH)))
  const grad    = ctx.createLinearGradient(0, lt.hudH, 0, H)
  grad.addColorStop(0,          SKY_TOP)
  grad.addColorStop(skyFrac * 0.6, SKY_HOR)
  grad.addColorStop(skyFrac,    GRASS_TOP)
  grad.addColorStop(1,          GRASS_BOT)
  ctx.fillStyle = grad
  ctx.fillRect(0, lt.hudH, W, H - lt.hudH)

  // distant grass lines
  ctx.strokeStyle = 'rgba(0,0,0,0.10)'
  ctx.lineWidth = 1
  for (let i = 1; i <= 5; i++) {
    const ty = i / 6
    const lx = lerp(lt.frontLeft.x, lt.backLeft.x, ty)
    const rx = lerp(lt.frontRight.x, lt.backRight.x, ty)
    const y  = lerp(lt.frontLeft.y, lt.backLeft.y, ty)
    ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke()
  }
}

function drawSilhouettes(ctx: CanvasRenderingContext2D, lt: Layout) {
  const baseY = lt.backLeft.y + (lt.frontLeft.y - lt.backLeft.y) * 0.18
  ctx.fillStyle = '#152810'

  function tree(tx: number, scale: number) {
    const h1 = 70 * scale, h2 = 48 * scale, tw = 22 * scale, th = 18 * scale
    ctx.fillRect(tx - 4 * scale, baseY - th, 8 * scale, th)
    ctx.beginPath(); ctx.moveTo(tx, baseY - th - h1); ctx.lineTo(tx - tw, baseY - th); ctx.lineTo(tx + tw, baseY - th); ctx.closePath(); ctx.fill()
    ctx.beginPath(); ctx.moveTo(tx, baseY - th - h1 - h2 * 0.5); ctx.lineTo(tx - tw * 0.7, baseY - th - h1 + h2 * 0.25); ctx.lineTo(tx + tw * 0.7, baseY - th - h1 + h2 * 0.25); ctx.closePath(); ctx.fill()
  }

  tree(lt.backLeft.x  - 28, 0.85)
  tree(lt.backLeft.x  -  8, 0.60)
  tree(lt.backRight.x + 28, 0.85)
  tree(lt.backRight.x +  8, 0.60)
}

function drawBoard(ctx: CanvasRenderingContext2D, lt: Layout) {
  const { frontLeft: FL, frontRight: FR, backLeft: BL, backRight: BR } = lt

  ctx.save()
  ctx.shadowBlur = 20; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowOffsetY = 4
  ctx.beginPath()
  ctx.moveTo(FL.x, FL.y); ctx.lineTo(FR.x, FR.y)
  ctx.lineTo(BR.x, BR.y); ctx.lineTo(BL.x, BL.y)
  ctx.closePath()
  ctx.fillStyle = WOOD_NEAR; ctx.fill()
  ctx.restore()

  ctx.beginPath()
  ctx.moveTo(FL.x, FL.y); ctx.lineTo(FR.x, FR.y)
  ctx.lineTo(BR.x, BR.y); ctx.lineTo(BL.x, BL.y)
  ctx.closePath()
  const woodGrad = ctx.createLinearGradient(lt.cssW / 2, FL.y, lt.cssW / 2, BL.y)
  woodGrad.addColorStop(0,    WOOD_NEAR)
  woodGrad.addColorStop(0.55, '#b87a2a')
  woodGrad.addColorStop(1,    WOOD_FAR)
  ctx.fillStyle = woodGrad; ctx.fill()

  // vertical board planks
  ctx.strokeStyle = 'rgba(255,255,255,0.055)'; ctx.lineWidth = 1
  for (let i = 1; i <= 4; i++) {
    const tx = i / 5
    const t0 = worldPt(-30 + tx * 60, 0,   0, lt)
    const t1 = worldPt(-30 + tx * 60, 120, 0, lt)
    ctx.beginPath(); ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.stroke()
  }

  // wood grain lines (diagonal)
  ctx.strokeStyle = 'rgba(0,0,0,0.055)'; ctx.lineWidth = 0.7
  for (let cy = 8; cy <= 118; cy += 14) {
    const p0 = worldPt(-30,  cy,     0, lt)
    const p1 = worldPt( 30,  cy + 4, 0, lt)
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke()
  }

  // board frame
  ctx.beginPath()
  ctx.moveTo(FL.x, FL.y); ctx.lineTo(FR.x, FR.y)
  ctx.lineTo(BR.x, BR.y); ctx.lineTo(BL.x, BL.y)
  ctx.closePath()
  ctx.strokeStyle = WOOD_FRAME; ctx.lineWidth = 2.5; ctx.stroke()

  // hole with depth
  const hPos = bagPos(BOARD.holeX, BOARD.holeY, lt)
  const hTy  = BOARD.holeY / 120
  const hr   = holeRadius(hTy, lt)

  // rim gradient
  const rimGrad = ctx.createRadialGradient(hPos.x, hPos.y - hr * 0.2, hr * 0.3, hPos.x, hPos.y, hr * 1.32)
  rimGrad.addColorStop(0,   '#110600')
  rimGrad.addColorStop(0.6, '#1a0a02')
  rimGrad.addColorStop(1,   HOLE_RIM)
  ctx.beginPath(); ctx.arc(hPos.x, hPos.y, hr * 1.30, 0, Math.PI * 2)
  ctx.fillStyle = rimGrad; ctx.fill()

  // hole depth
  const holeGrad = ctx.createRadialGradient(hPos.x, hPos.y - hr * 0.22, 0, hPos.x, hPos.y, hr)
  holeGrad.addColorStop(0,   '#040100')
  holeGrad.addColorStop(0.5, '#090300')
  holeGrad.addColorStop(1,   '#180800')
  ctx.beginPath(); ctx.arc(hPos.x, hPos.y, hr, 0, Math.PI * 2)
  ctx.fillStyle = holeGrad; ctx.fill()

  // top-edge highlight (light from above the player)
  const hlGrad = ctx.createLinearGradient(hPos.x, hPos.y - hr, hPos.x, hPos.y + hr * 0.4)
  hlGrad.addColorStop(0,   'rgba(160,80,20,0.22)')
  hlGrad.addColorStop(0.4, 'rgba(0,0,0,0)')
  ctx.beginPath(); ctx.arc(hPos.x, hPos.y, hr, 0, Math.PI * 2)
  ctx.fillStyle = hlGrad; ctx.fill()
}

/** Draws the bag outline path (bezier, soft corners). Context must be pre-translated to bag center. */
function drawBagShape(ctx: CanvasRenderingContext2D, hs: number, bulge: number, droop: number) {
  const r  = hs * 0.26
  const b  = hs * bulge
  const dr = hs * droop
  ctx.beginPath()
  ctx.moveTo(-hs + r, -hs)
  ctx.lineTo( hs - r, -hs)
  ctx.quadraticCurveTo( hs, -hs,  hs, -hs + r)
  ctx.bezierCurveTo(hs + b, -hs * 0.28, hs + b, hs * 0.28, hs, hs - r + dr * 0.4)
  ctx.quadraticCurveTo(hs, hs + dr, hs - r, hs + dr)
  ctx.lineTo(-hs + r, hs + dr)
  ctx.quadraticCurveTo(-hs, hs + dr, -hs, hs - r + dr * 0.4)
  ctx.bezierCurveTo(-hs - b, hs * 0.28, -hs - b, -hs * 0.28, -hs, -hs + r)
  ctx.quadraticCurveTo(-hs, -hs, -hs + r, -hs)
  ctx.closePath()
}

function drawBagPattern(ctx: CanvasRenderingContext2D, hs: number, pattern: BagPattern) {
  if (pattern === 'uni') return
  ctx.save()
  ctx.beginPath(); ctx.rect(-hs, -hs, hs * 2, hs * 2); ctx.clip()
  if (pattern === 'stripes') {
    const sh = (hs * 2) / 8
    ctx.fillStyle = 'rgba(255,255,255,0.24)'
    for (let i = 0; i < 4; i += 2) ctx.fillRect(-hs, -hs + i * sh * 2, hs * 2, sh)
  } else if (pattern === 'checker') {
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.fillRect(-hs, -hs, hs, hs)
    ctx.fillRect(0,   0,   hs, hs)
  } else if (pattern === 'dots') {
    const dr  = Math.max(1.5, hs * 0.16)
    const off = hs * 0.40
    ctx.fillStyle = 'rgba(255,255,255,0.44)'
    for (const [dx, dy] of [[-off, -off], [off, -off], [-off, off], [off, off]]) {
      ctx.beginPath(); ctx.arc(dx, dy, dr, 0, Math.PI * 2); ctx.fill()
    }
  } else if (pattern === 'logo') {
    ctx.beginPath(); ctx.arc(0, 0, hs * 0.42, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.48)'
    ctx.lineWidth   = Math.max(1.5, hs * 0.14)
    ctx.stroke()
  }
  ctx.restore()
}

function drawBag(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number, teamId: 0|1,
  lt: Layout, alpha = 1, angle = 0, spinType: 'yaw' | 'tumble' = 'yaw',
  design?: BagDesign, deform?: BagDeformState,
) {
  const { x, y } = bagPos(bx, by, lt)
  const ty      = by / 120
  const hs      = bagHalfSize(ty, lt)
  const squashY = deform?.squashY ?? 1
  const squashX = deform?.squashX ?? 1
  const bulge   = deform?.bulge   ?? 0
  const droop   = deform?.droop   ?? 0
  const wobble  = deform?.wobble  ?? 0
  const flipped = spinType === 'tumble' && Math.cos(angle) < 0
  const baseColor = design?.color ?? TEAM_COLOR[teamId]
  const color     = flipped ? TEAM_DARK[teamId] : baseColor

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  if (spinType === 'tumble') {
    ctx.scale(squashX, squashY * Math.max(0.08, Math.abs(Math.cos(angle))))
  } else {
    ctx.rotate(angle + wobble * 0.045)
    ctx.scale(squashX, squashY)
  }

  ctx.shadowBlur = hs * 0.9; ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowOffsetY = (angle === 0 && squashY >= 0.98) ? hs * 0.35 : 0
  drawBagShape(ctx, hs, bulge, droop); ctx.fillStyle = color; ctx.fill()
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0

  drawBagShape(ctx, hs, bulge, droop); ctx.fillStyle = color; ctx.fill()

  if (!flipped && design) drawBagPattern(ctx, hs, design.pattern)

  if (!flipped) {
    const hl = ctx.createLinearGradient(0, -hs, 0, -hs + hs * 0.5)
    hl.addColorStop(0, 'rgba(255,255,255,0.22)'); hl.addColorStop(1, 'rgba(255,255,255,0)')
    drawBagShape(ctx, hs, bulge, droop); ctx.fillStyle = hl; ctx.fill()
  }

  drawBagShape(ctx, hs, bulge, droop)
  ctx.strokeStyle = TEAM_LIGHT[teamId] + '88'; ctx.lineWidth = Math.max(0.8, hs * 0.1); ctx.stroke()

  ctx.restore()
}

function drawFlyingBag(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number, ty: number, teamId: 0|1, lt: Layout,
  angle: number, spinType: 'yaw' | 'tumble', design?: BagDesign,
) {
  const hs      = bagHalfSize(Math.max(0, Math.min(1, ty)), lt)
  const flipped = spinType === 'tumble' && Math.cos(angle) < 0
  const color   = flipped ? TEAM_DARK[teamId] : (design?.color ?? TEAM_COLOR[teamId])

  ctx.save()
  ctx.translate(sx, sy)
  if (spinType === 'tumble') ctx.scale(1, Math.max(0.08, Math.abs(Math.cos(angle))))
  else ctx.rotate(angle)

  ctx.shadowBlur = hs * 0.8; ctx.shadowColor = 'rgba(0,0,0,0.4)'
  drawBagShape(ctx, hs, 0, 0); ctx.fillStyle = color; ctx.fill()
  ctx.shadowBlur = 0

  drawBagShape(ctx, hs, 0, 0); ctx.fillStyle = color; ctx.fill()

  if (!flipped && design) drawBagPattern(ctx, hs, design.pattern)

  if (!flipped) {
    const hl = ctx.createLinearGradient(0, -hs, 0, 0)
    hl.addColorStop(0, 'rgba(255,255,255,0.25)'); hl.addColorStop(1, 'rgba(255,255,255,0)')
    drawBagShape(ctx, hs, 0, 0); ctx.fillStyle = hl; ctx.fill()
  }

  drawBagShape(ctx, hs, 0, 0)
  ctx.strokeStyle = TEAM_LIGHT[teamId] + '88'; ctx.lineWidth = Math.max(0.8, hs * 0.1); ctx.stroke()

  ctx.restore()
}

function drawGroundShadow(
  ctx: CanvasRenderingContext2D, p: { x: number; y: number; z: number },
  lt: Layout, shadowOpacity: number,
) {
  const groundPos = worldPt(p.x, p.y, 0, lt)
  const ty        = Math.max(0, Math.min(1, p.y / 120))
  const hs        = bagHalfSize(ty, lt)
  const zNorm     = Math.min(1, Math.max(0, p.z / 80))
  const rx        = hs * (1 + zNorm * 1.1)
  const ry        = rx * 0.28
  const opacity   = shadowOpacity * (0.48 - zNorm * 0.38)
  if (opacity < 0.02) return
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.translate(groundPos.x, groundPos.y)
  ctx.scale(1, ry / rx)
  ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fill()
  ctx.restore()
}

function drawPopups(ctx: CanvasRenderingContext2D, popups: Popup[], lt: Layout, ts: number) {
  for (const p of popups) {
    const age = (ts - p.startT) / POPUP_DURATION
    if (age >= 1) continue
    const { x, y } = bagPos(p.bx, p.by, lt)
    ctx.save()
    ctx.globalAlpha = 1 - age
    ctx.font = `bold ${Math.round(lt.cssW * 0.062)}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowBlur = 10; ctx.shadowColor = 'rgba(0,0,0,0.9)'
    ctx.fillStyle = '#fcd34d'
    ctx.fillText(p.text, x, y - age * 44)
    ctx.restore()
  }
}

function drawCrosshair(ctx: CanvasRenderingContext2D, bx: number, by: number, lt: Layout) {
  const { x, y } = bagPos(bx, by, lt)
  const ty   = by / 120
  const size = Math.max(10, pxPerCm(ty, lt) * 14)

  ctx.strokeStyle = 'rgba(255,230,50,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3])
  ctx.beginPath(); ctx.arc(x, y, size * 0.7, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x - size, y); ctx.lineTo(x - size * 0.38, y)
  ctx.moveTo(x + size * 0.38, y); ctx.lineTo(x + size, y)
  ctx.moveTo(x, y - size); ctx.lineTo(x, y - size * 0.38)
  ctx.moveTo(x, y + size * 0.38); ctx.lineTo(x, y + size)
  ctx.stroke(); ctx.setLineDash([])
}

function drawSlidePreview(
  ctx: CanvasRenderingContext2D,
  aim: { bx: number; by: number },
  flightType: FlightType, physics: PhysicsConfig, lt: Layout,
) {
  const idealP = computeIdealPower(aim.by)
  const baseV  = { flat: physics.slideVFlat, roll: physics.slideVRoll, airmail: physics.slideVAirmail }[flightType]
  const v0     = idealP * baseV
  const dist   = (v0 * v0) / (2 * physics.pushFriction)
  if (dist < 1) return
  const endY = Math.min(BOARD.length + 5, aim.by + dist)
  const p0   = bagPos(aim.bx, aim.by, lt)
  const p1   = bagPos(aim.bx, endY, lt)
  ctx.save()
  ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y)
  ctx.strokeStyle = 'rgba(255,230,50,0.40)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4])
  ctx.stroke(); ctx.setLineDash([]); ctx.restore()
}

function drawTrajectoryLine(
  ctx: CanvasRenderingContext2D, traj: Point[], lt: Layout,
  upTo: number, color: string, dashed: boolean, maxZ = Infinity,
) {
  if (traj.length < 2 || upTo <= 0) return
  const n  = Math.max(2, Math.floor(traj.length * upTo))
  const t0 = traj[0]
  const p0 = worldPt(t0.x, t0.y, Math.min(t0.z, maxZ), lt)
  ctx.beginPath(); ctx.moveTo(p0.x, p0.y)
  for (let i = 1; i < n; i++) {
    const tp = traj[i]
    const p  = worldPt(tp.x, tp.y, Math.min(tp.z, maxZ), lt)
    ctx.lineTo(p.x, p.y)
  }
  ctx.strokeStyle = color; ctx.lineWidth = 2
  if (dashed) ctx.setLineDash([5, 5])
  ctx.stroke()
  if (dashed) ctx.setLineDash([])
}

function drawDebugOverlay(ctx: CanvasRenderingContext2D, lt: Layout) {
  ctx.strokeStyle = 'rgba(0,255,255,0.35)'; ctx.lineWidth = 0.8; ctx.setLineDash([3, 3])
  for (let cx_cm = -30; cx_cm <= 30; cx_cm += 10) {
    const p0 = worldPt(cx_cm, 0,   0, lt); const p1 = worldPt(cx_cm, 120, 0, lt)
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke()
  }
  for (let cy_cm = 0; cy_cm <= 120; cy_cm += 10) {
    const p0 = worldPt(-30, cy_cm, 0, lt); const p1 = worldPt(30, cy_cm, 0, lt)
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke()
  }
  ctx.setLineDash([])
  const hPos = bagPos(BOARD.holeX, BOARD.holeY, lt)
  const hTy  = BOARD.holeY / 120
  const hr   = holeRadius(hTy, lt)
  ctx.beginPath(); ctx.arc(hPos.x, hPos.y, hr, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,0,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke()
  ctx.fillStyle = 'rgba(0,255,255,0.7)'
  ctx.font = `${Math.max(8, pxPerCm(0, lt) * 4)}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  for (let cy_cm = 0; cy_cm <= 120; cy_cm += 10) {
    const p = worldPt(0, cy_cm, 0, lt)
    ctx.fillText(`${cy_cm}`, p.x, p.y + 2)
  }
}

function drawHUD(ctx: CanvasRenderingContext2D, g: GameData, lt: Layout) {
  const { cssW: W, hudH: H } = lt
  const fs = g.frameState

  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.fillRect(0, 0, W, H)

  // Scores
  ctx.font = `bold ${Math.round(H * 0.55)}px system-ui,sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillStyle = TEAM_COLOR[0]; ctx.textAlign = 'right'
  ctx.fillText(String(fs.scores[0]), W * 0.45, H * 0.5)
  ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.textAlign = 'center'
  ctx.font = `${Math.round(H * 0.38)}px system-ui,sans-serif`
  ctx.fillText(':', W * 0.5, H * 0.48)
  ctx.fillStyle = TEAM_COLOR[1]; ctx.textAlign = 'left'
  ctx.font = `bold ${Math.round(H * 0.55)}px system-ui,sans-serif`
  ctx.fillText(String(fs.scores[1]), W * 0.55, H * 0.5)

  // Frame number (top-left)
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = `${Math.round(H * 0.28)}px system-ui,sans-serif`
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText(`Fr.${fs.frameIndex + 1}`, 8, 4)

  // Mute button (bottom-left of HUD)
  const mBtnS = Math.round(H * 0.36)
  const mBtnY = H - mBtnS - 3
  ctx.fillStyle = g.muted ? 'rgba(220,60,60,0.25)' : 'rgba(255,255,255,0.10)'
  ctx.beginPath(); ctx.roundRect(6, mBtnY, mBtnS, mBtnS, 4); ctx.fill()
  ctx.fillStyle = g.muted ? '#fca5a5' : 'rgba(255,255,255,0.55)'
  ctx.font = `${Math.round(mBtnS * 0.64)}px system-ui,sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(g.muted ? '✕' : '♪', 6 + mBtnS / 2, mBtnY + mBtnS / 2)

  // Active team indicator (top-right)
  const turnLabel = fs.activeTeam === 0 ? 'Du ▶' : '▶ KI'
  const turnColor = TEAM_COLOR[fs.activeTeam]
  ctx.fillStyle = g.uiPhase === 'playing' ? turnColor : 'rgba(255,255,255,0.25)'
  ctx.font = `${Math.round(H * 0.30)}px system-ui,sans-serif`
  ctx.textAlign = 'right'; ctx.textBaseline = 'top'
  ctx.fillText(turnLabel, W - 8, 4)

  // Bag dots
  const dotR    = Math.max(3, H * 0.09)
  const dotY    = H * 0.82
  const spacing = dotR * 2.8
  const base0   = W / 2 - BAGS_PER_TEAM * spacing - spacing * 0.5
  const base1   = W / 2 + spacing * 0.5
  const thrown0 = BAGS_PER_TEAM - fs.throwsLeft[0]
  const thrown1 = BAGS_PER_TEAM - fs.throwsLeft[1]
  for (let i = 0; i < BAGS_PER_TEAM; i++) {
    ctx.beginPath(); ctx.arc(base0 + i * spacing, dotY, dotR, 0, Math.PI * 2)
    ctx.fillStyle = i < thrown0 ? TEAM_COLOR[0] : 'rgba(255,255,255,0.15)'; ctx.fill()
    ctx.beginPath(); ctx.arc(base1 + i * spacing, dotY, dotR, 0, Math.PI * 2)
    ctx.fillStyle = i < thrown1 ? TEAM_COLOR[1] : 'rgba(255,255,255,0.15)'; ctx.fill()
  }

  if (g.debugMode) {
    ctx.fillStyle = 'rgba(0,255,255,0.8)'
    ctx.font = `${Math.round(H * 0.28)}px monospace`
    ctx.textAlign = 'right'; ctx.textBaseline = 'top'
    ctx.fillText('DEBUG', W - 6, H - 14)
  }
}

function drawFlightButtons(ctx: CanvasRenderingContext2D, g: GameData, lt: Layout) {
  const { cssW: W, throwZoneY: zy } = lt
  const bh = 26, btnY = zy + 10, gap = 6
  const bw = (W - gap * 4) / 3
  ctx.textBaseline = 'middle'
  for (let i = 0; i < FLIGHT_TYPES.length; i++) {
    const ft     = FLIGHT_TYPES[i]
    const btnX   = gap + i * (bw + gap)
    const active = g.flightType === ft
    ctx.beginPath(); ctx.roundRect(btnX, btnY, bw, bh, 5)
    ctx.fillStyle   = active ? TEAM_COLOR[0] : 'rgba(255,255,255,0.08)'; ctx.fill()
    ctx.strokeStyle = active ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1; ctx.stroke()
    ctx.fillStyle  = active ? '#fff' : 'rgba(255,255,255,0.40)'
    ctx.font       = `${active ? 'bold ' : ''}${Math.round(bh * 0.50)}px system-ui,sans-serif`
    ctx.textAlign  = 'center'
    ctx.fillText(FLIGHT_LABELS[ft], btnX + bw / 2, btnY + bh / 2)
  }
}

function drawThrowZone(ctx: CanvasRenderingContext2D, g: GameData, lt: Layout) {
  const { cssW: W, cssH: H, throwZoneY: zy } = lt
  const zh = H - zy

  const bg = ctx.createLinearGradient(0, zy, 0, H)
  bg.addColorStop(0, 'rgba(0,0,0,0.55)'); bg.addColorStop(1, 'rgba(0,0,0,0.75)')
  ctx.fillStyle = bg; ctx.fillRect(0, zy, W, zh)

  // separator line
  const lineColor = g.frameState.activeTeam === 0
    ? `${TEAM_COLOR[0]}55`
    : 'rgba(255,255,255,0.10)'
  ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(0, zy); ctx.lineTo(W, zy); ctx.stroke()

  if (g.frameState.activeTeam !== 0) {
    // AI's turn indicator
    ctx.fillStyle    = 'rgba(255,255,255,0.30)'
    ctx.font         = `${Math.round(zh * 0.18)}px system-ui,sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('KI wirft…', W / 2, zy + zh * 0.5)
    return
  }

  drawFlightButtons(ctx, g, lt)

  const color = TEAM_COLOR[0]
  const dark  = TEAM_DARK[0]
  const ctr   = bagRestCenter(lt)
  const ir    = Math.min(zh * 0.22, 22)

  if (g.phase === 'charging' && g.chargeOrig && g.chargeCurr) {
    const rawDy   = g.chargeCurr.sy - g.chargeOrig.sy
    const dy      = Math.max(0, rawDy)
    const maxPull = zh * g.pullPowerRatio
    const power   = Math.min(dy / maxPull, 1)
    const bagY    = Math.min(H - ir - 4, ctr.y + dy)

    ctx.strokeStyle = `${color}55`; ctx.lineWidth = 2; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(ctr.x, ctr.y - ir); ctx.lineTo(ctr.x, bagY - ir)
    ctx.stroke(); ctx.setLineDash([])

    ctx.save()
    ctx.shadowBlur = ir * 0.9; ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.arc(ctr.x, bagY, ir + 4, 0, Math.PI * 2)
    ctx.fillStyle = `${dark}88`; ctx.fill()
    ctx.beginPath(); ctx.arc(ctr.x, bagY, ir, 0, Math.PI * 2)
    ctx.fillStyle = color; ctx.fill()
    ctx.restore()

    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.font = `bold ${Math.round(ir * 0.62)}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`${Math.round(power * 100)}%`, ctr.x, bagY)

    const barW = 8, barH = zh * 0.55
    const barX = W - 22, barY0 = zy + (zh - barH) / 2
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath(); ctx.roundRect(barX, barY0, barW, barH, 3); ctx.fill()
    if (power > 0) {
      const fillH = barH * power
      ctx.fillStyle = color
      ctx.beginPath(); ctx.roundRect(barX, barY0 + barH - fillH, barW, fillH, 3); ctx.fill()
    }
    const ip      = computeIdealPower(g.aim.by)
    const markerY = barY0 + barH * (1 - ip)
    const zoneH   = barH * g.idealZoneWidth * 2
    ctx.fillStyle = 'rgba(252,211,77,0.22)'
    ctx.fillRect(barX - 2, markerY - zoneH / 2, barW + 4, zoneH)
    ctx.fillStyle = '#fcd34d'; ctx.fillRect(barX - 3, markerY - 1.5, barW + 6, 3)
  } else {
    ctx.save()
    ctx.shadowBlur = ir * 0.9; ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.arc(ctr.x, ctr.y, ir + 4, 0, Math.PI * 2)
    ctx.fillStyle = `${dark}88`; ctx.fill()
    ctx.beginPath(); ctx.arc(ctr.x, ctr.y, ir, 0, Math.PI * 2)
    ctx.fillStyle = color; ctx.fill()
    ctx.restore()

    if (g.phase === 'idle' || g.phase === 'settled') {
      for (let i = 0; i < 3; i++) {
        const alpha = (i + 1) / 3
        const ay = ctr.y + ir + 8 + i * 10
        const s  = 10
        ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.45})`
        ctx.lineWidth = 2; ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(ctr.x - s, ay - s * 0.5); ctx.lineTo(ctr.x, ay + s * 0.5); ctx.lineTo(ctr.x + s, ay - s * 0.5)
        ctx.stroke()
      }
    }
  }
}

function drawOutcomeLabel(ctx: CanvasRenderingContext2D, outcome: 'in' | 'on' | 'off', lt: Layout) {
  const label = outcome === 'in' ? 'HOLE!' : outcome === 'on' ? 'ON BOARD' : 'MISS'
  const color = outcome === 'in' ? '#fcd34d' : outcome === 'on' ? '#86efac' : '#fca5a5'
  const cx = lt.cssW / 2
  const cy = (lt.frontLeft.y + lt.backLeft.y) / 2
  ctx.save()
  ctx.font = `bold ${Math.round(lt.cssW * 0.065)}px system-ui,sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  const m = ctx.measureText(label)
  const pad = 14
  ctx.fillStyle = 'rgba(0,0,0,0.7)'
  ctx.roundRect(cx - m.width / 2 - pad, cy - 22, m.width + pad * 2, 44, 10); ctx.fill()
  ctx.fillStyle = color; ctx.fillText(label, cx, cy)
  ctx.restore()
}

function drawFrameSummaryOverlay(
  ctx: CanvasRenderingContext2D, g: GameData, lt: Layout,
) {
  if (!g.frameSummaryInfo) return
  const { cssW: W, cssH: H } = lt
  const { framePts, netPts } = g.frameSummaryInfo
  const cx = W / 2
  const cy = (lt.frontLeft.y + lt.backLeft.y) / 2

  const bw = Math.min(W * 0.78, 300)
  const bh = 80
  const bx = cx - bw / 2
  const by = cy - bh / 2

  ctx.fillStyle = 'rgba(0,0,0,0.82)'
  ctx.roundRect(bx, by, bw, bh, 12); ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1
  ctx.roundRect(bx, by, bw, bh, 12); ctx.stroke()

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `${Math.round(bh * 0.22)}px system-ui,sans-serif`
  ctx.fillText(`Frame ${g.frameState.frameIndex} abgeschlossen`, cx, by + bh * 0.25)

  const pts0 = framePts[0], pts1 = framePts[1]
  const net0 = netPts[0],   net1 = netPts[1]

  ctx.font = `bold ${Math.round(bh * 0.28)}px system-ui,sans-serif`
  ctx.fillStyle = net0 > 0 ? '#fcd34d' : 'rgba(255,255,255,0.55)'
  ctx.textAlign = 'right'
  ctx.fillText(`Du  ${pts0}pts → +${net0}`, cx - 10, by + bh * 0.65)

  ctx.fillStyle = net1 > 0 ? '#fcd34d' : 'rgba(255,255,255,0.55)'
  ctx.textAlign = 'left'
  ctx.fillText(`KI  ${pts1}pts → +${net1}`, cx + 10, by + bh * 0.65)

  // tap hint
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.font = `${Math.round(bh * 0.16)}px system-ui,sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('Tippen zum Fortfahren', cx, by + bh + 14)

  // entire screen is a button to advance
  g.overlayButtons = [{ x: 0, y: 0, w: W, h: H, tag: 'frame-continue' }]
}

function drawMatchOverOverlay(
  ctx: CanvasRenderingContext2D, g: GameData, lt: Layout,
) {
  const { cssW: W, cssH: H } = lt
  ctx.fillStyle = 'rgba(0,0,0,0.90)'
  ctx.fillRect(0, 0, W, H)

  const cx     = W / 2
  const winner = g.matchWinner!
  const winText = winner === 0 ? 'Du gewinnst!' : 'KI gewinnt!'

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = TEAM_COLOR[winner]
  ctx.font = `bold ${Math.round(W * 0.085)}px system-ui,sans-serif`
  ctx.fillText(winText, cx, H * 0.10)

  ctx.fillStyle = 'rgba(255,255,255,0.65)'
  ctx.font = `${Math.round(W * 0.060)}px system-ui,sans-serif`
  ctx.fillText(`${g.frameState.scores[0]} : ${g.frameState.scores[1]}`, cx, H * 0.18)

  // ── Stats table ──
  const st   = g.matchStats
  const fr   = Math.max(1, st.frames)
  const rows = [
    { label: 'Punkte pro Frame', v0: (st.ptsTotal[0] / fr).toFixed(1),  v1: (st.ptsTotal[1] / fr).toFixed(1) },
    { label: 'Loch-Quote',       v0: `${Math.round(st.holesTotal[0] / (fr * BAGS_PER_TEAM) * 100)}%`,
                                  v1: `${Math.round(st.holesTotal[1] / (fr * BAGS_PER_TEAM) * 100)}%` },
    { label: '4-Bagger',         v0: String(st.fourBaggers[0]),          v1: String(st.fourBaggers[1]) },
  ]

  const tbW  = Math.min(W * 0.88, 340)
  const tbX  = cx - tbW / 2
  const tbY0 = H * 0.26
  const rowH = Math.round(H * 0.068)
  const fs   = Math.max(11, Math.round(tbW * 0.055))

  // Column anchors: label occupies left 58 %, values share right 42 %
  const cLabelL   = tbX + 6
  const cVal0R    = tbX + Math.round(tbW * 0.78)
  const cVal1L    = tbX + Math.round(tbW * 0.82)
  const labelMaxW = Math.round(tbW * 0.58) - 6

  ctx.font = `bold ${fs}px system-ui,sans-serif`
  ctx.fillStyle = g.playerDesign.color
  ctx.textAlign = 'right'; ctx.fillText('Du', cVal0R, tbY0)
  ctx.fillStyle = g.opponentDesign.color
  ctx.textAlign = 'left';  ctx.fillText('KI', cVal1L, tbY0)

  rows.forEach((row, i) => {
    const ry = tbY0 + (i + 1) * rowH
    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fillRect(tbX, ry - rowH * 0.5, tbW, rowH)
    }
    ctx.font = `${fs}px system-ui,sans-serif`
    const lw = ctx.measureText(row.label).width
    if (lw > labelMaxW) {
      ctx.font = `${Math.max(9, Math.floor(fs * labelMaxW / lw))}px system-ui,sans-serif`
    }
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.textAlign = 'left'
    ctx.fillText(row.label, cLabelL, ry)

    ctx.font = `${fs}px system-ui,sans-serif`
    ctx.fillStyle = g.playerDesign.color;   ctx.textAlign = 'right'
    ctx.fillText(row.v0, cVal0R, ry)
    ctx.fillStyle = g.opponentDesign.color; ctx.textAlign = 'left'
    ctx.fillText(row.v1, cVal1L, ry)
  })

  // ── Buttons ──
  const btnH  = Math.round(H * 0.072)
  const gap   = 8
  const btnW  = Math.min(W * 0.84, 320)
  const btnX  = cx - btnW / 2
  const btn2W = (btnW - gap) / 2

  const byRow1 = tbY0 + (rows.length + 1.4) * rowH
  const byRow2 = byRow1 + btnH + gap
  const byRow3 = byRow2 + btnH + gap

  // stack secondary buttons when side-by-side would make them too narrow
  const stack = btn2W < 140

  function drawBtn(bx: number, by: number, bw: number, label: string, active = false) {
    ctx.beginPath(); ctx.roundRect(bx, by, bw, btnH, 8)
    ctx.fillStyle = active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.09)'; ctx.fill()
    ctx.strokeStyle = active ? 'rgba(255,255,255,0.50)' : 'rgba(255,255,255,0.22)'
    ctx.lineWidth = 1.2; ctx.stroke()
    ctx.fillStyle = '#fff'
    const nomFs = Math.round(btnH * 0.44)
    ctx.font     = `${active ? 'bold ' : ''}${nomFs}px system-ui,sans-serif`
    const tw     = ctx.measureText(label).width
    const fitFs  = tw > bw - 20 ? Math.max(10, Math.floor(nomFs * (bw - 20) / tw)) : nomFs
    ctx.font     = `${active ? 'bold ' : ''}${fitFs}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(label, bx + bw / 2, by + btnH / 2)
  }

  drawBtn(btnX, byRow1, btnW, 'Nochmal', true)
  if (stack) {
    drawBtn(btnX, byRow2, btnW, 'Gegner wechseln')
    drawBtn(btnX, byRow3, btnW, 'Hauptmenü')
    g.overlayButtons = [
      { x: btnX, y: byRow1, w: btnW, h: btnH, tag: 'restart' },
      { x: btnX, y: byRow2, w: btnW, h: btnH, tag: 'change-opponent' },
      { x: btnX, y: byRow3, w: btnW, h: btnH, tag: 'main-menu' },
    ]
  } else {
    drawBtn(btnX,               byRow2, btn2W, 'Gegner wechseln')
    drawBtn(btnX + btn2W + gap, byRow2, btn2W, 'Hauptmenü')
    g.overlayButtons = [
      { x: btnX,               y: byRow1, w: btnW,  h: btnH, tag: 'restart' },
      { x: btnX,               y: byRow2, w: btn2W, h: btnH, tag: 'change-opponent' },
      { x: btnX + btn2W + gap, y: byRow2, w: btn2W, h: btnH, tag: 'main-menu' },
    ]
  }
}

function drawSetupOverlay(
  ctx: CanvasRenderingContext2D, g: GameData, lt: Layout,
) {
  const { cssW: W, cssH: H } = lt
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, '#0d1b0a'); grad.addColorStop(1, '#1a3d12')
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H)

  const cx      = W / 2
  const secW    = Math.min(W * 0.88, 340)
  const secX    = cx - secW / 2
  const buttons: OverlayButton[] = []

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${Math.round(W * 0.10)}px system-ui,sans-serif`
  ctx.fillText('Cornhole', cx, H * 0.09)

  // ── Sack-Design ──
  const desY = H * 0.16
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `${Math.round(W * 0.042)}px system-ui,sans-serif`
  ctx.textAlign = 'left'
  ctx.fillText('Dein Sack-Design', secX, desY)

  // Color swatches: 2 rows × 4
  const swR   = Math.min(Math.round(secW / 10), 18)
  const swGap = Math.round((secW - 8 * swR * 2) / 9)
  const swY0  = desY + Math.round(H * 0.045)
  for (let i = 0; i < 8; i++) {
    const row  = Math.floor(i / 4)
    const col  = i % 4
    const sx   = secX + col * (swR * 2 + swGap) + swR
    const sy   = swY0 + row * (swR * 2 + 6) + swR
    const sel  = g.playerDesign.color === BAG_COLORS[i]
    ctx.beginPath(); ctx.arc(sx, sy, swR, 0, Math.PI * 2)
    ctx.fillStyle = BAG_COLORS[i]; ctx.fill()
    if (sel) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(sx, sy, swR + 3, 0, Math.PI * 2); ctx.stroke()
    }
    buttons.push({ x: sx - swR - 2, y: sy - swR - 2, w: swR * 2 + 4, h: swR * 2 + 4, tag: `design-color-${i}` })
  }

  // Pattern buttons
  const ptY   = swY0 + 2 * (swR * 2 + 6) + swR + Math.round(H * 0.016)
  const ptBW  = Math.round((secW - 4 * 6) / 5)
  const ptBH  = Math.round(H * 0.046)
  for (let i = 0; i < BAG_PATTERNS.length; i++) {
    const pt   = BAG_PATTERNS[i]
    const pbx  = secX + i * (ptBW + 6)
    const sel  = g.playerDesign.pattern === pt
    ctx.beginPath(); ctx.roundRect(pbx, ptY, ptBW, ptBH, 5)
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)'; ctx.fill()
    ctx.strokeStyle = sel ? 'rgba(255,255,255,0.60)' : 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 1; ctx.stroke()
    ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.50)'
    ctx.font = `${sel ? 'bold ' : ''}${Math.round(ptBH * 0.46)}px system-ui,sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(BAG_PATTERN_NAMES[pt], pbx + ptBW / 2, ptY + ptBH / 2)
    buttons.push({ x: pbx, y: ptY, w: ptBW, h: ptBH, tag: `design-pattern-${pt}` })
  }

  // Bag preview
  const prevY  = ptY + ptBH + Math.round(H * 0.024)
  const prevFs = Math.round(W * 0.034)
  ctx.font = `${prevFs}px system-ui,sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.38)'; ctx.textAlign = 'left'
  ctx.fillText('Vorschau:', secX, prevY + swR)

  const prevBagX0 = secX + Math.round(secW * 0.34)
  const prevBagX1 = secX + Math.round(secW * 0.62)
  const previewHs = swR + 2

  // player bag preview
  ctx.save()
  ctx.translate(prevBagX0, prevY + swR)
  ctx.beginPath(); ctx.roundRect(-previewHs, -previewHs, previewHs * 2, previewHs * 2, previewHs * 0.28)
  ctx.fillStyle = g.playerDesign.color; ctx.fill()
  drawBagPattern(ctx, previewHs, g.playerDesign.pattern)
  ctx.strokeStyle = 'rgba(255,255,255,0.30)'; ctx.lineWidth = 1; ctx.stroke()
  ctx.restore()
  ctx.fillStyle = g.playerDesign.color; ctx.textAlign = 'left'
  ctx.fillText('Du', prevBagX0 + previewHs + 5, prevY + swR)

  // opponent bag preview
  ctx.save()
  ctx.translate(prevBagX1, prevY + swR)
  ctx.beginPath(); ctx.roundRect(-previewHs, -previewHs, previewHs * 2, previewHs * 2, previewHs * 0.28)
  ctx.fillStyle = g.opponentDesign.color; ctx.fill()
  drawBagPattern(ctx, previewHs, g.opponentDesign.pattern)
  ctx.strokeStyle = 'rgba(255,255,255,0.30)'; ctx.lineWidth = 1; ctx.stroke()
  ctx.restore()
  ctx.fillStyle = g.opponentDesign.color; ctx.textAlign = 'left'
  ctx.fillText('KI', prevBagX1 + previewHs + 5, prevY + swR)

  // ── Separator ──
  const sepY = prevY + swR * 2 + Math.round(H * 0.022)
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(secX, sepY); ctx.lineTo(secX + secW, sepY); ctx.stroke()

  // ── Gegner wählen ──
  const aiLabelY = sepY + Math.round(H * 0.028)
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `${Math.round(W * 0.042)}px system-ui,sans-serif`
  ctx.textAlign = 'left'
  ctx.fillText('Gegner wählen', secX, aiLabelY)

  const styles: AiStyle[] = ['blocker', 'airmailer', 'nervenbundel']
  const bh  = Math.round(H * 0.080)
  const gap = Math.round(H * 0.014)
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i]
    const by    = aiLabelY + Math.round(H * 0.040) + i * (bh + gap)

    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath(); ctx.roundRect(secX, by, secW, bh, 10); ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.roundRect(secX, by, secW, bh, 10); ctx.stroke()

    ctx.fillStyle = '#fff'
    ctx.font = `bold ${Math.round(bh * 0.32)}px system-ui,sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText(AI_STYLE_LABELS[style], secX + 14, by + bh * 0.36)

    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = `${Math.round(bh * 0.26)}px system-ui,sans-serif`
    ctx.fillText(AI_STYLE_DESCS[style], secX + 14, by + bh * 0.72)

    buttons.push({ x: secX, y: by, w: secW, h: bh, tag: `style-${style}` })
  }

  g.overlayButtons = buttons
}

// ---- Main render ----

function render(ctx: CanvasRenderingContext2D, g: GameData, ts: number, bagDeforms: Map<string, BagDeform>) {
  const lt = g.layout
  ctx.clearRect(0, 0, lt.cssW, lt.cssH)

  if (g.uiPhase === 'setup') {
    drawSetupOverlay(ctx, g, lt)
    return
  }

  const fs = g.frameState
  const bagDesign = (teamId: 0|1) => teamId === 0 ? g.playerDesign : g.opponentDesign

  const zoomCx = (lt.frontLeft.x + lt.frontRight.x) / 2
  const zoomCy = (lt.backLeft.y + lt.frontLeft.y) / 2
  ctx.save()
  ctx.translate(zoomCx, zoomCy)
  ctx.scale(g.camZoom, g.camZoom)
  ctx.translate(-zoomCx, -zoomCy)

  drawBackground(ctx, lt)
  drawSilhouettes(ctx, lt)
  drawBoard(ctx, lt)

  if (g.debugMode) drawDebugOverlay(ctx, lt)

  if (g.phase === 'idle' || g.phase === 'charging' || g.phase === 'settled') {
    for (const b of fs.boardState.bags) {
      const d  = bagDeforms.get(b.id)
      const ds = d ? computeDeform(d, ts) : undefined
      if (ds) {
        const holeDist = Math.sqrt((b.x - BOARD.holeX) ** 2 + (b.y - BOARD.holeY) ** 2)
        if (holeDist < 10) ds.droop = Math.max(0, (10 - holeDist) / 10) * 0.4
      }
      drawBag(ctx, b.x, b.y, b.teamId, lt, 1, 0, 'yaw', bagDesign(b.teamId), ds)
    }
    if (fs.activeTeam === 0) {
      drawCrosshair(ctx, g.aim.bx, g.aim.by, lt)
      drawSlidePreview(ctx, g.aim, g.flightType, g.physicsConfig, lt)
    }
  }

  if (g.phase === 'flying' && g.pending) {
    const traj         = g.pending.trajectory
    const flyDurSec    = g.flyDur / 1000
    const elapsed      = (ts - g.flyStart) / 1000
    const tNorm        = Math.min(elapsed / flyDurSec, 1)
    const flightType   = g.pending.thrownFlightType
    const spinRate     = flightType === 'flat'    ? g.spinRateFlat
                       : flightType === 'airmail' ? g.spinRateAirmail
                       : g.spinRateRoll
    const spinType: 'yaw' | 'tumble' = flightType === 'roll' ? 'tumble' : 'yaw'
    const angle  = elapsed * spinRate
    const maxZ   = (lt.frontLeft.y - lt.hudH - 12) / (pxPerCm(0, lt) * Math.max(0.01, lt.zScale))

    for (const b of g.pending.prevBoardBags) {
      const d = bagDeforms.get(b.id)
      drawBag(ctx, b.x, b.y, b.teamId, lt, 1, 0, 'yaw', bagDesign(b.teamId), d ? computeDeform(d, ts) : undefined)
    }
    drawTrajectoryLine(ctx, traj, lt, tNorm, 'rgba(255,240,100,0.7)', false, maxZ)

    const p    = sampleTraj(traj, tNorm)
    drawGroundShadow(ctx, p, lt, g.shadowOpacity)
    const sPos = worldPt(p.x, p.y, Math.min(p.z, maxZ), lt)
    const ty   = Math.max(0, Math.min(1, p.y / 120))
    drawFlyingBag(ctx, sPos.x, sPos.y, ty, g.pending.thrownTeam, lt, angle, spinType, bagDesign(g.pending.thrownTeam))
  }

  if (g.phase === 'sliding' && g.slides.length > 0) {
    const tSlide     = Math.min((ts - g.slideStart) / SLIDE_MS, 1)
    const ease       = 1 - Math.pow(1 - tSlide, 3)
    const slidingIds = new Set(g.slides.map(s => s.id))
    for (const b of g.pending!.prevBoardBags) {
      if (!slidingIds.has(b.id)) {
        const d = bagDeforms.get(b.id)
        drawBag(ctx, b.x, b.y, b.teamId, lt, 1, 0, 'yaw', bagDesign(b.teamId), d ? computeDeform(d, ts) : undefined)
      }
    }
    for (const s of g.slides) {
      const bx    = lerp(s.x0, s.x1, ease)
      const by    = lerp(s.y0, s.y1, ease)
      const alpha = s.outcome === 'off' ? 1 - ease : 1
      const spinDelta = s.spinVelocity * (SLIDE_MS / 1000) * tSlide * (1 - 0.5 * tSlide)
      const angle = s.spinAngle + spinDelta
      const d = bagDeforms.get(s.id)
      if (alpha > 0.02) drawBag(ctx, bx, by, s.teamId, lt, alpha, angle, s.spinType, bagDesign(s.teamId), d ? computeDeform(d, ts) : undefined)
    }
  }

  if (g.phase === 'settled' && g.lastOutcome) {
    drawOutcomeLabel(ctx, g.lastOutcome, lt)
  }

  ctx.restore()

  drawPopups(ctx, g.popups, lt, ts)
  drawThrowZone(ctx, g, lt)
  drawHUD(ctx, g, lt)

  if (g.uiPhase === 'frameSummary' && g.frameSummaryInfo) {
    drawFrameSummaryOverlay(ctx, g, lt)
  } else if (g.uiPhase === 'matchOver') {
    drawMatchOverOverlay(ctx, g, lt)
  } else {
    if (g.overlayButtons.length > 0) g.overlayButtons = []
  }
}

// ---- React component ----

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const g = makeGameData()
    const bagDeforms = new Map<string, BagDeform>()
    let dpr   = 1
    let rafId = 0
    let audioCtx: AudioContext | null = null

    function playSound(name: string) {
      try {
        if (!audioCtx) audioCtx = new AudioContext()
        const ac = audioCtx
        const t  = ac.currentTime

        function noise(dur: number): AudioBufferSourceNode {
          const frames = Math.ceil(ac.sampleRate * dur)
          const buf    = ac.createBuffer(1, frames, ac.sampleRate)
          const data   = buf.getChannelData(0)
          for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
          const src = ac.createBufferSource(); src.buffer = buf
          return src
        }

        function lp(freq: number, q: number): BiquadFilterNode {
          const f = ac.createBiquadFilter()
          f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = q
          return f
        }

        if (name === 'impact') {
          // Low-pass filtered noise burst → dull thud
          const src    = noise(0.18)
          const filter = lp(160, 0.8)
          const gain   = ac.createGain()
          gain.gain.setValueAtTime(g.sndVolImpact, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
          src.connect(filter); filter.connect(gain); gain.connect(ac.destination)
          src.start(t); src.stop(t + 0.14)

        } else if (name === 'friction') {
          // Filtered noise that fades — sliding sound
          const src    = noise(0.45)
          const filter = lp(550, 1.2)
          const gain   = ac.createGain()
          gain.gain.setValueAtTime(g.sndVolFriction * 0.75, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38)
          src.connect(filter); filter.connect(gain); gain.connect(ac.destination)
          src.start(t); src.stop(t + 0.38)

        } else if (name === 'hole') {
          // Slightly deeper than impact, brief resonant thud
          const src    = noise(0.22)
          const filter = lp(220, 1.1)
          const gain   = ac.createGain()
          gain.gain.setValueAtTime(g.sndVolHole, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
          src.connect(filter); filter.connect(gain); gain.connect(ac.destination)
          src.start(t); src.stop(t + 0.18)

        } else if (name === 'miss') {
          // Soft low-frequency thud
          const src    = noise(0.16)
          const filter = lp(130, 0.6)
          const gain   = ac.createGain()
          gain.gain.setValueAtTime(g.sndVolMiss, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
          src.connect(filter); filter.connect(gain); gain.connect(ac.destination)
          src.start(t); src.stop(t + 0.14)

        } else if (name === 'collision') {
          // Bag-on-bag: slightly brighter noise, very short
          const src    = noise(0.12)
          const filter = lp(700, 1.0)
          const gain   = ac.createGain()
          gain.gain.setValueAtTime(g.sndVolCollision, t)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.10)
          src.connect(filter); filter.connect(gain); gain.connect(ac.destination)
          src.start(t); src.stop(t + 0.10)
        }
      } catch { /* audio not available */ }
    }

    function updateLayout() {
      const w = canvas!.clientWidth  || 390
      const h = canvas!.clientHeight || 844
      g.layout = makeLayout(w, h, g.camParams)
    }

    function resize() {
      dpr = window.devicePixelRatio || 1
      const w = canvas!.clientWidth  || 390
      const h = canvas!.clientHeight || 844
      canvas!.width  = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.layout = makeLayout(w, h, g.camParams)
      if (g.debugMode) refreshPanel()
    }

    // ---- Debug panel ----

    let panelOpen = true, camOpen = true, physOpen = true

    const debugPanel = document.createElement('div')
    debugPanel.style.display = 'none'

    const toggleBar = document.createElement('div')
    const toggleBtn = document.createElement('button')
    toggleBtn.style.cssText = 'background:none;border:none;color:#0ff;font:14px/1 monospace;cursor:pointer;padding:0;flex-shrink:0'
    toggleBtn.addEventListener('click', () => { panelOpen = !panelOpen; refreshPanel() })
    toggleBar.appendChild(toggleBtn)

    const collapseLabel = document.createElement('span')
    collapseLabel.textContent = 'DEBUG'
    collapseLabel.style.cssText = 'writing-mode:vertical-rl;font-size:9px;letter-spacing:.12em;opacity:0.45;margin-top:10px;text-transform:uppercase;display:none'
    toggleBar.appendChild(collapseLabel)
    debugPanel.appendChild(toggleBar)

    const panelInner = document.createElement('div')
    panelInner.style.cssText = 'overflow-y:auto;flex:1;min-width:0'
    debugPanel.appendChild(panelInner)

    function makeSection(title: string, getOpen: () => boolean, setOpen: (v: boolean) => void): HTMLDivElement {
      const wrap = document.createElement('div')
      const hdr  = document.createElement('div')
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 10px 4px;cursor:pointer;border-top:1px solid rgba(0,255,255,0.18)'
      const titleEl = document.createElement('span')
      titleEl.style.cssText = 'font-size:11px;font-weight:bold;letter-spacing:.06em'
      titleEl.textContent = title
      const chevron = document.createElement('span')
      chevron.style.cssText = 'font-size:9px;opacity:0.6'
      hdr.appendChild(titleEl); hdr.appendChild(chevron); wrap.appendChild(hdr)
      const body = document.createElement('div')
      body.style.padding = '3px 10px 8px'
      wrap.appendChild(body)
      function refresh() {
        const open = getOpen()
        body.style.display = open ? 'block' : 'none'
        chevron.textContent = open ? '▼' : '▶'
      }
      hdr.addEventListener('click', () => { setOpen(!getOpen()); refresh() })
      refresh()
      panelInner.appendChild(wrap)
      return body
    }

    function addSlider(
      parent: HTMLElement, label: string,
      value: number, min: number, max: number, step: number, fmt: number,
      onChange: (v: number) => void,
    ) {
      const row = document.createElement('div')
      row.style.marginBottom = '5px'
      const hdr = document.createElement('div')
      hdr.style.cssText = 'display:flex;justify-content:space-between;font-size:10px;margin-bottom:1px'
      const lbl = document.createElement('span'); lbl.textContent = label
      const val = document.createElement('span'); val.textContent = value.toFixed(fmt)
      hdr.appendChild(lbl); hdr.appendChild(val)
      const inp = document.createElement('input')
      inp.type = 'range'; inp.min = String(min); inp.max = String(max)
      inp.step = String(step); inp.value = String(value)
      inp.style.cssText = 'width:100%;accent-color:#0ff;cursor:pointer'
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value)
        val.textContent = v.toFixed(fmt)
        onChange(v)
      })
      row.appendChild(hdr); row.appendChild(inp); parent.appendChild(row)
    }

    const camBody = makeSection('KAMERA', () => camOpen, v => { camOpen = v })
    ;([
      { key: 'boardFrontY',      label: 'Front Y',     min: 0.40, max: 0.90, step: 0.01 },
      { key: 'boardBackY',       label: 'Back Y',      min: 0.05, max: 0.65, step: 0.01 },
      { key: 'boardCenterX',     label: 'Center X',    min: 0.20, max: 0.80, step: 0.01 },
      { key: 'frontWidthFactor', label: 'Width front', min: 0.10, max: 1.50, step: 0.01 },
      { key: 'taperFactor',      label: 'Taper',       min: 0.10, max: 0.90, step: 0.01 },
      { key: 'throwZoneY',       label: 'Zone Y',      min: 0.50, max: 0.99, step: 0.01 },
      { key: 'zScale',           label: 'Z-Scale',     min: 0.10, max: 2.00, step: 0.01 },
    ] as Array<{ key: keyof CameraParams; label: string; min: number; max: number; step: number }>)
      .forEach(({ key, label, min, max, step }) =>
        addSlider(camBody, label, g.camParams[key] as number, min, max, step, 2, v => {
          Object.assign(g.camParams, { [key]: v }); updateLayout()
        })
      )

    const physBody = makeSection('PHYSIK', () => physOpen, v => { physOpen = v })
    ;([
      { key: 'apexRoll',          label: 'Apex Roll cm',  min: 10,  max: 250, step: 5,    fmt: 0 },
      { key: 'apexFlat',          label: 'Apex Slide cm', min: 20,  max: 450, step: 5,    fmt: 0 },
      { key: 'apexAirmail',       label: 'Apex Air cm',   min: 50,  max: 700, step: 10,   fmt: 0 },
      { key: 'slideVRoll',        label: 'v-Roll cm/s',   min: 20,  max: 300, step: 5,    fmt: 0 },
      { key: 'slideVFlat',        label: 'v-Slide cm/s',  min: 5,   max: 150, step: 5,    fmt: 0 },
      { key: 'slideVAirmail',     label: 'v-Air cm/s',    min: 2,   max: 80,  step: 1,    fmt: 0 },
      { key: 'collisionTransfer', label: 'Stosskraft',    min: 0,   max: 1,   step: 0.05, fmt: 2 },
      { key: 'pushFriction',      label: 'Reibung cm/s²', min: 50,  max: 800, step: 10,   fmt: 0 },
    ] as Array<{ key: keyof PhysicsConfig; label: string; min: number; max: number; step: number; fmt: number }>)
      .forEach(({ key, label, min, max, step, fmt }) =>
        addSlider(physBody, label, g.physicsConfig[key] as number, min, max, step, fmt, v => {
          Object.assign(g.physicsConfig, { [key]: v })
        })
      )

    let gameOpen = true
    const gameBody = makeSection('SPIEL', () => gameOpen, v => { gameOpen = v })
    ;([
      { key: 'trajSlow',       label: 'Flug-Tempo ×',   min: 0.2, max: 2.0, step: 0.05, fmt: 2 },
      { key: 'settledMs',      label: 'Settled ms',      min: 100, max: 2000, step: 50,  fmt: 0 },
      { key: 'playerSkill',   label: 'Spieler Skill',   min: 0.1, max: 1.0, step: 0.02, fmt: 2 },
      { key: 'idealZoneWidth', label: 'Idealzone Breite',min: 0,   max: 0.4, step: 0.01, fmt: 2 },
      { key: 'pullPowerRatio', label: 'Zug/Kraft',       min: 0.2, max: 1.0, step: 0.02, fmt: 2 },
      { key: 'aimSensitivity', label: 'Ziel-Empfindl.',  min: 0.05,max: 1.0, step: 0.05, fmt: 2 },
    ] as Array<{ key: keyof GameData; label: string; min: number; max: number; step: number; fmt: number }>)
      .forEach(({ key, label, min, max, step, fmt }) =>
        addSlider(gameBody, label, g[key] as number, min, max, step, fmt, v => {
          (g as unknown as Record<string, unknown>)[key as string] = v
        })
      )

    let animOpen = true
    const animBody = makeSection('ANIMATION', () => animOpen, v => { animOpen = v })
    ;([
      { key: 'spinRateFlat',    label: 'Dreh-Slide rad/s',   min: 0, max: 20, step: 0.5, fmt: 1 },
      { key: 'spinRateAirmail', label: 'Dreh-Air rad/s',     min: 0, max: 20, step: 0.5, fmt: 1 },
      { key: 'spinRateRoll',    label: 'Dreh-Roll rad/s',    min: 0, max: 30, step: 0.5, fmt: 1 },
    ] as Array<{ key: keyof GameData; label: string; min: number; max: number; step: number; fmt: number }>)
      .forEach(({ key, label, min, max, step, fmt }) =>
        addSlider(animBody, label, g[key] as number, min, max, step, fmt, v => {
          (g as unknown as Record<string, unknown>)[key as string] = v
        })
      )

    let effOpen = true
    const effBody = makeSection('EFFEKTE', () => effOpen, v => { effOpen = v })
    ;([
      { key: 'deformStrength', label: 'Verformung',  min: 0, max: 1, step: 0.05, fmt: 2 },
      { key: 'shadowOpacity',  label: 'Schatten',    min: 0, max: 1, step: 0.05, fmt: 2 },
      { key: 'cameraZoomStr',  label: 'Kamera-Zoom', min: 0, max: 1, step: 0.05, fmt: 2 },
    ] as Array<{ key: keyof GameData; label: string; min: number; max: number; step: number; fmt: number }>)
      .forEach(({ key, label, min, max, step, fmt }) =>
        addSlider(effBody, label, g[key] as number, min, max, step, fmt, v => {
          (g as unknown as Record<string, unknown>)[key as string] = v
        })
      )

    let sndOpen = true
    const sndBody = makeSection('SOUND', () => sndOpen, v => { sndOpen = v })
    ;([
      { key: 'sndVolImpact',    label: 'Aufprall',    min: 0, max: 1, step: 0.05, fmt: 2 },
      { key: 'sndVolFriction',  label: 'Rutschen',    min: 0, max: 1, step: 0.05, fmt: 2 },
      { key: 'sndVolHole',      label: 'Loch',        min: 0, max: 1, step: 0.05, fmt: 2 },
      { key: 'sndVolMiss',      label: 'Daneben',     min: 0, max: 1, step: 0.05, fmt: 2 },
      { key: 'sndVolCollision', label: 'Kollision',   min: 0, max: 1, step: 0.05, fmt: 2 },
    ] as Array<{ key: keyof GameData; label: string; min: number; max: number; step: number; fmt: number }>)
      .forEach(({ key, label, min, max, step, fmt }) =>
        addSlider(sndBody, label, g[key] as number, min, max, step, fmt, v => {
          (g as unknown as Record<string, unknown>)[key as string] = v
        })
      )

    const printWrap = document.createElement('div')
    printWrap.style.padding = '6px 10px 10px'
    const printBtn = document.createElement('button')
    printBtn.textContent = 'Print to console'
    printBtn.style.cssText = 'width:100%;padding:4px 0;background:rgba(0,255,255,0.10);border:1px solid rgba(0,255,255,0.40);color:#0ff;font:11px monospace;border-radius:4px;cursor:pointer'
    printBtn.addEventListener('click', () => {
      console.log('CameraParams',  JSON.stringify(g.camParams,     null, 2))
      console.log('PhysicsConfig', JSON.stringify(g.physicsConfig, null, 2))
    })
    printWrap.appendChild(printBtn); panelInner.appendChild(printWrap)
    canvas.parentElement!.appendChild(debugPanel)

    function refreshPanel() {
      if (!g.debugMode) { debugPanel.style.display = 'none'; return }
      const narrow = (canvas!.clientWidth || 390) < 500
      if (narrow) {
        debugPanel.style.cssText = [
          'position:absolute','bottom:0','left:0','right:0',
          'display:flex','flex-direction:column',
          'background:rgba(0,0,0,0.88)','color:#0ff','font:11px/1.4 monospace',
          'border-radius:10px 10px 0 0',
          'border:1px solid rgba(0,255,255,0.28)','border-bottom:none',
          'z-index:10',
        ].join(';')
        toggleBar.style.cssText = 'display:flex;align-items:center;justify-content:center;height:36px;flex-shrink:0;cursor:pointer;border-bottom:1px solid rgba(0,255,255,0.18)'
        toggleBtn.textContent = panelOpen ? '▼  DEBUG  ▼' : '▲  DEBUG  ▲'
        collapseLabel.style.display = 'none'
        panelInner.style.cssText = panelOpen ? 'overflow-y:auto;max-height:calc(33vh - 36px);flex:1' : 'display:none'
      } else {
        debugPanel.style.cssText = [
          'position:absolute','top:0','right:0','bottom:0',
          `width:${panelOpen ? '220px' : '26px'}`,
          'display:flex','flex-direction:row',
          'background:rgba(0,0,0,0.72)','color:#0ff','font:11px/1.4 monospace',
          'border-left:1px solid rgba(0,255,255,0.20)',
          'z-index:10',
        ].join(';')
        toggleBar.style.cssText = 'display:flex;flex-direction:column;align-items:center;width:26px;flex-shrink:0;padding-top:10px;gap:4px;cursor:pointer'
        toggleBtn.textContent = panelOpen ? '◀' : '▶'
        collapseLabel.style.display = panelOpen ? 'none' : 'block'
        panelInner.style.cssText = panelOpen ? 'overflow-y:auto;flex:1;min-width:0;padding-bottom:12px' : 'display:none'
      }
    }

    // ---- Pointer helpers ----

    function flightButtonAt(sx: number, sy: number): FlightType | null {
      const lt   = g.layout
      const { cssW: W, throwZoneY: zy } = lt
      const bh = 26, gap = 6, btnY = zy + 10
      if (sy < btnY || sy > btnY + bh) return null
      const bw = (W - gap * 4) / 3
      for (let i = 0; i < FLIGHT_TYPES.length; i++) {
        const btnX = gap + i * (bw + gap)
        if (sx >= btnX && sx <= btnX + bw) return FLIGHT_TYPES[i]
      }
      return null
    }

    function isOnBag(sx: number, sy: number): boolean {
      const ctr  = bagRestCenter(g.layout)
      const zh   = g.layout.cssH - g.layout.throwZoneY
      const ir   = Math.min(zh * 0.22, 22)
      return (sx - ctr.x) ** 2 + (sy - ctr.y) ** 2 <= (ir * 2.5) ** 2
    }

    function canvasXY(e: PointerEvent): { sx: number; sy: number } {
      const rect = canvas!.getBoundingClientRect()
      return { sx: e.clientX - rect.left, sy: e.clientY - rect.top }
    }

    function hitOverlayButton(sx: number, sy: number): OverlayButton | null {
      for (const b of g.overlayButtons) {
        if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return b
      }
      return null
    }

    let activeThrowId = -1
    let activeAimId   = -1

    function onPointerDown(e: PointerEvent) {
      const { sx, sy } = canvasXY(e)

      // Mute button (HUD, bottom-left)
      if (g.uiPhase !== 'setup') {
        const mH    = g.layout.hudH
        const mBtnS = Math.round(mH * 0.36)
        const mBtnY = mH - mBtnS - 3
        if (sx >= 6 && sx <= 6 + mBtnS && sy >= mBtnY && sy <= mBtnY + mBtnS) {
          g.muted = !g.muted
          return
        }
      }

      // Handle overlay buttons first
      const btn = hitOverlayButton(sx, sy)
      if (btn) {
        if (btn.tag.startsWith('style-')) {
          const style = btn.tag.replace('style-', '') as AiStyle
          g.aiStyle  = style
          g.uiPhase  = 'playing'
          g.overlayButtons = []
        } else if (btn.tag.startsWith('design-color-')) {
          const idx = parseInt(btn.tag.replace('design-color-', ''), 10)
          g.playerDesign   = { ...g.playerDesign, color: BAG_COLORS[idx] }
          g.opponentDesign = contrastDesign(g.playerDesign)
          saveDesignToStorage(g.playerDesign)
        } else if (btn.tag.startsWith('design-pattern-')) {
          const pat = btn.tag.replace('design-pattern-', '') as BagPattern
          g.playerDesign   = { ...g.playerDesign, pattern: pat }
          g.opponentDesign = contrastDesign(g.playerDesign)
          saveDesignToStorage(g.playerDesign)
        } else if (btn.tag === 'restart') {
          const seed = (Date.now() * 0x9e3779b9) >>> 0
          const savedDesign   = g.playerDesign
          const savedAiStyle  = g.aiStyle
          Object.assign(g, makeGameData(), { layout: g.layout, camParams: g.camParams, physicsConfig: g.physicsConfig, seed })
          g.playerDesign   = savedDesign
          g.opponentDesign = contrastDesign(savedDesign)
          g.aiStyle        = savedAiStyle
          g.uiPhase        = 'playing'
        } else if (btn.tag === 'change-opponent' || btn.tag === 'main-menu') {
          const seed = (Date.now() * 0x9e3779b9) >>> 0
          const savedDesign = g.playerDesign
          Object.assign(g, makeGameData(), { layout: g.layout, camParams: g.camParams, physicsConfig: g.physicsConfig, seed })
          g.playerDesign   = savedDesign
          g.opponentDesign = contrastDesign(savedDesign)
          // uiPhase stays 'setup' (makeGameData default)
        } else if (btn.tag === 'frame-continue') {
          g.overlayButtons = []
          const now = performance.now()
          g.frameSummaryAt = now - FRAME_SUMMARY_MS  // force immediate advance
        }
        return
      }

      if (g.uiPhase !== 'playing') return
      if (g.phase === 'flying' || g.phase === 'sliding') return

      // Only allow player interaction on their turn
      if (g.frameState.activeTeam !== 0) return

      const lt = g.layout

      if (sy >= lt.throwZoneY) {
        if ((g.phase === 'idle' || g.phase === 'settled') && activeThrowId === -1) {
          const lt2 = g.layout
          const bh = 26, btnY = lt2.throwZoneY + 10
          if (sy >= btnY && sy <= btnY + bh) {
            const ft = flightButtonAt(sx, sy)
            if (ft) { g.flightType = ft; return }
          }
          if (isOnBag(sx, sy)) {
            activeThrowId = e.pointerId
            canvas!.setPointerCapture(e.pointerId)
            g.phase       = 'charging'
            g.chargeOrig  = { sx, sy }
            g.chargeCurr  = { sx, sy }
            g.chargePts   = [{ sx, sy }]
            g.previewTraj = null
          }
        }
      } else {
        if ((g.phase === 'idle' || g.phase === 'settled' || g.phase === 'charging') && activeAimId === -1) {
          activeAimId = e.pointerId
          canvas!.setPointerCapture(e.pointerId)
          g.aimDragOrigin = { bx: g.aim.bx, by: g.aim.by, sx, sy }
        }
      }
    }

    function onPointerMove(e: PointerEvent) {
      const { sx, sy } = canvasXY(e)

      if (e.pointerId === activeThrowId) {
        g.chargeCurr = { sx, sy }
        g.chargePts.push({ sx, sy })
        if (g.chargePts.length > 60) g.chargePts.shift()
        const input = computeThrowInput(g)
        if (input) {
          const previewInput: ThrowInput = { ...input, skillLevel: 1, focus: 1 }
          try {
            const { trajectory } = simulateThrow(g.frameState.boardState, previewInput, createRng(0), g.physicsConfig)
            g.previewTraj = trajectory
          } catch { g.previewTraj = null }
        }
      }

      if (e.pointerId === activeAimId && g.aimDragOrigin) {
        const { bx: bx0, by: by0, sx: sx0, sy: sy0 } = g.aimDragOrigin
        const lt = g.layout
        const xScale = 1 / pxPerCm(by0 / 120, lt)
        const yScale = 120 / (lt.frontLeft.y - lt.backLeft.y)
        g.aim = {
          bx: Math.max(-BOARD.halfWidth, Math.min(BOARD.halfWidth,
              bx0 + (sx - sx0) * g.aimSensitivity * xScale)),
          by: Math.max(10, Math.min(115,
              by0 - (sy - sy0) * g.aimSensitivity * yScale)),
        }
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (e.pointerId === activeThrowId) {
        activeThrowId = -1
        if (g.phase !== 'charging') return
        g.phase       = 'idle'
        g.previewTraj = null

        const input = computeThrowInput(g)
        if (!input) { g.chargeOrig = null; g.chargeCurr = null; g.chargePts = []; return }

        const prevBags = [...g.frameState.boardState.bags]
        const { state: newBoardState, trajectory, result } = simulateThrow(
          g.frameState.boardState, input, createRng(g.seed), g.physicsConfig,
        )
        g.pending    = { result, newBoardState, prevBoardBags: prevBags, trajectory, thrownTeam: 0, thrownFlightType: g.flightType }
        g.flyStart   = performance.now()
        g.flyDur     = trajectory[trajectory.length - 1].t * g.trajSlow * 1000
        g.phase      = 'flying'
        g.chargeOrig = null; g.chargeCurr = null; g.chargePts = []
      }

      if (e.pointerId === activeAimId) {
        activeAimId = -1
        g.aimDragOrigin = null
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'd' || e.key === 'D') {
        g.debugMode = !g.debugMode
        if (g.debugMode) panelOpen = true
        refreshPanel()
      }
    }

    function loop(ts: number) {
      const prevPhase = g.phase
      update(g, ts)
      if (prevPhase === 'flying' && g.phase === 'sliding' && g.pending) {
        const r   = g.pending.result
        const amp = 0.30 * g.deformStrength
        bagDeforms.set(r.thrownBag.id, { landedAt: ts, squashAmp: amp, wobbleAmp: 0.6 * g.deformStrength })
        for (const pb of r.pushedBags) {
          bagDeforms.set(pb.id, { landedAt: ts, squashAmp: amp * 0.55, wobbleAmp: 0.28 * g.deformStrength })
        }
      }
      while (g.soundQueue.length > 0) {
        const snd = g.soundQueue.shift()!
        if (!g.muted) playSound(snd)
      }
      render(ctx!, g, ts, bagDeforms)
      rafId = requestAnimationFrame(loop)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    canvas.addEventListener('pointerdown',   onPointerDown,  { passive: true })
    canvas.addEventListener('pointermove',   onPointerMove,  { passive: true })
    canvas.addEventListener('pointerup',     onPointerUp,    { passive: true })
    canvas.addEventListener('pointercancel', onPointerUp,    { passive: true })
    canvas.addEventListener('contextmenu', e => e.preventDefault())
    window.addEventListener('keydown', onKeyDown)

    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      debugPanel.remove()
      canvas.removeEventListener('pointerdown',   onPointerDown)
      canvas.removeEventListener('pointermove',   onPointerMove)
      canvas.removeEventListener('pointerup',     onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="block w-full h-full"
      style={{ touchAction: 'none', userSelect: 'none' }}
    />
  )
}
