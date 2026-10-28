import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Effort, Extra, Limit, Omni, Running, Spend, Suggestion, Usage } from '../types'

const isOn = atom({ plugin: 'ahorro-tokens', key: 'isOn' } as const, true)
const switchModel = atom({ plugin: 'ahorro-tokens', key: 'switchModel' } as const, false)
const promptEffort = atom({ plugin: 'ahorro-tokens', key: 'promptEffort' } as const, 'medium' as Effort)
const last = atom({ plugin: 'ahorro-tokens', key: 'last' } as const, null as string | null)
const suggestion = atom({ plugin: 'ahorro-tokens', key: 'suggestion' } as const, null as Suggestion | null)
const isBusy = atom({ plugin: 'ahorro-tokens', key: 'isBusy' } as const, false)
const showAvatar = atom({ plugin: 'ahorro-tokens', key: 'showAvatar' } as const, true)
const isThinking = atom({ plugin: 'ahorro-tokens', key: 'isThinking' } as const, false)
const activity = atom({ plugin: 'ahorro-tokens', key: 'activity' } as const, 'idle' as Activity)
const ideasOn = atom({ plugin: 'ahorro-tokens', key: 'ideasOn' } as const, true)
const idea = atom({ plugin: 'ahorro-tokens', key: 'idea' } as const, null as string | null)
const usage = atom({ plugin: 'ahorro-tokens', key: 'usage' } as const, null as Usage | null)
const limits = atom({ plugin: 'ahorro-tokens', key: 'limits' } as const, [] as Limit[])
const spend = atom({ plugin: 'ahorro-tokens', key: 'spend' } as const, {} as Spend)
const omni = atom({ plugin: 'ahorro-tokens', key: 'omni' } as const, null as Omni | null)
// Kept in the session state, not in module variables, so a reload of the mod does not start them over.
const costSeen = atom({ plugin: 'ahorro-tokens', key: 'costSeen' } as const, 0)
const ideaTurns = atom({ plugin: 'ahorro-tokens', key: 'ideaTurns' } as const, 0)
// What runs now (subagents, shell commands), the files the session edited, and whether compacting was offered.
const running = atom({ plugin: 'ahorro-tokens', key: 'running' } as const, { agents: 0, commands: 0 } as Running)
const edited = atom({ plugin: 'ahorro-tokens', key: 'edited' } as const, [] as string[])
const compactOffered = atom({ plugin: 'ahorro-tokens', key: 'compactOffered' } as const, false)
// The extra usage the person bought: the budget and what this mod counted against it, kept in $.store
// across sessions since the bill is the account's. Only cost spent past the 5 h limit is counted.
const extra = atom({ plugin: 'ahorro-tokens', key: 'extra' } as const, null as Extra | null)
const EXTRA_KEY = 'extra'
const EXTRA_OFFER_AT = 90
let isExtraOffered = false
const SHELLS = /^(Bash|PowerShell)$/
const COMPACT_OFFER_AT = 80
const COMPACT_TARGET = 'compact'
const SUMMARY_FILE = '.claude/ahorro-sesion.md'

// Counts the subagents still running; teammates waiting for a message are idle and not counted.
async function refreshAgents($: EngineInterface) {
  const agents = (await $.agent.list().catch(() => [])).filter(a => a.status === 'running').length
  await update($, running, r => (r.agents === agents ? r : { ...r, agents }))
}

// OmniRoute writes one JSON file per call, in a folder per day, under the home folder.
async function omniLogs($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home.replace(/\\/g, '/')}/.omniroute/call_logs`
}

// The model of OmniRoute's last call and how many calls its newest day folder holds.
async function readOmni($: EngineInterface): Promise<Omni | null> {
  const OMNI_LOGS = await omniLogs($)
  const days = (await $.fs.list(OMNI_LOGS)).filter(d => d.kind === 'dir').map(d => d.name).sort()
  const day = days.at(-1)
  if (day === undefined) return null
  const calls = (await $.fs.list(`${OMNI_LOGS}/${day}`)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const newest = [...calls].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (newest === undefined) return null
  const summary = JSON.parse(String(await $.fs.read(`${OMNI_LOGS}/${day}/${newest.name}`))).summary ?? {}
  return { model: String(summary.model ?? '?'), calls: calls.length, at: newest.mtimeMs }
}
// What the last read of OmniRoute's logs came to, shown by /ahorro.
let lastOmni = 'sin leer todavía'
const refreshOmni = ($: EngineInterface) =>
  readOmni($)
    .then(o => {
      lastOmni = o ? `${o.model}, ${o.calls} llamada(s)` : 'sin registros'
      return update($, omni, () => o)
    })
    .catch(error => {
      lastOmni = `error: ${String(error).slice(0, 160)}`
    })

// How full the context window is: calm below half, tired from half, alarmed near the limit.
type Fill = 'low' | 'half' | 'full'
const HALF = 50
const NEAR_LIMIT = 80
const fillOf = (u: Usage | null): Fill => (u === null || u.percent < HALF ? 'low' : u.percent < NEAR_LIMIT ? 'half' : 'full')
const RED = '#C2453A'
// How long until a limit resets, short: "1 h 40", "25 min"; empty when the time is unknown or past.
const untilText = (resetsAt: string | null, now: number) => {
  const ms = resetsAt === null ? NaN : Date.parse(resetsAt) - now
  if (!(ms > 0)) return ''
  const min = Math.ceil(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h >= 24 ? `${Math.round(h / 24)} d` : `${h} h ${String(min % 60).padStart(2, '0')}`
}
// The weekly limit only takes a row once it starts to matter.
const WEEK_SHOW_AT = 70
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const LEVELS: Effort[] = ['low', 'medium', 'high']
const CHEAP_MODEL_MAIN = 'claude-sonnet-5-5'
const CHEAP_MODEL_AGENT = 'claude-haiku-5-5'
const SWITCH_MAX_CONTEXT = 30_000
const STRONG_MODEL = 'claude-opus-5-5'
const ORANGE = '#D97757'
const CLOUD = '#D97757'

// The face by state, and a stepped pixel cloud: puffs, a rounded top, the filled body, a rounded bottom.
const FACE: Record<Activity | 'talking', [string, string]> = {
  idle: ['(•ᴗ•)', 'en espera'],
  think: ['(•_•)…', 'pensando'],
  read: ['(◔_◔)', 'leyendo'],
  write: ['(•̀ᴗ•́)✎', 'escribiendo'],
  run: ['(⌐■_■)', 'ejecutando'],
  web: ['(°o°)', 'buscando en la web'],
  agent: ['(•ᴗ•)ノ', 'delegando a un ayudante'],
  done: ['(^ᴗ^)✓', 'listo'],
  error: ['(×_×)', 'algo falló'],
  talking: ['(^ᴗ^)', 'tengo algo que decirte'],
  ask: ['(•ᴗ•)?', 'te pregunto algo'],
}

// The mascot from Claude Code's "create" screen, drawn on its own pixel grid; each state moves a different part.
const EYE = '#2B1A12'
const move = (type: string, values: string, dur: string) =>
  `<animateTransform attributeName="transform" type="${type}" values="${values}" dur="${dur}" repeatCount="indefinite"/>`
const rect = (x: number, y: number, w: number, h: number, fill = ORANGE) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`

