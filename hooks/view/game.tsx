import type { Color, TextProps } from 'claude-code'

import type { TypingField, TypingRoundRunning } from '../../types'
import { buildVisibleLines, LETTER_STYLE } from '../engine/layout'
import type { LetterStyle } from '../engine/layout'
import { MODES } from '../engine/modes'
import { drawnOf, fieldKey } from '../engine/field'
import type { FieldAsDrawn } from '../engine/field'
import { liveWpm } from '../engine/stats'
import { activeElapsedMs, isIdle, timeLimitMs } from '../engine/timing'
import type { Palette } from './palette'
import { settingsPicker } from './picker'
import type { PickerActions, PickerProps } from './picker'
import { formatClock, ONE_ROW, progressLabel, ROW_GAP } from './shared'
import type { ActiveRound, GameElements } from './shared'

/**
 * How each letter of the words rows is drawn: the target letter, styled by how it was typed. Text
 * still to type is dim; letters typed right white, wrong ones red; letters skipped in a finished word
 * dim. A yellow block on the next character is where the next key lands. A word with a mistake is
 * underlined (`isInErrorWord`, added per run): in its letters' colors, as a terminal draws it.
 */
const letterTextPropsOf = (palette: Palette): Record<LetterStyle, TextProps> => ({
  [LETTER_STYLE.correct]: {},
  [LETTER_STYLE.incorrect]: { color: palette.error },
  [LETTER_STYLE.missed]: { dimColor: true },
  [LETTER_STYLE.untyped]: { dimColor: true },
  [LETTER_STYLE.caret]: { color: palette.warning, inverse: true },
})

// The props of the last palette drawn with: made once per theme, not on every draw.
let letterPropsCache: { readonly palette: Palette; readonly props: Record<LetterStyle, TextProps> } | undefined

const letterTextProps = (palette: Palette): Record<LetterStyle, TextProps> => {
  if (letterPropsCache?.palette !== palette) {
    letterPropsCache = { palette, props: letterTextPropsOf(palette) }
  }

  return letterPropsCache.props
}

/** Three lines of words in every phase: the first key changes nothing above the field. */
const WORD_LINE_COUNT = 3
/** What Enter does, drawn by the field after its text: `⏎ finish`. */
const SUBMIT_LABEL = 'finish'
/**
 * In the field before the first key, so the row reads `start typing ⏎ finish`, in that order. The
 * leading space takes the cursor, which a focused field draws on the placeholder's first cell.
 */
const FOCUSED_PLACEHOLDER = ' start typing'
const UNFOCUSED_PLACEHOLDER = 'ctrl+x tab to type'
/** Live wpm swings in the first seconds, so the vs-PB color waits for this much active time. */
const PB_MARK_AFTER_MS = 5000

export type GameViewProps = {
  /** The pane body's width: the word lines wrap to it. */
  readonly bodyColumns: number
  readonly isFocused: boolean
  readonly now: number
  /** The colors for the person's Claude Code theme. */
  readonly palette: Palette
  /** The toolbar, drawn before the first key; none once the test runs, so a key reads no settings. */
  readonly picker: PickerProps | undefined
}

export type GameActions = {
  readonly onInput: (field: FieldAsDrawn, text: string) => void
  readonly onFinish: (roundId: number) => void
  readonly picker: PickerActions
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

/**
 * Last on the status row, so a narrow pane cuts it first: Esc, or that Claude is done and how to
 * end. Flow ends with the word; time and words end on Enter, the field's own `⏎ finish`.
 */
const keyHint = ({ Text }: Pick<GameElements, 'Text'>, round: TypingRoundRunning, palette: Palette) =>
  round.isClaudeDone ? (
    <Text color={palette.success} wrap={ONE_ROW}>
      {`∘ Claude is done ⋅ ${MODES[round.mode].endsWhen === 'claudeDone' ? 'finish the word' : '⏎ finish'}`}
    </Text>
  ) : (
    <Text dimColor wrap={ONE_ROW}>esc: hide</Text>
  )

/** The clock and live wpm of a test in play: `0:12  52 wpm`, the wpm colored against the personal best. */
const pace = (elements: Pick<GameElements, 'Box' | 'Text'>, round: TypingRoundRunning, now: number, palette: Palette) => {
  const activeMs = activeElapsedMs(round, now)
  const wpm = liveWpm(round, activeMs)
  const clock =
    MODES[round.mode].endsWhen === 'timeUp' ? `${formatClock(Math.max(0, timeLimitMs(round) - activeMs))} left` : formatClock(activeMs)

  return [stat(elements, clock, { dimColor: true }), stat(elements, `${wpm} wpm`, { color: pbColor(activeMs, wpm, round.pbWpm, palette), bold: true })]
}

/** The status after the field: `0:12  52 wpm  7 words  esc: hide`, or `paused ⋅ type to resume` in place of the pace. */
const liveStatus = ({ Box, Text }: Pick<GameElements, 'Box' | 'Text'>, round: ActiveRound, now: number, palette: Palette) => {
  // Before the first key the field itself says "start typing"; after it, only the weak pairs, if any.
  if (round.phase === 'ready') {
    return round.focusBigrams.length > 0 ? <Text dimColor wrap={ONE_ROW}>{`your weak pairs: ${round.focusBigrams.join(' ')}`}</Text> : null
  }
  const lead = isIdle(round, now) ? [stat({ Box, Text }, 'paused ⋅ type to resume', { dimColor: true })] : pace({ Box, Text }, round, now, palette)

  return (
    <Box flexDirection="row" columnGap={2}>
      {lead}
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
export const gameView = (elements: GameElements, round: ActiveRound, field: TypingField, props: GameViewProps, actions: GameActions) => {
  const { Box, Button, Input, Text } = elements
  const [typedWords, currentWord] = round.phase === 'running' ? [round.typedWords, round.currentWord] : [[], '']
  const lines = buildVisibleLines(round.targetWords, typedWords, currentWord, props.bodyColumns, WORD_LINE_COUNT)
  const drawn = drawnOf(field)
  const letterProps = letterTextProps(props.palette)

  return (
    <Box flexDirection="column" rowGap={ROW_GAP}>
      <Box flexDirection="column" rowGap={ROW_GAP}>
        {lines.map(line => (
          <Box flexDirection="row">
            {line.length === 0 ? <Text> </Text> : line.map(run => <Text {...letterProps[run.style]} underline={run.isInErrorWord}>{run.text}</Text>)}
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" columnGap={2}>
        <Input
          key={fieldKey(field)}
          // In the field, before its own `⏎ finish`: what to do now, then what Enter does. The
          // first key replaces it. Without the keys, the way back to them.
          placeholder={props.isFocused ? FOCUSED_PLACEHOLDER : UNFOCUSED_PLACEHOLDER}
          // Empty for a fresh field; the word as cut for one drawn after keys past its end.
          value={field.value === '' ? undefined : field.value}
          submitLabel={SUBMIT_LABEL}
          autoFocus
          onInput={text => actions.onInput(drawn, text)}
          onSubmit={() => actions.onFinish(round.roundId)}
        />
        {liveStatus({ Box, Text }, round, props.now, props.palette)}
      </Box>
      {props.picker === undefined ? <Text> </Text> : settingsPicker({ Box, Button, Text }, props.picker, actions.picker)}
    </Box>
  )
}
