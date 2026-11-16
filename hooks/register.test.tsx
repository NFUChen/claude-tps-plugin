import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Dollar = Engine

const usage = (output_tokens: number, model = 'm-1') => ({
  input_tokens: 1,
  output_tokens,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model,
})

// One model call: 1s to the first token, then `ms` more until the end.
// The one hook beneath the plugin stands for the engine and moves the clock;
// a test sets `next` before each run (hooks beneath register before the first `$` call).
const next = { tokens: 0, ms: 0, model: 'm-1' }

const PANE = {
  plugin: 'tok-rate',
  component: 'Pane',
  requestId: 'tok-rate',
  surface: 'terminal',
  props: {
    title: 'tok/s',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const run = async (
  $: Dollar,
  agentId?: string,
) => {
  const stream = $.turn.step({
    turnId: 't',
    index: 0,
    model: 'm-1',
    messageCount: 1,
    ...(agentId ? { agentId } : {}),
  })
  for await (const _ of stream) void _
  return stream.result
}

const rows = async (
  $: Dollar,
): Promise<string[]> => {
  const ui = await $.ui.mount(PANE)
  const out: string[] = []
  for (const t of await ui.findAll({ type: 'Text' })) out.push(t.text ?? '')
  await ui.unmount()
  return out
}

const setup = (on: On) => {
  const clock = mock.clock(on, { now: 0 })
  on('turn.step', async function* () {
    await clock.advance(1000)
    yield { kind: 'text' as const, index: 0, text: 'hi' }
    await clock.advance(next.ms)
    const u = usage(next.tokens, next.model)
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: u }
    return {
      turnId: 't',
      index: 0,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: u,
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({
    value: [{ id: 'sub-1', type: 'Explore', description: '', status: 'running' }],
  }))
  on('command.register', () => ({ value: { command: 'tok-rate' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const go = (
  $: Dollar,
  tokens: number,
  ms: number,
  model = 'm-1',
  agentId?: string,
) => {
  Object.assign(next, { tokens, ms, model })
  return run($, agentId)
}

test('tok/s of one call is tokens over end minus first token', async ($, on) => {
  setup(on)
  await go($, 100, 2000)
  // 100 tokens / 2 s = 50; TTFT 1.0 s
  const [row] = await rows($)
  expect(row).toMatch(/main m-1\s+50 tok\/s avg 50 ttft 1\.0s calls 1 idle/)
})

test('main loop and subagent stats stay apart', async ($, on) => {
  setup(on)
  await go($, 100, 1000)
  await go($, 30, 1000, 'm-2', 'sub-1')
  const [main, sub] = await rows($)
  expect(main).toMatch(/^main m-1\s+100 tok\/s/)
  expect(sub).toMatch(/^Explore sub-1 m-2\s+30 tok\/s/)
})

test('the average covers the last 10 calls', { timeoutMs: 60000 }, async ($, on) => {
  setup(on)
  // 12 calls at 1..12 tok/s; the last 10 are 3..12, mean 7.5 (shown as 8)
  for (let n = 1; n <= 12; n++) {
    await go($, n, 1000)
  }
  const [row] = await rows($)
  expect(row).toMatch(/12 tok\/s avg 8 ttft 1\.0s calls 12/)
})

test('/tok-rate reset clears the stats', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await go($, 100, 1000)
  expect((await rows($))[0]).toMatch(/main/)
  await $.command.run({
    command: 'tok-rate',
    args: 'reset',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  })
  expect(await rows($)).toEqual(['No model calls yet.'])
})