function mascotSvg(state: Activity | 'talking', fill: Fill = 'low'): string {
  const fade = (begin: string, dur = '1.2s') =>
    `<animate attributeName="opacity" values="0.35;1;0.35" dur="${dur}" begin="${begin}" repeatCount="indefinite"/>`
  const dot = (x: number, y: number, begin: string, size = 18) =>
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${ORANGE}" opacity="0.35">${fade(begin)}</rect>`
  const whole: Record<string, string> = {
    idle: move('translate', '0 0;0 -3;0 0', '3s'),
    done: move('translate', '0 0;0 -26;0 0;0 -12;0 0', '1s'),
    talking: move('translate', '0 0;0 -10;0 0', '0.6s'),
    ask: move('rotate', '0 113 86;-4 113 86;0 113 86;4 113 86;0 113 86', '2s'),
    error: move('translate', '-7 0;7 0;-7 0', '0.12s'),
    web: move('translate', '0 0;0 -6;0 0', '0.5s'),
    run: move('translate', '0 0;0 -5;0 0', '0.36s'),
    think: move('translate', '0 0;-3 0;3 0;0 0', '2.4s'),
  }
  const eyes: Record<string, string> = {
    ask: move('translate', '-8 -6;-8 -6;0 -6;-8 -6', '2s'),
    idle: move('translate', '0 0;0 0;-9 0;-9 0;9 0;9 0;0 0', '8s'),
    think: move('translate', '0 0;-10 -6;10 -6;0 0', '1.8s'),
    read: move('translate', '-10 0;10 0;-10 0', '0.9s'),
    web: move('translate', '0 -6;0 6;0 -6', '0.8s'),
    agent: move('translate', '0 0;10 -4;0 0', '1.2s'),
  }
  const blink =
    state === 'idle' || state === 'talking'
      ? `<animate attributeName="height" values="26;26;2;26" keyTimes="0;0.9;0.95;1" dur="4s" repeatCount="indefinite"/>` +
        `<animate attributeName="y" values="32;32;44;32" keyTimes="0;0.9;0.95;1" dur="4s" repeatCount="indefinite"/>`
      : ''
  const rightArm =
    state === 'write' ? move('translate', '0 0;0 -16;0 0', '0.3s')
    : state === 'agent' ? move('rotate', '0 196 72;-40 196 72;0 196 72', '0.6s')
    : state === 'talking' ? move('rotate', '0 196 72;-18 196 72;0 196 72', '0.8s')
    : state === 'done' ? move('rotate', '0 196 72;-60 196 72;0 196 72', '0.5s')
    : ''
  const legsA = state === 'run' ? move('translate', '0 0;0 -12;0 0', '0.36s') : state === 'idle' ? move('translate', '0 0;0 0;0 -5;0 0', '3s') : ''
  const legsB = state === 'run' ? move('translate', '0 -12;0 0;0 -12', '0.36s') : ''

  // Eyes: holes, or chevrons when happy, crosses when it failed.
  const eyeRect = (x: number) => rect(x, 32, 14, 26, EYE).replace('/>', `>${blink}</rect>`)
  const happy = (x: number) => `<path d="M${x - 2} 56 L${x + 7} 36 L${x + 16} 56" stroke="${EYE}" stroke-width="7" fill="none"/>`
  const cross = (x: number) => `<path d="M${x} 34 L${x + 14} 56 M${x + 14} 34 L${x} 56" stroke="${EYE}" stroke-width="6" fill="none"/>`
  const eye = (x: number) => (state === 'done' ? happy(x) : state === 'error' ? cross(x) : eyeRect(x))

  // What floats around it, by state.
  const around: Record<string, string> = {
    think: dot(88, -26, '0s') + dot(112, -34, '0.3s') + dot(136, -26, '0.6s'),
    write: dot(234, 48, '0s', 14) + dot(242, 26, '0.25s', 12) + dot(228, 8, '0.5s', 14),
    run: dot(-12, 60, '0s', 12) + dot(-24, 82, '0.18s', 12) + dot(-10, 104, '0.36s', 12),
    web:
      `<g><circle cx="196" cy="-12" r="16" fill="none" stroke="${ORANGE}" stroke-width="5"/>` +
      `<g>${move('rotate', '0 196 -12;360 196 -12', '2s')}${rect(192, -32, 8, 8)}</g></g>`,
    agent: `<g><rect x="232" y="100" width="16" height="16" fill="${ORANGE}">${move('translate', '0 0;0 -22;0 0', '0.6s')}</rect></g>`,
    done: `<path d="M-24 14 L-10 30 L20 -12" stroke="${ORANGE}" stroke-width="10" fill="none"/>`,
    ask: `<g>${move('translate', '0 0;0 -6;0 0', '1s')}` +
      rect(-18, -46, 24, 8) + rect(-26, -38, 8, 8) + rect(6, -38, 8, 16) + rect(-2, -22, 8, 8) + rect(-10, -14, 8, 12) + rect(-10, 4, 8, 8) + `</g>`,
    error: `<g>${rect(108, -44, 12, 28)}${rect(108, -8, 12, 12)}<animate attributeName="opacity" values="1;0.5;1" dur="0.4s" repeatCount="indefinite"/></g>`,
    talking: dot(212, 2, '0s', 14) + dot(226, -20, '0.3s', 12),
    read: dot(96, -26, '0s', 14) + dot(124, -26, '0.4s', 14),
  }

  // By how full the context is: from half, a sweat drop falls; near the limit, it flushes red and pants.
  const body = fill === 'full' ? RED : ORANGE
  const tired =
    fill === 'half'
      ? `<rect x="204" y="10" width="10" height="14" fill="#7FB3E0" opacity="0">` +
        `<animate attributeName="opacity" values="0;1;1;0" dur="1.6s" repeatCount="indefinite"/>` +
        `${move('translate', '0 0;0 4;0 24;0 30', '1.6s')}</rect>`
      : fill === 'full'
        ? `<g>${rect(204, 4, 10, 14, '#7FB3E0')}${rect(14, 20, 10, 14, '#7FB3E0')}` +
          `${move('translate', '0 0;0 26', '0.8s')}<animate attributeName="opacity" values="1;0" dur="0.8s" repeatCount="indefinite"/></g>` +
          `<g>${rect(226, -30, 12, 28, RED)}${rect(226, 6, 12, 12, RED)}` +
          `<animate attributeName="opacity" values="1;0.15;1" dur="0.7s" repeatCount="indefinite"/></g>`
        : ''
  const pant = fill === 'full' ? move('scale', '1 1;1.02 0.97;1 1', '0.5s') : ''

  // The floating marks go last, over the body, so a jump never hides them.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-30 -60 290 206" shape-rendering="crispEdges">` +
    `<g>${pant}<g>${whole[state] ?? ''}` +
    rect(31, 4, 165, 82, body) +
    rect(4, 59, 27, 27, body) +
    `<g>${rightArm}${rect(196, 59, 28, 27, body)}</g>` +
    `<g>${eyes[state] ?? ''}${eye(59)}${eye(155)}</g>` +
    `<g>${legsA}${rect(44, 86, 14, 56, body)}${rect(72, 86, 14, 56, body)}</g>` +
    `<g>${legsB}${rect(141, 86, 14, 56, body)}${rect(169, 86, 14, 56, body)}</g>` +
    `</g></g>` +
    (around[state] ?? '') +
    tired +
    `</svg>`
  )
}

