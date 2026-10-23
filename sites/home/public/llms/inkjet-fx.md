<!-- Inkjet (inkjet-fx). Live playground: https://libraries.dev/inkjet. npm: https://www.npmjs.com/package/inkjet-fx -->

# Inkjet

Streaming text and images that print themselves in ink drops: each word of an AI reply is fired onto the page by a printhead, soaks in and dries into the real font; a generated image prints row by row (npm `inkjet-fx`).

## When to use

- A chat or assistant reply that streams in token by token: `<InkText>` prints each word as it arrives and leaves plain text behind.
- The wait before the first token: the `thinking` states (a fizzing caret, halftone skeleton bars, or a word that rains in and dries off) hold the spot where the answer will start.
- Short generated copy that appears in place: titles, summaries, suggestions, a hero line written by the model.
- An image being generated: `<InkImage>` shows a fine dot grid that fills in (with real progress when you have it) and then prints the picture.

### When not to use

- Static body copy that is already there on load. Render it as text, or with `animate={false}`.
- Long documents or code blocks streamed in bulk. Code wants a monospace typewriter, not ink; very long outputs print faster than anyone reads.
- Many replies animating at once in a long thread. Animate only the live message, and render history with `animate={false}`.
- An image slot where img-fx is already in place. Both are image-generation loaders; pick one per product.
- Non-React stacks. The engines `InkTextEngine` and `InkImageEngine` do work on any element (see Recipes), but there is no custom-element wrapper.

## Install

```bash
npm install inkjet-fx
pnpm add inkjet-fx
yarn add inkjet-fx
```

```tsx
import { InkText, InkImage } from 'inkjet-fx';
```

- React component plus vanilla engines. Peer dependencies: `react` >= 18, `react-dom` >= 18. No other runtime dependencies.
- ESM and CJS builds with types (`dist/index.es.js`, `dist/index.cjs.js`, `dist/index.d.ts`).
- The bundle has no `"use client"` directive. In the Next.js App Router, render it from your own file that starts with `"use client"`.
- Everything GPU-side starts in an effect after mount; server rendering outputs only an empty wrapper `<div>`.

## Basic usage

Install & Usage tab on the detail page:

```tsx
import { InkText, InkImage } from 'inkjet-fx';

// a streamed reply: append to text as tokens arrive
<InkText text={reply} streaming={isStreaming} look="printhead" thinking="caret" />

// a generated image: src stays null while it is made
<InkImage src={imageUrl} style={{ width: 320, height: 320, borderRadius: 20 }} />
```

Snippet the playground builds from its controls (speed is only written when it is not 80):

```tsx
import { InkText } from 'inkjet-fx';

<InkText
  text={reply}
  streaming={isStreaming}
  look="rain"
  thinking="skeleton"
  speed={120}
/>
```

`<InkText>` renders a wrapper `<div>` holding real text. Style it as you would the reply: font, size, line height, colour and width all come from your CSS, and the ink takes the text's `color`. `<InkImage>` is the card itself: give it a size and corners.

## Options (free)

`<InkText>`:

| Prop | Values | Default | What it does |
| --- | --- | --- | --- |
| `text` | `string` | required | The reply so far. Appending prints the new chunk. A value that doesn't continue the previous one starts a fresh print. |
| `streaming` | `boolean` | `false` | More is coming. With no text yet it shows the thinking state. Turning false lets the last words dry, after which the element holds plain text. |
| `look` | `'printhead'` \| `'rain'` \| `'develop'` \| `'fall'` | `'printhead'` | How drops reach the paper. Printhead: a head sweeps each word. Rain: drops fall onto the line as streaks. Develop: the word develops in Bayer passes. 3D fall: drops fall from above the page in perspective. Changes apply from the next word. |
| `thinking` | `'caret'` \| `'skeleton'` \| `'word'` | `'caret'` | Before the first words. Caret: the head fizzes where the text will start. Skeleton: three halftone bars darken. Word: `thinkingWord` rains in and dries off on a loop. |
| `speed` | `20` to `200` (tuner: step 10) | `80` | Characters per second. The head speeds up by itself when the stream gets ahead. |
| `animate` | `boolean` | `true` | `false` renders plain text, with no canvas. |
| `thinkingWord` | `string` | `'Thinking'` | The word for `thinking="word"`. |
| `onDone` | `() => void` | | The last word has dried. |

`<InkImage>`:

| Prop | Values | Default | What it does |
| --- | --- | --- | --- |
| `src` | `string` \| `null` | | The picture. Leave it null while it generates; when it arrives it prints. A new `src`, or null again, starts over. |
| `progress` | `0` to `1` | | Optional generation progress: the grid fills in as it rises. |
| `look` | `'printhead'` \| `'rain'` \| `'fall'` \| `'passes'` | `'printhead'` | Printhead: rows printed left to right, top to bottom, with the real image following the ink down. Rain and 3D fall: the same rows, with falling drops. Passes: the grid's dots grow into the picture, then a finer screen prints over it. |
| `screen` | `'color'` \| `'process'` | `'color'` | Color: one 45° screen of coloured dots matched to the ground. Process: CMYK screens on light grounds, RGB on dark ones. |
| `alt` | `string` | `''` | Alt text for the image. |
| `generating` | `boolean` | `true` | Show the dot grid while `src` is empty. |
| `onShown` | `() => void` | | The real image is fully showing. |

