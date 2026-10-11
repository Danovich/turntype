import type { TypingProgressSummary, TypingResult, TypingRoundFinished } from '../../types'
import { sparkline } from '../engine/progress'
import type { Palette } from './palette'
import { settingsPicker } from './picker'
import type { PickerActions, PickerProps } from './picker'
import { formatClock, ONE_ROW, rule } from './shared'
import type { GameElements } from './shared'

export type ResultCardProps = {
  /** The pane body's width: the rule spans it. */
  readonly bodyColumns: number
  /** The card's field: a new key per key pressed, so it is always drawn empty. */
  readonly fieldKey: string
  readonly isDetailsShown: boolean
  /** The colors for the person's Claude Code theme. */
  readonly palette: Palette
  /** The toolbar: what the next test ("again") is made from. */
  readonly picker: PickerProps
}

export type ResultCardActions = {
  /** A key typed on the card, lowercased: `a`, `x` and `d` act, any other does nothing. */
  readonly onKey: (key: string) => void
  readonly onAgain: () => void
  readonly onClose: () => void
  readonly onToggleDetails: () => void
  readonly picker: PickerActions
}

const pbText = (Text: GameElements['Text'], wpm: number, progress: TypingProgressSummary | undefined, palette: Palette) => {
  switch (progress?.pb.kind) {
    case 'new':
      return <Text color={palette.success} bold wrap={ONE_ROW}>{`✦ new personal best (+${wpm - progress.pb.previousWpm})`}</Text>
    case 'first':
      return <Text color={palette.success} wrap={ONE_ROW}>✦ first personal best for this test</Text>
    case 'kept':
      return <Text dimColor wrap={ONE_ROW}>{`personal best ${progress.pb.pbWpm} wpm`}</Text>
    case 'unfair':
      return <Text dimColor wrap={ONE_ROW}>{`not a personal best try: ${progress.pb.reason}`}</Text>
    case undefined:
      return <Text> </Text>
  }
}

/** One row: the last results as a sparkline, the 7-day trend, today and the streak. */
const trendRow = ({ Box, Text }: Pick<GameElements, 'Box' | 'Text'>, progress: TypingProgressSummary | undefined, palette: Palette) => {
  if (progress === undefined) {
    return <Text> </Text>
  }
  const { trendDelta, recentWpm, todayTests, streakDays } = progress
  const today = `today ${todayTests} ${todayTests === 1 ? 'test' : 'tests'}${streakDays >= 2 ? ` ⋅ ${streakDays}-day streak` : ''}`

  return (
    <Box flexDirection="row" columnGap={2}>
      {recentWpm.length >= 2 && <Text color={palette.suggestion}>{sparkline(recentWpm)}</Text>}
      {trendDelta !== undefined && trendDelta !== 0 && (
        <Text color={trendDelta > 0 ? palette.success : palette.warning}>{`${trendDelta > 0 ? '⇡ +' : '⇣ '}${trendDelta} vs week`}</Text>
      )}
      <Text dimColor wrap={ONE_ROW}>{today}</Text>
    </Box>
  )
}

/** The details over two rows, in the trend's and the rule's place: neither is cut at 80 columns. */
const detailsRows = (result: TypingResult, progress: TypingProgressSummary | undefined): readonly [string, string] => [
  [
    `raw ${result.raw}`,
    `consistency ${result.consistency}%`,
    `${formatClock(result.durationMs)} ⋅ ${result.wordCount} ${result.wordCount === 1 ? 'word' : 'words'}`,
    ...(progress === undefined ? [] : [`today ${formatClock(progress.todayActiveMs)}`]),
  ].join(' ⋅ '),
  `correct ${result.chars.correct} ⋅ wrong ${result.chars.incorrect} ⋅ extra ${result.chars.extra} ⋅ missed ${result.chars.missed}`,
]

/**
 * The result card, five rows like the game: the wpm, accuracy and personal best; the trend and the
 * rule, or the details over both; the card's field, close and details; the toolbar for the next test.
 *
 * The field holds the keys: only an Input takes every key, and a key a pane does not take goes to
 * the prompt with the keyboard. A test ends on a key or a tick with more keys on their way, so the
 * card must hold them all. Enter on it is again; `a`, `x`, `d` act; any other key, nothing. Drawn
 * before every Button, so it is where the focus ring lands.
 */
export const resultCard = (elements: GameElements, round: TypingRoundFinished, props: ResultCardProps, actions: ResultCardActions) => {
  const { Box, Button, Input, Text } = elements
  const { result, progress } = round

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={0}>
          <Text color={props.palette.warning} bold>{`${result.wpm} wpm`}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold>{`${result.accuracy}% accuracy`}</Text>
        </Box>
        {pbText(Text, result.wpm, progress, props.palette)}
      </Box>
      {props.isDetailsShown
        ? detailsRows(result, progress).map(row => <Text dimColor wrap={ONE_ROW}>{row}</Text>)
        : [trendRow({ Box, Text }, progress, props.palette), rule({ Text }, props.bodyColumns)]}
      <Box flexDirection="row" columnGap={3}>
        <Input
          key={props.fieldKey}
          submitLabel="again"
          autoFocus
          onInput={text => actions.onKey(text.slice(-1).toLowerCase())}
          onSubmit={actions.onAgain}
        />
        <Button key="close" label="close" hotkey="x" plain onPress={actions.onClose} />
        <Button key="details" label={props.isDetailsShown ? 'hide details' : 'details'} hotkey="d" plain onPress={actions.onToggleDetails} />
      </Box>
      {settingsPicker({ Box, Button, Text }, props.picker, actions.picker)}
    </Box>
  )
}