// Pixel-art cloud edges, stepped like the mascot: bumps up on top, bumps down at the bottom.
const cloudSvg = (rects: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 24" shape-rendering="crispEdges">${rects}</svg>`
const CLOUD_TOP_SVG = cloudSvg(
  rect(0, 16, 340, 8, CLOUD) + rect(24, 8, 72, 8, CLOUD) + rect(140, 8, 80, 8, CLOUD) + rect(250, 8, 60, 8, CLOUD) +
    rect(48, 0, 24, 8, CLOUD) + rect(164, 0, 32, 8, CLOUD),
)
const CLOUD_BOTTOM_SVG = cloudSvg(
  rect(0, 0, 340, 8, CLOUD) + rect(40, 8, 80, 8, CLOUD) + rect(200, 8, 80, 8, CLOUD) + rect(64, 16, 32, 8, CLOUD),
)

// A stepped pixel bar, ten cells; the cells fill orange, then red near the limit, the last one blinking.
function barSvg(percent: number, fill: Fill): string {
  const lit = Math.min(10, Math.ceil(percent / 10))
  const cells = Array.from({ length: 10 }, (_, i) => {
    const color = i < lit ? (fill === 'full' ? RED : ORANGE) : '#5A4A42'
    const blink = i === lit - 1 && fill !== 'low' ? `<animate attributeName="opacity" values="1;0.3;1" dur="${fill === 'full' ? '0.5s' : '1.4s'}" repeatCount="indefinite"/>` : ''
    return `<rect x="${i * 16}" y="0" width="14" height="14" fill="${color}" opacity="${i < lit ? 1 : 0.4}">${blink}</rect>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 158 14" shape-rendering="crispEdges">${cells}</svg>`
}
const barText = (percent: number) => {
  const lit = Math.min(10, Math.ceil(percent / 10))
  return `${'█'.repeat(lit)}${'░'.repeat(10 - lit)}`
}

const activityOf =(tool: string): Activity =>
  /^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool) ? 'read'
  : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? 'write'
  : /^(Bash|PowerShell)$/.test(tool) ? 'run'
  : /^(WebFetch|WebSearch)$|browser|Browser/.test(tool) ? 'web'
  : /^(Agent|Task)$/.test(tool) ? 'agent'
  : /^(AskUserQuestion|ExitPlanMode)$/.test(tool) ? 'ask'
  : 'think'
const CLOUD_WIDTH = 50

// Session ideas: a cheap model reads the recent conversation every few turns and may suggest one thing.
const IDEA_EVERY = 4
const IDEA_MESSAGES = 12
const IDEA_SYSTEM =
  'Eres un asistente que observa una sesión de programación. Lee el final de la conversación y, si hay algo realmente útil, ' +
  'escribe UNA sola idea, recordatorio o siguiente paso para el usuario, en español, en máximo 20 palabras, sin comillas. ' +
  'Ejemplos: un pendiente que quedó sin hacer, una fecha o tarea próxima mencionada, una mejora obvia. ' +
  'Si no hay nada que valga la pena, responde exactamente: NADA'
const CLOUD_PUFFS = '   ▄▄▄▄▄       ▄▄▄▄▄▄▄          ▄▄▄▄▄           '
const CLOUD_TOP = ` ${'▄'.repeat(CLOUD_WIDTH)} `
const CLOUD_BOTTOM = ` ${'▀'.repeat(CLOUD_WIDTH)} `
// Easy prompts in a row before suggesting a cheaper model, and prompts to stay quiet after a "no".
const EASY_STREAK = 2
const COOLDOWN = 5
// How long a switch waits for /compact to finish, and how much of the conversation plan B hands Haiku.
const COMPACT_WAIT_SECONDS = 180
const HANDOFF_MESSAGES = 40
const CONTEXT_FILE = '.claude/ahorro-contexto.md'
const LIMIT_HANDOFF_AT = 95
let isLimitHandedOff = false
const OMNI_TARGET = 'omniroute'

// Opens a new terminal window in the project that runs claude through OmniRoute; the variable lives only there.
async function openOmniSession($: EngineInterface) {
  await update($, suggestion, () => null)
  const home = ((await $.env.get('USERPROFILE')) ?? '').replace(/\\/g, '/')
  const script = `${home}/.claude/mods/ahorro-tokens/omniroute-claude.cmd`
  const cwd = await $.session.root()
  try {
    await $.process.run(['cmd', '/c', 'start', '', 'cmd', '/k', script.replace(/\//g, '\\')], { cwd, timeoutMs: 15000 })
    $.ui.toast('(^ᴗ^) Abrí una terminal nueva con OmniRoute. Sigue ahí.')
  } catch (error) {
    $.ui.toast(`(•_•) No pude abrir la terminal: ${String(error).slice(0, 120)}`)
  }
}
// A short handoff for the next model: it reads this instead of the whole conversation.
const COMPACT_INSTRUCTIONS = [
  'Escribe una entrega para OTRO modelo que seguirá este trabajo. En español, máximo 300 palabras, solo puntos clave:',
  '## Objetivo: una línea.',
  '## Dónde quedó: 2 o 3 puntos, con el estado de cada uno (hecho, a medias, falló y por qué).',
  '## Siguiente paso: lo que debe hacer ahora, en orden.',
  '## Ya decidido: preferencias y decisiones del usuario que no hay que volver a preguntar.',
  '## Archivos clave: solo rutas exactas.',
  'Nada de relleno ni de historia de la conversación.',
].join('\n')

// Prompts that need real thinking vs. ones that are mechanical or a quick question.
const HARD = /\b(dise[ñn]a|arquitectura|refactoriza|refactor|depura|debug|bug|error|falla|optimiza|implementa|migra|seguridad|por qu[eé] no funciona|investiga|analiza|plan)\w*/i
const EASY = /\b(qu[eé] es|explica|resume|lista|muestra|renombra|typo|formatea|traduce|cambia el texto|corrige la ortograf|ejecuta|corre|abre|instala|git (status|log|add|commit|push))\w*/i

// Tools that only read: the step after them rarely needs deep reasoning.
const READ_ONLY = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|ReadNotifications|mcp__.*(search|read|list|get|fetch).*)$/i

const lower = (level: Effort): Effort => LEVELS[Math.max(0, LEVELS.indexOf(level) - 1)]
const atMost = (wanted: Effort, current: unknown): Effort =>
  typeof current === 'string' && LEVELS.includes(current as Effort) && LEVELS.indexOf(current as Effort) < LEVELS.indexOf(wanted)
    ? (current as Effort)
    : wanted
const isExpensive = (model: string) => /opus|fable/i.test(model)

const classify = (text: string): Effort => {
  if (HARD.test(text) || text.length > 1500) return 'high'
  if (EASY.test(text) || text.length < 80) return 'low'
  return 'medium'
}

// Easy prompts so far and prompts left to stay quiet; they start over when the mod reloads.
let easyStreak = 0
let quietFor = 0

// The phase of the work, read off the main loop's last turn: what it called, how often that failed,
// and whether it ended as a plan waiting for the person's yes.
let turnTools: string[] = []
let turnErrors = 0
let lastTurnWasPlan = false
const ERRORS_FOR_OPUS = 3
const WRITES = /^(Edit|Write|MultiEdit|NotebookEdit)$/
const ASKS = /^(AskUserQuestion|ExitPlanMode)$/
const APPROVAL_MAX_LENGTH = 200
const PLAN_MIN_TOOLS = 2
const PLAN_WORDS = /\b(plan(es)?|pasos|propongo|propuesta|corregir|correcciones|implementar)\b/i
const APPROVAL = /^(s[ií]|dale|ok(ay)?|vale|perfecto|adelante|hazlo|procede|implementa|me parece|de acuerdo|listo|correcto|aprobado)(?=[\s,.;:!¡]|$)/i

// A plan turn changed no file, looked into things or laid out steps, and ended asking the person something.
function isPlanTurn(tools: readonly string[], text: string): boolean {
  if (tools.some(t => WRITES.test(t))) return false
  if (tools.some(t => ASKS.test(t))) return true
  const ending = text.trim().slice(-400)
  const asks = /[?？]\s*$/.test(ending) || /¿[^?¿]{3,}\?/.test(ending)
  const investigated = tools.length >= PLAN_MIN_TOOLS || PLAN_WORDS.test(text)
  return asks && investigated
}

async function accept($: EngineInterface, s: Suggestion) {
  if (s.to === OMNI_TARGET) return openOmniSession($)
  if (s.to === COMPACT_TARGET) {
    // The same /compact the person types; the session.compact hook saves its summary to the file.
    await update($, suggestion, () => null)
    $.ui.toast('Compactando la conversación…')
    void $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS }).catch(() => $.ui.toast('(•_•) No pude compactar.'))
    return
  }
  if (await read($, isBusy)) return
  await update($, isBusy, () => true)
  // The cloud goes at once; the person is told how the switch went in toasts.
  await update($, suggestion, () => null)
  $.ui.toast('Compactando la conversación antes de cambiar…')
  const from = await $.session.model()
  let handoff: string | null = null
  let isCleared = false

  try {
    // Plan A: the same /compact the person types; the session.compact hook below catches its summary.
    compactSummary = null
    isCompactRefused = false
    isSwitching = true
    await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS }).catch(() => undefined)
    for (let waited = 0; compactSummary === null && !isCompactRefused && waited < COMPACT_WAIT_SECONDS; waited += 1) {
      await $.clock.sleep(1000)
    }
    handoff = compactSummary
    if (handoff !== null) {
      lastSwitch = `compactado con /compact (${handoff.length} caracteres)`
    } else {
      // Plan B: Haiku writes the handoff, the conversation is cleared, and the new model starts from it alone.
      $.ui.toast('No se pudo compactar; preparo una entrega corta y reinicio la conversación…')
      handoff = await writeHandoff($)
      if (handoff !== null) {
        await $.command.run({ command: 'clear' })
        isCleared = true
        lastSwitch = `plan B: entrega de Haiku (${handoff.length} caracteres) y conversación limpia`
      } else {
        lastSwitch = 'no se compactó y Haiku no pudo escribir la entrega; cambio sin resumen'
      }
    }
    if (handoff !== null) {
      const path = await saveContext($, handoff, `De ${from} a ${s.name}.`)
      lastSwitch += ` · guardada en ${path}`
    }
  } catch (error) {
    lastSwitch = `error al preparar el cambio: ${String(error).slice(0, 200)}`
    $.ui.toast(`No se pudo preparar el contexto: ${String(error).slice(0, 120)}. Cambio de modelo igual.`)
  } finally {
    isSwitching = false
  }

  try {
    await $.command.run({ command: 'model', args: s.to })
    const now = await $.session.model()
    if (isCleared && handoff !== null) {
      // The cleared conversation starts from the handoff; the person sends it with Enter.
      await $.prompt.fill({ text: `Continúa el trabajo desde esta entrega (no repitas lo ya hecho):\n\n${handoff}` })
    }
    $.ui.toast(
      now === from
        ? `No se pudo cambiar el modelo; sigue ${now}. Usa /model ${s.to}.`
        : isCleared
          ? `Listo: ahora usas ${now}. La entrega está en la barra; pulsa Enter para seguir.`
          : `Listo: ahora usas ${now}.`,
      { timeoutMs: 12000 },
    )
  } catch (error) {
    $.ui.toast(`No se pudo cambiar el modelo: ${String(error).slice(0, 120)}. Usa /model ${s.to}.`, { timeoutMs: 10000 })
  } finally {
    await update($, isBusy, () => false)
  }
}

