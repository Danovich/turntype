import type { Color, TextProps } from 'claude-code'

import type { TypingRoundRunning, TypingSettings } from '../../types'
import { buildVisibleLines, LETTER_STYLE } from '../engine/layout'
import type { LetterStyle } from '../engine/layout'
import { TYPING_MODE } from '../engine/settings'
import { liveWpm } from '../engine/stats'
import { activeElapsedMs, isIdle } from '../engine/timing'
import { foldOf } from '../engine/window'
import type { Palette } from './palette'
import { settingsPicker } from './picker'
import { formatClock, ONE_ROW, progressLabel, ROW_GAP } from './shared'
import type { ActiveRound, GameElements } from './shared'

/** How each letter of the words rows is drawn: the target letter, styled by how it was typed. */
const letterTextProps = (palette: Palette): Record<LetterStyle, TextProps> => ({
  [LETTER_STYLE.correct]: {},
  [LETTER_STYLE.incorrect]: { color: palette.error },
  [LETTER_STYLE.missed]: { color: palette.error, dimColor: true },
  [LETTER_STYLE.untyped]: { dimColor: true },
  [LETTER_STYLE.currentCorrect]: { bold: true, underline: true },
  [LETTER_STYLE.currentIncorrect]: { color: palette.error, bold: true, underline: true },
  [LETTER_STYLE.currentUntyped]: { color: palette.warning, underline: true },
  [LETTER_STYLE.space]: {},
})

/** Three lines of words in every phase: the first key changes nothing above the field. */
const WORD_LINE_COUNT = 3
/** Live wpm swings in the first seconds, so the vs-PB color waits for this much active time. */
const PB_MARK_AFTER_MS = 5000

export type GameViewProps = {
  /** The pane body's width: the word lines wrap to it. */
  readonly bodyColumns: number
  readonly isFocused: boolean
  readonly now: number
  /** The settings a pick in the picker starts from. */
  readonly settings: TypingSettings
  /** Every word list read from `word-lists/`, in order: the label moves to the next. */
  readonly wordListNames: readonly string[]
  /** The colors for the person's Claude Code theme. */
  readonly palette: Palette
}

export type GameActions = {
  /** `fieldBaseDropped`: how much the window had folded when the field was drawn. */
  readonly onInput: (roundId: number, fieldIndex: number, fieldBaseLength: number, fieldBaseDropped: number, text: string) => void
  readonly onFinish: (roundId: number) => void
  readonly onChoose: (chosen: TypingSettings) => void
}

/** Green while live wpm is at or over the personal best of this test, yellow under it; none at first. */
const pbColor = (activeMs: number, wpm: number, pbWpm: number | undefined, palette: Palette): Color | undefined => {
  if (pbWpm === undefined || activeMs < PB_MARK_AFTER_MS) {
    return undefined
  }

  return wpm >= pbWpm ? palette.success : palette.warning
}

/** One stat of the status row at its full width: a narrow pane cuts the hint after it, never wraps a stat. */
const stat = ({ Box, Text }: Pick<GameElements, 'Box' | 'Text'>, text: string, props: TextProps) => (
  <Box flexShrink={0}>
    <Text {...props}>{text}</Text>
  </Box>
)

/** Last on the status row, so a narrow pane cuts it first: Esc, or that Claude is done. Enter is the field's own `⏎ finish`. */
const keyHint = ({ Text }: Pick<GameElements, 'Text'>, round: TypingRoundRunning, palette: Palette) =>
  round.isClaudeDone ? (
    <Text color={palette.success} wrap={ONE_ROW}>∘ Claude is done ⋅ finish the word</Text>
  ) : (
    <Text dimColor wrap={ONE_ROW}>esc: hide</Text>
  )

/** The status after the field: `0:12  52 wpm  7 words  esc: hide`, nothing more. */
const liveStatus = ({ Box, Text }: Pick<GameElements, 'Box' | 'Text'>, round: ActiveRound, now: number, palette: Palette) => {
  if (round.phase === 'ready') {
    const practice = round.focusBigrams.length > 0 ? ` ⋅ your weak pairs: ${round.focusBigrams.join(' ')}` : ''

    return <Text dimColor wrap={ONE_ROW}>{`start typing${practice}`}</Text>
  }
  if (isIdle(round, now)) {
    return (
      <Box flexDirection="row" columnGap={2}>
        {stat({ Box, Text }, 'paused ⋅ type to resume', { dimColor: true })}
        {stat({ Box, Text }, progressLabel(round), { dimColor: true })}
        {keyHint({ Text }, round, palette)}
      </Box>
    )
  }
  const activeMs = activeElapsedMs(round, now)
  const wpm = liveWpm(round, activeMs)
  const clock =
    round.mode === TYPING_MODE.time ? `${formatClock(Math.max(0, round.timeLimitMs - activeMs))} left` : formatClock(activeMs)
  const color = pbColor(activeMs, wpm, round.pbWpm, palette)

  return (
    <Box flexDirection="row" columnGap={2}>
      {stat({ Box, Text }, clock, { dimColor: true })}
      {stat({ Box, Text }, `${wpm} wpm`, color === undefined ? { bold: true } : { color, bold: true })}
      {stat({ Box, Text }, progressLabel(round), { dimColor: true })}
      {keyHint({ Text }, round, palette)}
    </Box>
  )
}

/**
 * The pane before and during a test, nine rows: three word lines, the field with the status
 * after it, then the toolbar before the first key or an empty row. The field keeps its row
 * and its place in the tree, and is drawn before every Button: the toolbar going at the first key
 * must not take the focus ring from it.
 */
export const gameView = (elements: GameElements, round: ActiveRound, props: GameViewProps, actions: GameActions) => {
  const { Box, Button, Input, Text } = elements
  const typed = round.phase === 'running' ? round.typed : ''
  const lines = buildVisibleLines(round.targetWords, typed, props.bodyColumns, WORD_LINE_COUNT)
  const { roundId, fieldIndex, fieldBaseLength } = round
  const { droppedCharacters } = foldOf(round)
  const letterProps = letterTextProps(props.palette)

  return (
    <Box flexDirection="column" rowGap={ROW_GAP}>
      <Box flexDirection="column" rowGap={ROW_GAP}>
        {lines.map(line => (
          <Box flexDirection="row">
            {line.length === 0 ? <Text> </Text> : line.map(run => <Text {...letterProps[run.style]}>{run.text}</Text>)}
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" columnGap={2}>
        <Input
          key={`r${roundId}-f${fieldIndex}`}
          // With the keys, a key lands here already, and the status says "start typing": no
          // placeholder, which would read as a box to click. Without them, the way back.
          placeholder={props.isFocused ? undefined : 'ctrl+x tab to type'}
          submitLabel="finish"
          autoFocus
          onInput={text => actions.onInput(roundId, fieldIndex, fieldBaseLength, droppedCharacters, text)}
          onSubmit={() => actions.onFinish(roundId)}
        />
        {liveStatus({ Box, Text }, round, props.now, props.palette)}
      </Box>
      {round.phase === 'ready' ? (
        settingsPicker({ Box, Button, Text }, round, props.settings, props.wordListNames, props.palette, actions.onChoose)
      ) : (
        <Text> </Text>
      )}
    </Box>
  )
}
