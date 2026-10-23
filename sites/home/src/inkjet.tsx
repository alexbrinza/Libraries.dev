import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeBlock } from "./examples/CodeCopy";
import {
  InkImage,
  type InkImageLook,
  type InkImageScreen,
  InkText,
  type InkTextLook,
  type InkTextThinking,
} from "inkjet-fx";

/* Inkjet detail page — playground island (examples + stage + controls +
   live snippet). A stand-in model streams the answers so the text prints
   the way a real reply does: tokens of a few characters, small gaps, the
   odd pause. The examples loop on their own; the playground runs on Ask /
   Generate. */

const ANSWERS = [
  "A printhead slides across the page on a rail. Underneath it are hundreds of nozzles, each narrower than a hair, and each one can fire a single drop of ink on cue.",
  "At six hundred dots per inch each dot is about a twentieth of a millimetre across. The ink spreads a little into the paper, so neighbouring drops run together into one clean stroke.",
  "In a thermal head a tiny resistor heats the ink behind each nozzle for a few millionths of a second. The ink boils into a bubble, and the bubble pushes one droplet out.",
];
const QUESTIONS = ["How does an inkjet printer work?", "Why does printed text look smooth?", "What happens inside a nozzle?"];
const IMAGES = ["/images/gen-1.jpg", "/images/gen-2.jpg", "/images/gen-3.jpg"];

const TEXT_LOOKS: Array<{ value: InkTextLook; label: string }> = [
  { value: "printhead", label: "Printhead" },
  { value: "rain", label: "Rain" },
  { value: "develop", label: "Develop" },
  { value: "fall", label: "3D fall" },
];
const THINKING: Array<{ value: InkTextThinking; label: string }> = [
  { value: "caret", label: "Caret" },
  { value: "skeleton", label: "Skeleton" },
  { value: "word", label: "Word" },
];
const IMAGE_LOOKS: Array<{ value: InkImageLook; label: string }> = [
  { value: "printhead", label: "Printhead" },
  { value: "rain", label: "Rain" },
  { value: "fall", label: "3D fall" },
  { value: "passes", label: "Passes" },
];
const SCREENS: Array<{ value: InkImageScreen; label: string }> = [
  { value: "color", label: "Color" },
  { value: "process", label: "Process" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// roughly how a tokenizer cuts text: words with their leading space, long words in pieces
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\s*)(\S+)/g)) {
    let w = m[2];
    let first = true;
    while (w.length) {
      const n = w.length > 7 ? 3 + Math.floor(Math.random() * 4) : w.length;
      out.push((first ? m[1] : "") + w.slice(0, n));
      w = w.slice(n);
      first = false;
    }
  }
  return out;
}

/* Streams `answer` into state like a model would; `run` restarts it. */
function useFakeStream() {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const id = useRef(0);
  const run = async (answer: string, wait = 1500) => {
    const me = ++id.current;
    setText("");
    setStreaming(true);
    await sleep(wait);
    let acc = "";
    for (const t of tokens(answer)) {
      if (id.current !== me) return;
      acc += t;
      setText(acc);
      await sleep(Math.random() < 0.04 ? 380 : 18 + Math.random() * 22);
    }
    if (id.current === me) setStreaming(false);
  };
  useEffect(() => () => void ++id.current, []);
  return { text, streaming, run };
}

/* An answer that asks, streams, holds, and asks the next question. */
function LoopingAnswer({ look, thinking, start = 0 }: { look: InkTextLook; thinking: InkTextThinking; start?: number }) {
  const { text, streaming, run } = useFakeStream();
  const [k, setK] = useState(start);
  useEffect(() => {
    run(ANSWERS[k % ANSWERS.length], 1800);
  }, [k]);
  return (
    <div className="ink-chat">
      <div className="ink-q">{QUESTIONS[k % QUESTIONS.length]}</div>
      <InkText
        className="ink-answer"
        text={text}
        streaming={streaming}
        look={look}
        thinking={thinking}
        onDone={() => setTimeout(() => setK((v) => v + 1), 3200)}
      />
    </div>
  );
}

/* A card that generates, prints, holds, and generates the next picture. */
function LoopingImage({ look, screen, className }: { look: InkImageLook; screen: InkImageScreen; className: string }) {
  const [k, setK] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    const t = setTimeout(() => setSrc(IMAGES[k % IMAGES.length]), 2600);
    return () => clearTimeout(t);
  }, [k]);
  return (
    <InkImage
      className={className}
      src={src}
      look={look}
      screen={screen}
      alt="A generated picture"
      onShown={() => setTimeout(() => setK((v) => v + 1), 3000)}
    />
  );
}

function Slider({
  min,
  max,
  step,
  value,
  onChange,
  format,
  ariaLabel,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  ariaLabel: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="pg-vslider">
      <div className="pg-vslider-fill" style={{ width: `${pct}%` }} />
      <span className="pg-vslider-label">{ariaLabel}</span>
      <span className="pg-vslider-value">{format(value)}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
      />
    </div>
  );
}