// Writes the handoff where the next session can read it.
async function saveContext($: EngineInterface, handoff: string, label: string): Promise<string> {
  const path = `${await $.session.root()}/${CONTEXT_FILE}`
  const stamp = new Date(await $.clock.now()).toLocaleString('es')
  await $.fs.write(path, `# Entrega de contexto (${stamp})

${label}

${handoff}
`)
  return path
}

// The handoff for plan B: Haiku reads the recent conversation and writes the key points, short.
async function writeHandoff($: EngineInterface): Promise<string | null> {
  const recent = (await $.session.messages()).slice(-HANDOFF_MESSAGES)
  const transcript = recent
    .filter(m => m.text)
    .map(m => `${m.role === 'user' ? 'Usuario' : 'Claude'}: ${m.text.slice(0, 800)}`)
    .join('\n\n')
  if (!transcript) return null

  const reply = await $.model.complete({
    model: 'haiku',
    system: COMPACT_INSTRUCTIONS,
    prompt: transcript,
    maxTokens: 900,
    effort: 'low',
  })
  return reply.isAnswered && reply.text.trim() ? reply.text.trim() : null
}

// Set while a switch waits for its compaction, so a /compact the person runs alone is left as it is.
let isSwitching = false
let isCompactRefused = false
let compactSummary: string | null = null

// What the last idea ask and the last switch came to, shown by /ahorro so a silent failure is visible.
let lastIdea = 'ninguna todavía'
let lastSwitch = 'ninguno todavía'

// Which surface last asked to draw the band above the prompt, to tell whether it shows at all.
let bandSurface: string | null = null
let bandElements = ''

