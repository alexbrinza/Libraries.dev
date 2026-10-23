import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { InkTextEngine } from './engine/ink-text';
import type { InkTextHandle, InkTextProps } from './types';

const fill = { display: 'block' } as const;

/**
 * Text that prints itself in ink drops as it streams in, then is plain text.
 *
 * The words are real DOM text in your font and colour (selectable, read by
 * screen readers). While `streaming` is true and `text` is empty it shows the
 * thinking state; each chunk appended to `text` prints as it arrives; once
 * `streaming` is false the last words dry and the canvas goes away.
 */
export const InkText = forwardRef<InkTextHandle, InkTextProps>(function InkText(
  {
    text,
    streaming = false,
    animate = true,
    look,
    thinking,
    thinkingWord,
    speed,
    pitch,
    thresh,
    rough,
    satellites,
    seed,
    onDone,
    ...rest
  },
  ref
) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<InkTextEngine | null>(null);
  const writtenRef = useRef('');
  const restoreRef = useRef('');
  const endingRef = useRef<InkTextEngine | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const optsRef = useRef({ look, thinking, thinkingWord, speed, pitch, thresh, rough, satellites, seed });
  optsRef.current = { look, thinking, thinkingWord, speed, pitch, thresh, rough, satellites, seed };
  // bumped to start over on a fresh engine (new text that doesn't continue the old)
  const [gen, setGen] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return outerRef.current;
      },
      get engine() {
        return engineRef.current;
      },
      restart() {
        restoreRef.current = '';
        setGen((g) => g + 1);
      }
    }),
    []
  );

  // one engine per generation; it owns the host's children
  // biome-ignore lint/correctness/useExhaustiveDependencies: gen is the trigger
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !animate) return;
    const engine = new InkTextEngine(host, optsRef.current);
    engineRef.current = engine;
    endingRef.current = null;
    writtenRef.current = '';
    if (restoreRef.current) {
      engine.restore(restoreRef.current);
      writtenRef.current = restoreRef.current;
      restoreRef.current = '';
    }
    return () => {
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [gen, animate]);

  // feed the stream
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !animate) return;
    const written = writtenRef.current;
    const ended = endingRef.current === engine;
    if (!text.startsWith(written) || (ended && text !== written)) {
      // a different text, or more after it was told to end: start over on a
      // fresh engine, keeping what is already on the page dry when the new
      // text continues it
      restoreRef.current = text.startsWith(written) ? written : '';
      setGen((g) => g + 1);
      return;
    }
    if (text.length > written.length) {
      engine.write(text.slice(written.length));
      writtenRef.current = text;
    }
    if (streaming) {
      if (!text) engine.think();
    } else if (text && !ended) {
      endingRef.current = engine;
      engine.end().then(() => {
        if (engineRef.current === engine || engineRef.current === null) onDoneRef.current?.();
      });
    }
  }, [text, streaming, animate, gen]);

  // live options: a new look applies from the next word
  useEffect(() => {
    engineRef.current?.set({ look, thinking, thinkingWord, speed, pitch, thresh, rough, satellites });
  }, [look, thinking, thinkingWord, speed, pitch, thresh, rough, satellites]);

  return (
    <div ref={outerRef} aria-busy={animate && streaming ? true : undefined} {...rest}>
      {animate ? <div key={`ink-${gen}`} ref={hostRef} style={fill} /> : <div style={{ ...fill, whiteSpace: 'pre-wrap' }}>{text}</div>}
    </div>
  );
});
