import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { InkImageEngine } from './engine/ink-image';
import type { InkImageHandle, InkImageProps } from './types';

const host = { position: 'absolute', inset: 0, borderRadius: 'inherit', overflow: 'hidden' } as const;

/**
 * An image that prints itself in ink drops.
 *
 * With no `src` it shows a fine dot grid that fills in while the image is
 * generated (driven by `progress` when you have one). When `src` arrives the
 * picture prints row by row and the real `<img>` follows the ink down. Give
 * the element a size (and corners) through `className` or `style`.
 */
export const InkImage = forwardRef<InkImageHandle, InkImageProps>(function InkImage(
  { src, generating = true, progress, look, screen, pitch, alt, crossOrigin, seed, onShown, style, ...rest },
  ref
) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<InkImageEngine | null>(null);
  const givenRef = useRef<string | null>(null);
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  const optsRef = useRef({ look, screen, pitch, alt, crossOrigin, seed });
  optsRef.current = { look, screen, pitch, alt, crossOrigin, seed };
  // bumped for a fresh engine: a new picture after one was shown, or back to generating
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
        setGen((g) => g + 1);
      }
    }),
    []
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: gen is the trigger
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const engine = new InkImageEngine(el, optsRef.current);
    engineRef.current = engine;
    givenRef.current = null;
    return () => {
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [gen]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = src || null;
    if (givenRef.current !== null && next !== givenRef.current) {
      // the picture changed (or went back to generating): start on a clean sheet
      setGen((g) => g + 1);
      return;
    }
    if (next && givenRef.current === null) {
      givenRef.current = next;
      engine.show(next).then(() => {
        if (engineRef.current === engine) onShownRef.current?.();
      });
    } else if (!next && generating) engine.think();
  }, [src, generating, gen]);

  useEffect(() => {
    if (progress !== undefined) engineRef.current?.progress(progress);
  }, [progress, gen]);

  useEffect(() => {
    engineRef.current?.set({ look, screen, pitch, alt });
  }, [look, screen, pitch, alt]);

  return (
    <div ref={outerRef} aria-busy={!src && generating ? true : undefined} style={{ position: 'relative', ...style }} {...rest}>
      <div key={`ink-${gen}`} ref={hostRef} style={host} />
    </div>
  );
});
