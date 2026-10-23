# inkjet-fx

Streaming text and images that print themselves in ink drops, for React. Each word of an AI reply is fired onto the page by a printhead, splashes, soaks in and dries into your real font. A generated image prints row by row, and the real picture follows the ink down.

Live playground: [libraries.dev/inkjet](https://libraries.dev/inkjet)

## Install

```bash
npm install inkjet-fx
```

`react` and `react-dom` (18 or newer) are peer dependencies. No other runtime dependencies; WebGL2 does the drawing.

### Local development

```bash
npm install
npm run dev          # local Vite playground
npm run build        # produce dist/ (ESM + CJS + .d.ts)
```

## Quick start

### Streaming text

```tsx
import { InkText } from 'inkjet-fx';

<InkText text={reply} streaming={isStreaming} look="printhead" thinking="caret" />
```

Append to `text` as tokens arrive. While `streaming` is true and `text` is still empty, the thinking state shows where the answer will start. When `streaming` turns false the last words dry, the canvas and its WebGL context go away, and the element is left holding plain text.

The words are real DOM text, laid out by your CSS in your font and colour. They are selectable and copyable, and screen readers read them. The drops are drawn on a canvas behind them, and each word is revealed in the real font once its ink has dried (a CSS custom highlight).

### Generated image

```tsx
import { InkImage } from 'inkjet-fx';

<InkImage
  src={imageUrl /* null while generating */}
  progress={progress}
  alt="A generated picture"
  style={{ width: 320, height: 320, borderRadius: 20 }}
/>
```

With no `src` it shows a fine dot grid that fills in while the image is being made. When `src` arrives the picture prints a row at a time, and the real `<img>` follows the ink down. A new `src` later, or going back to `null`, starts over on a clean sheet.

## `<InkText>` props

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `text` | `string` | required | The text so far. Appending prints the new chunk; a value that doesn't continue the previous one starts a fresh print. |
| `streaming` | `boolean` | `false` | More text is coming. With no text yet it shows the thinking state; turning false lets the last words dry. |
| `animate` | `boolean` | `true` | `false` renders plain text with no canvas: chat history, restored messages, server rendering. |
| `look` | `'printhead' \| 'rain' \| 'develop' \| 'fall'` | `'printhead'` | How the drops reach the paper. Printhead: a head sweeps each word, nozzles firing in dither order. Rain: drops fall onto the line as streaks. Develop: the word develops in place in Bayer passes. Fall: drops fall from above the page in perspective. A change applies from the next word. |
| `thinking` | `'caret' \| 'skeleton' \| 'word'` | `'caret'` | Before the first words. Caret: the head fizzes where the text will start. Skeleton: three halftone bars darken where the answer will go. Word: `thinkingWord` rains in, holds and dries off, again and again. |
| `thinkingWord` | `string` | `'Thinking'` | The word for `thinking="word"`. |
| `speed` | `number` | `80` | Characters per second the head prints at. It speeds up when the stream gets ahead of it. |
| `pitch` | `number` | `0` | Dot pitch in CSS px. `0` picks one from the font size. |
| `thresh` | `number` | `0` | Ink threshold. `0` matches the weight of the real text (measured per platform). |
| `rough` | `number` | `0.7` | How much the ink's edge wanders with the paper's fibres, 0–1. |
| `satellites` | `number` | `0.05` | Share of drops that throw a tiny satellite drop beside them, 0–1. |
| `seed` | `number` | random | Replays the same drops. Read when a print starts. |
| `onDone` | `() => void` | | The last word has dried and the element holds plain text. |

Any other HTML attribute (`className`, `style`, `id`, `aria-*`) goes to the wrapper `<div>`. Style the text there: font, size, line height, colour and width all come from your CSS. The ink takes the text's `color`, and fresh ink glows briefly when the text is light (on dark grounds).

The ref is an `InkTextHandle`: `element`, `engine` (the running `InkTextEngine`) and `restart()`.

## `<InkImage>` props

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `src` | `string \| null` | | The picture. Empty while it is generated; when it arrives it prints. |
| `generating` | `boolean` | `true` | Show the dot grid while there is no `src`. |
| `progress` | `number` | | Optional 0–1 progress: the grid fills in as it rises. Without it the grid fills in over a few seconds. |
| `look` | `'printhead' \| 'rain' \| 'fall' \| 'passes'` | `'printhead'` | Printhead: a head prints a row at a time, left to right, top to bottom. Rain and Fall: the same rows, with drops falling in as streaks or from above in perspective. Passes: the grid's dots grow into the picture, then a finer screen prints over it. |
| `screen` | `'color' \| 'process'` | `'color'` | Color: one 45° screen of coloured dots, each averaging to the picture over the ground behind it. Process: separate inks at their own angles, CMYK multiplied on light grounds, RGB added on dark ones. |
| `pitch` | `number` | `0` | Pitch of the generating grid in CSS px. `0` picks one from the size; the picture prints at half of it. |
| `alt` | `string` | `''` | Alt text for the image. |
| `crossOrigin` | `'' \| 'anonymous' \| 'use-credentials'` | | Passed to the `<img>`, for cross-origin images served with CORS headers. |
| `seed` | `number` | random | Replays the same drops. |
| `onShown` | `() => void` | | The real image is fully showing. |

Give the element a size (and corners) through `className` or `style`. The dots are coloured against the first opaque background behind it, and the generating grid uses the element's `color`.

The ref is an `InkImageHandle`: `element`, `engine` (the running `InkImageEngine`) and `restart()`.

## Recipes

Chat reply from a streaming API:

```tsx
function Reply({ reply, isStreaming }: { reply: string; isStreaming: boolean }) {
  return <InkText className="answer" text={reply} streaming={isStreaming} thinking="skeleton" />;
}
```

Messages from history, without the animation:

```tsx
{messages.map((m) => (
  <InkText key={m.id} text={m.content} animate={m.id === liveId} streaming={m.id === liveId && isStreaming} />
))}
```

Image generation with progress:

```tsx
<InkImage src={result?.url ?? null} progress={job.progress} look="passes" screen="process" style={{ width: 384, aspectRatio: '1', borderRadius: 16 }} />
```

### Without React

The engines work on any element:

```ts
import { InkTextEngine, InkImageEngine, printStream } from 'inkjet-fx';

const ink = new InkTextEngine(answerEl, { look: 'rain', thinking: 'word' });
ink.think();
for await (const chunk of stream) ink.write(chunk);
await ink.end(); // resolves once the text is plain

await printStream(answerEl, stream, { look: 'develop' }); // the same, in one call

const pic = new InkImageEngine(cardEl, { look: 'printhead' });
pic.think();
pic.progress(0.4);
await pic.show(url);
```

## Accessibility & performance

- The text is real text the whole time. The canvas is `aria-hidden`, and the wrapper has `aria-busy` while streaming.
- `prefers-reduced-motion: reduce`: every word shows as it arrives, and images fade in.
- Without WebGL2 the text shows plainly as it arrives and images fade in, with no errors.
- Text drops are drawn only in the band of the page where drops are still in play. Dry words are dropped from the buffer, so a long answer costs no more per frame than a short one. When the answer is done the canvas and its WebGL context are released.
- Each image is one canvas draw per frame. The canvas is released once the picture shows.
- Offscreen instances skip drawing (`IntersectionObserver`). Device pixel ratio is capped at 2.
- A cross-origin image without CORS headers can't be read back for its colours, so it fades in instead. Pass `crossOrigin="anonymous"` when the server sends CORS headers.

## Common mistakes

- **An `<InkImage>` with no size.** The wrapper has no intrinsic size; give it a width and height (or an aspect ratio).
- **Replacing `text` instead of appending to it.** A value that doesn't start with the previous one is treated as a new message and prints from the start.
- **Leaving `streaming` true after the stream ends.** The head keeps idling at the end of the text; set it to false so the last words dry.
- **Server rendering.** The components render an empty wrapper on the server and start in an effect. In the Next.js App Router, render them from a file that starts with `"use client"`.

## Credits

Made by [Alexandr Brinza](https://x.com/a_brinza) for [Libraries.dev](https://libraries.dev).

## License

MIT