function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="pg-field" role="radiogroup" aria-label={label}>
      <span className="pg-label">{label}</span>
      <div className="pg-tabs">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="pg-tab"
            role="radio"
            aria-checked={value === o.value}
            data-active={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function textSnippet(look: InkTextLook, thinking: InkTextThinking, speed: number): string {
  const lines = ["import { InkText } from 'inkjet-fx';", "", "<InkText", "  text={reply}", "  streaming={isStreaming}", `  look="${look}"`, `  thinking="${thinking}"`];
  if (speed !== 80) lines.push(`  speed={${speed}}`);
  lines.push("/>");
  return lines.join("\n");
}

function imageSnippet(look: InkImageLook, screen: InkImageScreen): string {
  return [
    "import { InkImage } from 'inkjet-fx';",
    "",
    "<InkImage",
    "  src={imageUrl} // null while generating",
    `  look="${look}"`,
    `  screen="${screen}"`,
    "  style={{ width: 280, height: 280, borderRadius: 20 }}",
    "/>",
  ].join("\n");
}

function InkjetPlayground() {
  const [kind, setKind] = useState<"text" | "image">("text");
  const [look, setLook] = useState<InkTextLook>("printhead");
  const [thinking, setThinking] = useState<InkTextThinking>("caret");
  const [speed, setSpeed] = useState(80);
  const [imageLook, setImageLook] = useState<InkImageLook>("printhead");
  const [screen, setScreen] = useState<InkImageScreen>("color");
  const [q, setQ] = useState(0);
  const { text, streaming, run } = useFakeStream();
  const [src, setSrc] = useState<string | null>(IMAGES[0]);
  const [generating, setGenerating] = useState(false);
  const gen = useRef(0);

  const ask = () => {
    const next = q + 1;
    setQ(next);
    run(ANSWERS[next % ANSWERS.length]);
  };

  const generate = async () => {
    const me = ++gen.current;
    setGenerating(true);
    setSrc(null);
    await sleep(2400);
    if (gen.current !== me) return;
    setSrc(IMAGES[me % IMAGES.length]);
    setGenerating(false);
  };

  // first visit: one answer prints on its own
  useEffect(() => {
    run(ANSWERS[0], 900);
  }, []);

  const snippet = kind === "text" ? textSnippet(look, thinking, speed) : imageSnippet(imageLook, screen);

  return (
    <>
      <div className="detail-examples">
        <div className="example-row-full">
          <LoopingAnswer look="printhead" thinking="caret" />
        </div>
        <div className="example-row-split">
          <div className="example-cell">
            <LoopingImage className="ex-image-card ex-image-card--sm ink-image-card" look="printhead" screen="color" />
          </div>
          <div className="example-cell">
            <LoopingAnswer look="rain" thinking="skeleton" start={1} />
          </div>
        </div>
      </div>

      <p className="detail-playground-label">Playground</p>

      <div className="pg">
        <div className="pg-stage">
          {kind === "text" ? (
            <div className="ink-chat ink-chat--stage">
              <div className="ink-q">{QUESTIONS[q % QUESTIONS.length]}</div>
              <InkText className="ink-answer" text={text} streaming={streaming} look={look} thinking={thinking} speed={speed} />
            </div>
          ) : (
            <InkImage
              className="ink-image-card"
              src={src}
              look={imageLook}
              screen={screen}
              alt="A generated picture"
              style={{ width: 280, height: 280, borderRadius: 20 }}
            />
          )}

          <div className="pg-toolbar">
            <button type="button" className="btn-animate" onClick={kind === "text" ? ask : generate} disabled={kind === "text" ? streaming : generating}>
              {kind === "text" ? "Ask again" : "Generate"}
            </button>
          </div>
        </div>

        <div className="pg-controls">
          <Tabs
            label="Component"
            value={kind}
            options={[
              { value: "text", label: "Text" },
              { value: "image", label: "Image" },
            ]}
            onChange={setKind}
          />
          {kind === "text" ? (
            <>
              <Tabs label="Look" value={look} options={TEXT_LOOKS} onChange={setLook} />
              <Tabs label="Thinking" value={thinking} options={THINKING} onChange={setThinking} />
              <div className="pg-field">
                <Slider min={20} max={200} step={10} value={speed} onChange={setSpeed} format={(v) => `${v} cps`} ariaLabel="Speed" />
              </div>
            </>
          ) : (
            <>
              <Tabs label="Look" value={imageLook} options={IMAGE_LOOKS} onChange={setImageLook} />
              <Tabs label="Screen" value={screen} options={SCREENS} onChange={setScreen} />
            </>
          )}
        </div>
      </div>

      <CodeBlock code={snippet} label="Copy playground snippet" className="pg-snippet" />
    </>
  );
}

const el = document.getElementById("playground-root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <InkjetPlayground />
    </StrictMode>
  );
}
