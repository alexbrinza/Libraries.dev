import { useEffect, useRef, useState } from 'react';
import {
  IMAGE_LOOKS,
  IMAGE_SCREENS,
  InkImage,
  type InkImageLook,
  type InkImageScreen,
  InkText,
  type InkTextLook,
  type InkTextThinking,
  TEXT_THINKING
} from '../src';

const TEXT_LOOKS: InkTextLook[] = ['printhead', 'rain', 'develop', 'fall'];
const ANSWER =
  'A printhead slides across the page on a rail. Underneath it are hundreds of nozzles, each narrower than a hair, and each one can fire a single drop of ink on cue.\n\nAs the head moves, the printer decides which nozzles fire at every step. The drops land in a fine grid, and wherever enough of them sit side by side, you see a line, a curve, a letter.';
const IMAGES = ['/images/garden.jpg', '/images/tunnel.jpg'];

// roughly how a model streams: words with their leading space, long words in pieces
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\s*)(\S+)/g)) {
    let w = m[2];
    let first = true;
    while (w.length) {
      const n = w.length > 7 ? 3 + Math.floor(Math.random() * 4) : w.length;
      out.push((first ? m[1] : '') + w.slice(0, n));
      w = w.slice(n);
      first = false;
    }
  }
  return out;
}

function Tabs<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="pg-control" role="radiogroup" aria-label={label}>
      <span className="pg-control-label">{label}</span>
      <div className="pg-toggle-row">
        {options.map((o) => (
          <button type="button" key={o} className={`tab-btn${value === o ? ' active' : ''}`} onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Playground(): JSX.Element {
  const [kind, setKind] = useState<'text' | 'image'>('text');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [look, setLook] = useState<InkTextLook>('printhead');
  const [thinking, setThinking] = useState<InkTextThinking>('caret');
  const [imageLook, setImageLook] = useState<InkImageLook>('printhead');
  const [screen, setScreen] = useState<InkImageScreen>('color');
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const run = useRef(0);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const ask = async () => {
    const id = ++run.current;
    setText('');
    setStreaming(true);
    await new Promise((r) => setTimeout(r, 1600));
    let acc = '';
    for (const t of tokens(ANSWER)) {
      if (run.current !== id) return;
      acc += t;
      setText(acc);
      await new Promise((r) => setTimeout(r, 18 + Math.random() * 24));
    }
    setStreaming(false);
  };

  const generate = () => {
    const id = ++run.current;
    setSrc(null);
    setTimeout(() => {
      if (run.current === id) setSrc(IMAGES[id % IMAGES.length]);
    }, 2400);
  };

  return (
    <div className="pg-page">
      <div className="pg-header">
        <div className="pg-title">inkjet-fx playground</div>
      </div>
      <div className="pg-toolbar">
        <Tabs label="Component" value={kind} options={['text', 'image'] as const} onChange={setKind} />
        {kind === 'text' ? (
          <>
            <Tabs label="Look" value={look} options={TEXT_LOOKS} onChange={setLook} />
            <Tabs label="Thinking" value={thinking} options={TEXT_THINKING} onChange={setThinking} />
          </>
        ) : (
          <>
            <Tabs label="Look" value={imageLook} options={IMAGE_LOOKS} onChange={setImageLook} />
            <Tabs label="Screen" value={screen} options={IMAGE_SCREENS} onChange={setScreen} />
          </>
        )}
        <Tabs label="Theme" value={theme} options={['dark', 'light'] as const} onChange={setTheme} />
        <div className="pg-control">
          <span className="pg-control-label">Run</span>
          <button type="button" className="tab-btn active" onClick={kind === 'text' ? ask : generate}>
            {kind === 'text' ? 'Ask' : 'Generate'}
          </button>
        </div>
      </div>
      <div className="pg-preview">
        {kind === 'text' ? (
          <InkText
            text={text}
            streaming={streaming}
            look={look}
            thinking={thinking}
            style={{ width: 520, maxWidth: '100%', minHeight: 200, font: '400 16px/1.7 Inter, system-ui, sans-serif', color: 'var(--heading-fg)' }}
          />
        ) : (
          <InkImage src={src} look={imageLook} screen={screen} alt="A generated picture" style={{ width: 320, height: 320, borderRadius: 20, background: 'var(--surface)', color: 'var(--heading-fg)' }} />
        )}
      </div>
    </div>
  );
}