async function askIdea($: EngineInterface, isAsked = false) {
  await update($, ideaTurns, () => 0)
  if (isAsked) $.ui.toast('(•_•) Pensando una idea…')
  const recent = (await $.session.messages()).slice(-IDEA_MESSAGES)
  const transcript = recent
    .filter(m => m.text)
    .map(m => `${m.role === 'user' ? 'Usuario' : 'Claude'}: ${m.text.slice(0, 600)}`)
    .join('\n\n')
  if (!transcript) {
    lastIdea = 'sin mensajes que leer'
    return
  }

  const reply = await $.model.complete({ model: 'haiku', system: IDEA_SYSTEM, prompt: transcript, maxTokens: 80, effort: 'low' })
  const text = reply.isAnswered ? reply.text.trim() : ''
  lastIdea = reply.isAnswered ? `Haiku respondió: ${text.slice(0, 80)}` : `Haiku falló: ${reply.reason}`
  if (text && !/^NADA\b/i.test(text)) {
    await update($, idea, () => text)
    $.ui.toast(`(^ᴗ^) ${text}`, { timeoutMs: 15000 })
  } else if (isAsked) {
    $.ui.toast(reply.isAnswered ? '(•ᴗ•) Nada que sugerir por ahora.' : `(•_•) No pude pensar una idea: ${reply.reason}`)
  }
}

async function useIdea($: EngineInterface, text: string) {
  await update($, idea, () => null)
  await $.prompt.fill({ text })
}

async function reject($: EngineInterface) {
  quietFor = COOLDOWN
  easyStreak = 0
  await update($, suggestion, () => null)
}

