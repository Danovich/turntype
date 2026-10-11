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
  return counts
}

/** A store with nothing saved: what a new player has. */
const stubEmptyStore = (on: On): void => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}

const reset = (counts: Counts): void => {
  counts.panes = 0
  counts.bandRenders = 0
}

test('cost: typing 20 words with the pane focused', async ($, on) => {
  const clock = mock.clock(on)
  const counts = stubCounting(on)
  stubEmptyStore(on)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.advance(3000)
  const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'play' })
  const pane = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'Pane', requestId: GAME, props: PANE_PROPS })
  await band.find({ type: 'Box' })
  reset(counts)

  for (let index = 0; index < 20; index++) {
    const key = (await pane.find({ type: 'Input' }))?.key ?? ''
    // The word at the caret: the yellow underline on its first letter, up to the next space.
    const texts = await pane.findAll({ type: 'Text' })
    const caret = texts.findIndex(found => found.props['underline'] === true)
    const word = texts.slice(caret).map(found => found.text).join('').split(' ')[0] ?? ''
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
  stubEmptyStore(on)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.advance(3000)
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

/** The store calls the mod makes, and the most of each kind in flight at once: calls made together overlap. */
type StoreCounts = { gets: string[]; sets: string[]; maxGetsAtOnce: number; maxSetsAtOnce: number }

/** A store that answers a moment later, so calls made together are seen in flight together. */
const stubSlowStore = (on: On): StoreCounts => {
  const counts: StoreCounts = { gets: [], sets: [], maxGetsAtOnce: 0, maxSetsAtOnce: 0 }
  let getsInFlight = 0
  let setsInFlight = 0
  const aMoment = async () => {
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
  }
  on('store.get', async (_, e) => {
    counts.gets.push(e.key)
    counts.maxGetsAtOnce = Math.max(counts.maxGetsAtOnce, ++getsInFlight)
    await aMoment()
    getsInFlight--

    return { value: undefined }
  })
  on('store.set', async (_, e) => {
    counts.sets.push(e.key)
    counts.maxSetsAtOnce = Math.max(counts.maxSetsAtOnce, ++setsInFlight)
    await aMoment()
    setsInFlight--

    return { value: undefined }
  })

  return counts
}

test('cost: a finished test reads each progress part once and writes it once, all four at once', async ($, on) => {
  const clock = mock.clock(on)
  stubCounting(on)
  const store = stubSlowStore(on)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.advance(3000)
  const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'play' })
  const pane = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'Pane', requestId: GAME, props: PANE_PROPS })
  await pane.input({ key: 'r1-f0', text: 'x', kind: 'change' })
  store.gets.length = 0
  store.maxGetsAtOnce = 0

  await pane.input({ key: 'r1-f0', text: 'x', kind: 'submit' })
  await clock.settle()

  // Before: 18 calls one after another (a legacy check, 4 reads, then a read and a write per part).
  expect(store.gets.toSorted(), 'store reads at the end of a test').toEqual(['bigrams', 'daily', 'history', 'personalBests'])
  expect(store.sets.toSorted(), 'store writes at the end of a test').toEqual(['bigrams', 'daily', 'history', 'personalBests'])
  expect(store.maxGetsAtOnce, 'reads in flight at once').toBe(4)
  expect(store.maxSetsAtOnce, 'writes in flight at once').toBe(4)
})

test('cost: a session start reads the store at once: the picks, the old record and the four parts', async ($, on) => {
  stubCounting(on)
  const store = stubSlowStore(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(store.gets.toSorted(), 'store reads at a start').toEqual(['bigrams', 'daily', 'history', 'personalBests', 'progress', 'settings'])
  // Before: 6 reads one after another.
  expect(store.maxGetsAtOnce, 'reads in flight at once').toBe(6)
})
