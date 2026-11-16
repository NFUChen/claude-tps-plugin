import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokRateSource } from '../types'

const PANE = 'tok-rate'
const WINDOW = 10
const LIVE_EVERY_MS = 500
const CHARS_PER_TOKEN = 4

// Change the tag when a source's fields change: state outlives a reload.
const sources = atom(
  { plugin: 'tok-rate', key: 'sources' } as const,
  {} as Record<string, TokRateSource>,
  { shape: 'sources-1' },
)

export const average = (rates: number[]): number | null =>
  rates.length === 0 ? null : rates.reduce((a, b) => a + b, 0) / rates.length

// Output tokens per second between the first token and the end of a call.
export const tokPerSec = (tokens: number, ms: number): number | null =>
  ms > 0 && tokens > 0 ? tokens / (ms / 1000) : null

const fmt = (n: number | null) => (n === null ? '-' : String(Math.round(n)))

const blank = (id: string, label: string, model: string): TokRateSource => ({
  id,
  label,
  model,
  last: null,
  recent: [],
  live: null,
  ttftMs: null,
  calls: 0,
  status: 'idle',
})

const ordered = (all: Record<string, TokRateSource>) =>
  Object.values(all).sort((a, b) =>
    a.id === 'main' ? -1 : b.id === 'main' ? 1 : 0,
  )

const showStatus = async ($: EngineInterface) => {
  const main = (await read($, sources)).main
  const rate = main?.live ?? main?.last ?? null
  $.ui.status(
    rate === null ? undefined : `main ${main?.live ? '~' : ''}${fmt(rate)} tok/s`,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tok-rate',
      description: 'Show output tokens/sec per agent (reset: clear stats)',
      argumentHint: '[reset]',
    })
    return next(e)
  })

  on('command.run', { command: 'tok-rate' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      await update($, sources, () => ({}))
      $.ui.status(undefined)
      return { text: 'tok-rate: stats cleared.' }
    }
    await $.ui.open({ id: PANE, title: 'tok/s' })
    return { text: 'tok/s pane opened.' }
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? 'main'
    let label = 'main'
    if (e.agentId !== undefined) {
      const info = (await $.agent.list()).find(a => a.id === e.agentId)
      label = info?.type ?? 'agent'
    }
    const startedAt = await $.clock.now()
    let firstAt: number | undefined
    let chars = 0
    let lastLive = startedAt

    await update($, sources, all => ({
      ...all,
      [id]: { ...(all[id] ?? blank(id, label, e.model)), model: e.model, status: 'streaming' as const, live: null },
    }))

    const stream = next(e)
    for await (const chunk of stream) {
      if (chunk.kind === 'text' || chunk.kind === 'thinking' || chunk.kind === 'input') {
        const now = await $.clock.now()
        firstAt ??= now
        chars += chunk.kind === 'input' ? chunk.json.length : chunk.text.length
        if (now - lastLive >= LIVE_EVERY_MS) {
          lastLive = now
          const live = tokPerSec(chars / CHARS_PER_TOKEN, now - firstAt)
          await update($, sources, all => {
            const one = all[id]
            return one ? { ...all, [id]: { ...one, live } } : all
          })
          if (id === 'main') await showStatus($)
        }
      }
      yield chunk
    }
    const result = await stream.result
    const endedAt = await $.clock.now()
    // No first-token chunk seen: fall back to the request start.
    const first = firstAt ?? startedAt
    const tokens = result.usage?.output_tokens ?? 0
    const rate = tokPerSec(tokens, endedAt - first)
    const model = result.usage?.model ?? e.model

    await update($, sources, all => {
      const one = all[id] ?? blank(id, label, model)
      const done = rate !== null
      return {
        ...all,
        [id]: {
          ...one,
          model,
          live: null,
          status: 'idle' as const,
          calls: one.calls + 1,
          last: done ? rate : one.last,
          recent: done ? [...one.recent, rate].slice(-WINDOW) : one.recent,
          ttftMs: first - startedAt,
        },
      }
    })
    if (id === 'main') await showStatus($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      await update($, sources, all => {
        const one = all[id]
        return one ? { ...all, [id]: { ...one, status: 'done' as const, live: null } } : all
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = ordered(await read($, sources))

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No model calls yet.</Text>}
        {rows.map(s => {
          const rate = s.live ?? s.last
          const ttft = s.ttftMs === null ? '-' : `${(s.ttftMs / 1000).toFixed(1)}s`
          return (
            <Text dimColor={s.status === 'done'}>
              {s.label}
              {s.id === 'main' ? '' : ` ${s.id.slice(0, 6)}`} {s.model}
              {'  '}
              {s.live !== null ? '~' : ''}
              {fmt(rate)} tok/s avg {fmt(average(s.recent))} ttft {ttft} calls{' '}
              {s.calls} {s.status}
            </Text>
          )
        })}
      </Box>
    )
  })
}
