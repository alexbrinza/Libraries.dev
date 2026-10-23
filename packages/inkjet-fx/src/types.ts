import type { HTMLAttributes } from 'react';
import type { InkImageEngine, InkImageLook, InkImageScreen } from './engine/ink-image';
import type { InkTextEngine, InkTextLook, InkTextThinking } from './engine/ink-text';

export type { InkImageLook, InkImageScreen, InkTextLook, InkTextThinking };

export interface InkTextProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * The text so far. Append to it as the stream arrives and each new chunk
   * prints after the last; a value that doesn't continue the previous one
   * starts a fresh print.
   */
  text: string;
  /**
   * True while more text is coming. With no text yet it shows the thinking
   * state; when it turns false the last words print and dry, and the element
   * is left holding plain text.
   * @default false
   */
  streaming?: boolean;
  /**
   * False renders the text plainly with no canvas (history, restored
   * messages, server rendering).
   * @default true
   */
  animate?: boolean;
  /**
   * How the drops reach the paper.
   * - `printhead`: a head sweeps each word left to right, nozzles firing in dither order.
   * - `rain`: drops fall onto the line as streaks.
   * - `develop`: the word develops in place in Bayer passes, like a photo.
   * - `fall`: drops fall from above the page in perspective.
   * @default 'printhead'
   */
  look?: InkTextLook;
  /**
   * What shows before the first words.
   * - `caret`: the printhead fizzes where the text will start.
   * - `skeleton`: three halftone bars darken where the answer will go.
   * - `word`: a word (`thinkingWord`) rains in, holds and dries off, again and again.
   * @default 'caret'
   */
  thinking?: InkTextThinking;
  /** The word the `word` thinking state prints. @default 'Thinking' */
  thinkingWord?: string;
  /** Characters per second the head prints at; it speeds up when the stream gets ahead of it. @default 80 */
  speed?: number;
  /** Dot pitch in CSS px; 0 picks one from the font size. @default 0 */
  pitch?: number;
  /** Ink threshold; 0 matches the weight of the real text (measured per platform). @default 0 */
  thresh?: number;
  /** How much the ink's edge wanders with the paper's fibres, 0–1. @default 0.7 */
  rough?: number;
  /** Share of drops that throw a tiny satellite drop, 0–1. @default 0.05 */
  satellites?: number;
  /** Seed for the drops, so a print replays exactly. Read when a print starts. */
  seed?: number;
  /** Called when the last word has dried and the element holds plain text. */
  onDone?: () => void;
}

/** Imperative handle on `<InkText ref>`. */
export interface InkTextHandle {
  /** The wrapper element. */
  readonly element: HTMLDivElement | null;
  /** The running engine, or null when animate is false. */
  readonly engine: InkTextEngine | null;
  /** Print the current text again from the start. */
  restart(): void;
}

export interface InkImageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * The picture. Empty while it is being generated; when it arrives it
   * prints. A different `src` later (or going back to empty) starts over.
   */
  src?: string | null;
  /** Show the generating dot grid while there is no `src`. @default true */
  generating?: boolean;
  /** Optional 0–1 progress of the generation: the grid fills in as it rises. */
  progress?: number;
  /**
   * How the picture is printed.
   * - `printhead`: a head prints a row at a time, left to right, top to bottom.
   * - `rain`: the same rows, with drops falling in as streaks.
   * - `fall`: the same rows, with drops falling from above in perspective.
   * - `passes`: the grid's dots grow into the picture, then a finer screen prints over it.
   * @default 'printhead'
   */
  look?: InkImageLook;
  /**
   * - `color`: one 45° screen of coloured dots, each averaging to the picture over the ground behind it.
   * - `process`: separate inks at their own angles, CMYK multiplied on light grounds, RGB added on dark ones.
   * @default 'color'
   */
  screen?: InkImageScreen;
  /** Pitch of the generating grid in CSS px; 0 picks one from the size. The picture prints at half of it. @default 0 */
  pitch?: number;
  /** Alt text for the image (also the element's accessible name). */
  alt?: string;
  /** Passed to the `<img>`, for cross-origin images served with CORS headers. */
  crossOrigin?: '' | 'anonymous' | 'use-credentials';
  /** Seed for the drops, so a print replays exactly. Read when a print starts. */
  seed?: number;
  /** Called when the real image is fully showing. */
  onShown?: () => void;
}

/** Imperative handle on `<InkImage ref>`. */
export interface InkImageHandle {
  /** The wrapper element. */
  readonly element: HTMLDivElement | null;
  /** The running engine (null once unmounted). */
  readonly engine: InkImageEngine | null;
  /** Start over on a clean sheet: the grid again, then the current `src`. */
  restart(): void;
}
