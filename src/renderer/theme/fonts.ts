/** The font xterm measures its cells with, once, when a terminal opens (tokens.css). */
export const TERMINAL_FONT = "12px 'JetBrains Mono'";

/** Resolves once the terminal font is ready, or failed to load: the fallback font then applies. */
export async function terminalFontReady(fonts: Pick<FontFaceSet, 'load'> = document.fonts) {
  try {
    await fonts.load(TERMINAL_FONT);
  } catch {
    // ui-monospace takes over; the cells are measured with it.
  }
}
