import type { Color } from 'claude-code'

/** The colors the views draw with: theme keys, so each follows the person's Claude Code theme. */
export type Palette = {
  /** What is selected or next: the toolbar pick, the letters to type, the big wpm, a trend down. */
  readonly warning: Color
  readonly error: Color
  readonly success: Color
  readonly suggestion: Color
}

export const THEME_PALETTE: Palette = {
  warning: 'warning',
  error: 'error',
  success: 'success',
  suggestion: 'suggestion',
}

/**
 * Our own shades where a theme's key does not suit the game. In `dark` the theme's warning
 * (#FFC107) leans orange next to the green and red: turntype's yellow is a clearer #FFCE1B.
 * Other themes (light, colorblind, ANSI) keep their keys: their warning is tuned for them.
 */
const THEME_OVERRIDES: Readonly<Record<string, Partial<Palette>>> = {
  dark: { warning: '#FFCE1B' },
}

/** The palette for a Claude Code theme by name (`dark`, `light`, `dark-daltonized`, ...). */
export const paletteFor = (theme: string): Palette => ({ ...THEME_PALETTE, ...THEME_OVERRIDES[theme] })
