import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'ahorro-tokens',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0 }, view: {} },
} as const

const IDEA = 'Quedó pendiente revisar el video de mañana del canal Cocina'
const HANDOFF = '## Objetivo\nPublicar los videos.\n## Dónde quedó\nRender listo.\n## Qué debe hacer el nuevo modelo\nSubir el video.'

// The engine beneath the mod: answers every call the mod makes and records what it was asked.
type Engine = Parameters<Parameters<typeof test>[1]>[0]

const engine = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  { compactWorks = true, top, startModel = 'claude-opus-5-5', failingTools = false }: { compactWorks?: boolean; top?: Engine; startModel?: string; failingTools?: boolean } = {},
) => {
  const seen = {
    toasts: [] as string[],
    writes: [] as { path: string; text: string }[],
    models: [] as string[],
    commands: [] as string[],
    fills: [] as string[],
    asks: 0,
  }
  let model = startModel
  on('tool.call', () => (failingTools ? { result: {}, isError: true } : { result: {} }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.register', () => ({ value: { command: 'ahorro' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_790_000_000_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('session.model', () => ({ value: model }))
  on('session.root', () => ({ value: '/proyecto' }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'mañana sale el video de Cocina, recuérdame revisarlo', toolUses: [] },
      { role: 'assistant', text: 'Anotado.', toolUses: [] },
    ],
  }))
  on('model.complete', () => {
    seen.asks += 1
    return { value: { isAnswered: true, text: IDEA, usage: { inputTokens: 1, outputTokens: 1 } } }
  })
  on('session.compact', () => ({ messages: [{ role: 'user', text: HANDOFF, toolUses: [] }] }))
  on('fs.write', (_, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  on('command.run', async (_, e) => {
    seen.commands.push(e.command)
    // /compact raises the compaction as the engine does; a broken one does nothing at all.
    if (e.command === 'compact' && compactWorks && top) await top.session.compact({ instructions: e.args, trigger: 'manual', messages: [{ role: 'user', text: 'historia larga', toolUses: [] }] })
    if (e.command === 'model') {
      model = e.args
      seen.models.push(e.args)
    }
    return { text: '' }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  return seen
}

test('an idea shows in the cloud after four turns', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/proyecto', surface: 'desktop', isInteractive: true })

  for (let i = 0; i < 4; i += 1) {
    await $.turn.start({ turnId: `t${i}` })
    await $.turn.complete({ turnId: `t${i}`, reason: 'answer', answer: 'hecho', durationMs: 1000, isAborted: false })
  }
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(seen.asks).toBe(1)
  expect(seen.toasts.some(t => t.includes(IDEA))).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /video de mañana/ }))?.text).toBe(IDEA)
  await ui.unmount()
})

const pressYes = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  await $.session.start({ cwd: '/proyecto', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'ahorro', args: 'prueba' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'yes' })
  await ui.unmount()
}

test('plan A: yes compacts with /compact, saves the summary and switches the model', async ($, on) => {
  const seen = engine(on, { top: $ })
  await pressYes($)

  expect(seen.commands.filter(c => c !== 'ahorro')).toEqual(['compact', 'model'])
  expect(seen.models).toEqual(['claude-sonnet-5-5'])
  expect(seen.writes.length).toBe(1)
  expect(seen.writes[0].path.split('\\').join('/').endsWith('/proyecto/.claude/ahorro-contexto.md')).toBe(true)
  expect(seen.writes[0].text.includes('Dónde quedó')).toBe(true)
  expect(seen.fills).toEqual([])
  expect(seen.toasts.some(t => t.startsWith('Listo'))).toBe(true)
})

test('plan B: when /compact does nothing, Haiku writes the handoff, the chat is cleared and resumed', async ($, on) => {
  const seen = engine(on, { compactWorks: false })
  await pressYes($)

  expect(seen.commands.filter(c => c !== 'ahorro')).toEqual(['compact', 'clear', 'model'])
  expect(seen.asks).toBe(1)
  expect(seen.writes.length).toBe(1)
  expect(seen.writes[0].text.includes(IDEA)).toBe(true)
  expect(seen.fills.length).toBe(1)
  expect(seen.fills[0].includes(IDEA)).toBe(true)
  expect(seen.toasts.some(t => t.includes('pulsa Enter'))).toBe(true)
})

const turn = async ($: Engine, id: string, tools: string[], text: string) => {
  await $.turn.start({ turnId: id })
  for (const tool of tools) await $.tool.call({ tool, file_path: '/proyecto/a.ts', old_string: 'a', new_string: 'b', pattern: 'x', command: 'ls' } as never)
  await $.turn.complete({ turnId: id, reason: 'answer', answer: text, durationMs: 1000, isAborted: false })
}

test('a plan that ends in a question offers Sonnet, and the yes counts as execution', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proyecto', surface: 'desktop', isInteractive: true })
  await turn($, 'p1', ['Read', 'Grep'], 'Este es el plan: 1) detectar fases 2) sugerir modelo. ¿Lo implemento?')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Plan listo/ }))?.text.includes('Sonnet')).toBe(true)
  await ui.unmount()

  await $.prompt.submit({ text: 'Sí, implementa los dos cambios y el error de diseño' })
  const status = await $.command.run({ command: 'ahorro', args: '' })
  expect(String(status.text).includes('clasificado como: low')).toBe(true)
})

test('a turn that edited files is not a plan', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proyecto', surface: 'desktop', isInteractive: true })
  await turn($, 'w1', ['Read', 'Edit'], 'Listo, cambié el archivo. ¿Algo más?')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Plan listo/ })).toBe(undefined)
  await ui.unmount()
})

test('the token bar shows the context fill and warns near the limit', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proyecto', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], cost: { usd: 1.5 }, changed: ['context'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /tokens/ })
  expect(line?.text.includes('170k / 200k tokens · 85%')).toBe(true)
  expect(line?.text.includes('cerca del límite')).toBe(true)
  await ui.unmount()
})

test('repeated failures on Sonnet offer Opus', async ($, on) => {
  engine(on, { startModel: 'claude-sonnet-5-5', failingTools: true })
  await $.session.start({ cwd: '/proyecto', surface: 'desktop', isInteractive: true })
  await turn($, 'e1', ['Bash', 'Bash', 'Bash'], 'Sigue fallando la compilación.')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Opus/ }))?.text.includes('3 errores')).toBe(true)
  await ui.unmount()
})

test('a /compact typed by the person also saves its summary', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/proyecto', surface: 'desktop', isInteractive: true })
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'historia larga', toolUses: [] }] })

  expect(seen.writes.length).toBe(1)
  expect(seen.writes[0].path.split('\\').join('/').endsWith('/proyecto/.claude/ahorro-contexto.md')).toBe(true)
  expect(seen.writes[0].text.includes('Dónde quedó')).toBe(true)
})