Tuner to prop mapping:
- "Component": Text / Image picks `<InkText>` or `<InkImage>`.
- "Look": Printhead / Rain / Develop / 3D fall maps to `printhead` / `rain` / `develop` / `fall`. On Image it is Printhead / Rain / 3D fall / Passes.
- "Thinking": Caret / Skeleton / Word maps to the `thinking` values.
- "Speed" is `speed` in characters per second.
- "Screen": Color / Process maps to `screen`.
- "Ask again" and "Generate" only replay the demo stream; they are not props.

Advanced props, documented in the package README: `pitch` (dot pitch, CSS px), `thresh` (ink threshold), `rough` (fibre edge wander), `satellites` (satellite-drop share), `seed`, `crossOrigin` (on InkImage). Refs expose `element`, `engine` and `restart()`.

## Recipes

Streaming chat reply. Use when: the app keeps the reply in state and has a streaming flag (Vercel AI SDK `useChat`, a `fetch` stream reader, SSE).

```tsx
import { InkText } from 'inkjet-fx';

function AssistantMessage({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  return <InkText className="prose" text={content} streaming={isStreaming} thinking="skeleton" />;
}
```

A thread where only the live message animates:

```tsx
{messages.map((m) => (
  <InkText
    key={m.id}
    text={m.content}
    animate={m.id === liveId}
    streaming={m.id === liveId && status === 'streaming'}
  />
))}
```

Generated image with progress. Use when: an image request is in flight and the URL arrives later.

```tsx
import { InkImage } from 'inkjet-fx';

<InkImage
  src={result?.url ?? null}
  progress={job?.progress}
  alt={prompt}
  style={{ width: 384, aspectRatio: '1', borderRadius: 16 }}
/>
```

Regenerate: set `src` back to `null` when the user asks again, and set the new URL when it comes. The card clears, shows the grid, then prints the new picture.

Without React:

```ts
import { InkTextEngine, printStream } from 'inkjet-fx';

const ink = new InkTextEngine(answerEl, { look: 'printhead', thinking: 'caret' });
ink.think();
for await (const chunk of stream) ink.write(chunk);
await ink.end(); // resolves once the text is plain

await printStream(answerEl, stream); // the same in one call
```

## Accessibility & performance

- The text is real DOM text from the first token. Screen readers read it, and it can be selected and copied. The canvas is `aria-hidden`, and the wrapper carries `aria-busy` while streaming.
- `prefers-reduced-motion: reduce` is handled: each word shows as it arrives and images fade in. Nothing to wire.
- Without WebGL2 the text shows plainly and images fade in. No errors are thrown.
- Drops are drawn only in the band where they are still in play, and dry words leave the buffer, so long replies cost no more per frame than short ones. When a reply is done the canvas and its WebGL context are released.
- Offscreen instances skip drawing (`IntersectionObserver`). Device pixel ratio is capped at 2.
- Each live `<InkText>` or `<InkImage>` holds its own WebGL context while it animates. Keep one or two animating at once (the live message); render history with `animate={false}`.

## Common mistakes

- Replacing `text` with only the newest token. Pass the accumulated reply; each new value must start with the previous one or it reprints from the start.
- Leaving `streaming` true after the stream ends. The head idles at the end of the text; set it false so the last words dry.
- An `<InkImage>` without a size. Give it a width and height (or `aspectRatio`).
- Animating every message in a long thread. Use `animate={false}` for anything that isn't live.
- Cross-origin images without CORS headers. They can't be read back for their colours, so they fade in instead of printing. Serve them same-origin, or with CORS plus `crossOrigin="anonymous"`.
- Wrapping it in a container with `color: transparent` or text gradients. The ink colour is read from the text's `color`.

## Detecting a fit in a codebase

| Signal to grep for | Suggest |
| --- | --- |
| Streaming chat code: `useChat`, `streamText`, `messages.map`, `getReader()`, `EventSource`, `for await (const chunk`, `delta.content` | Wrap the assistant message body in `<InkText text={content} streaming={isStreaming} />`; `animate={false}` for history. |
| Copy like "Thinking…", "Generating…", "Typing…", typing-dot components (`TypingIndicator`, `<Dots`, `animate-bounce`) before a reply | Replace with `thinking="caret"` or `"skeleton"` on the reply's `<InkText>` (thinking orbs remain the pick for a standalone status chip). |
| Typewriter effects: `typewriter`, `useTypewriter`, `react-type-animation`, character-by-character `setInterval` | `<InkText>` with the full text and `streaming={false}`; it prints and finishes on its own. |
| Image generation results (`images.generate`, `gpt-image`, `fal.ai`, `replicate`, `flux`) with a skeleton or spinner | `<InkImage src={url ?? null} progress={progress} />` (or img-fx; offer them as alternatives). |
| AI-written titles or summaries that pop in (`generateTitle`, `summary` state set after a call) | `<InkText text={summary} />` once the text arrives. |

## Go further

Inkjet is free and has no Studio panel yet. Its engines (`InkTextEngine`, `InkImageEngine`) and their options are exported for custom setups. The look tables `TEXT_LOOKS`, `IMAGE_LOOKS` and `IMAGE_SCREENS` are exported too.