export const register: Register = on => {
  // Tool names called since the last model request of the main loop.
  let stepTools: string[] = []
  on('session.start', async ($, e, next) => {
    // The /ahorro switches are remembered across sessions: start from the person's last choice.
    const saved = async (key: string) => {
      const value = await $.store.get(key)
      return typeof value === 'boolean' ? value : undefined
    }
    const on_ = await saved('isOn')
    if (on_ !== undefined) await update($, isOn, () => on_)
    const model = await saved('switchModel')
    if (model !== undefined) await update($, switchModel, () => model)
    const avatar = await saved('showAvatar')
    if (avatar !== undefined) await update($, showAvatar, () => avatar)
    const ideas = await saved('ideasOn')
    if (ideas !== undefined) await update($, ideasOn, () => ideas)
    const savedExtra = (await $.store.get(EXTRA_KEY)) as Extra | null | undefined
    if (savedExtra && typeof savedExtra.budget === 'number') await update($, extra, () => savedExtra)

    void refreshOmni($)

    await $.command.register({
      name: 'ahorro',
      description: 'Ahorro de tokens: estado, on/off, o "modelo on/off" para cambiar también el modelo',
      argumentHint: '[on|off|modelo on|modelo off|avatar on|avatar off|ideas on|ideas off|idea|cambiar|no|prueba]',
    })

    return next(e)
  })

  on('command.run', { command: 'ahorro' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    const value = args.endsWith('on')
    if (args === 'on' || args === 'off') {
      await update($, isOn, () => value)
      await $.store.set('isOn', value)
    }
    if (args === 'modelo on' || args === 'modelo off') {
      await update($, switchModel, () => value)
      await $.store.set('switchModel', value)
    }
    if (args === 'avatar on' || args === 'avatar off') {
      await update($, showAvatar, () => value)
      await $.store.set('showAvatar', value)
    }
    if (args === 'ideas on' || args === 'ideas off') {
      await update($, ideasOn, () => value)
      await $.store.set('ideasOn', value)
    }
    const pending = await read($, suggestion)
    if (args === 'cambiar' || args === 'no') {
      if (pending === null) return { text: 'No hay ningún cambio de modelo sugerido ahora.' }
      if (args === 'no') await reject($)
      // Not awaited: the compaction runs once this command has finished.
      else void accept($, pending)
      return { text: args === 'no' ? 'Vale, sigo con el modelo actual.' : `Guardando el contexto y cambiando a ${pending.name}…` }
    }
    // "/ahorro extra 40 1.75" sets a budget of 40 USD with 1.75 already used, as the plan page shows it;
    // without the second figure the count starts at zero; "/ahorro extra off" drops it.
    const extraArg = /^extra (off|\d+(?:[.,]\d+)?)(?: (\d+(?:[.,]\d+)?))?$/.exec(args)
    if (extraArg) {
      const usd = (s: string | undefined) => (s === undefined ? 0 : Number(s.replace(',', '.')))
      const value = extraArg[1] === 'off' ? null : { budget: usd(extraArg[1]), used: usd(extraArg[2]) }
      await update($, extra, () => value)
      await $.store.set(EXTRA_KEY, value)
      isExtraOffered = false
    }
    if (args === 'idea') void askIdea($, true).catch(() => $.ui.toast('(•_•) No pude pensar una idea.'))
    // A way to see the cloud without waiting for a real suggestion; "No, gracias" closes it.
    if (args === 'prueba') {
      await update($, suggestion, () => ({ to: CHEAP_MODEL_MAIN, name: 'Sonnet', reason: 'Esto es una prueba de la nube. ¿Cambio a Sonnet?' }))
    }
    // Preview the tired and alarmed mascot; the next real measure puts the true figures back.
    const preview = /^prueba (mitad|limite|límite)$/.exec(args)
    if (preview) {
      const percent = preview[1] === 'mitad' ? 55 : 88
      await update($, usage, u => ({ tokens: Math.round(((u?.window ?? 200_000) * percent) / 100), window: u?.window ?? 200_000, percent, usd: u?.usd ?? null }))
    }
    if (!(await read($, isOn))) {
      $.ui.status(undefined)
      await update($, suggestion, () => null)
    }

    const model = (await read($, switchModel)) ? 'sí (Sonnet en tareas simples, Haiku en subagentes)' : 'no'
    const x = await read($, extra)
    const extraText = x ? `$${x.used.toFixed(2)} de $${x.budget.toFixed(2)}` : 'sin tope (usa /ahorro extra 5)'
    return {
      text: `Ahorro de tokens: ${(await read($, isOn)) ? 'activado' : 'desactivado'} · cambiar modelo automático: ${model} · último prompt clasificado como: ${await read($, promptEffort)}\nÚltimo paso: ${(await read($, last)) ?? 'ninguno todavía'}\nIdeas: ${(await read($, ideasOn)) ? `encendidas, próxima en ${Math.max(0, IDEA_EVERY - (await read($, ideaTurns)))} turno(s)` : 'apagadas'} · última: ${lastIdea}\nÚltimo cambio de modelo: ${lastSwitch}\nOmniRoute: ${lastOmni}\nUso extra: ${extraText}\nBarra sobre el prompt: ${bandSurface ? `se dibuja (${bandSurface}); elementos: ${bandElements}` : 'este app no la ha pedido; las ideas salen como aviso flotante'}`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.text.trimStart().startsWith('/')) {
      // A slash command is not a task, and it may have changed the model by hand: drop a suggestion that is now moot.
      const pending = await read($, suggestion)
      if (pending && (await $.session.model()).includes(pending.name.toLowerCase())) await update($, suggestion, () => null)
      return next(e)
    }

    stepTools = []
    // A short yes right after a plan is execution, not a hard task, whatever words it uses.
    const isApproval = lastTurnWasPlan && e.text.trim().length <= APPROVAL_MAX_LENGTH && APPROVAL.test(e.text.trim())
    lastTurnWasPlan = false
    // Every prompt counts toward the quiet spell after a "no", approvals included.
    quietFor = Math.max(0, quietFor - 1)
    const level = isApproval ? 'low' : classify(e.text)
    await update($, promptEffort, () => level)

    if ((await read($, isOn)) && !isApproval) {
      const current = await $.session.model()
      easyStreak = level === 'low' ? easyStreak + 1 : 0

      let next_: Suggestion | null = null
      if (quietFor === 0 && isExpensive(current) && easyStreak >= EASY_STREAK) {
        next_ = { to: CHEAP_MODEL_MAIN, name: 'Sonnet', reason: 'Tus últimas tareas son sencillas. ¿Cambio a Sonnet para gastar menos?' }
      } else if (quietFor === 0 && !isExpensive(current) && level === 'high') {
        next_ = { to: STRONG_MODEL, name: 'Opus', reason: 'Esto parece complejo. ¿Cambio a Opus para hacerlo mejor?' }
      }
      if (next_) {
        await update($, suggestion, () => next_)
        $.ui.toast(`(^ᴗ^) ${next_.reason} Respóndeme en la barra o con /ahorro cambiar.`, { timeoutMs: 15000 })
      }
    }

    return next(e)
  })

  // On the way out, a note of what the session did: no model call, so it is written even with the limit spent.
  on('session.end', async ($, e, next) => {
    try {
      const files = await read($, edited)
      const costs = Object.entries(await read($, spend))
        .map(([m, s]) => `- ${m.replace(/^claude-/, '')}: ${s.turns} turno(s), $${s.usd.toFixed(2)}`)
      const asks = (await $.session.messages()).filter(m => m.role === 'user' && m.text).slice(-5)
        .map(m => `- ${m.text.replace(/\s+/g, ' ').slice(0, 200)}`)
      const lastAnswer = (await $.session.messages()).filter(m => m.role === 'assistant' && m.text).at(-1)?.text.slice(0, 1500) ?? ''
      if (files.length + costs.length + asks.length > 0) {
        const stamp = new Date(await $.clock.now()).toLocaleString('es')
        await $.fs.write(`${await $.session.root()}/${SUMMARY_FILE}`, `# Resumen de la sesión (${stamp})

Cierre: ${e.reason}. Para volver: \`claude --resume ${e.sessionId}\`

## Últimos pedidos
${asks.join('\n') || '- ninguno'}

## Archivos editados
${files.map(f => `- ${f}`).join('\n') || '- ninguno'}

## Gasto por modelo
${costs.join('\n') || '- sin datos'}

## Última respuesta (lo que quedó pendiente suele estar aquí)
${lastAnswer || '(ninguna)'}
`)
      }
    } catch {
      // A failed note never holds up the exit.
    }
    return next(e)
  })

  // Catches the summary of the /compact a switch asked for; any other compaction passes untouched.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (isSwitching && compacted.skip === undefined && e.trigger !== 'precompute') {
      compactSummary = compacted.messages.map(m => m.text).filter(Boolean).join('\n\n') || '(resumen vacío)'
    } else if (isSwitching && compacted.skip !== undefined) {
      isCompactRefused = true
      lastSwitch = `/compact no se ejecutó: ${compacted.skip}`
    } else if (!isSwitching && e.trigger === 'manual' && compacted.skip === undefined) {
      // A /compact the person typed also leaves its summary in the file, so a later session can pick it up.
      const summary = compacted.messages.map(m => m.text).filter(Boolean).join('\n\n')
      if (summary) {
        const path = await saveContext($, summary, 'Resumen de /compact.').catch(() => null)
        if (path !== null) $.ui.toast(`Resumen guardado en ${CONTEXT_FILE}`)
      }
    }

    return compacted
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnTools = []
      turnErrors = 0
      await update($, isThinking, () => true)
      await update($, activity, () => 'think')
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    await update($, isThinking, () => false)
    // A turn that ends asking the person something shows the asking face instead of the tick.
    const ending = (e.answer ?? '').trim().slice(-400)
    const isAsking = turnTools.some(t => ASKS.test(t)) || /[?？]$/.test(ending) || /¿[^?¿]{3,}[?]/.test(ending)
    await update($, activity, () => (isAsking ? 'ask' : 'done'))
    void refreshOmni($)
    const used = await $.session.model()
    await update($, spend, s => ({ ...s, [used]: { turns: (s[used]?.turns ?? 0) + 1, usd: s[used]?.usd ?? 0 } }))

    // The phase the turn ended in: a plan waiting for a yes, or work that keeps failing.
    lastTurnWasPlan = isPlanTurn(turnTools, e.answer ?? '')
    if ((await read($, isOn)) && quietFor === 0 && (await read($, suggestion)) === null) {
      const current = await $.session.model()
      let next_: Suggestion | null = null
      if (lastTurnWasPlan && isExpensive(current)) {
        next_ = { to: CHEAP_MODEL_MAIN, name: 'Sonnet', reason: 'Plan listo. Si lo apruebas, ¿lo ejecuto con Sonnet? Compacto antes para que gaste menos.' }
      } else if (!isExpensive(current) && turnErrors >= ERRORS_FOR_OPUS) {
        next_ = { to: STRONG_MODEL, name: 'Opus', reason: `Hubo ${turnErrors} errores en este paso. ¿Paso a Opus para resolverlo?` }
      }
      if (next_) {
        await update($, suggestion, () => next_)
        $.ui.toast(`(^ᴗ^) ${next_.reason}`, { timeoutMs: 15000 })
      }
    }

    const turns = (await read($, ideaTurns)) + 1
    await update($, ideaTurns, () => turns)
    const isDue = turns >= IDEA_EVERY && (await read($, isOn)) && (await read($, ideasOn))
    if (isDue && (await read($, suggestion)) === null) void askIdea($).catch(error => {
      lastIdea = `error: ${String(error).slice(0, 200)}`
    })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    stepTools.push(e.tool)
    const isMain = e.agentId === undefined
    if (isMain) turnTools.push(e.tool)
    await update($, activity, () => activityOf(e.tool))
    const isShell = SHELLS.test(e.tool)
    if (isShell) await update($, running, r => ({ ...r, commands: r.commands + 1 }))
    let ran
    try {
      ran = await next(e)
    } finally {
      if (isShell) await update($, running, r => ({ ...r, commands: Math.max(0, r.commands - 1) }))
      void refreshAgents($)
    }
    const path = (e.input as { file_path?: unknown } | undefined)?.file_path
    if (WRITES.test(e.tool) && ran.isError !== true && typeof path === 'string') {
      await update($, edited, list => (list.includes(path) ? list : [...list, path]))
    }
    if (isMain && ran.isError === true) turnErrors += 1
    await update($, activity, () => (ran.isError === true ? 'error' : 'think'))

    return ran
  })

  on('turn.step', async function* ($, e, next) {
    if (!(await read($, isOn)) || typeof e.effort === 'number') return yield* next(e)

    const canSwitch = await read($, switchModel)

    if (e.agentId !== undefined) {
      const model = canSwitch && isExpensive(e.model) ? CHEAP_MODEL_AGENT : e.model
      return yield* next({ ...e, model, effort: atMost('low', e.effort) })
    }

    const base = await read($, promptEffort)
    const onlyRead = e.index > 0 && stepTools.length > 0 && stepTools.every(t => READ_ONLY.test(t))
    stepTools = []

    const effort = atMost(onlyRead ? lower(base) : base, e.effort)
    // The model follows the prompt, not the step, so a turn keeps one model and its prompt cache.
    // A switch rewrites the whole context to the other model's cache (2x input price), while Sonnet
    // saves only on output; measured, it pays off only while the context is still small.
    const context = canSwitch ? ((await $.session.usage()).context.tokens ?? Infinity) : Infinity
    const model = canSwitch && base === 'low' && isExpensive(e.model) && context < SWITCH_MAX_CONTEXT ? CHEAP_MODEL_MAIN : e.model

    const changed = effort !== e.effort || model !== e.model
    await update($, last, () =>
      `${e.model}/${e.effort ?? '-'} → ${model}/${effort}${changed ? '' : ' (sin cambio: ya estaba igual o más bajo)'}`,
    )
    $.ui.status(`esfuerzo ${effort} · ${model.replace(/^claude-/, '')}`)

    return yield* next({ ...e, model, effort })
  })

  // The context fill, pushed after each turn; the band redraws from it.
  on('session.measure', async ($, e, next) => {
    const { tokens, window, percent } = e.context
    if (tokens !== undefined && window > 0) {
      await update($, usage, () => ({ tokens, window, percent: percent ?? Math.round((tokens / window) * 100), usd: e.cost?.usd ?? null }))
    }
    // Near 80 % the mod offers to compact now, before the automatic one cuts in mid-task; once per climb.
    const fillNow = percent ?? (tokens !== undefined && window > 0 ? Math.round((tokens / window) * 100) : 0)
    if (fillNow < COMPACT_OFFER_AT) {
      if (await read($, compactOffered)) await update($, compactOffered, () => false)
    } else if (!(await read($, compactOffered)) && (await read($, isOn)) && (await read($, suggestion)) === null) {
      await update($, compactOffered, () => true)
      const reason = `Contexto al ${fillNow} %. ¿Guardo el resumen y compacto ahora, antes de que se compacte solo a mitad de una tarea?`
      await update($, suggestion, () => ({ to: COMPACT_TARGET, name: 'compactar', reason }))
    }
    await update($, limits, () => e.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt ?? null })))
    // Near the 5 h limit the model can no longer write a summary, so the last messages go to the file as they are.
    const five = e.rateLimits.find(r => r.kind === 'five_hour')
    if (five !== undefined && five.percentUsed >= LIMIT_HANDOFF_AT && !isLimitHandedOff) {
      isLimitHandedOff = true
      const recent = (await $.session.messages()).slice(-IDEA_MESSAGES).filter(m => m.text)
        .map(m => `${m.role === 'user' ? 'Usuario' : 'Claude'}: ${m.text.slice(0, 1500)}`).join('\n\n')
      if (recent) {
        await saveContext($, recent, 'Guardado al acercarse el límite de 5 h; continúa con OmniRoute.').catch(() => null)
        const reason = `Límite de 5 h al ${Math.round(five.percentUsed)} %. Guardé la conversación. ¿Sigo gratis con OmniRoute? Abro una terminal que retoma esta misma conversación.`
        await update($, suggestion, () => ({ to: OMNI_TARGET, name: 'OmniRoute', reason }))
        $.ui.toast(`(•_•) ${reason}`, { timeoutMs: 20000 })
      }
    } else if (five !== undefined && five.percentUsed < LIMIT_HANDOFF_AT) isLimitHandedOff = false
    // The cost that grew since the last reading belongs to the model in use now.
    const total = e.cost?.usd
    if (total !== undefined) {
      const seen = await read($, costSeen)
      const grew = Math.max(0, total - seen)
      await update($, costSeen, () => total)
      if (grew > 0) {
        const model = await $.session.model()
        await update($, spend, s => ({ ...s, [model]: { turns: s[model]?.turns ?? 0, usd: (s[model]?.usd ?? 0) + grew } }))
        // Past the 5 h limit the turns are billed to the extra usage; the store is read again so other sessions' spend adds up.
        // The first reading of a session (seen still 0) carries the whole resumed conversation's cost: a baseline, not new spend.
        if (seen > 0 && five !== undefined && five.percentUsed >= 100) {
          const stored = (await $.store.get(EXTRA_KEY)) as Extra | null | undefined
          if (stored && typeof stored.budget === 'number') {
            const counted = { ...stored, used: stored.used + grew }
            await $.store.set(EXTRA_KEY, counted)
            await update($, extra, () => counted)
          }
        }
      }
    }
    // Near the end of the budget the same OmniRoute offer comes up, once per budget.
    const x = await read($, extra)
    if (x && x.budget > 0 && (x.used / x.budget) * 100 >= EXTRA_OFFER_AT && !isExtraOffered && (await read($, suggestion)) === null) {
      isExtraOffered = true
      const reason = `Uso extra: $${x.used.toFixed(2)} de $${x.budget.toFixed(2)}. ¿Sigo gratis con OmniRoute? Abro una terminal que retoma esta misma conversación.`
      await update($, suggestion, () => ({ to: OMNI_TARGET, name: 'OmniRoute', reason }))
      $.ui.toast(`(•_•) ${reason}`, { timeoutMs: 20000 })
    }
    return next(e)
  })

  // The pixel mascot lives above the prompt; when a switch pays off it speaks in a pixel cloud.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandSurface = e.surface
    if (e.props.hasSurvey || !(await read($, isOn)) || !(await read($, showAvatar))) return next(e)

    const s = await read($, suggestion)
    const note = await read($, idea)
    const busy = await read($, isBusy)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = e.surface === 'terminal' ? null : ui.Svg
    bandElements = `${Object.keys(ui).join(', ')} · Svg: ${Svg ? 'sí' : 'no'}`

    const isTalking = s !== null || note !== null
    const state = isTalking ? 'talking' : await read($, activity)
    const [face, doing] = FACE[state]
    const u = await read($, usage)
    const fill = fillOf(u)
    // Desktop draws the real pixel mascot, animated; the terminal keeps the text face.
    const mascot = Svg ? (
      <Svg key="mascot" source={mascotSvg(state, fill)} alt={`Mascota: ${doing}`} width={84} height={60} isInteractive />
    ) : (
      <Text key="face" color={fill === 'full' ? RED : ORANGE}>{face}</Text>
    )

    // The token bar beside the mascot: the context window's fill, its figures and the session's cost.
    const figures = u === null ? 'tokens: sin datos aún' : `${kTokens(u.tokens)} / ${kTokens(u.window)} tokens · ${u.percent}%${u.usd !== null ? ` · $${u.usd.toFixed(2)}` : ''}`
    const allLimits = await read($, limits)
    const five = allLimits.find(l => l.kind === 'five_hour')
    const week = allLimits.find(l => l.kind === 'seven_day')
    const now = await $.clock.now()
    const fiveReset = five ? untilText(five.resetsAt, now) : ''
    const weekReset = week ? untilText(week.resetsAt, now) : ''
    const fiveText = five ? ` · 5 h: ${Math.round(five.percent)}%` : ''
    const warn = fill === 'full' ? ' · cerca del límite, compacta pronto' : fill === 'half' ? ' · a mitad' : ''
    const r = await read($, running)
    const busyParts = [
      r.agents > 0 ? `${r.agents} agente${r.agents === 1 ? '' : 's'} trabajando` : '',
      r.commands > 0 ? `${r.commands} comando${r.commands === 1 ? '' : 's'} en curso` : '',
    ].filter(Boolean)
    const nEdited = (await read($, edited)).length
    const workLine = [...busyParts, nEdited > 0 ? `${nEdited} archivo${nEdited === 1 ? '' : 's'} editado${nEdited === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
    const bar = Svg ? (
      <Svg key="bar" source={barSvg(u?.percent ?? 0, fill)} alt={`Contexto ${u?.percent ?? 0}%`} width={110} height={10} />
    ) : (
      <Text key="bar" color={fill === 'full' ? RED : ORANGE}>{barText(u?.percent ?? 0)}</Text>
    )
    // A small orange card on the right: model, the 5 h limit, the context and the cost.
    const model = (await $.session.model()).replace(/^claude-/, '')
    const o = await read($, omni)
    const fiveFill: Fill = !five || five.percent < HALF ? 'low' : five.percent < NEAR_LIMIT ? 'half' : 'full'
    const fiveBar = five
      ? Svg ? <Svg key="five" source={barSvg(five.percent, fiveFill)} alt={`Límite de 5 h ${Math.round(five.percent)}%`} width={110} height={10} /> : <Text color={ORANGE}>{barText(five.percent)}</Text>
      : null
    // The extra usage row shows once the 5 h limit is spent, or once something was counted against the budget.
    const x = await read($, extra)
    const extraPercent = x && x.budget > 0 ? Math.min(100, (x.used / x.budget) * 100) : 0
    const showExtra = x !== null && (x.used > 0 || (five !== undefined && five.percent >= 100))
    const extraFill: Fill = extraPercent < HALF ? 'low' : extraPercent < EXTRA_OFFER_AT ? 'half' : 'full'
    const extraBar = Svg
      ? <Svg key="extra" source={barSvg(extraPercent, extraFill)} alt={`Uso extra ${Math.round(extraPercent)}%`} width={110} height={10} />
      : <Text color={extraFill === 'full' ? RED : ORANGE}>{barText(extraPercent)}</Text>
    const meter = (
      <Box key="right" flexDirection="row" flexGrow={1} justifyContent="flex-end">
        <Box key="meter" flexDirection="column" borderStyle="round" borderColor={fill === 'full' ? RED : ORANGE} paddingX={1}>
          <Text><Text bold color={ORANGE}>Tokens</Text> · {model}{o ? ` · Omni: ${o.model} (${o.calls} hoy)` : ''}</Text>
          {five ? (
            <Box key="five-row" flexDirection="row" gap={1} alignItems="center">
              <Box width={14}><Text>Límite 5 h {Math.round(five.percent)}%</Text></Box>
              {fiveBar}
              {fiveReset ? <Text dimColor>↻ {fiveReset}</Text> : null}
            </Box>
          ) : null}
          {showExtra && x ? (
            <Box key="extra-row" flexDirection="row" gap={1} alignItems="center">
              <Box width={14}><Text>Extra ${x.used.toFixed(2)}</Text></Box>
              {extraBar}
              <Text dimColor>de ${x.budget.toFixed(2)}</Text>
            </Box>
          ) : null}
          {week && week.percent >= WEEK_SHOW_AT ? (
            <Text key="week" color={week.percent >= NEAR_LIMIT ? RED : undefined} dimColor={week.percent < NEAR_LIMIT}>
              Semana {Math.round(week.percent)}%{weekReset ? ` · ↻ ${weekReset}` : ''}
            </Text>
          ) : null}
          <Box key="context-row" flexDirection="row" gap={1} alignItems="center">
            <Box width={14}><Text>Contexto {u?.percent ?? 0}%</Text></Box>
            {bar}
          </Box>
          <Text dimColor>{figures}{warn}</Text>
          {workLine ? <Text key="work" color={busyParts.length > 0 ? ORANGE : undefined} dimColor={busyParts.length === 0}>{workLine}</Text> : null}
        </Box>
      </Box>
    )

    if (!isTalking) {
      return (
        <Box flexDirection="row" gap={2} alignItems="center">
          {mascot}
          <Text dimColor>{doing} · ahorro: {await read($, promptEffort)}</Text>
          {meter}
        </Box>
      )
    }

    const message = busy ? 'Guardando el contexto y cambiando de modelo…' : s !== null ? s.reason : note
    const buttons = busy ? null : s !== null ? (
      <Box key="ask" flexDirection="row" gap={2}>
        <Button key="yes" label={s.to === COMPACT_TARGET ? 'Sí, compactar' : s.to === OMNI_TARGET ? 'Sí, abrir OmniRoute' : `Sí, cambiar a ${s.name}`} onPress={() => accept($, s)} />
        <Button key="no" label="No, gracias" onPress={() => reject($)} />
      </Box>
    ) : (
      <Box key="note" flexDirection="row" gap={2}>
        <Button key="use" label="Usar idea" onPress={() => useIdea($, note ?? '')} />
        <Button key="ok" label="Gracias" onPress={() => update($, idea, () => null)} />
      </Box>
    )

    if (Svg) {
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          {mascot}
          <Box key="cloud" flexDirection="column">
            <Svg key="top" source={CLOUD_TOP_SVG} alt="" width={340} height={24} />
            <Box paddingX={2} flexDirection="column" gap={1}>
              <Text>{message}</Text>
              {buttons}
            </Box>
            <Svg key="bottom" source={CLOUD_BOTTOM_SVG} alt="" width={340} height={24} />
          </Box>
          {meter}
        </Box>
      )
    }

    return (
      <Box flexDirection="row" alignItems="center">
        {mascot}
        <Box key="tail" flexDirection="column" marginX={1}>
          <Text color={CLOUD}>{'   ▄'}</Text>
          <Text color={CLOUD}>{' ▄ ▀'}</Text>
          <Text color={CLOUD}>{'▀   '}</Text>
        </Box>
        <Box key="cloud" flexDirection="column">
          <Text color={CLOUD}>{CLOUD_PUFFS}</Text>
          <Text color={CLOUD}>{CLOUD_TOP}</Text>
          <Box width={CLOUD_WIDTH + 2} paddingX={2} flexDirection="column" gap={1}>
            <Text>{message}</Text>
            {buttons}
          </Box>
          <Text color={CLOUD}>{CLOUD_BOTTOM}</Text>
        </Box>
        {meter}
      </Box>
    )
  })
}
