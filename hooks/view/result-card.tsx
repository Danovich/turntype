import type { TypingProgressSummary, TypingResult, TypingRoundFinished, TypingSettings } from '../../types'
import { bigNumberRows } from '../engine/big-digits'
import { sparkline } from '../engine/progress'
import type { Palette } from './palette'
import { settingsPicker } from './picker'
import type { OpenOptions, PickerActions } from './picker'
import { formatClock, ONE_ROW, ROW_GAP } from './shared'
import type { GameElements } from './shared'

export type ResultCardProps = {
  /** Block digits need the terminal's monospace cells; elsewhere the wpm is plain text. */
  readonly isTerminal: boolean
  readonly isDetailsShown: boolean
  /** The settings a pick in the picker starts from. */
  readonly settings: TypingSettings
  /** Every word list read from `word-lists/`. */
  readonly wordListNames: readonly string[]
  /** The colors for the person's Claude Code theme. */
  readonly palette: Palette
  /** The toolbar group showing its options, if any. */
  readonly openOptions: OpenOptions
}

export type ResultCardActions = {
  readonly onAgain: () => void
  readonly onClose: () => void
  readonly onToggleDetails: () => void
  readonly onChoose: (chosen: TypingSettings) => void
  readonly onToggle: PickerActions['onToggle']
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

const detailsText = (result: TypingResult, progress: TypingProgressSummary | undefined): string =>
  [
    `raw ${result.raw}`,
    `consistency ${result.consistency}%`,
    `correct ${result.chars.correct} ⋅ wrong ${result.chars.incorrect} ⋅ extra ${result.chars.extra} ⋅ missed ${result.chars.missed}`,
    `${formatClock(result.durationMs)} ⋅ ${result.wordCount} words`,
    ...(progress === undefined ? [] : [`today ${formatClock(progress.todayActiveMs)}`]),
  ].join(' ⋅ ')

/** The result card: wpm in big digits on the terminal, accuracy and progress beside it. Nine rows. */
export const resultCard = (elements: GameElements, round: TypingRoundFinished, props: ResultCardProps, actions: ResultCardActions) => {
  const { Box, Button, Text } = elements
  const { result, progress } = round
  const digitRows = props.isTerminal ? bigNumberRows(result.wpm) : [String(result.wpm), ' ', ' ']

  return (
    <Box flexDirection="column" rowGap={ROW_GAP}>
      <Box flexDirection="row" columnGap={3}>
        <Box flexDirection="column">
          {digitRows.map(row => (
            <Text color={props.palette.warning} bold>{row}</Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={3}>
            <Text dimColor>wpm</Text>
            <Text bold wrap={ONE_ROW}>{`${result.accuracy}% accuracy`}</Text>
          </Box>
          {pbText(Text, result.wpm, progress, props.palette)}
          {trendRow({ Box, Text }, progress, props.palette)}
        </Box>
      </Box>
      {props.isDetailsShown ? <Text dimColor wrap={ONE_ROW}>{detailsText(result, progress)}</Text> : <Text> </Text>}
      <Box flexDirection="row" columnGap={3}>
        <Button key="again" label="again" hotkey="a" plain autoFocus onPress={actions.onAgain} />
        <Button key="close" label="close" hotkey="x" plain onPress={actions.onClose} />
        <Button key="details" label={props.isDetailsShown ? 'hide details' : 'details'} hotkey="d" plain onPress={actions.onToggleDetails} />
      </Box>
      {settingsPicker(
        { Box, Button, Text },
        round,
        { settings: props.settings, wordListNames: props.wordListNames, palette: props.palette, openOptions: props.openOptions },
        { onChoose: actions.onChoose, onToggle: actions.onToggle },
      )}
    </Box>
  )
}
