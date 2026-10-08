/**
 * Cost probe: host calls and redraws on the hot paths (each key, each clock tick).
 * Run: claude plugin test <mod folder>. Each limit fails with the count it saw.
 */
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const GAME = 'turntype'
const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE_PROPS = { title: GAME, isFocused: true, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 9 }, view: {} }

type Counts = { panes: number; bandRenders: number }

const stubCounting = (on: On): Counts => {
  const counts: Counts = { panes: 0, bandRenders: 0 }
  const openPaneIds = new Set<string>()

  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', (_, e) => {
    if (e.component === 'AbovePrompt') {
      counts.bandRenders++
    }

    return { type: 'Box', props: {} }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.open', (_, e) => (openPaneIds.add(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (openPaneIds.delete(e.id), { value: undefined }))
  on('ui.panes', () => {
    counts.panes++

    return { value: [...openPaneIds].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))

  return counts
}

const reset = (counts: Counts): void => {
  counts.panes = 0
  counts.bandRenders = 0
}

test('cost: typing 20 words with the pane focused', async ($, on) => {
  const clock = mock.clock(on)
  const counts = stubCounting(on)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.advance(1500)
  const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'play' })
  const pane = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'Pane', requestId: GAME, props: PANE_PROPS })
  await band.find({ type: 'Box' })
  reset(counts)

  for (let index = 0; index < 20; index++) {
    const key = (await pane.find({ type: 'Input' }))?.key ?? ''
    const word = (await pane.findAll({ type: 'Text' })).filter(found => found.props['underline'] === true).map(found => found.text).join('')
    for (const [position] of [...word, ' '].entries()) {
      await pane.input({ key, text: `${word} `.slice(0, position + 1), kind: 'change' })
    }
    await band.find({ type: 'Box' })
  }
  // Before the fix: 105 of each, one per key.
  expect(counts.bandRenders, 'band redraws per 20 words').toBe(0)
  expect(counts.panes, 'ui.panes calls per 20 words').toBe(0)
})

test('cost: 10 clock ticks of a running test with the pane closed', async ($, on) => {
  const clock = mock.clock(on)
  const counts = stubCounting(on)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.advance(1500)
  const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'play' })
  const pane = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'Pane', requestId: GAME, props: PANE_PROPS })
  await pane.input({ key: 'r1-f0', text: 'x', kind: 'change' })
  await pane.unmount()
  reset(counts)

  for (let tick = 0; tick < 10; tick++) {
    await clock.advance(1000)
    await band.find({ type: 'Box' })
  }
  // The band shows no time: a tick that only moves the clock must not draw it. Before the fix: 10.
  expect(counts.bandRenders, 'band redraws per 10 ticks').toBe(0)
  expect(counts.panes, 'ui.panes calls per 10 ticks').toBe(0)
})
