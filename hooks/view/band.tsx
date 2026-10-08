import type { TypingRoundFinished } from '../../types'
import type { TodayPractice } from '../engine/progress'
import type { Palette } from './palette'
import { progressLabel } from './shared'
import type { ActiveRound, GameElements } from './shared'

type BandElements = Pick<GameElements, 'Box' | 'Button' | 'Text'>

/**
 * `press 1: <label>`: what to press bright, what it does dim. A plain Button always draws as
 * `<hotkey>: <label>`, so "press" goes before it. Its `1` also fires from an empty prompt.
 */
const pressOne = ({ Box, Button, Text }: BandElements, key: string, label: string, onPress: () => void) => (
  <Box flexDirection="row" columnGap={1}>
    <Text>press</Text>
    <Button key={key} label={label} hotkey="1" plain dimColor onPress={onPress} />
  </Box>
)

/** The pane is open but a dialog or a click took the keys: the way back. */
export const backToTypingBand = (elements: BandElements, round: ActiveRound, onOpen: () => void) => {
  const { Box, Text } = elements
  const label = round.phase === 'running' ? `back to typing ⋅ ${progressLabel(round)}` : 'back to typing'

  return (
    <Box flexDirection="row" columnGap={2}>
      {pressOne(elements, 'play', label, onOpen)}
      <Text dimColor>or ctrl+x tab</Text>
    </Box>
  )
}

/** A finished test while the pane is closed: the result in one row, and another test. */
export const resultBand = (elements: BandElements, round: TypingRoundFinished, palette: Palette, onOpen: () => void) => {
  const { Box, Text } = elements

  return (
    <Box flexDirection="row" columnGap={2}>
      <Text color={palette.warning} bold>{`${round.result.wpm} wpm`}</Text>
      <Text dimColor>{`${round.result.accuracy}% accuracy`}</Text>
      {round.progress?.pb.kind === 'new' && <Text color={palette.success} bold>✦ new personal best</Text>}
      {pressOne(elements, 'again', 'again', onOpen)}
    </Box>
  )
}

/** Today's practice beside the invitation; `goalMinutes` undefined: the goal is off, the streak alone. */
export type DailyGoal = { readonly practice: TodayPractice; readonly goalMinutes: number | undefined }

const MINUTE_MS = 60_000
/** A one-day run is no streak worth a word. */
const MIN_STREAK_SHOWN = 2

/** `2/5 min today ⋅ 4-day streak`, or `keep your 4-day streak` before today's first test; met: `daily goal met (5 min)`. */
const dailyGoalText = ({ practice, goalMinutes }: DailyGoal): string | undefined => {
  const minutes = Math.floor(practice.activeMs / MINUTE_MS)
  const goal =
    goalMinutes === undefined ? [] : [minutes >= goalMinutes ? `daily goal met (${goalMinutes} min)` : `${minutes}/${goalMinutes} min today`]
  const streak = practice.streakDays < MIN_STREAK_SHOWN ? [] : [`${practice.isPlayedToday ? '' : 'keep your '}${practice.streakDays}-day streak`]
  const parts = [...goal, ...streak]

  return parts.length === 0 ? undefined : parts.join(' ⋅ ')
}

/**
 * The invitation while Claude works, with today's goal and streak; or a test in progress waiting
 * while the pane is closed, its progress alone.
 */
export const invitationBand = (elements: BandElements, round: ActiveRound, daily: DailyGoal | undefined, onOpen: () => void) => {
  if (round.phase === 'running') {
    return pressOne(elements, 'play', `continue ⋅ ${progressLabel(round)}`, onOpen)
  }
  // No mode label: the mode shows in the pane.
  const invitation = pressOne(elements, 'play', 'type while you wait', onOpen)
  const goalText = daily === undefined ? undefined : dailyGoalText(daily)
  const { Box, Text } = elements

  return goalText === undefined ? invitation : (
    <Box flexDirection="row" columnGap={1}>
      {invitation}
      <Text dimColor>{`⋅ ${goalText}`}</Text>
    </Box>
  )
}
