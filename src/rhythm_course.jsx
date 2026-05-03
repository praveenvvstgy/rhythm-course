import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Play, Pause, RotateCcw, ChevronLeft, ChevronRight, Menu, X } from "lucide-react";

// ============================================================================
// AUDIO ENGINE
// A small Web Audio wrapper that handles a metronome-style scheduler and tone
// playback. Built from scratch — no external libs — so we can synthesize
// clicks and notes precisely on the beat.
// ============================================================================

function useAudio() {
  const ctxRef = useRef(null);
  // Track every scheduled oscillator so we can cancel them on stop.
  // Each entry: { osc, gain, end } where `end` is audioCtx time when the node finishes.
  const activeRef = useRef([]);

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new AC();
    }
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  // Helper: register a node and prune finished ones to keep the list small.
  const register = (osc, gain, end) => {
    const ctx = ctxRef.current;
    activeRef.current.push({ osc, gain, end });
    // Prune anything that's already finished so the array doesn't grow forever.
    if (activeRef.current.length > 64) {
      const t = ctx.currentTime;
      activeRef.current = activeRef.current.filter((n) => n.end > t - 0.1);
    }
  };

  // Cancel any scheduled audio whose start hasn't come yet, and silence anything
  // currently playing. Called from the transport when the user hits Stop.
  const cancelScheduled = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const { osc, gain } of activeRef.current) {
      try {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
        osc.stop(t + 0.03);
      } catch {
        // osc may already have stopped — ignore.
      }
    }
    activeRef.current = [];
  }, []);

  // Click sound — short percussive blip. `accent` makes it brighter (for beat 1).
  const click = useCallback((when, accent = false) => {
    const ctx = ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.4 : 0.25, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
    register(osc, gain, when + 0.06);
  }, [ensureCtx]);

  // Voice click — softer click for "and"s and subdivisions
  const tick = useCallback((when, freq = 700, vol = 0.15) => {
    const ctx = ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(vol, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.05);
    register(osc, gain, when + 0.05);
  }, [ensureCtx]);

  // A pitched note — used to play melody examples.
  // freq in Hz, when is start time, dur is duration in seconds.
  const note = useCallback((freq, when, dur, vol = 0.2) => {
    const ctx = ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(vol, when + 0.01);
    gain.gain.setValueAtTime(vol, when + Math.max(dur - 0.05, 0.01));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.02);
    register(osc, gain, when + dur + 0.02);
  }, [ensureCtx]);

  const now = useCallback(() => ensureCtx().currentTime, [ensureCtx]);

  // Memoise the returned object so its reference is stable across renders.
  // Without this, every render produces a new wrapper object, which makes
  // every callback in useTransport (stop, start, etc.) recreate, which makes
  // any effect that depends on them tear down and re-run on every render —
  // including the unmount cleanup that calls stop(), which would silently
  // halt the transport every time React re-renders for any reason.
  return useMemo(
    () => ({ click, tick, note, now, ensureCtx, cancelScheduled }),
    [click, tick, note, now, ensureCtx, cancelScheduled]
  );
}

// MIDI -> frequency, using A4 = 440. Most lessons use simple diatonic melodies.
const noteFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Named pitches for clarity
const PITCH = {
  C4: 60, D4: 62, E4: 64, F4: 65, G4: 67, A4: 69, B4: 71,
  C5: 72, D5: 74, E5: 76, F5: 77, G5: 79,
};

// ============================================================================
// SCHEDULER HOOK
// Drives an animation against a tempo. `onTick` fires every `subdivision`th
// of a beat (e.g. 4 = sixteenth notes). Returns transport state and controls.
// ============================================================================

function useTransport({ bpm = 80, subdivision = 1, totalSubdivisions = Infinity, onTick }) {
  const audio = useAudio();
  const [playing, setPlaying] = useState(false);
  // `position` is a CONTINUOUS float subdivision index, updated every animation
  // frame from the audio clock. This makes the playhead glide smoothly with
  // the audio instead of stepping in discrete chunks.
  const [position, setPosition] = useState(0);
  // Anchor-based timing lets us change tempo mid-play without skipping or
  // jumping the playhead. anchor: { audioTime, subIdx } is the fixed point;
  // current position = anchor.subIdx + (now - anchor.audioTime) / currentSubDur.
  // When tempo changes, we re-anchor at "now" so existing position is preserved.
  const stateRef = useRef({
    anchorTime: 0,       // audioCtx time of anchor
    anchorSub: 0,        // subdivision index at anchor
    nextSched: 0,        // index of next subdivision to schedule
    nextSchedTime: 0,    // audio time when nextSched should fire
    running: false,
  });
  const rafRef = useRef(null);
  // Hold the latest tick callback and timing params in refs so the running
  // loop reads the live values (no stale closures, no ref-during-render).
  const onTickRef = useRef(onTick);
  const bpmRef = useRef(bpm);
  const subdivisionRef = useRef(subdivision);
  const totalSubsRef = useRef(totalSubdivisions);

  useEffect(() => { onTickRef.current = onTick; }, [onTick]);
  useEffect(() => { subdivisionRef.current = subdivision; }, [subdivision]);
  useEffect(() => { totalSubsRef.current = totalSubdivisions; }, [totalSubdivisions]);

  // When BPM changes mid-play, re-anchor so position progresses smoothly with the new tempo.
  useEffect(() => {
    const oldBpm = bpmRef.current;
    bpmRef.current = bpm;
    const s = stateRef.current;
    if (!s.running || oldBpm === bpm) return;
    const t = audio.now();
    const oldSubDur = 60 / oldBpm / subdivisionRef.current;
    const elapsed = Math.max(0, t - s.anchorTime);
    const currentSub = s.anchorSub + elapsed / oldSubDur;
    s.anchorTime = t;
    s.anchorSub = currentSub;
    // Recompute when the next un-scheduled subdivision should fire under the new tempo.
    const newSubDur = 60 / bpm / subdivisionRef.current;
    s.nextSchedTime = t + (s.nextSched - currentSub) * newSubDur;
  }, [bpm, audio]);

  const stop = useCallback(() => {
    stateRef.current.running = false;
    setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    audio.cancelScheduled();
  }, [audio]);

  const reset = useCallback(() => {
    stop();
    setPosition(0);
    stateRef.current.anchorSub = 0;
    stateRef.current.nextSched = 0;
  }, [stop]);

  const start = useCallback(() => {
    audio.ensureCtx();
    const lookAhead = 0.12;
    const startTime = audio.now() + 0.08;
    const s = stateRef.current;
    s.anchorTime = startTime;
    s.anchorSub = 0;
    s.nextSched = 0;
    s.nextSchedTime = startTime;
    s.running = true;
    setPosition(0);
    setPlaying(true);

    const loop = () => {
      if (!stateRef.current.running) return;
      const t = audio.now();
      const subDur = 60 / bpmRef.current / subdivisionRef.current;
      const totalSubs = totalSubsRef.current;

      // 1. Schedule any subdivisions whose time falls within the lookahead window.
      while (
        s.nextSched < totalSubs &&
        s.nextSchedTime < t + lookAhead
      ) {
        if (onTickRef.current) onTickRef.current(s.nextSched, s.nextSchedTime, audio);
        s.nextSched += 1;
        s.nextSchedTime += subDur;
      }

      // 2. Update the visual position from the audio clock.
      const elapsed = Math.max(0, t - s.anchorTime);
      const continuousPos = s.anchorSub + elapsed / subDur;

      if (totalSubs !== Infinity && continuousPos >= totalSubs) {
        setPosition(totalSubs);
        const tailMs = 250;
        setTimeout(() => {
          if (stateRef.current.running) {
            stateRef.current.running = false;
            setPlaying(false);
          }
        }, tailMs);
        return;
      }

      setPosition(continuousPos);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [audio]);

  // Unmount cleanup. Inlined (rather than calling `stop`) so this effect's
  // deps stay empty and it only runs on mount/unmount.
  useEffect(() => () => {
    stateRef.current.running = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  return { playing, position, start, stop, reset, audio };
}

// ============================================================================
// NOTATION PRIMITIVES (SVG)
// We draw notes from scratch using SVG so they look right on every device.
// All shapes use a single `unit` value so they scale uniformly.
// ============================================================================

// A notehead is an oval tilted ~20deg. Filled = quarter or shorter; hollow = half/whole.
function Notehead({ x, y, filled = true, unit = 10 }) {
  const rx = unit * 0.7;
  const ry = unit * 0.55;
  return (
    <g transform={`translate(${x},${y}) rotate(-20)`}>
      <ellipse
        cx={0} cy={0} rx={rx} ry={ry}
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : unit * 0.18}
      />
    </g>
  );
}

function Stem({ x, y, up = true, unit = 10, length = 3.5 }) {
  // y is the notehead center. Stem goes up or down from the side of the head.
  const dx = up ? unit * 0.65 : -unit * 0.65;
  const dy = up ? -unit * length : unit * length;
  return (
    <line
      x1={x + dx} y1={y - (up ? 0 : 0)}
      x2={x + dx} y2={y + dy}
      stroke="currentColor" strokeWidth={unit * 0.16}
    />
  );
}

// Flag (the curly tail on an eighth+). Count = how many flags.
function Flag({ x, y, up = true, unit = 10, count = 1, stemLen = 3.5 }) {
  const dx = up ? unit * 0.65 : -unit * 0.65;
  const tipY = y + (up ? -unit * stemLen : unit * stemLen);
  const flags = [];
  for (let i = 0; i < count; i++) {
    const offset = i * unit * 0.85 * (up ? 1 : -1);
    flags.push(
      <path
        key={i}
        d={
          up
            ? `M ${x + dx} ${tipY + offset} q ${unit * 1.5} ${unit * 0.6} ${unit * 1.3} ${unit * 1.8}`
            : `M ${x + dx} ${tipY + offset} q ${unit * 1.5} ${-unit * 0.6} ${unit * 1.3} ${-unit * 1.8}`
        }
        fill="none"
        stroke="currentColor"
        strokeWidth={unit * 0.22}
        strokeLinecap="round"
      />
    );
  }
  return <g>{flags}</g>;
}

function AugmentationDot({ x, y, unit = 10 }) {
  return <circle cx={x + unit * 1.2} cy={y} r={unit * 0.22} fill="currentColor" />;
}

// Ledger lines for notes that sit above or below the 5-line staff.
// `staffY` is the middle-line Y. The staff spans from staffY-2u (top line)
// to staffY+2u (bottom line). We add short horizontal lines every `unit`
// past those boundaries, on whole-step positions only.
function LedgerLines({ x, y, staffY, unit = 10 }) {
  const lines = [];
  const halfWidth = unit * 1.0;
  // Below the staff: positions staffY+3u, staffY+4u, ...
  if (y > staffY + unit * 2) {
    for (let ly = staffY + unit * 3; ly <= y + unit * 0.4; ly += unit) {
      lines.push(<line key={`b${ly}`} x1={x - halfWidth} x2={x + halfWidth} y1={ly} y2={ly} stroke="currentColor" strokeWidth={unit * 0.16} />);
    }
  }
  // Above the staff: positions staffY-3u, staffY-4u, ...
  if (y < staffY - unit * 2) {
    for (let ly = staffY - unit * 3; ly >= y - unit * 0.4; ly -= unit) {
      lines.push(<line key={`a${ly}`} x1={x - halfWidth} x2={x + halfWidth} y1={ly} y2={ly} stroke="currentColor" strokeWidth={unit * 0.16} />);
    }
  }
  return <g>{lines}</g>;
}

// A complete note. Type: 'whole', 'half', 'quarter', 'eighth', 'sixteenth'.
// Pass `staffY` (middle-line y) to draw ledger lines automatically when the
// note sits outside the 5-line staff.
function Note({ x, y, type = "quarter", dotted = false, stemUp = true, staccato = false, unit = 10, label = null, staffY = null }) {
  const filled = type !== "whole" && type !== "half";
  const hasStem = type !== "whole";
  const flagCount = type === "eighth" ? 1 : type === "sixteenth" ? 2 : 0;
  const stemLen = 3.5;

  return (
    <g>
      {staffY !== null && <LedgerLines x={x} y={y} staffY={staffY} unit={unit} />}
      <Notehead x={x} y={y} filled={filled} unit={unit} />
      {hasStem && <Stem x={x} y={y} up={stemUp} unit={unit} length={stemLen} />}
      {flagCount > 0 && <Flag x={x} y={y} up={stemUp} unit={unit} count={flagCount} stemLen={stemLen} />}
      {dotted && <AugmentationDot x={x} y={y} unit={unit} />}
      {staccato && (
        <circle cx={x} cy={y + (stemUp ? unit * 2.2 : -unit * 2.2)} r={unit * 0.22} fill="currentColor" />
      )}
      {label && (
        <text x={x} y={y + unit * 5.2} textAnchor="middle" fontSize={unit * 1.4} fill="currentColor" fontFamily="ui-serif, Georgia, serif" fontStyle="italic">
          {label}
        </text>
      )}
    </g>
  );
}

// Rests
function Rest({ x, y, type = "quarter", unit = 10 }) {
  // y is the staff center line.
  const u = unit;
  if (type === "whole") {
    // Rectangle hanging from the 4th line (one above center).
    return <rect x={x - u * 0.7} y={y - u * 1.0} width={u * 1.4} height={u * 0.5} fill="currentColor" />;
  }
  if (type === "half") {
    // Rectangle sitting on the middle line.
    return <rect x={x - u * 0.7} y={y - u * 0.5} width={u * 1.4} height={u * 0.5} fill="currentColor" />;
  }
  if (type === "quarter") {
    // Squiggle approximation
    return (
      <path
        d={`
          M ${x - u * 0.5} ${y - u * 1.8}
          Q ${x + u * 0.5} ${y - u * 0.8}, ${x - u * 0.3} ${y + u * 0.2}
          Q ${x - u * 0.9} ${y + u * 1.0}, ${x + u * 0.3} ${y + u * 1.6}
          Q ${x - u * 0.6} ${y + u * 1.2}, ${x + u * 0.1} ${y + u * 2.4}
        `}
        fill="none" stroke="currentColor" strokeWidth={u * 0.28} strokeLinecap="round" strokeLinejoin="round"
      />
    );
  }
  if (type === "eighth") {
    return (
      <g>
        <line x1={x + u * 0.6} y1={y - u * 1.5} x2={x - u * 0.4} y2={y + u * 1.6} stroke="currentColor" strokeWidth={u * 0.18} />
        <circle cx={x + u * 0.55} cy={y - u * 1.3} r={u * 0.32} fill="currentColor" />
        <path d={`M ${x + u * 0.55} ${y - u * 1.3} Q ${x + u * 1.4} ${y - u * 0.8} ${x + u * 0.9} ${y + u * 0.2}`} fill="none" stroke="currentColor" strokeWidth={u * 0.22} strokeLinecap="round" />
      </g>
    );
  }
  if (type === "sixteenth") {
    return (
      <g>
        <line x1={x + u * 0.7} y1={y - u * 1.6} x2={x - u * 0.5} y2={y + u * 1.8} stroke="currentColor" strokeWidth={u * 0.18} />
        <circle cx={x + u * 0.6} cy={y - u * 1.4} r={u * 0.3} fill="currentColor" />
        <path d={`M ${x + u * 0.6} ${y - u * 1.4} Q ${x + u * 1.4} ${y - u * 0.9} ${x + u * 0.95} ${y + u * 0.0}`} fill="none" stroke="currentColor" strokeWidth={u * 0.2} strokeLinecap="round" />
        <circle cx={x + u * 0.35} cy={y - u * 0.4} r={u * 0.28} fill="currentColor" />
        <path d={`M ${x + u * 0.35} ${y - u * 0.4} Q ${x + u * 1.15} ${y + u * 0.1} ${x + u * 0.7} ${y + u * 1.0}`} fill="none" stroke="currentColor" strokeWidth={u * 0.2} strokeLinecap="round" />
      </g>
    );
  }
  return null;
}

// Staff = 5 horizontal lines.
function Staff({ x, y, width, unit = 10 }) {
  const lines = [];
  for (let i = 0; i < 5; i++) {
    const ly = y - unit * 2 + i * unit;
    lines.push(<line key={i} x1={x} y1={ly} x2={x + width} y2={ly} stroke="currentColor" strokeWidth={1} />);
  }
  return <g>{lines}</g>;
}

// A simple treble clef using a stylized 'G'. Real glyphs are complex; this reads as one.
function TrebleClef({ x, y, unit = 10 }) {
  // y is the middle line. Treble clef wraps around the G line (2nd from bottom).
  const cx = x;
  const cy = y;
  const u = unit;
  return (
    <g transform={`translate(${cx},${cy})`} fill="none" stroke="currentColor" strokeWidth={u * 0.35} strokeLinecap="round" strokeLinejoin="round">
      <path d={`
        M 0 ${u * 4}
        C ${u * 2} ${u * 3.5}, ${u * 2} ${u * 1}, ${u * 0} ${u * 0.5}
        C ${-u * 2.5} ${u * 0}, ${-u * 2.5} ${-u * 3}, ${u * 0.5} ${-u * 3.5}
        C ${u * 3} ${-u * 3.7}, ${u * 2.5} ${-u * 0.5}, ${u * 0} ${u * 0}
        C ${-u * 1.5} ${u * 0.3}, ${-u * 1.7} ${u * 2}, ${u * 0} ${u * 2.5}
        C ${u * 1.5} ${u * 3}, ${u * 1.5} ${u * 4.5}, ${u * 0} ${u * 5}
      `} />
      <circle cx={u * 0} cy={u * 5} r={u * 0.5} fill="currentColor" stroke="none" />
    </g>
  );
}

// Time signature (two stacked numbers)
function TimeSignature({ x, y, top, bottom, unit = 10 }) {
  return (
    <g fontFamily="ui-serif, Georgia, serif" fontWeight="900" fill="currentColor" textAnchor="middle">
      <text x={x} y={y - unit * 0.2} fontSize={unit * 2.6}>{top}</text>
      <text x={x} y={y + unit * 2.2} fontSize={unit * 2.6}>{bottom}</text>
    </g>
  );
}

// Bar line
function BarLine({ x, y, unit = 10, thick = false }) {
  return <line x1={x} y1={y - unit * 2} x2={x} y2={y + unit * 2} stroke="currentColor" strokeWidth={thick ? unit * 0.4 : 1} />;
}

// ============================================================================
// SHARED UI BITS
// ============================================================================

function Button({ onClick, children, primary = false, small = false, disabled = false, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`
        inline-flex items-center gap-2 font-medium tracking-wide transition-all
        ${small ? "px-3 py-1.5 text-sm" : "px-5 py-2.5 text-base"}
        ${primary
          ? "bg-stone-900 text-amber-50 hover:bg-stone-800 disabled:bg-stone-400"
          : "bg-amber-50 text-stone-900 border border-stone-300 hover:border-stone-900 hover:bg-amber-100 disabled:opacity-50"}
        ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
      `}
      style={{ borderRadius: "2px" }}
    >
      {children}
    </button>
  );
}

function Slider({ label, value, onChange, min, max, step = 1, suffix = "" }) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-stone-700 min-w-[72px]">{label}</label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-stone-900"
      />
      <span className="text-sm text-stone-700 tabular-nums min-w-[60px] text-right font-mono">
        {value}{suffix}
      </span>
    </div>
  );
}

function Caption({ children }) {
  return <p className="text-sm text-stone-600 italic mt-3 leading-relaxed">{children}</p>;
}

function Insight({ children }) {
  return (
    <div className="border-l-2 border-stone-900 pl-4 py-2 my-4 bg-amber-50/50">
      <p className="text-stone-800 text-base leading-relaxed">{children}</p>
    </div>
  );
}

// ============================================================================
// YOUTUBE EMBED
// Lazy-loaded: shows a thumbnail until clicked, then swaps in the iframe with
// autoplay. Saves bandwidth and avoids loading dozens of YouTube players up
// front (this course references ~25 videos).
// ============================================================================

function YouTubeEmbed({ id, title = "", caption = "", start = 0 }) {
  const [loaded, setLoaded] = useState(false);
  const src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ""}`;
  const thumb = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  return (
    <figure className="my-4">
      <div className="relative w-full bg-stone-900 overflow-hidden border border-stone-900" style={{ aspectRatio: "16 / 9", borderRadius: "2px" }}>
        {loaded ? (
          <iframe
            src={src}
            title={title || "YouTube video"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
            style={{ border: 0 }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setLoaded(true)}
            className="absolute inset-0 w-full h-full group"
            aria-label={`Play video: ${title || id}`}
          >
            <img
              src={thumb}
              alt={title || "YouTube video thumbnail"}
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-100 transition"
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="bg-red-700 text-amber-50 rounded-full w-16 h-16 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                <Play size={28} fill="currentColor" className="ml-1" />
              </div>
            </div>
            {title && (
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-stone-900/80 to-transparent text-amber-50 text-sm p-3 text-left">
                {title}
              </div>
            )}
          </button>
        )}
      </div>
      {caption && <figcaption className="text-sm text-stone-600 italic mt-2 leading-relaxed">{caption}</figcaption>}
    </figure>
  );
}

// A grid of video clips — used for "listen" sections that present several
// example tracks side-by-side.
function VideoGrid({ videos }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-4">
      {videos.map((v) => (
        <YouTubeEmbed key={v.id} id={v.id} title={v.title} caption={v.caption} start={v.start} />
      ))}
    </div>
  );
}

// Simple localStorage wrapper that swallows errors (e.g. private browsing).
const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
  },
};

// ============================================================================
// MAIN APP
// ============================================================================

const LESSONS = [
  { id: 1, title: "Beats, bars & BPM", subtitle: "What is a beat? How fast?" },
  { id: 2, title: "Notes", subtitle: "Heavier = half as long" },
  { id: 3, title: "Counting beats in bars", subtitle: "Three rules to read by" },
  { id: 4, title: "Dotted notes", subtitle: "A dot adds half" },
  { id: 5, title: "Counting offbeats", subtitle: "1 and 2 and 3 and 4 and" },
  { id: 6, title: "Playing with a metronome", subtitle: "Seven steps to in-time" },
  { id: 7, title: "Counting ¼-beats", subtitle: "1 e and a 2 e and a" },
  { id: 8, title: "Dotted rhythms", subtitle: "Split the beat in 4, not 3" },
  { id: 9, title: "Rests", subtitle: "Symbols for silence" },
  { id: 10, title: "Staccato notes", subtitle: "Half the length, half the silence" },
  { id: 11, title: "Counting ⅛-beats", subtitle: "Faster subdivisions" },
  { id: 12, title: "Time signatures", subtitle: "3/4 vs 6/8 — and why it matters" },
];

// Read the persisted current lesson once during initial render so we never
// call setState inside an effect (which causes a cascading render).
function loadCurrentLesson() {
  const saved = storage.get("rhythm_course_current");
  if (!saved) return 1;
  const n = Number(saved);
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : 1;
}

export default function RhythmCourse() {
  const [current, setCurrent] = useState(loadCurrentLesson);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    storage.set("rhythm_course_current", current);
  }, [current]);

  const lesson = LESSONS.find((l) => l.id === current);

  return (
    <div className="min-h-screen bg-amber-50/40 text-stone-900" style={{ fontFamily: "'EB Garamond', 'Cormorant Garamond', Georgia, serif" }}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,700;1,400&family=JetBrains+Mono:wght@400;600&family=Playfair+Display:wght@700;900&display=swap" rel="stylesheet" />

      <style>{`
        body { background: #faf6ec; }
        .display-font { font-family: 'Playfair Display', 'EB Garamond', Georgia, serif; }
        .mono-font { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        .grain {
          background-image: radial-gradient(rgba(120,90,40,0.05) 1px, transparent 1px);
          background-size: 4px 4px;
        }
      `}</style>

      {/* Header */}
      <header className="border-b border-stone-300 bg-amber-50/60 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => setNavOpen(!navOpen)} className="md:hidden p-2">
              {navOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <div>
              <h1 className="display-font text-xl sm:text-2xl font-black tracking-tight leading-none">
                Reading Rhythm
              </h1>
              <p className="text-xs text-stone-600 italic mt-0.5">A 12-part course, animated</p>
            </div>
          </div>
          <div className="text-sm text-stone-700 mono-font">
            {String(current).padStart(2, "0")} / 12
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto flex flex-col md:flex-row">
        {/* Sidebar */}
        <aside className={`
          ${navOpen ? "block" : "hidden"} md:block
          md:w-64 md:flex-shrink-0 border-r border-stone-300
          md:sticky md:top-[73px] md:self-start md:max-h-[calc(100vh-73px)] md:overflow-y-auto
          bg-amber-50/30
        `}>
          <nav className="p-4 space-y-1">
            {LESSONS.map((l) => (
              <button
                key={l.id}
                onClick={() => { setCurrent(l.id); setNavOpen(false); }}
                className={`
                  w-full text-left px-3 py-2.5 transition-colors group
                  ${current === l.id ? "bg-stone-900 text-amber-50" : "hover:bg-stone-200/60"}
                `}
                style={{ borderRadius: "2px" }}
              >
                <div className="flex items-baseline gap-3">
                  <span className={`mono-font text-xs ${current === l.id ? "text-amber-200" : "text-stone-500"}`}>
                    {String(l.id).padStart(2, "0")}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm leading-tight">{l.title}</div>
                    <div className={`text-xs italic mt-0.5 truncate ${current === l.id ? "text-amber-200/80" : "text-stone-500"}`}>
                      {l.subtitle}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 px-4 sm:px-8 py-8 sm:py-12 min-w-0">
          <div className="max-w-3xl">
            {/* Title */}
            <div className="mb-8">
              <p className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">
                Part {current}
              </p>
              <h2 className="display-font text-4xl sm:text-5xl font-black leading-tight tracking-tight">
                {lesson.title}
              </h2>
              <p className="text-stone-600 italic text-lg mt-2">{lesson.subtitle}</p>
            </div>

            {/* Lesson body */}
            <LessonRouter id={current} />

            {/* Nav buttons */}
            <div className="flex items-center justify-between mt-12 pt-6 border-t border-stone-300">
              <Button onClick={() => setCurrent(Math.max(1, current - 1))} disabled={current === 1}>
                <ChevronLeft size={18} /> Previous
              </Button>
              <span className="mono-font text-xs text-stone-500">
                {String(current).padStart(2, "0")} / 12
              </span>
              <Button onClick={() => setCurrent(Math.min(12, current + 1))} disabled={current === 12} primary>
                Next <ChevronRight size={18} />
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// ============================================================================
// LESSON ROUTER
// ============================================================================

function LessonRouter({ id }) {
  switch (id) {
    case 1:  return <Lesson1 />;
    case 2:  return <Lesson2 />;
    case 3:  return <Lesson3 />;
    case 4:  return <Lesson4 />;
    case 5:  return <Lesson5 />;
    case 6:  return <Lesson6 />;
    case 7:  return <Lesson7 />;
    case 8:  return <Lesson8 />;
    case 9:  return <Lesson9 />;
    case 10: return <Lesson10 />;
    case 11: return <Lesson11 />;
    case 12: return <Lesson12 />;
    default: return null;
  }
}

// ============================================================================
// LESSON 1 — Beats, bars, BPM
// Animation goal: Show that a beat is a regularly-occurring point in time,
// with adjustable BPM and bar grouping. The first beat of each bar is
// emphasized visually and audibly.
// ============================================================================

function Lesson1() {
  const [bpm, setBpm] = useState(80);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const TOTAL_BARS = 4;
  const totalBeats = beatsPerBar * TOTAL_BARS;

  const onTick = useCallback((idx, when, audio) => {
    const beatInBar = idx % beatsPerBar;
    audio.click(when, beatInBar === 0);
  }, [beatsPerBar]);

  const t = useTransport({ bpm, subdivision: 1, totalSubdivisions: Infinity, onTick });

  // We loop indefinitely but use modulo for the visual.
  const visualPos = t.playing ? t.position % totalBeats : 0;
  const currentBar = Math.floor(visualPos / beatsPerBar);
  const currentBeat = Math.floor(visualPos % beatsPerBar);

  return (
    <div className="space-y-6">
      <details className="border border-stone-300 bg-amber-50/60 p-4 text-sm leading-relaxed text-stone-700" style={{ borderRadius: "2px" }}>
        <summary className="cursor-pointer font-medium text-stone-900">
          A note from Benedict, before we begin
        </summary>
        <div className="mt-3 space-y-3">
          <p>
            This is the third part of <em>Read Music Fast!</em> — a 12-part series on reading
            rhythm. Rhythm comes <em>after</em> notes and key signatures because, honestly, you can
            usually copy a rhythm off a recording faster than you can work out the notes. Not being
            able to read rhythm certainly didn't hamper musicians like Art Tatum or Stevie Wonder
            (who couldn't see), or Jimi Hendrix and Paul McCartney (who couldn't read). But if
            you're playing on your own, it helps to be able to analyse a rhythm so you can play it
            properly.
          </p>
          <p className="italic">
            Rhythm notation is even more counter-intuitive than note notation, which is saying a
            lot. We'll make it as straightforward as possible.
          </p>
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <YouTubeEmbed id="D9Cs_zb4q14" title="Art Tatum" />
          <YouTubeEmbed id="9_k7D92Ir4k" title="Stevie Wonder" />
          <YouTubeEmbed id="IPtv14q9ZDg" title="Jimi Hendrix" />
          <YouTubeEmbed id="A_MjCqQoLLA" title="Paul McCartney" />
        </div>
      </details>

      <p className="text-lg leading-relaxed">
        Before we get into notation, let's pin down the basics. A <strong>beat</strong> is what your
        foot taps to when you listen to a piece of music. The snare in Stevie Wonder's "Uptight" or
        the bass drum in Daft Punk's "One More Time" both fall <em>on the beat</em>.
      </p>

      <VideoGrid videos={[
        { id: "8pBym6iHlBk", title: "Stevie Wonder — \"Uptight\"", caption: "The snare drum lands on the beat (≈133 bpm)." },
        { id: "A2VpR8HahKc", title: "Daft Punk — \"One More Time\"", caption: "The bass drum lands on the beat (≈123 bpm)." },
      ]} />

      <p className="leading-relaxed">
        From those two examples we can write a definition: <strong>a beat is a regularly-occurring
        point in time</strong>. Two things follow from that. <em>Regularly-occurring</em> means the
        spacing between beats is steady, no matter what other rhythms are happening. <em>A point in
        time</em> means beats themselves don't have length — the snare or bass drum isn't <em>the</em>{" "}
        beat, it's <em>on</em> the beat. The beat is a concept.
      </p>

      <Insight>
        Press play below. Listen for the <em>brighter</em> click on beat 1 of each bar. Drag the
        BPM and beats-per-bar sliders. Only the speed and grouping change — the beats stay
        perfectly even.
      </Insight>

      <div className="border border-stone-900 bg-amber-50 p-6" style={{ borderRadius: "2px" }}>
        {/* Beat dots */}
        <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: `repeat(${beatsPerBar}, 1fr)` }}>
          {Array.from({ length: beatsPerBar }, (_, i) => {
            const isActive = t.playing && currentBeat === i;
            const isFirst = i === 0;
            return (
              <div key={i} className="flex flex-col items-center gap-2">
                <div
                  className={`
                    rounded-full border-2 border-stone-900 transition-all duration-75
                    ${isFirst ? "w-16 h-16" : "w-12 h-12"}
                    ${isActive ? (isFirst ? "bg-red-700 border-red-700 scale-110" : "bg-stone-900 scale-110") : "bg-amber-50"}
                  `}
                />
                <span className={`mono-font font-bold text-xl ${isFirst ? "text-red-800" : "text-stone-700"}`}>
                  {i + 1}
                </span>
              </div>
            );
          })}
        </div>

        {/* Bar progress */}
        <div className="flex gap-2 mb-6">
          {Array.from({ length: TOTAL_BARS }, (_, i) => (
            <div
              key={i}
              className={`flex-1 h-1 transition-colors ${t.playing && currentBar === i ? "bg-red-700" : "bg-stone-300"}`}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-6">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="space-y-3">
          <Slider label="BPM" value={bpm} onChange={setBpm} min={40} max={200} suffix=" bpm" />
          <Slider label="Beats / bar" value={beatsPerBar} onChange={(v) => { t.stop(); setBeatsPerBar(v); }} min={2} max={6} />
        </div>
      </div>

      <h3 className="display-font text-2xl font-black mt-8">BPM — beats per minute</h3>
      <p className="leading-relaxed">
        How <em>regularly</em> regular? That depends. We measure how far apart beats are with{" "}
        <strong>BPM</strong> — beats per minute. 60 bpm is one beat per second; 120 bpm is two per
        second. The speed of a piece is its <em>tempo</em> (Italian for "time").
      </p>

      <VideoGrid videos={[
        { id: "y6KWK7DPPjE", title: "Yuja Wang — Strauss \"Tritsch-Tratsch-Polka\"", caption: "Around 180 bpm — fast." },
        { id: "_eLU5W1vc8Y", title: "Albinoni — \"Adagio\"", caption: "Around 60 bpm — about a third of the speed of the Strauss." },
      ]} />

      <p className="leading-relaxed text-sm text-stone-700">
        For reference: Stevie Wonder's "Uptight" sits at about 133 bpm, Daft Punk's "One More Time"
        at 123 bpm. Dance music often sits around 120 — the rate of a slightly elevated heartbeat.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        {[
          { name: "Adagio", bpm: 60 },
          { name: "Andante", bpm: 80 },
          { name: "Pop / Dance", bpm: 120 },
          { name: "Presto", bpm: 180 },
        ].map((p) => (
          <button
            key={p.name}
            onClick={() => { t.stop(); setBpm(p.bpm); }}
            className="border border-stone-300 hover:border-stone-900 px-3 py-2 bg-amber-50 transition-colors"
            style={{ borderRadius: "2px" }}
          >
            <div className="font-medium">{p.name}</div>
            <div className="text-xs mono-font text-stone-500">{p.bpm} bpm</div>
          </button>
        ))}
      </div>

      <Insight>
        <strong>Important:</strong> don't confuse <em>how far apart the beats are</em> with{" "}
        <em>how far apart the notes are</em>. A quieter passage of "One More Time" might{" "}
        <em>feel</em> slower, but the beat itself is identical — your foot would tap at the same
        speed.
      </Insight>

      <h3 className="display-font text-2xl font-black mt-8">Bars: counting beats in groups</h3>
      <p className="leading-relaxed">
        We don't count beats one at a time, or in a never-ending list. We count beats in repeated
        groups — like Coolio:
      </p>

      <YouTubeEmbed
        id="E2KRH27aWcU"
        title={`Coolio — "1, 2, 3, 4 (Sumpin' New)"`}
        caption="Most popular music groups beats in fours: 1, 2, 3, 4 / 1, 2, 3, 4 / …"
      />

      <p className="leading-relaxed">
        It can be other numbers though. "Oom Pah-Pah" from <em>Oliver!</em> groups beats in{" "}
        <strong>threes</strong>:
      </p>

      <YouTubeEmbed
        id="njx_ojr-Hi4"
        title='"Oom Pah-Pah" from Oliver!'
        caption="Three beats per bar: OOM-pah-pah, OOM-pah-pah."
      />

      <p className="leading-relaxed">
        A repeated group of beats is called a <strong>bar</strong> (or <em>measure</em>, in the
        US). The first beat of a bar is emphasised — the "OOM" in "Oom-Pah-Pah" is also lower
        than the "pah"s. You can hear the same pattern in Verdi's "La donna è mobile": the bass
        notes fall on beat 1, while the upper chords cover the other beats.
      </p>

      <YouTubeEmbed
        id="xCFEk6Y8TmM"
        title='Verdi — "La donna è mobile"'
        caption="Bass note on beat 1, chords on beats 2 and 3."
      />

      <Caption>
        <strong>How beats are notated in scores:</strong> they aren't, directly. Bar lines (the
        vertical lines between groups of notes) are the only visible cue, and you have to work out
        where each beat falls from the durations of the notes themselves. We'll do exactly that
        in part 3, with Beethoven's <em>Ode to Joy</em>.
      </Caption>
    </div>
  );
}

// ============================================================================
// LESSON 2 — Notes
// Animation goal: Show the half-as-long progression. Tap to make the note
// "heavier" — and watch its duration bar shrink to half. Side-by-side staff
// notation and piano-roll bar.
// ============================================================================

function Lesson2() {
  const TYPES = [
    { name: "Whole", type: "whole", beats: 4 },
    { name: "Half", type: "half", beats: 2 },
    { name: "Quarter", type: "quarter", beats: 1 },
    { name: "Eighth", type: "eighth", beats: 0.5 },
    { name: "Sixteenth", type: "sixteenth", beats: 0.25 },
  ];
  const [idx, setIdx] = useState(0);
  const audio = useAudio();
  const [playingIdx, setPlayingIdx] = useState(null);

  const playNote = (i) => {
    audio.ensureCtx();
    const t = audio.now();
    const beats = TYPES[i].beats;
    const dur = beats * (60 / 80); // 80 bpm
    audio.note(noteFreq(PITCH.G4), t, Math.min(dur, 4));
    setPlayingIdx(i);
    setTimeout(() => setPlayingIdx(null), Math.min(dur, 4) * 1000);
  };

  const note = TYPES[idx];

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        Unlike beats, which are points in time, <strong>notes have duration</strong>. They can
        start at any time and be any length. The last note of Stravinsky's <em>Firebird</em> lasts
        about 6 seconds; the notes in Rimsky-Korsakov's "Flight of the Bumblebee" are a fraction of
        a second each.
      </p>

      <VideoGrid videos={[
        { id: "5tGA6bpscj8", title: "Stravinsky — The Firebird (final note)", caption: "A single note, ~6 seconds long." },
        { id: "fdKEUmFUMFg", title: "Rimsky-Korsakov — Flight of the Bumblebee", caption: "Notes a fraction of a second each (Yuja Wang plays Cziffra's arrangement)." },
      ]} />

      <h3 className="display-font text-2xl font-black mt-8">Beats and "beats"</h3>
      <p className="leading-relaxed">
        Quick warning. We just defined a beat as a <em>point in time</em>. But the word "beat"
        is also used for the <em>length of time between</em> two consecutive beats — so we can say
        a note is "2 beats long" or "1 beat long". Same word, two meanings (point vs. length).
        Which one is meant is usually obvious from context.
      </p>

      <Insight>
        As a note's symbol gets "heavier" — adding a stem, filling in the head, adding flags —
        its duration is cut in half each time. Click each note below to hear it.
      </Insight>

      {/* Comparison: staff notation vs. piano-roll bar */}
      <div className="border border-stone-900 bg-amber-50 p-6 space-y-6" style={{ borderRadius: "2px" }}>
        <div>
          <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">Staff Notation</div>
          <svg viewBox="0 0 700 120" className="w-full" style={{ maxHeight: "120px" }}>
            <g transform="translate(20, 60)" stroke="currentColor">
              <Staff x={0} y={0} width={660} unit={10} />
              {TYPES.map((tp, i) => {
                const x = 80 + i * 120;
                const isCurrent = i === idx;
                const isPlaying = i === playingIdx;
                return (
                  <g
                    key={i}
                    onClick={() => { setIdx(i); playNote(i); }}
                    style={{ cursor: "pointer" }}
                    className={isPlaying ? "animate-pulse" : ""}
                  >
                    {/* Highlight ring */}
                    {isCurrent && (
                      <rect x={x - 35} y={-35} width={70} height={75} fill="none" stroke="#9a1f1f" strokeWidth={1.5} strokeDasharray="3 3" rx={2} />
                    )}
                    <Note x={x} y={5} type={tp.type} unit={11} />
                    <text x={x} y={50} textAnchor="middle" fontSize={11} fill={isCurrent ? "#9a1f1f" : "#666"} fontFamily="ui-serif, serif" fontStyle="italic">
                      {tp.name}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        <div>
          <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">Duration (in beats)</div>
          <div className="space-y-2 mono-font text-sm">
            {TYPES.map((tp, i) => {
              const isCurrent = i === idx;
              const widthPct = (tp.beats / 4) * 100;
              return (
                <div key={i} className="flex items-center gap-3" onClick={() => { setIdx(i); playNote(i); }} style={{ cursor: "pointer" }}>
                  <span className={`min-w-[80px] ${isCurrent ? "text-red-800 font-semibold" : "text-stone-600"}`}>
                    {tp.name}
                  </span>
                  <div className="flex-1 h-7 bg-stone-100 border border-stone-300 relative">
                    {/* beat tick marks */}
                    {[1, 2, 3].map((b) => (
                      <div key={b} className="absolute top-0 bottom-0 w-px bg-stone-300" style={{ left: `${b * 25}%` }} />
                    ))}
                    <div
                      className={`absolute top-0 bottom-0 left-0 transition-all ${isCurrent ? "bg-red-700/70" : "bg-stone-700/60"}`}
                      style={{ width: `${widthPct}%` }}
                    />
                    <div className="absolute inset-0 flex items-center justify-start pl-2 text-xs text-amber-50 font-semibold">
                      {tp.beats} {tp.beats === 1 ? "beat" : "beats"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-1 mono-font text-xs text-stone-500 px-[88px]">
            <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span>
          </div>
        </div>

        <div className="pt-4 border-t border-stone-300 text-center">
          <p className="text-stone-700 italic mb-3">
            "{note.name} note" — {note.beats} {note.beats === 1 ? "beat" : "beats"} at 80&nbsp;bpm
          </p>
          <Button onClick={() => playNote(idx)} primary><Play size={16} /> Play this note</Button>
        </div>
      </div>

      <Caption>
        The mnemonic: <em>heavier = half as long</em>. A whole note (no stem) is 4 beats; add a
        stem to get a half note (2); fill it in for a quarter (1); add a flag for an eighth (½);
        another flag for a sixteenth (¼). And so on, halving each time.
      </Caption>
    </div>
  );
}

// ============================================================================
// LESSON 3 — Counting beats in bars (Ode to Joy)
// Animation goal: Play "Ode to Joy" while highlighting each note as it sounds
// AND showing the beat number 1,2,3,4 below — making visible the alignment
// between note durations and the steady beat grid.
// ============================================================================

// Ode to Joy data. Each note: { pitch, beats, type, dotted }
// Position is computed cumulatively in beats.
function odeToJoyMelody() {
  const P = PITCH;
  const seq = [
    // Bar 1
    { pitch: P.E4, beats: 1, type: "quarter" },
    { pitch: P.E4, beats: 1, type: "quarter" },
    { pitch: P.F4, beats: 1, type: "quarter" },
    { pitch: P.G4, beats: 1, type: "quarter" },
    // Bar 2
    { pitch: P.G4, beats: 1, type: "quarter" },
    { pitch: P.F4, beats: 1, type: "quarter" },
    { pitch: P.E4, beats: 1, type: "quarter" },
    { pitch: P.D4, beats: 1, type: "quarter" },
    // Bar 3
    { pitch: P.C4, beats: 1, type: "quarter" },
    { pitch: P.C4, beats: 1, type: "quarter" },
    { pitch: P.D4, beats: 1, type: "quarter" },
    { pitch: P.E4, beats: 1, type: "quarter" },
    // Bar 4
    { pitch: P.E4, beats: 1.5, type: "quarter", dotted: true },
    { pitch: P.D4, beats: 0.5, type: "eighth" },
    { pitch: P.D4, beats: 2, type: "half" },
  ];
  let pos = 0;
  return seq.map((n) => {
    const obj = { ...n, position: pos };
    pos += n.beats;
    return obj;
  });
}

function Lesson3() {
  const melody = useMemo(() => odeToJoyMelody(), []);
  const totalBeats = 16; // 4 bars × 4 beats
  const SUBDIV = 4; // sixteenth-note resolution for smooth motion
  const totalSubs = totalBeats * SUBDIV;
  const [bpm, setBpm] = useState(72);
  const [showRules, setShowRules] = useState(true);

  // Pre-compute which subdivision each note starts on.
  const noteStarts = useMemo(() =>
    melody.map((n) => Math.round(n.position * SUBDIV))
  , [melody]);

  const onTick = useCallback((idx, when, audio) => {
    const noteIdx = noteStarts.indexOf(idx);
    if (noteIdx >= 0) {
      const n = melody[noteIdx];
      audio.note(noteFreq(n.pitch), when, n.beats * (60 / bpm) * 0.95);
    }
    // Click on every beat (every SUBDIV ticks)
    if (idx % SUBDIV === 0) {
      const beatNum = Math.floor(idx / SUBDIV) % 4;
      audio.tick(when, beatNum === 0 ? 900 : 600, 0.08);
    }
  }, [bpm, melody, noteStarts]);

  const t = useTransport({ bpm, subdivision: SUBDIV, totalSubdivisions: totalSubs, onTick });

  const currentBeatExact = t.position / SUBDIV;
  const currentNoteIdx = melody.findIndex((n) =>
    currentBeatExact >= n.position && currentBeatExact < n.position + n.beats
  );

  // Score layout
  const BEAT_W = 38; // px per beat
  const BAR_W = BEAT_W * 4;
  const STAFF_X = 80;
  const STAFF_W = BAR_W * 4 + 30;
  const STAFF_Y = 60;

  // Map MIDI pitch to vertical position on staff (treble clef, middle C = below staff).
  // Staff lines top to bottom: F5, D5, B4, G4, E4. Spaces: E5, C5, A4, F4.
  // y = STAFF_Y is the middle line (B4).
  const pitchY = (midi) => {
    const stepsFromB4 = (() => {
      // diatonic steps. C=0,D=1,E=2,F=3,G=4,A=5,B=6
      const diatonic = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
      const pc = midi % 12;
      const oct = Math.floor(midi / 12) - 1;
      const stepIdx = diatonic[pc];
      const b4Step = diatonic[11] + 4 * 7; // octave 4
      const myStep = stepIdx + oct * 7;
      return myStep - b4Step;
    })();
    return STAFF_Y - stepsFromB4 * 5;
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        Music notation doesn't draw the beats — you have to deduce them from the notes. Three
        rules, true for every piece, let you do that. We'll apply them to Beethoven's{" "}
        <em>Ode to Joy</em>.
      </p>

      {showRules && (
        <div className="border border-stone-900 bg-amber-50 p-5 space-y-2 text-base relative" style={{ borderRadius: "2px" }}>
          <button onClick={() => setShowRules(false)} className="absolute top-2 right-2 text-stone-500 hover:text-stone-900">
            <X size={16} />
          </button>
          <p className="font-semibold display-font text-lg mb-2">The three rules</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>The first note (or rest) after a bar line is always on <strong>beat 1</strong> of the bar.</li>
            <li>The length of a note (or rest) tells you when the <em>next</em> note (or rest) happens.</li>
            <li>Notes stacked vertically on the staff are played at the <strong>same time</strong>.</li>
          </ol>
          <p className="text-sm italic text-stone-700 mt-2">
            Plus, in this piece the bottom number of the time signature is 4, so a quarter note = 1
            beat. (We'll cover what that bottom number does in part 12.)
          </p>
        </div>
      )}

      <YouTubeEmbed
        id="2nNrjsoJvIg"
        title="Counting beats in bars — Ode to Joy walkthrough"
        caption="Benedict walks through Beethoven's tune note-by-note, deducing where each beat falls."
      />

      <p className="leading-relaxed">
        Below, you can play the same melody and watch the beat numbers tick under the staff.
        Notice how the second-to-last bar contains a <em>dotted quarter</em> followed by an{" "}
        <em>eighth</em> — together they take 1½ + ½ = 2 beats, and the half note that follows
        fills the remaining 2 beats. Dotted notes are next.
      </p>

      <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
        <div className="overflow-x-auto pb-2">
          <svg viewBox={`0 0 ${STAFF_X + STAFF_W + 30} 160`} className="block" style={{ minWidth: "640px", width: "100%" }}>
            {/* Staff */}
            <Staff x={STAFF_X} y={STAFF_Y} width={STAFF_W} unit={5} />
            <TrebleClef x={STAFF_X + 20} y={STAFF_Y} unit={5} />
            <TimeSignature x={STAFF_X + 50} y={STAFF_Y - 5} top="4" bottom="4" unit={5} />

            {/* Bar lines */}
            {[0, 1, 2, 3, 4].map((b) => (
              <BarLine key={b} x={STAFF_X + 65 + b * BAR_W} y={STAFF_Y} unit={10} thick={b === 4} />
            ))}

            {/* Notes */}
            {melody.map((n, i) => {
              const x = STAFF_X + 65 + n.position * BEAT_W + 15;
              const y = pitchY(n.pitch);
              const stemUp = n.pitch < PITCH.B4;
              const isActive = currentNoteIdx === i;
              const isPast = currentBeatExact > n.position + n.beats - 0.05 && currentBeatExact < totalBeats;
              const color = isActive ? "#9a1f1f" : isPast ? "#999" : "#1c1917";
              return (
                <g key={i} style={{ color }}>
                  <Note x={x} y={y} type={n.type} dotted={n.dotted} stemUp={stemUp} unit={6} staffY={STAFF_Y} />
                </g>
              );
            })}

            {/* Beat numbers below staff */}
            {Array.from({ length: 16 }, (_, i) => {
              const beat = i % 4 + 1;
              const x = STAFF_X + 65 + i * BEAT_W + 15;
              const beatPlaying = Math.floor(currentBeatExact) === i && t.playing;
              return (
                <text
                  key={i}
                  x={x} y={STAFF_Y + 50}
                  textAnchor="middle"
                  fontSize={14}
                  fontWeight={beat === 1 ? 700 : 500}
                  fill={beatPlaying ? "#9a1f1f" : beat === 1 ? "#1c1917" : "#888"}
                  className="mono-font"
                >
                  {beat}
                </text>
              );
            })}

            {/* Playhead */}
            {t.playing && (
              <line
                x1={STAFF_X + 65 + currentBeatExact * BEAT_W + 15}
                x2={STAFF_X + 65 + currentBeatExact * BEAT_W + 15}
                y1={STAFF_Y - 30}
                y2={STAFF_Y + 35}
                stroke="#9a1f1f"
                strokeWidth={1.5}
                opacity={0.6}
              />
            )}
          </svg>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-4">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play melody</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="mt-4">
          <Slider label="BPM" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={40} max={140} suffix=" bpm" />
        </div>
      </div>

      <Insight>
        Most notes here are <strong>quarter notes</strong> — one note per beat. But the second-to-last
        bar has a <strong>dotted quarter + eighth</strong>: the dotted quarter takes 1½ beats, and the
        eighth takes ½, so together they fill exactly 2 beats. We'll cover dotted notes next.
      </Insight>

      <Caption>
        Watch the red playhead sweep across as the music plays. Each note lights up as it sounds,
        and the beat numbers below tick along underneath — making the relationship between
        notation and time fully visible.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 4 — Dotted notes
// Animation goal: Toggle a dot on/off and watch the duration bar grow by 50%.
// Hear the note before and after. Show the math visually: note + half-of-note.
// ============================================================================

function Lesson4() {
  const TYPES = [
    { name: "Half", type: "half", baseBeats: 2 },
    { name: "Quarter", type: "quarter", baseBeats: 1 },
    { name: "Eighth", type: "eighth", baseBeats: 0.5 },
  ];
  const [selected, setSelected] = useState(0);
  const [dotted, setDotted] = useState(true);
  const audio = useAudio();
  const [phase, setPhase] = useState(null); // 'main' | 'extra' | null

  const note = TYPES[selected];
  const beats = dotted ? note.baseBeats * 1.5 : note.baseBeats;
  const BPM = 80;

  const playWithAnimation = () => {
    audio.ensureCtx();
    const t0 = audio.now();
    const mainDur = note.baseBeats * (60 / BPM);
    const extraDur = note.baseBeats * 0.5 * (60 / BPM);

    audio.note(noteFreq(PITCH.G4), t0, beats * (60 / BPM) * 0.95);
    setPhase("main");
    setTimeout(() => {
      if (dotted) {
        setPhase("extra");
        setTimeout(() => setPhase(null), extraDur * 1000);
      } else {
        setPhase(null);
      }
    }, mainDur * 1000);
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        A <strong>dot</strong> placed after a note multiplies its length by 1½. So you get the
        original note plus half of itself again.
      </p>

      <Insight>
        Toggle the dot on and off and watch the duration bar grow or shrink by exactly 50%.
        Press play to hear the difference.
      </Insight>

      <div className="border border-stone-900 bg-amber-50 p-6" style={{ borderRadius: "2px" }}>
        {/* Note picker */}
        <div className="flex flex-wrap gap-2 mb-6">
          {TYPES.map((tp, i) => (
            <button
              key={tp.name}
              onClick={() => setSelected(i)}
              className={`
                px-4 py-2 border transition-colors
                ${selected === i ? "border-stone-900 bg-stone-900 text-amber-50" : "border-stone-300 hover:border-stone-900 bg-amber-50"}
              `}
              style={{ borderRadius: "2px" }}
            >
              {tp.name} note
            </button>
          ))}
        </div>

        {/* Notation */}
        <div className="flex items-center justify-center gap-8 mb-6 py-4">
          <svg width={140} height={100} viewBox="0 0 140 100">
            <g transform="translate(70, 50)" stroke="currentColor">
              <Note x={0} y={0} type={note.type} dotted={dotted} unit={14} />
            </g>
          </svg>
          <div className="display-font text-3xl font-black">=</div>
          <div className="display-font text-3xl font-black tabular-nums">
            {beats} <span className="text-base font-normal italic">{beats === 1 ? "beat" : "beats"}</span>
          </div>
        </div>

        {/* Toggle */}
        <div className="flex items-center justify-center mb-6">
          <button
            onClick={() => setDotted(!dotted)}
            className={`
              relative w-72 h-12 border border-stone-900 bg-amber-50 transition-colors
              flex items-center justify-around mono-font font-medium text-sm
            `}
            style={{ borderRadius: "2px" }}
          >
            <span className={`z-10 transition-colors ${!dotted ? "text-amber-50" : "text-stone-700"}`}>No dot</span>
            <span className={`z-10 transition-colors ${dotted ? "text-amber-50" : "text-stone-700"}`}>With dot</span>
            <div
              className="absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] bg-stone-900 transition-all"
              style={{ left: dotted ? "calc(50% + 1px)" : "1px", borderRadius: "1px" }}
            />
          </button>
        </div>

        {/* Duration visualization */}
        <div className="mb-6">
          <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">Duration</div>
          <div className="h-12 bg-stone-100 border border-stone-300 relative">
            {/* Beat ticks */}
            {[1, 2, 3].map((b) => (
              <div key={b} className="absolute top-0 bottom-0 w-px bg-stone-300" style={{ left: `${b * 25}%` }} />
            ))}
            {/* Beat labels */}
            <div className="absolute -top-5 inset-x-0 flex justify-between mono-font text-xs text-stone-500">
              {[0, 1, 2, 3, 4].map((b) => <span key={b}>{b}</span>)}
            </div>
            {/* Main fill */}
            <div
              className={`absolute top-0 bottom-0 left-0 transition-all duration-200 ${phase === "main" ? "bg-red-700/80" : "bg-stone-700/70"}`}
              style={{ width: `${(note.baseBeats / 4) * 100}%` }}
            />
            {/* Extension (dot) */}
            {dotted && (
              <div
                className={`absolute top-0 bottom-0 transition-all duration-200 ${phase === "extra" ? "bg-red-700/80" : "bg-amber-700/70"}`}
                style={{
                  left: `${(note.baseBeats / 4) * 100}%`,
                  width: `${(note.baseBeats * 0.5 / 4) * 100}%`,
                }}
              />
            )}
            <div className="absolute inset-0 flex items-center justify-start pl-3 text-sm text-amber-50 font-semibold">
              {note.baseBeats} {note.baseBeats === 1 ? "beat" : "beats"}
              {dotted && (
                <span className="ml-2 italic font-normal">+ {note.baseBeats * 0.5} = {beats}</span>
              )}
            </div>
          </div>
        </div>

        <div className="text-center">
          <Button onClick={playWithAnimation} primary><Play size={16} /> Play</Button>
        </div>
      </div>

      <div className="border border-stone-900 bg-amber-50 p-5" style={{ borderRadius: "2px" }}>
        <p className="font-semibold display-font text-lg mb-3">The shortcut: just memorize these.</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          {TYPES.map((tp) => (
            <div key={tp.name} className="border border-stone-300 p-3 bg-stone-50" style={{ borderRadius: "2px" }}>
              <svg viewBox="0 0 80 60" className="mx-auto" width="60" height="50">
                <g transform="translate(35, 30)">
                  <Note x={0} y={0} type={tp.type} dotted={true} unit={9} />
                </g>
              </svg>
              <p className="mono-font text-sm mt-1">
                = {tp.baseBeats * 1.5} {tp.baseBeats * 1.5 === 1 ? "beat" : "beats"}
              </p>
            </div>
          ))}
        </div>
      </div>

      <Caption>
        It's faster to think "dotted half = 3 beats" than to compute "2 × 1½." With practice these
        feel automatic. <strong>Important:</strong> a dot <em>after</em> a note (extending duration)
        is different from a dot <em>above or below</em> a note — that's <em>staccato</em>, covered
        in lesson 10.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 5 — Counting offbeats
// Animation goal: Show "1 + 2 + 3 + 4 +" counting (with "+" = "and").
// Notes fall on beats AND on the "and"s between them. Highlight whichever
// count syllable is currently sounding.
// ============================================================================

function Lesson5() {
  // A simple rhythm using quarters and eighths:
  // | q  q  e e  q  | q  e e  q  q  | (in 4/4)
  // Reusing the eighth-note pattern that's classic for offbeat practice.
  const rhythm = useMemo(() => {
    return [
      // Bar 1: q q ee q   (beats 1, 2, 3 3.5, 4)
      { pos: 0,   beats: 1,   type: "quarter", pitch: PITCH.G4 },
      { pos: 1,   beats: 1,   type: "quarter", pitch: PITCH.G4 },
      { pos: 2,   beats: 0.5, type: "eighth",  pitch: PITCH.A4 },
      { pos: 2.5, beats: 0.5, type: "eighth",  pitch: PITCH.G4 },
      { pos: 3,   beats: 1,   type: "quarter", pitch: PITCH.E4 },
      // Bar 2: ee q q ee q
      { pos: 4,   beats: 0.5, type: "eighth",  pitch: PITCH.F4 },
      { pos: 4.5, beats: 0.5, type: "eighth",  pitch: PITCH.G4 },
      { pos: 5,   beats: 1,   type: "quarter", pitch: PITCH.A4 },
      { pos: 6,   beats: 0.5, type: "eighth",  pitch: PITCH.G4 },
      { pos: 6.5, beats: 0.5, type: "eighth",  pitch: PITCH.E4 },
      { pos: 7,   beats: 1,   type: "quarter", pitch: PITCH.D4 },
    ];
  }, []);

  const totalBeats = 8;
  const SUBDIV = 2; // eighth-note resolution
  const totalSubs = totalBeats * SUBDIV;
  const [bpm, setBpm] = useState(70);

  const noteStarts = useMemo(() => rhythm.map((n) => Math.round(n.pos * SUBDIV)), [rhythm]);

  const onTick = useCallback((idx, when, audio) => {
    const ni = noteStarts.indexOf(idx);
    if (ni >= 0) {
      const n = rhythm[ni];
      audio.note(noteFreq(n.pitch), when, n.beats * (60 / bpm) * 0.9);
    }
    // metronome on every beat
    if (idx % SUBDIV === 0) {
      const beat = Math.floor(idx / SUBDIV) % 4;
      audio.tick(when, beat === 0 ? 900 : 600, 0.07);
    }
  }, [bpm, rhythm, noteStarts]);

  const t = useTransport({ bpm, subdivision: SUBDIV, totalSubdivisions: totalSubs, onTick });
  const subPos = t.position; // current subdivision (eighth)
  const beatExact = subPos / SUBDIV;

  // Layout
  const BEAT_W = 60;
  const STAFF_X = 80;
  const STAFF_Y = 60;
  const STAFF_W = totalBeats * BEAT_W + 30;

  const pitchY = (midi) => {
    const diatonic = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    const stepIdx = diatonic[pc];
    const b4Step = diatonic[11] + 4 * 7;
    const myStep = stepIdx + oct * 7;
    return STAFF_Y - (myStep - b4Step) * 5;
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        When notes fall <em>between</em> the beats — on what's called the <strong>offbeat</strong> — we
        count them by saying "<strong>and</strong>" (often written as <span className="mono-font">+</span>).
        For more practice, here's Benedict working through Brahms's Lullaby — same technique, more
        offbeats:
      </p>

      <YouTubeEmbed
        id="7-yR5BjTQyc"
        title="Counting offbeats — Brahms's Lullaby walkthrough"
        caption="Three beats per bar, with eighth notes filling in the offbeats."
      />

      <Insight>
        The trick: say "<strong>1 and 2 and 3 and 4 and</strong>" steadily, with the numbers landing
        on the metronome clicks. A note on the beat = a number; a note on the offbeat = an "and."
      </Insight>

      <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
        <div className="overflow-x-auto pb-2">
          <svg viewBox={`0 0 ${STAFF_X + STAFF_W + 20} 180`} className="block" style={{ minWidth: "640px", width: "100%" }}>
            <Staff x={STAFF_X} y={STAFF_Y} width={STAFF_W} unit={5} />
            <TrebleClef x={STAFF_X + 20} y={STAFF_Y} unit={5} />
            <TimeSignature x={STAFF_X + 50} y={STAFF_Y - 5} top="4" bottom="4" unit={5} />

            {[0, 1, 2].map((b) => (
              <BarLine key={b} x={STAFF_X + 65 + b * 4 * BEAT_W} y={STAFF_Y} unit={10} thick={b === 2} />
            ))}

            {rhythm.map((n, i) => {
              const x = STAFF_X + 65 + n.pos * BEAT_W + 18;
              const y = pitchY(n.pitch);
              const stemUp = n.pitch < PITCH.B4;
              const isPlaying = beatExact >= n.pos && beatExact < n.pos + n.beats;
              return (
                <g key={i} style={{ color: isPlaying ? "#9a1f1f" : "#1c1917" }}>
                  <Note x={x} y={y} type={n.type} stemUp={stemUp} unit={6} />
                </g>
              );
            })}

            {/* Count syllables below */}
            {Array.from({ length: totalBeats * 2 }, (_, i) => {
              const isBeat = i % 2 === 0;
              const beatNum = Math.floor(i / 2) % 4 + 1;
              const x = STAFF_X + 65 + (i / 2) * BEAT_W + 18;
              const isCurrent = Math.floor(subPos) === i && t.playing;
              const label = isBeat ? `${beatNum}` : "+";
              return (
                <g key={i}>
                  <text
                    x={x}
                    y={STAFF_Y + 50}
                    textAnchor="middle"
                    fontSize={isBeat ? 16 : 14}
                    fontWeight={isBeat ? 700 : 500}
                    fill={isCurrent ? "#9a1f1f" : isBeat ? "#1c1917" : "#999"}
                    fontStyle={isBeat ? "normal" : "italic"}
                    className="mono-font"
                  >
                    {label}
                  </text>
                </g>
              );
            })}

            {/* Beat connector marks */}
            {Array.from({ length: totalBeats + 1 }, (_, i) => (
              <line
                key={i}
                x1={STAFF_X + 65 + i * BEAT_W + 18}
                x2={STAFF_X + 65 + i * BEAT_W + 18}
                y1={STAFF_Y + 25}
                y2={STAFF_Y + 35}
                stroke="#bbb"
                strokeWidth={0.5}
              />
            ))}

            {t.playing && (
              <line
                x1={STAFF_X + 65 + beatExact * BEAT_W + 18}
                x2={STAFF_X + 65 + beatExact * BEAT_W + 18}
                y1={STAFF_Y - 30}
                y2={STAFF_Y + 40}
                stroke="#9a1f1f"
                strokeWidth={1.5}
                opacity={0.5}
              />
            )}
          </svg>
        </div>

        {/* Big spelled-out counter */}
        <div className="mt-4 mb-4 flex flex-wrap justify-center gap-1.5 text-xl mono-font">
          {Array.from({ length: 16 }, (_, i) => {
            const isBeat = i % 2 === 0;
            const beatNum = Math.floor(i / 2) % 4 + 1;
            const isCurrent = Math.floor(subPos) === i && t.playing;
            const label = isBeat ? `${beatNum}` : "+";
            return (
              <span
                key={i}
                className={`
                  inline-block min-w-[32px] text-center px-1 py-0.5 transition-all
                  ${isCurrent ? "bg-red-700 text-amber-50 scale-110" : isBeat ? "text-stone-900" : "text-stone-400"}
                  ${isBeat ? "font-bold" : "italic"}
                `}
                style={{ borderRadius: "2px" }}
              >
                {label}
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-4">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play & count</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="mt-4">
          <Slider label="BPM" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={40} max={140} suffix=" bpm" />
        </div>
      </div>

      <Caption>
        Try it slow first. Notice how the eighth-note pairs land on
        "<strong>3</strong> <em>and</em>" and "<strong>1</strong> <em>and</em>" —
        the beat plus the offbeat between. A common mistake is putting an "and" on a click —
        the <em>numbers</em> go on the clicks; the "and"s sit halfway between.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 6 — Playing with a metronome
// Animation goal: A real, working metronome (visual pendulum + click) that
// the user can practice with. Plus the 7-step practice protocol.
// ============================================================================

function Lesson6() {
  const [bpm, setBpm] = useState(80);
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [accent, setAccent] = useState(true);

  const onTick = useCallback((idx, when, audio) => {
    const beat = idx % beatsPerBar;
    audio.click(when, accent && beat === 0);
  }, [beatsPerBar, accent]);

  const t = useTransport({ bpm, subdivision: 1, totalSubdivisions: Infinity, onTick });

  // Pendulum animation. Synced to the transport's continuous `position` so the
  // arm reaches its furthest swing exactly when the audio click sounds. One
  // full swing cycle (-30° → +30° → -30°) takes two beats. Cosine, not a
  // triangle wave: a real pendulum eases at the extremes and accelerates
  // through the middle.
  const angle = t.playing ? -30 * Math.cos(Math.PI * t.position) : -30;

  const STEPS = [
    "Make sure you're on top of the notes and fingering.",
    "Set the metronome to a slow speed.",
    "Practise saying the rhythm in time with the metronome, without playing the notes.",
    "Practise playing the notes while saying the rhythm, without the metronome.",
    "Combine: play the notes while saying the rhythm, in time with the metronome.",
    "Play the notes in time with the metronome, without saying the beats.",
    "Gradually speed it up.",
  ];

  const [activeStep, setActiveStep] = useState(0);

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        Now that we know <em>where</em> the beats go on the page, how do we translate that into
        actually playing the piece in time? With a <strong>metronome</strong>. It turns the
        abstract beat into something audible.
      </p>

      <YouTubeEmbed
        id="3sOAxHfRkTw"
        title="Playing with a metronome — practice walkthrough"
        caption="Benedict demonstrates the seven-step protocol. Watch this first, then use the metronome below."
      />

      <Insight>
        The metronome is unforgiving — that's the point. Set it slow enough that you can play
        every note correctly, then increase the tempo only when you're locked in.
      </Insight>

      {/* The metronome itself */}
      <div className="border border-stone-900 bg-amber-50 p-6" style={{ borderRadius: "2px" }}>
        <div className="flex flex-col sm:flex-row items-center gap-6">
          {/* Pendulum */}
          <div className="flex-shrink-0">
            <svg viewBox="0 0 200 240" width="180" height="216">
              {/* Trapezoidal body */}
              <path d="M 50 230 L 70 30 L 130 30 L 150 230 Z" fill="#1c1917" stroke="#1c1917" strokeWidth={2} />
              {/* Inner cutout */}
              <path d="M 75 215 L 88 60 L 112 60 L 125 215 Z" fill="#faf6ec" />
              {/* Pivot point */}
              <circle cx={100} cy={70} r={4} fill="#1c1917" />
              {/* Pendulum arm. Translate the pivot to the origin, rotate, then
                  translate back — robust across browsers regardless of how the
                  SVG transform attribute is parsed (SVG 1.1 vs CSS Transforms). */}
              <g transform={`translate(100 70) rotate(${angle}) translate(-100 -70)`}>
                <line x1={100} y1={70} x2={100} y2={210} stroke="#1c1917" strokeWidth={3} />
                {/* Sliding weight */}
                <rect x={92} y={120} width={16} height={10} fill="#1c1917" />
                {/* Tip */}
                <circle cx={100} cy={210} r={5} fill="#9a1f1f" />
              </g>
              {/* Scale marks */}
              {[-30, -15, 0, 15, 30].map((a) => {
                const rad = (a - 90) * Math.PI / 180;
                const x1 = 100 + 90 * Math.cos(rad);
                const y1 = 70 + 90 * Math.sin(rad);
                const x2 = 100 + 95 * Math.cos(rad);
                const y2 = 70 + 95 * Math.sin(rad);
                return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#666" strokeWidth={1} />;
              })}
            </svg>
          </div>

          {/* Controls */}
          <div className="flex-1 w-full space-y-4">
            <div className="text-center">
              <div className="display-font text-5xl font-black mono-font">{bpm}</div>
              <div className="text-xs text-stone-500 uppercase tracking-widest mono-font">BPM</div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              {!t.playing ? (
                <Button onClick={t.start} primary><Play size={18} /> Start</Button>
              ) : (
                <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
              )}
            </div>

            <Slider label="Tempo" value={bpm} onChange={(v) => { setBpm(v); }} min={30} max={240} suffix=" bpm" />
            <Slider label="Bar size" value={beatsPerBar} onChange={(v) => { setBeatsPerBar(v); }} min={2} max={6} />

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={accent} onChange={(e) => setAccent(e.target.checked)} className="accent-stone-900" />
              <span>Accent beat 1</span>
            </label>
          </div>
        </div>
      </div>

      {/* The 7-step practice protocol */}
      <div className="border border-stone-900 bg-amber-50 p-5" style={{ borderRadius: "2px" }}>
        <p className="font-semibold display-font text-lg mb-3">The seven-step protocol</p>
        <p className="text-sm text-stone-600 italic mb-4">
          Click each step to mark it complete. With practice, you can skip steps —
          experienced players sight-read a piece in time on the first try.
        </p>
        <ol className="space-y-2">
          {STEPS.map((step, i) => (
            <li key={i}>
              <button
                onClick={() => setActiveStep(i)}
                className={`
                  w-full text-left flex gap-3 p-3 transition-colors
                  ${activeStep === i ? "bg-stone-900 text-amber-50" : "hover:bg-stone-200/60"}
                `}
                style={{ borderRadius: "2px" }}
              >
                <span className={`mono-font font-bold flex-shrink-0 ${activeStep === i ? "text-amber-200" : "text-stone-400"}`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-sm leading-relaxed">{step}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <Caption>
        The classic mistake is rushing past step 3 — saying the rhythm out loud before playing
        it. Doing this, slowly, is what trains your inner clock.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 7 — Counting ¼-beats (sixteenth-note subdivisions)
// Animation goal: Show "1 e and a 2 e and a 3 e and a 4 e and a" subdivision.
// Each beat is split into 4. Show how a sixteenth-note rhythm fits into this grid.
// ============================================================================

function Lesson7() {
  // A two-bar rhythm using sixteenth-note groupings.
  // | 1 e + a 2 e + a 3 + 4 e + a |  (mix)
  const rhythm = useMemo(() => {
    return [
      // Bar 1
      { pos: 0,    beats: 0.25, type: "sixteenth", pitch: PITCH.C5 },
      { pos: 0.25, beats: 0.25, type: "sixteenth", pitch: PITCH.C5 },
      { pos: 0.5,  beats: 0.25, type: "sixteenth", pitch: PITCH.D5 },
      { pos: 0.75, beats: 0.25, type: "sixteenth", pitch: PITCH.E5 },
      { pos: 1,    beats: 1,    type: "quarter",   pitch: PITCH.G5 },
      { pos: 2,    beats: 0.5,  type: "eighth",    pitch: PITCH.E5 },
      { pos: 2.5,  beats: 0.25, type: "sixteenth", pitch: PITCH.D5 },
      { pos: 2.75, beats: 0.25, type: "sixteenth", pitch: PITCH.C5 },
      { pos: 3,    beats: 1,    type: "quarter",   pitch: PITCH.D5 },
    ];
  }, []);

  const totalBeats = 4;
  const SUBDIV = 4; // sixteenth-note resolution
  const totalSubs = totalBeats * SUBDIV;
  const [bpm, setBpm] = useState(60);

  const noteStarts = useMemo(() => rhythm.map((n) => Math.round(n.pos * SUBDIV)), [rhythm]);

  const onTick = useCallback((idx, when, audio) => {
    const ni = noteStarts.indexOf(idx);
    if (ni >= 0) {
      const n = rhythm[ni];
      audio.note(noteFreq(n.pitch), when, n.beats * (60 / bpm) * 0.85);
    }
    if (idx % SUBDIV === 0) {
      // beat click
      audio.tick(when, 900, 0.07);
    } else {
      // softer subdivision tick
      audio.tick(when, 500, 0.03);
    }
  }, [bpm, rhythm, noteStarts]);

  const t = useTransport({ bpm, subdivision: SUBDIV, totalSubdivisions: totalSubs, onTick });
  const subPos = t.position;
  const beatExact = subPos / SUBDIV;

  const SYLLABLES = ["1", "e", "+", "a", "2", "e", "+", "a", "3", "e", "+", "a", "4", "e", "+", "a"];

  const BEAT_W = 110;
  const STAFF_X = 80;
  const STAFF_Y = 60;
  const STAFF_W = totalBeats * BEAT_W + 30;

  const pitchY = (midi) => {
    const diatonic = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    const stepIdx = diatonic[pc];
    const b4Step = diatonic[11] + 4 * 7;
    return STAFF_Y - (stepIdx + oct * 7 - b4Step) * 5;
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        We covered offbeats in part 5. What about "off-offbeats" — notes that fall halfway between
        a beat and an offbeat? Those are <strong>¼-beat notes</strong> (sixteenth notes), and they
        need a different counting technique.
      </p>

      <YouTubeEmbed
        id="hWD4Osy6oiE"
        title="Counting ¼-beats — worked examples"
        caption="A few short examples of how to count sixteenth-note rhythms."
      />

      <Insight>
        Each beat splits into 4 syllables: <strong>1 — e — and — a</strong>. The number is the
        beat, the "and" is the offbeat (halfway), and "e" / "a" are the quarter-points before and
        after. Don't confuse a ¼-<em>beat</em> (a sixteenth — a quarter <em>of</em> a beat) with a{" "}
        <em>quarter note</em> (one whole beat).
      </Insight>

      <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
        <div className="overflow-x-auto pb-2">
          <svg viewBox={`0 0 ${STAFF_X + STAFF_W + 20} 180`} className="block" style={{ minWidth: "640px", width: "100%" }}>
            <Staff x={STAFF_X} y={STAFF_Y} width={STAFF_W} unit={5} />
            <TrebleClef x={STAFF_X + 20} y={STAFF_Y} unit={5} />
            <TimeSignature x={STAFF_X + 50} y={STAFF_Y - 5} top="4" bottom="4" unit={5} />

            <BarLine x={STAFF_X + 65 + totalBeats * BEAT_W} y={STAFF_Y} unit={10} thick />

            {rhythm.map((n, i) => {
              const x = STAFF_X + 65 + n.pos * BEAT_W + 18;
              const y = pitchY(n.pitch);
              const stemUp = n.pitch < PITCH.B4;
              const isPlaying = beatExact >= n.pos && beatExact < n.pos + n.beats;
              return (
                <g key={i} style={{ color: isPlaying ? "#9a1f1f" : "#1c1917" }}>
                  <Note x={x} y={y} type={n.type} stemUp={stemUp} unit={6} />
                </g>
              );
            })}

            {/* Subdivision tick marks */}
            {Array.from({ length: totalSubs + 1 }, (_, i) => {
              const x = STAFF_X + 65 + (i / SUBDIV) * BEAT_W + 18;
              const isBeat = i % SUBDIV === 0;
              return (
                <line
                  key={i}
                  x1={x} x2={x}
                  y1={STAFF_Y + 25}
                  y2={STAFF_Y + (isBeat ? 38 : 32)}
                  stroke={isBeat ? "#1c1917" : "#bbb"}
                  strokeWidth={isBeat ? 1 : 0.5}
                />
              );
            })}

            {/* Syllables */}
            {SYLLABLES.map((s, i) => {
              const x = STAFF_X + 65 + (i / SUBDIV) * BEAT_W + 18;
              const isCurrent = Math.floor(subPos) === i && t.playing;
              const isBeat = i % SUBDIV === 0;
              return (
                <text
                  key={i}
                  x={x} y={STAFF_Y + 55}
                  textAnchor="middle"
                  fontSize={isBeat ? 16 : 13}
                  fontWeight={isBeat ? 700 : 500}
                  fill={isCurrent ? "#9a1f1f" : isBeat ? "#1c1917" : "#999"}
                  fontStyle={isBeat ? "normal" : "italic"}
                  className="mono-font"
                >
                  {s}
                </text>
              );
            })}

            {t.playing && (
              <line
                x1={STAFF_X + 65 + beatExact * BEAT_W + 18}
                x2={STAFF_X + 65 + beatExact * BEAT_W + 18}
                y1={STAFF_Y - 30}
                y2={STAFF_Y + 45}
                stroke="#9a1f1f" strokeWidth={1.5} opacity={0.5}
              />
            )}
          </svg>
        </div>

        {/* Big counter */}
        <div className="mt-4 mb-4 flex flex-wrap justify-center gap-1 text-lg mono-font">
          {SYLLABLES.map((s, i) => {
            const isBeat = i % SUBDIV === 0;
            const isCurrent = Math.floor(subPos) === i && t.playing;
            return (
              <span
                key={i}
                className={`
                  inline-block min-w-[28px] text-center px-1 py-0.5 transition-all
                  ${isCurrent ? "bg-red-700 text-amber-50 scale-110" : isBeat ? "text-stone-900" : "text-stone-400"}
                  ${isBeat ? "font-bold" : "italic text-sm"}
                `}
                style={{ borderRadius: "2px" }}
              >
                {s}
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-4">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play & count</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="mt-4">
          <Slider label="BPM" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={40} max={120} suffix=" bpm" />
        </div>
      </div>

      <Caption>
        Don't confuse "¼-beat" (one sixteenth — a quarter <em>of a beat</em>) with "quarter note"
        (one whole beat). They use the same word for different things — the curse of music
        terminology. Slow tempo + steady subdivision is the only way to internalize this.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 8 — Dotted rhythms
// Animation goal: Show the difference between a CORRECT dotted-eighth + sixteenth
// (splits beat into 4: long-long-long-short) and the common WRONG triplet feel
// (long-short, splits beat into 3). User can hear both and see the difference.
// ============================================================================

function Lesson8() {
  const [bpm, setBpm] = useState(60);
  const [mode, setMode] = useState("dotted"); // 'dotted' or 'triplet'

  // For visualization, we'll show 4 beats, each containing one dotted-eighth + sixteenth.
  const totalBeats = 4;
  const SUBDIV = 12; // multiple of both 3 and 4 for clean rendering
  const totalSubs = totalBeats * SUBDIV;

  const onTick = useCallback((idx, when, audio) => {
    const beatPos = idx % SUBDIV;
    if (mode === "dotted") {
      // Dotted = first note 9/12 of beat, second note last 3/12
      if (beatPos === 0) audio.note(noteFreq(PITCH.G4), when, (9 / 12) * (60 / bpm) * 0.95);
      if (beatPos === 9) audio.note(noteFreq(PITCH.A4), when, (3 / 12) * (60 / bpm) * 0.95);
    } else {
      // Triplet (long-short, swung) = 8/12 + 4/12
      if (beatPos === 0) audio.note(noteFreq(PITCH.G4), when, (8 / 12) * (60 / bpm) * 0.95);
      if (beatPos === 8) audio.note(noteFreq(PITCH.A4), when, (4 / 12) * (60 / bpm) * 0.95);
    }
    // Beat click on every beat
    if (beatPos === 0) audio.tick(when, 800, 0.07);
  }, [bpm, mode]);

  const t = useTransport({ bpm, subdivision: SUBDIV, totalSubdivisions: totalSubs, onTick });
  const beatExact = t.position / SUBDIV;
  const subInBeat = t.position % SUBDIV;

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        A <strong>dotted rhythm</strong> is a particular use of dotted notes: one note falls on the
        beat, another falls ¾ of the way through the beat. Written as{" "}
        <span className="mono-font">𝅘𝅥𝅮. 𝅘𝅥𝅯</span> — a dotted-eighth followed by a sixteenth. It's
        common enough that it's worth practicing on its own.
      </p>

      <YouTubeEmbed
        id="qj4Sh3rl6h4"
        title="Dotted rhythms — worked examples"
        caption="Benedict works through dotted rhythms in Dvořák's Largo, Albinoni's Adagio, Bizet's Toreador Song, and Verdi's La donna è mobile."
      />

      <Insight>
        The rule: when playing a dotted rhythm, <strong>split the beat into 4</strong>, not 3. The
        first note takes ¾ of the beat (3 sixteenths); the second takes ¼ (1 sixteenth). The most
        common mistake is splitting it into 3 — making it sound like a triplet.
      </Insight>

      <div className="border border-stone-900 bg-amber-50 p-6" style={{ borderRadius: "2px" }}>
        {/* Mode toggle */}
        <div className="flex justify-center mb-6">
          <div className="inline-flex border border-stone-900 bg-amber-50 mono-font text-sm" style={{ borderRadius: "2px" }}>
            <button
              onClick={() => { t.stop(); setMode("dotted"); }}
              className={`px-4 py-2 transition-colors ${mode === "dotted" ? "bg-stone-900 text-amber-50" : "hover:bg-stone-200/60"}`}
            >
              ✓ Correct (split in 4)
            </button>
            <button
              onClick={() => { t.stop(); setMode("triplet"); }}
              className={`px-4 py-2 transition-colors border-l border-stone-900 ${mode === "triplet" ? "bg-red-800 text-amber-50" : "hover:bg-stone-200/60"}`}
            >
              ✗ Common mistake (split in 3)
            </button>
          </div>
        </div>

        {/* Visualization: a single beat with subdivisions */}
        <div className="space-y-4">
          <div>
            <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">
              One beat, {mode === "dotted" ? "split into 4 sixteenths" : "split into 3 (triplet)"}
            </div>
            <div className="relative h-16 bg-stone-100 border border-stone-300 mb-2">
              {/* Subdivision marks */}
              {mode === "dotted" ? (
                <>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="absolute top-0 bottom-0 w-px bg-stone-400" style={{ left: `${i * 25}%` }} />
                  ))}
                  {/* The two notes */}
                  <div className="absolute top-1 bottom-1 left-0 bg-stone-700/80 flex items-center justify-center text-amber-50 mono-font text-sm" style={{ width: "75%" }}>
                    dotted 8th (¾ beat)
                  </div>
                  <div className="absolute top-1 bottom-1 bg-amber-700/80 flex items-center justify-center text-amber-50 mono-font text-xs" style={{ left: "75%", width: "25%" }}>
                    16th
                  </div>
                </>
              ) : (
                <>
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="absolute top-0 bottom-0 w-px bg-stone-400" style={{ left: `${(i / 3) * 100}%` }} />
                  ))}
                  <div className="absolute top-1 bottom-1 left-0 bg-stone-700/80 flex items-center justify-center text-amber-50 mono-font text-sm" style={{ width: "66.66%" }}>
                    long (⅔ beat)
                  </div>
                  <div className="absolute top-1 bottom-1 bg-amber-700/80 flex items-center justify-center text-amber-50 mono-font text-xs" style={{ left: "66.66%", width: "33.33%" }}>
                    short
                  </div>
                </>
              )}
              {/* Playhead within current beat */}
              {t.playing && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-red-700"
                  style={{ left: `${(subInBeat / SUBDIV) * 100}%` }}
                />
              )}
            </div>
            <div className="flex justify-between text-xs mono-font text-stone-500">
              {mode === "dotted"
                ? <><span>1</span><span>e</span><span>+</span><span>a</span><span>(next beat)</span></>
                : <><span>1</span><span>(2/3)</span><span>(3/3)</span><span>(next beat)</span></>
              }
            </div>
          </div>

          {/* Notation showing 4 of these in a row */}
          <div>
            <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">In notation</div>
            <svg viewBox="0 0 600 100" className="w-full" style={{ maxHeight: "100px" }}>
              <Staff x={50} y={50} width={520} unit={5} />
              <TrebleClef x={70} y={50} unit={5} />
              <TimeSignature x={100} y={45} top="4" bottom="4" unit={5} />
              {[0, 1, 2, 3].map((b) => {
                const beatX = 130 + b * 110;
                const isPlayingBeat = Math.floor(beatExact) === b && t.playing;
                return (
                  <g key={b}>
                    {mode === "dotted" ? (
                      <>
                        <Note x={beatX} y={45} type="eighth" dotted={true} unit={6} stemUp={true} />
                        <Note x={beatX + 60} y={45} type="sixteenth" unit={6} stemUp={true} />
                      </>
                    ) : (
                      <>
                        {/* Pseudo-triplet: just two notes, but spaced in 2:1 */}
                        <Note x={beatX} y={45} type="eighth" unit={6} stemUp={true} />
                        <Note x={beatX + 53} y={45} type="eighth" unit={6} stemUp={true} />
                        <text x={beatX + 25} y={20} fontSize={9} fill="#9a1f1f" fontStyle="italic" textAnchor="middle">3</text>
                      </>
                    )}
                    <text x={beatX + 5} y={85} fontSize={11} fill={isPlayingBeat ? "#9a1f1f" : "#666"} className="mono-font" fontWeight={700}>
                      {b + 1}
                    </text>
                  </g>
                );
              })}
              <BarLine x={570} y={50} unit={10} thick />
            </svg>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-6">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play (slow it down to hear)</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="mt-4">
          <Slider label="BPM" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={40} max={120} suffix=" bpm" />
        </div>
      </div>

      <div className="border border-stone-900 bg-amber-50 p-5" style={{ borderRadius: "2px" }}>
        <p className="font-semibold display-font text-lg mb-2">Why this matters</p>
        <p className="text-stone-800 leading-relaxed text-base">
          The "wrong" version sounds swung — like a jazz shuffle or a lazy lullaby. The "right"
          version sounds crisp and martial — think of the opening of an orchestral fanfare.
          They're <em>different rhythms</em> and reading them correctly is part of reading the
          composer's intention.
        </p>
      </div>

      <Caption>
        At slow tempos the difference is obvious. At fast tempos players often unconsciously
        flatten dotted rhythms into triplets — a habit worth catching early.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 9 — Rests
// Animation goal: A rest is a symbol for silence. Show the chart of rest
// symbols, then play a rhythm that mixes notes and rests — visually showing
// "sound" vs "silence" segments.
// ============================================================================

function Lesson9() {
  const [bpm, setBpm] = useState(70);

  // A rhythm with mixed notes and rests: | q  R  q  q | q  q  R  q | (R = quarter rest)
  // For demo, use eighth-rest pairs with eighth notes too.
  const rhythm = useMemo(() => {
    return [
      { pos: 0, beats: 1, type: "quarter", isRest: false, pitch: PITCH.E4 },
      { pos: 1, beats: 1, type: "quarter", isRest: true },
      { pos: 2, beats: 1, type: "quarter", isRest: false, pitch: PITCH.G4 },
      { pos: 3, beats: 1, type: "quarter", isRest: false, pitch: PITCH.A4 },
      // Bar 2
      { pos: 4, beats: 0.5, type: "eighth", isRest: false, pitch: PITCH.G4 },
      { pos: 4.5, beats: 0.5, type: "eighth", isRest: true },
      { pos: 5, beats: 0.5, type: "eighth", isRest: false, pitch: PITCH.E4 },
      { pos: 5.5, beats: 0.5, type: "eighth", isRest: false, pitch: PITCH.G4 },
      { pos: 6, beats: 2, type: "half", isRest: false, pitch: PITCH.C5 },
    ];
  }, []);

  const totalBeats = 8;
  const SUBDIV = 2;
  const totalSubs = totalBeats * SUBDIV;
  const noteStarts = useMemo(() => rhythm.map((n) => Math.round(n.pos * SUBDIV)), [rhythm]);

  const onTick = useCallback((idx, when, audio) => {
    const ni = noteStarts.indexOf(idx);
    if (ni >= 0) {
      const n = rhythm[ni];
      if (!n.isRest) {
        audio.note(noteFreq(n.pitch), when, n.beats * (60 / bpm) * 0.9);
      }
    }
    if (idx % SUBDIV === 0) {
      const beat = Math.floor(idx / SUBDIV) % 4;
      audio.tick(when, beat === 0 ? 900 : 600, 0.07);
    }
  }, [bpm, rhythm, noteStarts]);

  const t = useTransport({ bpm, subdivision: SUBDIV, totalSubdivisions: totalSubs, onTick });
  const beatExact = t.position / SUBDIV;

  const REST_CHART = [
    { name: "Whole rest", type: "whole", beats: 4 },
    { name: "Half rest", type: "half", beats: 2 },
    { name: "Quarter rest", type: "quarter", beats: 1 },
    { name: "Eighth rest", type: "eighth", beats: 0.5 },
    { name: "Sixteenth rest", type: "sixteenth", beats: 0.25 },
  ];

  // Layout for the rhythm
  const BEAT_W = 60;
  const STAFF_X = 80;
  const STAFF_Y = 60;
  const STAFF_W = totalBeats * BEAT_W + 30;

  const pitchY = (midi) => {
    const diatonic = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    return STAFF_Y - (diatonic[pc] + oct * 7 - (diatonic[11] + 4 * 7)) * 5;
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        A <strong>rest</strong> is a symbol that tells you <em>not</em> to play anything for a
        certain period of time. A 1-beat rest = silence for 1 beat, a 2-beat rest = silence for 2
        beats, and so on. Every note duration has a matching rest.
      </p>

      <YouTubeEmbed
        id="41GwV7KssfI"
        title="Rests — deducing the symbols from real scores"
        caption="Just as we deduced the note symbols from Ode to Joy, we can deduce most of the rest symbols from scores."
      />

      <Insight>
        Unlike notes (where heavier = half as long), rest symbols are mostly arbitrary and just
        have to be memorized — except for ⅛- and ¹⁄₁₆-rests, which gain tails like the notes do.
      </Insight>

      {/* Chart */}
      <div className="border border-stone-900 bg-amber-50 p-6" style={{ borderRadius: "2px" }}>
        <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-4">
          The rest chart
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {REST_CHART.map((r) => (
            <div key={r.name} className="border border-stone-300 p-3 bg-stone-50 text-center" style={{ borderRadius: "2px" }}>
              <svg viewBox="0 0 60 60" width="60" height="60" className="mx-auto">
                <g transform="translate(30, 30)">
                  {/* Mini staff */}
                  <line x1={-25} y1={0} x2={25} y2={0} stroke="#ddd" strokeWidth={0.5} />
                  <line x1={-25} y1={-10} x2={25} y2={-10} stroke="#ddd" strokeWidth={0.5} />
                  <line x1={-25} y1={10} x2={25} y2={10} stroke="#ddd" strokeWidth={0.5} />
                  <Rest x={0} y={0} type={r.type} unit={9} />
                </g>
              </svg>
              <p className="mono-font text-xs mt-1 text-stone-700">{r.name}</p>
              <p className="mono-font text-xs text-stone-500">
                {r.beats} {r.beats === 1 ? "beat" : "beats"}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Played example */}
      <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
        <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-3">
          A rhythm with rests
        </div>

        <div className="overflow-x-auto pb-2">
          <svg viewBox={`0 0 ${STAFF_X + STAFF_W + 20} 160`} className="block" style={{ minWidth: "640px", width: "100%" }}>
            <Staff x={STAFF_X} y={STAFF_Y} width={STAFF_W} unit={5} />
            <TrebleClef x={STAFF_X + 20} y={STAFF_Y} unit={5} />
            <TimeSignature x={STAFF_X + 50} y={STAFF_Y - 5} top="4" bottom="4" unit={5} />

            {[0, 1, 2].map((b) => (
              <BarLine key={b} x={STAFF_X + 65 + b * 4 * BEAT_W} y={STAFF_Y} unit={10} thick={b === 2} />
            ))}

            {rhythm.map((n, i) => {
              const x = STAFF_X + 65 + n.pos * BEAT_W + 18;
              const isPlaying = beatExact >= n.pos && beatExact < n.pos + n.beats;
              const color = isPlaying ? "#9a1f1f" : "#1c1917";
              if (n.isRest) {
                return (
                  <g key={i} style={{ color }}>
                    <Rest x={x} y={STAFF_Y} type={n.type} unit={6} />
                  </g>
                );
              }
              const y = pitchY(n.pitch);
              const stemUp = n.pitch < PITCH.B4;
              return (
                <g key={i} style={{ color }}>
                  <Note x={x} y={y} type={n.type} stemUp={stemUp} unit={6} />
                </g>
              );
            })}

            {/* Beat numbers */}
            {Array.from({ length: totalBeats }, (_, i) => (
              <text
                key={i}
                x={STAFF_X + 65 + i * BEAT_W + 18}
                y={STAFF_Y + 50}
                textAnchor="middle"
                fontSize={13}
                fontWeight={i % 4 === 0 ? 700 : 500}
                fill={Math.floor(beatExact) === i && t.playing ? "#9a1f1f" : "#666"}
                className="mono-font"
              >
                {(i % 4) + 1}
              </text>
            ))}

            {t.playing && (
              <line
                x1={STAFF_X + 65 + beatExact * BEAT_W + 18}
                x2={STAFF_X + 65 + beatExact * BEAT_W + 18}
                y1={STAFF_Y - 30}
                y2={STAFF_Y + 40}
                stroke="#9a1f1f" strokeWidth={1.5} opacity={0.5}
              />
            )}
          </svg>
        </div>

        {/* Sound/silence visualization */}
        <div>
          <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">
            Sound vs silence
          </div>
          <div className="relative h-8 bg-stone-100 border border-stone-300">
            {rhythm.map((n, i) => {
              const left = (n.pos / totalBeats) * 100;
              const width = (n.beats / totalBeats) * 100;
              return (
                <div
                  key={i}
                  className={`absolute top-0 bottom-0 ${n.isRest ? "" : "bg-stone-700/70"}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={n.isRest ? "silence" : "sound"}
                />
              );
            })}
            {[1, 2, 3, 4, 5, 6, 7].map((b) => (
              <div key={b} className="absolute top-0 bottom-0 w-px bg-stone-400" style={{ left: `${(b / totalBeats) * 100}%` }} />
            ))}
            {t.playing && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-red-700"
                style={{ left: `${(beatExact / totalBeats) * 100}%` }}
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-4">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="mt-4">
          <Slider label="BPM" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={40} max={140} suffix=" bpm" />
        </div>
      </div>

      <Caption>
        <strong>Important:</strong> the symbol for a 4-beat rest is <em>also</em> the symbol for a
        bar-long rest, even if the bar isn't 4 beats long. So a whole-rest in 3/4 means rest for 3
        beats; in 6/8, rest for the whole bar. You'll see this in pieces like Ponchielli's "Dance
        of the Hours" (3/4) and Saint-Saëns's "The Swan" (6/4) — bars that look like they have a
        4-beat rest are actually full-bar rests.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 10 — Staccato notes
// Animation goal: Toggle between "written" (note with dot above) and
// "played" (note half its length + rest of equal length). Hear and see
// the difference. The dot is ABOVE the note, not after it.
// ============================================================================

function Lesson10() {
  const [bpm, setBpm] = useState(80);
  const [showAs, setShowAs] = useState("written"); // 'written' | 'played'

  // Use the opening of Haydn's Surprise Symphony — staccato quarter notes.
  const rhythm = useMemo(() => {
    return [
      { pos: 0, beats: 1, type: "quarter", pitch: PITCH.C4 },
      { pos: 1, beats: 1, type: "quarter", pitch: PITCH.C4 },
      { pos: 2, beats: 1, type: "quarter", pitch: PITCH.E4 },
      { pos: 3, beats: 1, type: "quarter", pitch: PITCH.E4 },
      { pos: 4, beats: 1, type: "quarter", pitch: PITCH.G4 },
      { pos: 5, beats: 1, type: "quarter", pitch: PITCH.G4 },
      { pos: 6, beats: 2, type: "half", pitch: PITCH.E4 },
    ];
  }, []);

  const totalBeats = 8;
  const SUBDIV = 4; // sixteenth resolution so we can model "half + half"
  const totalSubs = totalBeats * SUBDIV;
  const noteStarts = useMemo(() => rhythm.map((n) => Math.round(n.pos * SUBDIV)), [rhythm]);

  const onTick = useCallback((idx, when, audio) => {
    const ni = noteStarts.indexOf(idx);
    if (ni >= 0) {
      const n = rhythm[ni];
      // Staccato quarters get half their written length.
      const isStaccato = n.type === "quarter";
      const playDur = isStaccato ? n.beats * 0.5 : n.beats;
      audio.note(noteFreq(n.pitch), when, playDur * (60 / bpm) * 0.95);
    }
    if (idx % SUBDIV === 0) {
      const beat = Math.floor(idx / SUBDIV) % 4;
      audio.tick(when, beat === 0 ? 900 : 600, 0.07);
    }
  }, [bpm, rhythm, noteStarts]);

  const t = useTransport({ bpm, subdivision: SUBDIV, totalSubdivisions: totalSubs, onTick });
  const beatExact = t.position / SUBDIV;

  const BEAT_W = 60;
  const STAFF_X = 80;
  const STAFF_Y = 60;
  const STAFF_W = totalBeats * BEAT_W + 30;
  const pitchY = (midi) => {
    const diatonic = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    return STAFF_Y - (diatonic[pc] + oct * 7 - (diatonic[11] + 4 * 7)) * 5;
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        A dot <em>above or below</em> a note (not <em>after</em> it!) means{" "}
        <strong>staccato</strong> — Italian for "detached." The note is played short, with silence
        after it. You can hear it from the very opening of Haydn's "Surprise" Symphony:
      </p>

      <YouTubeEmbed
        id="fg9oSHL4J1g"
        title='Haydn — "Surprise" Symphony, "Andante" (first 18 seconds)'
        caption="Crisp, detached quarter notes — that's staccato."
      />

      <p className="leading-relaxed">
        Why does it sound short like that? Because of the rule below.
      </p>

      <Insight>
        The rule: a staccato note is played as <strong>a note half its length, followed by a rest
        of equal length</strong>. The total time still adds up to the written duration.
      </Insight>

      <div className="border border-stone-900 bg-amber-50 p-6" style={{ borderRadius: "2px" }}>
        {/* Visual rule explanation */}
        <div className="mb-6 grid grid-cols-1 sm:grid-cols-3 items-center gap-4 text-center">
          <div>
            <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">Written</div>
            <svg viewBox="0 0 100 80" className="mx-auto" width="100" height="80">
              <line x1={10} y1={40} x2={90} y2={40} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={50} x2={90} y2={50} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={60} x2={90} y2={60} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={30} x2={90} y2={30} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={20} x2={90} y2={20} stroke="#ddd" strokeWidth={0.5} />
              <Note x={50} y={45} type="quarter" staccato={true} unit={9} stemUp={true} />
            </svg>
          </div>
          <div className="display-font text-2xl">→ played as →</div>
          <div>
            <div className="mono-font text-xs text-stone-500 uppercase tracking-widest mb-2">Played</div>
            <svg viewBox="0 0 100 80" className="mx-auto" width="100" height="80">
              <line x1={10} y1={40} x2={90} y2={40} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={50} x2={90} y2={50} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={60} x2={90} y2={60} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={30} x2={90} y2={30} stroke="#ddd" strokeWidth={0.5} />
              <line x1={10} y1={20} x2={90} y2={20} stroke="#ddd" strokeWidth={0.5} />
              <Note x={35} y={45} type="eighth" unit={9} stemUp={true} />
              <Rest x={70} y={40} type="eighth" unit={7} />
            </svg>
          </div>
        </div>

        {/* Toggle for the played example */}
        <div className="flex justify-center mb-6">
          <div className="inline-flex border border-stone-900 mono-font text-sm" style={{ borderRadius: "2px" }}>
            <button
              onClick={() => setShowAs("written")}
              className={`px-4 py-2 ${showAs === "written" ? "bg-stone-900 text-amber-50" : "bg-amber-50 hover:bg-stone-200/60"}`}
            >
              Written
            </button>
            <button
              onClick={() => setShowAs("played")}
              className={`px-4 py-2 border-l border-stone-900 ${showAs === "played" ? "bg-stone-900 text-amber-50" : "bg-amber-50 hover:bg-stone-200/60"}`}
            >
              Played
            </button>
          </div>
        </div>

        {/* Score */}
        <div className="overflow-x-auto pb-2">
          <svg viewBox={`0 0 ${STAFF_X + STAFF_W + 20} 160`} className="block" style={{ minWidth: "640px", width: "100%" }}>
            <Staff x={STAFF_X} y={STAFF_Y} width={STAFF_W} unit={5} />
            <TrebleClef x={STAFF_X + 20} y={STAFF_Y} unit={5} />
            <TimeSignature x={STAFF_X + 50} y={STAFF_Y - 5} top="4" bottom="4" unit={5} />
            {[0, 1, 2].map((b) => (
              <BarLine key={b} x={STAFF_X + 65 + b * 4 * BEAT_W} y={STAFF_Y} unit={10} thick={b === 2} />
            ))}

            {showAs === "written"
              ? rhythm.map((n, i) => {
                  const x = STAFF_X + 65 + n.pos * BEAT_W + 18;
                  const y = pitchY(n.pitch);
                  const isStacc = n.type === "quarter";
                  const isPlaying = beatExact >= n.pos && beatExact < n.pos + (isStacc ? n.beats * 0.5 : n.beats);
                  return (
                    <g key={i} style={{ color: isPlaying ? "#9a1f1f" : "#1c1917" }}>
                      <Note x={x} y={y} type={n.type} staccato={isStacc} stemUp={n.pitch < PITCH.B4} unit={6} />
                    </g>
                  );
                })
              : rhythm.map((n, i) => {
                  // "Played" view: staccato becomes eighth-note + eighth-rest; non-staccato stays.
                  const isStacc = n.type === "quarter";
                  const x = STAFF_X + 65 + n.pos * BEAT_W + 18;
                  const y = pitchY(n.pitch);
                  if (!isStacc) {
                    const isPlaying = beatExact >= n.pos && beatExact < n.pos + n.beats;
                    return (
                      <g key={i} style={{ color: isPlaying ? "#9a1f1f" : "#1c1917" }}>
                        <Note x={x} y={y} type={n.type} stemUp={n.pitch < PITCH.B4} unit={6} />
                      </g>
                    );
                  }
                  const isPlayingNote = beatExact >= n.pos && beatExact < n.pos + 0.5;
                  return (
                    <g key={i}>
                      <g style={{ color: isPlayingNote ? "#9a1f1f" : "#1c1917" }}>
                        <Note x={x} y={y} type="eighth" stemUp={n.pitch < PITCH.B4} unit={6} />
                      </g>
                      <g style={{ color: "#1c1917" }}>
                        <Rest x={x + 22} y={STAFF_Y} type="eighth" unit={5} />
                      </g>
                    </g>
                  );
                })}

            {/* Beat numbers */}
            {Array.from({ length: totalBeats }, (_, i) => (
              <text
                key={i}
                x={STAFF_X + 65 + i * BEAT_W + 18}
                y={STAFF_Y + 50}
                textAnchor="middle"
                fontSize={13}
                fontWeight={i % 4 === 0 ? 700 : 500}
                fill={Math.floor(beatExact) === i && t.playing ? "#9a1f1f" : "#666"}
                className="mono-font"
              >
                {(i % 4) + 1}
              </text>
            ))}

            {t.playing && (
              <line
                x1={STAFF_X + 65 + beatExact * BEAT_W + 18}
                x2={STAFF_X + 65 + beatExact * BEAT_W + 18}
                y1={STAFF_Y - 30}
                y2={STAFF_Y + 45}
                stroke="#9a1f1f" strokeWidth={1.5} opacity={0.5}
              />
            )}
          </svg>
        </div>

        <div className="text-center mb-4">
          <p className="text-sm italic text-stone-700">
            Haydn's "Surprise" Symphony — staccato quarters become short notes with breathing
            space between them. Same audio either way; only the notation differs.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="mt-4">
          <Slider label="BPM" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={40} max={140} suffix=" bpm" />
        </div>
      </div>

      <h3 className="display-font text-2xl font-black mt-8">Two more examples</h3>
      <p className="leading-relaxed">
        The same trick is used in Bizet's "Toreador Song" — the left hand is{" "}
        <em>written</em> as plain quarter notes with staccato dots, but is <em>played</em> as
        eighth-note + eighth-rest pairs:
      </p>

      <YouTubeEmbed
        id="BZly4o23Cqw"
        title='Bizet — "Toreador Song"'
        caption="Listen for the bouncy, detached left hand."
      />

      <p className="leading-relaxed">
        And one more wrinkle: <em>sometimes a staccato note is even shorter than half its
        length</em>. In the original orchestral version of Albinoni's Adagio the bass was{" "}
        <em>pizzicato</em> (plucked strings), so Benedict notates it as staccato quarter notes —
        but recommends playing them as <strong>1⁄16-notes</strong> (a quarter of their written
        length) to get the full pizzicato effect:
      </p>

      <YouTubeEmbed
        id="0VSKn00faGQ"
        title="Albinoni — Adagio (with pizzicato bass)"
        caption="The staccato quarters in the bass are played as 1⁄16-notes — even shorter than the rule says."
      />

      <Caption>
        Why not just write the actual rests? Because staccato dots are easier to read and write —
        much less cluttered. Music notation grew up by hand, and economy on the page mattered.{" "}
        <strong>Don't confuse</strong> a staccato dot (above/below the note) with an augmentation
        dot (after the note, lengthening it).
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 11 — Counting ⅛-beats (32nd notes)
// Animation goal: At slow tempos, even a 16th note is too coarse a grid.
// Show a passage with 32nd notes and how you'd insert an extra "and" between
// the existing "1 e + a" syllables.
// ============================================================================

function Lesson11() {
  const [bpm, setBpm] = useState(40); // slow because this is fine subdivision

  // A 1-bar pattern with 32nd note flourishes — common in slow Adagio movements.
  // Beat 1: q
  // Beat 2: e e
  // Beat 3: 16 16 16 16
  // Beat 4: 32 32 32 32 32 32 32 32 (eight 32nd notes)
  const rhythm = useMemo(() => {
    return [
      { pos: 0,     beats: 1,    type: "quarter",   pitch: PITCH.C5 },
      { pos: 1,     beats: 0.5,  type: "eighth",    pitch: PITCH.D5 },
      { pos: 1.5,   beats: 0.5,  type: "eighth",    pitch: PITCH.E5 },
      { pos: 2,     beats: 0.25, type: "sixteenth", pitch: PITCH.F5 },
      { pos: 2.25,  beats: 0.25, type: "sixteenth", pitch: PITCH.E5 },
      { pos: 2.5,   beats: 0.25, type: "sixteenth", pitch: PITCH.D5 },
      { pos: 2.75,  beats: 0.25, type: "sixteenth", pitch: PITCH.E5 },
      // Eight 32nd notes (drawn as sixteenths since we don't have 32nd note rendering — close enough for the demo)
      { pos: 3,      beats: 0.125, type: "sixteenth", pitch: PITCH.F5 },
      { pos: 3.125,  beats: 0.125, type: "sixteenth", pitch: PITCH.G5 },
      { pos: 3.25,   beats: 0.125, type: "sixteenth", pitch: PITCH.A4 },
      { pos: 3.375,  beats: 0.125, type: "sixteenth", pitch: PITCH.G5 },
      { pos: 3.5,    beats: 0.125, type: "sixteenth", pitch: PITCH.F5 },
      { pos: 3.625,  beats: 0.125, type: "sixteenth", pitch: PITCH.E5 },
      { pos: 3.75,   beats: 0.125, type: "sixteenth", pitch: PITCH.D5 },
      { pos: 3.875,  beats: 0.125, type: "sixteenth", pitch: PITCH.C5 },
    ];
  }, []);

  const totalBeats = 4;
  const SUBDIV = 8; // 32nd-note resolution
  const totalSubs = totalBeats * SUBDIV;
  const noteStarts = useMemo(() => rhythm.map((n) => Math.round(n.pos * SUBDIV)), [rhythm]);

  const onTick = useCallback((idx, when, audio) => {
    const ni = noteStarts.indexOf(idx);
    if (ni >= 0) {
      const n = rhythm[ni];
      audio.note(noteFreq(n.pitch), when, n.beats * (60 / bpm) * 0.85);
    }
    if (idx % SUBDIV === 0) {
      audio.tick(when, 900, 0.07);
    }
  }, [bpm, rhythm, noteStarts]);

  const t = useTransport({ bpm, subdivision: SUBDIV, totalSubdivisions: totalSubs, onTick });
  const beatExact = t.position / SUBDIV;

  // Per the Musophone instruction: "count the ¼-beats normally (1 e + a) and
  // slip an 'and' between each pair." We label the four ¼-beat positions
  // explicitly and use a small ampersand on the in-between ⅛-beat positions
  // (so it's visually clear which is which).
  const SYLLABLES_32 = [];
  for (let beat = 1; beat <= 4; beat++) {
    SYLLABLES_32.push({ s: String(beat), main: true });
    SYLLABLES_32.push({ s: "&", main: false, extra: true });   // ⅛-beat between 1 and e
    SYLLABLES_32.push({ s: "e", main: true });
    SYLLABLES_32.push({ s: "&", main: false, extra: true });   // ⅛-beat between e and +
    SYLLABLES_32.push({ s: "+", main: true });
    SYLLABLES_32.push({ s: "&", main: false, extra: true });   // ⅛-beat between + and a
    SYLLABLES_32.push({ s: "a", main: true });
    SYLLABLES_32.push({ s: "&", main: false, extra: true });   // ⅛-beat between a and next beat
  }

  const BEAT_W = 130;
  const STAFF_X = 80;
  const STAFF_Y = 70;
  const STAFF_W = totalBeats * BEAT_W + 30;

  const pitchY = (midi) => {
    const diatonic = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    return STAFF_Y - (diatonic[pc] + oct * 7 - (diatonic[11] + 4 * 7)) * 5;
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        ⅛-beat notes — 32nd notes — appear in slow movements where the underlying tempo is so
        relaxed that even sixteenths feel slow. Beethoven's <em>Adagio Cantabile</em> and
        Albinoni's <em>Adagio</em> use them this way.
      </p>

      <YouTubeEmbed
        id="A8dsgqpSrVU"
        title="Counting ⅛-beats — worked examples"
        caption="The trick: count the ¼-beats normally, then drop an extra 'and' between each one for the ⅛-beat positions."
      />

      <Insight>
        The trick: keep counting "<strong>1 e + a 2 e + a</strong>" as before, but slip an
        extra <strong>"+"</strong> ("and") between each syllable. So a beat split into 8 reads
        as: <span className="mono-font">1 + e + + + a +</span> — though in practice you mostly feel them
        rather than count every one.
      </Insight>

      <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
        <div className="overflow-x-auto pb-2">
          <svg viewBox={`0 0 ${STAFF_X + STAFF_W + 20} 200`} className="block" style={{ minWidth: "640px", width: "100%" }}>
            <Staff x={STAFF_X} y={STAFF_Y} width={STAFF_W} unit={5} />
            <TrebleClef x={STAFF_X + 20} y={STAFF_Y} unit={5} />
            <TimeSignature x={STAFF_X + 50} y={STAFF_Y - 5} top="4" bottom="4" unit={5} />
            <BarLine x={STAFF_X + 65 + totalBeats * BEAT_W} y={STAFF_Y} unit={10} thick />

            {rhythm.map((n, i) => {
              const x = STAFF_X + 65 + n.pos * BEAT_W + 18;
              const y = pitchY(n.pitch);
              const isPlaying = beatExact >= n.pos && beatExact < n.pos + n.beats;
              return (
                <g key={i} style={{ color: isPlaying ? "#9a1f1f" : "#1c1917" }}>
                  <Note x={x} y={y} type={n.type} stemUp={n.pitch < PITCH.B4} unit={5} />
                </g>
              );
            })}

            {/* Subdivision tick marks: every 32nd note */}
            {Array.from({ length: totalSubs + 1 }, (_, i) => {
              const x = STAFF_X + 65 + (i / SUBDIV) * BEAT_W + 18;
              const isBeat = i % SUBDIV === 0;
              const isQuarterBeat = i % (SUBDIV / 4) === 0;
              return (
                <line
                  key={i}
                  x1={x} x2={x}
                  y1={STAFF_Y + 25}
                  y2={STAFF_Y + (isBeat ? 38 : isQuarterBeat ? 33 : 30)}
                  stroke={isBeat ? "#1c1917" : isQuarterBeat ? "#888" : "#ccc"}
                  strokeWidth={isBeat ? 1 : 0.5}
                />
              );
            })}

            {/* 32nd-note syllables */}
            {SYLLABLES_32.map((sy, i) => {
              const x = STAFF_X + 65 + (i / SUBDIV) * BEAT_W + 18;
              const isCurrent = Math.floor(t.position) === i && t.playing;
              const isMainBeat = i % SUBDIV === 0;
              return (
                <text
                  key={i}
                  x={x} y={STAFF_Y + 55}
                  textAnchor="middle"
                  fontSize={isMainBeat ? 14 : sy.extra ? 9 : 11}
                  fontWeight={isMainBeat ? 700 : 500}
                  fill={isCurrent ? "#9a1f1f" : isMainBeat ? "#1c1917" : sy.extra ? "#bbb" : "#888"}
                  fontStyle={!isMainBeat ? "italic" : "normal"}
                  className="mono-font"
                >
                  {sy.s}
                </text>
              );
            })}

            {t.playing && (
              <line
                x1={STAFF_X + 65 + beatExact * BEAT_W + 18}
                x2={STAFF_X + 65 + beatExact * BEAT_W + 18}
                y1={STAFF_Y - 30}
                y2={STAFF_Y + 45}
                stroke="#9a1f1f" strokeWidth={1.5} opacity={0.5}
              />
            )}
          </svg>
        </div>

        <div className="text-center my-4 text-sm italic text-stone-700">
          Beat 1: a quarter. Beat 2: two eighths. Beat 3: four sixteenths. Beat 4: eight 32nd notes.
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!t.playing ? (
            <Button onClick={t.start} primary><Play size={18} /> Play (slow!)</Button>
          ) : (
            <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
          )}
          <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
        </div>

        <div className="mt-4">
          <Slider label="BPM" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={20} max={80} suffix=" bpm" />
        </div>
      </div>

      <Caption>
        At the very slow tempos where 32nd notes appear, you don't actually count every sub-syllable
        out loud — you feel the gestures. The counting framework is just there for when you need
        to <em>analyze</em> a tricky bar carefully.
      </Caption>
    </div>
  );
}
// ============================================================================
// LESSON 12 — Time signatures
// Animation goal: Show what top/bottom numbers mean. Especially: 3/4 vs 6/8
// — same six 1/8-notes, grouped differently. Show, hear, and feel the
// difference. Plus an optional Bernstein "America" demo where the meter
// alternates.
// ============================================================================

function Lesson12() {
  const [demo, setDemo] = useState("3v6"); // '3v6', 'top', 'bottom', 'compound'
  const [bpm, setBpm] = useState(80);
  const [meter, setMeter] = useState("3/4"); // for the 3v6 demo

  // For 3/4: 6 eighth notes grouped 2+2+2 = 3 beats, each split in 2.
  // For 6/8: 6 eighth notes grouped 3+3 = 2 beats, each split in 3.
  // Same 6 pitches, same total time — different stress pattern.
  const sixNotes = useMemo(() => [PITCH.G4, PITCH.A4, PITCH.B4, PITCH.C5, PITCH.B4, PITCH.A4], []);

  // 12 SUBDIVISIONS = 1 bar (so 6 eighth notes are at 0,2,4,6,8,10).
  const SUBDIV = 12;
  // Total bars to play: 4
  const BARS = 4;
  const totalSubs = SUBDIV * BARS;

  // Tick at the 16th-note level (subdivision=4 per quarter beat).
  // SUBDIV = 12 ticks per bar means each bar = 3 quarter notes = 6 eighth notes.
  // So bpm (quarter-note pulse) directly drives playback. 1 eighth = 2 ticks.
  const eighthDur = 60 / bpm / 2; // seconds per eighth note
  const onTick = useCallback((idx, when, audio) => {
    const subInBar = idx % SUBDIV;
    // Notes start at sub 0,2,4,6,8,10 (eighth-note positions)
    if (subInBar % 2 === 0) {
      const noteIdx = subInBar / 2;
      audio.note(noteFreq(sixNotes[noteIdx]), when, eighthDur * 0.9);
    }
    // Click pattern depends on meter
    if (meter === "3/4") {
      // 3 beats per bar at sub positions 0, 4, 8
      if (subInBar === 0) audio.click(when, true);
      else if (subInBar === 4 || subInBar === 8) audio.click(when, false);
    } else {
      // 6/8: 2 beats per bar (dotted quarters) at sub positions 0 and 6
      if (subInBar === 0) audio.click(when, true);
      else if (subInBar === 6) audio.click(when, false);
    }
  }, [eighthDur, meter, sixNotes]);

  const t = useTransport({ bpm, subdivision: 4, totalSubdivisions: totalSubs, onTick });

  const subPos = t.position;
  const subInBar = subPos % SUBDIV;
  const currentBar = Math.floor(subPos / SUBDIV);

  const NOTE_W = 56;
  const STAFF_X = 80;
  const STAFF_Y = 60;
  const STAFF_W = 6 * NOTE_W + 30;

  const pitchY = (midi) => {
    const diatonic = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    return STAFF_Y - (diatonic[pc] + oct * 7 - (diatonic[11] + 4 * 7)) * 5;
  };

  // For the simple top/bottom number demo
  const TOP_DEMO_DATA = {
    "2/4": { beatsPerBar: 2, label: "2 beats per bar" },
    "3/4": { beatsPerBar: 3, label: "3 beats per bar (waltz)" },
    "4/4": { beatsPerBar: 4, label: "4 beats per bar (most common)" },
    "5/4": { beatsPerBar: 5, label: "5 beats per bar (Take Five)" },
  };

  return (
    <div className="space-y-6">
      <p className="text-lg leading-relaxed">
        A time signature is the two stacked numbers at the start of a piece. Almost all popular
        music — pop, rock, hip hop, country, R&amp;B — is in 4/4, so for those genres you barely
        have to think about it. But classical, jazz, folk and alternative roam more: pieces in 4/2,
        3/4, 6/8, 12/8 and stranger.
      </p>

      <Insight>
        Two rules: <strong>(1)</strong> the top number tells you how many beats are in a bar.{" "}
        <strong>(2)</strong> the bottom number tells you what kind of note counts as 1 beat (4 =
        quarter, 2 = half, 8 = eighth). <strong>Exception:</strong> if the top is 6, 9, or 12, you
        actually have 2, 3, or 4 beats per bar, and each beat is split into 3 — that's a{" "}
        <em>compound</em> time signature.
      </Insight>

      {/* Demo selector */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setDemo("3v6")} className={`px-4 py-2 border text-sm transition-colors ${demo === "3v6" ? "border-stone-900 bg-stone-900 text-amber-50" : "border-stone-300 hover:border-stone-900 bg-amber-50"}`} style={{ borderRadius: "2px" }}>
          3/4 vs 6/8
        </button>
        <button onClick={() => setDemo("top")} className={`px-4 py-2 border text-sm transition-colors ${demo === "top" ? "border-stone-900 bg-stone-900 text-amber-50" : "border-stone-300 hover:border-stone-900 bg-amber-50"}`} style={{ borderRadius: "2px" }}>
          The top number
        </button>
        <button onClick={() => setDemo("bottom")} className={`px-4 py-2 border text-sm transition-colors ${demo === "bottom" ? "border-stone-900 bg-stone-900 text-amber-50" : "border-stone-300 hover:border-stone-900 bg-amber-50"}`} style={{ borderRadius: "2px" }}>
          The bottom number
        </button>
      </div>

      {demo === "3v6" && (
        <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
          <div className="flex justify-center mb-4">
            <div className="inline-flex border border-stone-900 mono-font text-base" style={{ borderRadius: "2px" }}>
              <button
                onClick={() => { t.stop(); setMeter("3/4"); }}
                className={`px-6 py-2 ${meter === "3/4" ? "bg-stone-900 text-amber-50" : "bg-amber-50 hover:bg-stone-200/60"}`}
              >
                3/4 — three beats split in 2
              </button>
              <button
                onClick={() => { t.stop(); setMeter("6/8"); }}
                className={`px-6 py-2 border-l border-stone-900 ${meter === "6/8" ? "bg-stone-900 text-amber-50" : "bg-amber-50 hover:bg-stone-200/60"}`}
              >
                6/8 — two beats split in 3
              </button>
            </div>
          </div>

          <div className="overflow-x-auto pb-2">
            <svg viewBox={`0 0 ${STAFF_X + STAFF_W + 20} 180`} className="block" style={{ minWidth: "560px", width: "100%" }}>
              <Staff x={STAFF_X} y={STAFF_Y} width={STAFF_W} unit={5} />
              <TrebleClef x={STAFF_X + 20} y={STAFF_Y} unit={5} />
              <TimeSignature
                x={STAFF_X + 50}
                y={STAFF_Y - 5}
                top={meter === "3/4" ? "3" : "6"}
                bottom={meter === "3/4" ? "4" : "8"}
                unit={5}
              />
              <BarLine x={STAFF_X + 65 + 6 * NOTE_W} y={STAFF_Y} unit={10} thick />

              {/* The six eighth notes */}
              {sixNotes.map((p, i) => {
                const x = STAFF_X + 65 + i * NOTE_W + 18;
                const y = pitchY(p);
                const subStart = i * 2;
                const isPlaying = currentBar < BARS && subInBar >= subStart && subInBar < subStart + 2;
                return (
                  <g key={i} style={{ color: isPlaying ? "#9a1f1f" : "#1c1917" }}>
                    <Note x={x} y={y} type="eighth" stemUp={p < PITCH.B4} unit={6} />
                  </g>
                );
              })}

              {/* Beat groupings (curly brace below) */}
              {meter === "3/4" ? (
                // 3 groups of 2
                [0, 1, 2].map((g) => {
                  const left = STAFF_X + 65 + g * 2 * NOTE_W + 5;
                  const right = STAFF_X + 65 + (g * 2 + 2) * NOTE_W + 8;
                  const beatNum = g + 1;
                  const isCurrent = currentBar < BARS && Math.floor(subInBar / 4) === g;
                  return (
                    <g key={g} style={{ color: isCurrent ? "#9a1f1f" : "#666" }}>
                      <line x1={left} y1={STAFF_Y + 30} x2={right} y2={STAFF_Y + 30} stroke="currentColor" strokeWidth={1} />
                      <line x1={left} y1={STAFF_Y + 30} x2={left} y2={STAFF_Y + 26} stroke="currentColor" strokeWidth={1} />
                      <line x1={right} y1={STAFF_Y + 30} x2={right} y2={STAFF_Y + 26} stroke="currentColor" strokeWidth={1} />
                      <text x={(left + right) / 2} y={STAFF_Y + 50} textAnchor="middle" fontSize={14} fontWeight={700} fill="currentColor" className="mono-font">
                        {beatNum}
                      </text>
                    </g>
                  );
                })
              ) : (
                // 2 groups of 3
                [0, 1].map((g) => {
                  const left = STAFF_X + 65 + g * 3 * NOTE_W + 5;
                  const right = STAFF_X + 65 + (g * 3 + 3) * NOTE_W + 8;
                  const beatNum = g + 1;
                  const isCurrent = currentBar < BARS && Math.floor(subInBar / 6) === g;
                  return (
                    <g key={g} style={{ color: isCurrent ? "#9a1f1f" : "#666" }}>
                      <line x1={left} y1={STAFF_Y + 30} x2={right} y2={STAFF_Y + 30} stroke="currentColor" strokeWidth={1} />
                      <line x1={left} y1={STAFF_Y + 30} x2={left} y2={STAFF_Y + 26} stroke="currentColor" strokeWidth={1} />
                      <line x1={right} y1={STAFF_Y + 30} x2={right} y2={STAFF_Y + 26} stroke="currentColor" strokeWidth={1} />
                      <text x={(left + right) / 2} y={STAFF_Y + 50} textAnchor="middle" fontSize={14} fontWeight={700} fill="currentColor" className="mono-font">
                        {beatNum}
                      </text>
                    </g>
                  );
                })
              )}

              {/* Eighth-note count syllables */}
              {sixNotes.map((_, i) => {
                const x = STAFF_X + 65 + i * NOTE_W + 18;
                const subStart = i * 2;
                const isCurrent = currentBar < BARS && subInBar >= subStart && subInBar < subStart + 2;
                let s;
                if (meter === "3/4") {
                  s = i % 2 === 0 ? String(Math.floor(i / 2) + 1) : "+";
                } else {
                  // 6/8: counted "1 2 3 4 5 6" or "1 la lee 2 la lee"
                  s = i % 3 === 0 ? String(Math.floor(i / 3) + 1) : (i % 3 === 1 ? "la" : "lee");
                }
                return (
                  <text
                    key={i}
                    x={x} y={STAFF_Y + 70}
                    textAnchor="middle"
                    fontSize={11}
                    fontStyle="italic"
                    fill={isCurrent ? "#9a1f1f" : "#888"}
                    className="mono-font"
                  >
                    {s}
                  </text>
                );
              })}
            </svg>
          </div>

          {/* Pulse indicators */}
          <div className="flex justify-center gap-1 mb-4 mt-2">
            {Array.from({ length: meter === "3/4" ? 3 : 2 }, (_, i) => {
              const isCurrent = currentBar < BARS && (
                meter === "3/4" ? Math.floor(subInBar / 4) === i : Math.floor(subInBar / 6) === i
              );
              return (
                <div
                  key={i}
                  className={`
                    flex flex-col items-center gap-1 px-3 py-2 transition-all
                    ${isCurrent ? "scale-110" : ""}
                  `}
                >
                  <div className={`
                    w-12 h-12 rounded-full border-2 transition-colors
                    ${isCurrent ? (i === 0 ? "bg-red-700 border-red-700" : "bg-stone-900 border-stone-900") : "border-stone-400"}
                  `} />
                  <span className="mono-font text-xs">{i + 1}</span>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {!t.playing ? (
              <Button onClick={t.start} primary><Play size={18} /> Play in {meter}</Button>
            ) : (
              <Button onClick={t.stop} primary><Pause size={18} /> Stop</Button>
            )}
            <Button onClick={t.reset}><RotateCcw size={16} /> Reset</Button>
          </div>

          <div className="mt-4">
            <Slider label="Tempo" value={bpm} onChange={(v) => { t.stop(); setBpm(v); }} min={40} max={140} suffix=" bpm" />
          </div>
        </div>
      )}

      {demo === "top" && <TopNumberDemo data={TOP_DEMO_DATA} />}
      {demo === "bottom" && <BottomNumberDemo />}

      <h3 className="display-font text-2xl font-black mt-8">Counting ½- or ⅛-notes as beats</h3>
      <p className="leading-relaxed">
        Examples where the bottom number is something other than 4 — so you get used to counting a
        ½-note or an ⅛-note as one beat:
      </p>

      <YouTubeEmbed
        id="bczJQSO4zto"
        title="The bottom number — worked examples"
        caption="Counting ½-notes as beats (4/2) and ⅛-notes as beats (3/8)."
      />

      <p className="leading-relaxed text-sm text-stone-700">
        The arithmetic works just like fractions: 4/2 = four ½-notes per bar, 6/4 = six ¼-notes per
        bar, 3/8 = three ⅛-notes per bar. Music teachers will tell you not to think of time
        signatures as fractions, and that's technically true — but they multiply like fractions.
      </p>

      <h3 className="display-font text-2xl font-black mt-8">Compound time signatures</h3>
      <p className="leading-relaxed">
        Look at the left hand of Chopin's <em>Nocturne Op. 9 No. 2</em> (in 12/8): the 12 ⅛-notes
        are grouped into <strong>4 groups of 3</strong>. So you don't count
        "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12" — you count{" "}
        <strong>1</strong>‑2‑3, <strong>2</strong>‑2‑3, <strong>3</strong>‑2‑3, <strong>4</strong>‑2‑3:
        4 beats, each split in 3.
      </p>

      <YouTubeEmbed
        id="08Y0YrB5FQY"
        title='6/8 in practice — Puccini "O mio babbino caro"'
        caption="Two beats per bar, each split into 3 ⅛-notes."
      />

      <ul className="list-disc pl-6 leading-relaxed text-stone-800">
        <li>Top number is <strong>6</strong> → 2 beats, each split into 3</li>
        <li>Top number is <strong>9</strong> → 3 beats, each split into 3</li>
        <li>Top number is <strong>12</strong> → 4 beats, each split into 3</li>
      </ul>

      <p className="leading-relaxed text-sm text-stone-700">
        <strong>Note:</strong> this rule applies to multiples of 3 <em>except 3 itself</em>.
        A bar of 3/4 isn't "1 beat split into 3" — it's just 3 beats (think Beethoven's "Für
        Elise" or any waltz).
      </p>

      <div className="border border-stone-900 bg-amber-50 p-5" style={{ borderRadius: "2px" }}>
        <p className="font-semibold display-font text-lg mb-2">The 3/4 vs 6/8 distinction</p>
        <p className="text-stone-800 leading-relaxed text-base">
          Both have six ⅛-notes per bar. But in <strong>3/4</strong> they group as three pairs
          (waltz feel: <em>OOM-pah, OOM-pah, OOM-pah</em>). In <strong>6/8</strong> they group as
          two triplets (lilting feel: <em>ONE-and-a, TWO-and-a</em>). Compare Brahms's Lullaby (3/4
          — three beats split in 2) with Puccini's "O mio babbino caro" (6/8 — two beats split in
          3). Same number of notes, totally different feel.
        </p>
      </div>

      <p className="leading-relaxed">
        Leonard Bernstein's "America" from <em>West Side Story</em> cleverly switches between the
        two patterns every couple of bars — a 3/4 bar followed by a 6/8 bar, repeated:
      </p>

      <YouTubeEmbed
        id="YhSKk-cvblc"
        title='Bernstein — "America" (West Side Story)'
        caption="Listen for the alternation between 3/4 and 6/8 — the very thing that makes the song feel like dancing."
      />

      <h3 className="display-font text-2xl font-black mt-8">5/4, 7/8, and other unusual signatures</h3>
      <p className="leading-relaxed">
        A few pieces use something other than 2, 3 or 4 beats per bar — Dave Brubeck's "Take
        Five" and the <em>Mission Impossible</em> theme are both in 5/4; Brubeck's "Unsquare
        Dance" is in 7/8. They're <em>notable</em> precisely because they're so unusual — don't
        worry about these until you encounter them, which might be never.
      </p>

      <Caption>
        That's the end of the rhythm course. From here, the next steps Benedict suggests are:
        learn pieces from the Intermediate Classical course, or work through{" "}
        <em>Read Music Fast! Part 1</em> (notes) and <em>Part 2</em> (intervals and key
        signatures) if you haven't already.
      </Caption>
    </div>
  );
}

// Sub-demo: just shows the top number changing how many beats are in a bar.
function TopNumberDemo({ data }) {
  const [sig, setSig] = useState("4/4");
  const cfg = data[sig];
  const [bpm, setBpm] = useState(90);

  const onTick = useCallback((idx, when, audio) => {
    audio.click(when, idx % cfg.beatsPerBar === 0);
  }, [cfg.beatsPerBar]);

  const t = useTransport({ bpm, subdivision: 1, totalSubdivisions: Infinity, onTick });
  const beatInBar = Math.floor(t.position % cfg.beatsPerBar);

  return (
    <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
      <div className="flex flex-wrap gap-2 mb-4 justify-center">
        {Object.keys(data).map((k) => (
          <button
            key={k}
            onClick={() => { t.stop(); setSig(k); }}
            className={`px-4 py-2 border mono-font text-sm ${sig === k ? "border-stone-900 bg-stone-900 text-amber-50" : "border-stone-300 hover:border-stone-900"}`}
            style={{ borderRadius: "2px" }}
          >
            {k}
          </button>
        ))}
      </div>
      <p className="text-center mb-4 text-stone-700 italic">{cfg.label}</p>

      <div className="flex justify-center gap-2 mb-4">
        {Array.from({ length: cfg.beatsPerBar }, (_, i) => {
          const isFirst = i === 0;
          const isCurrent = t.playing && beatInBar === i;
          return (
            <div
              key={i}
              className={`
                w-12 h-12 rounded-full border-2 transition-all flex items-center justify-center mono-font font-bold
                ${isCurrent ? (isFirst ? "bg-red-700 border-red-700 text-amber-50" : "bg-stone-900 border-stone-900 text-amber-50") : "border-stone-400"}
                ${isFirst && !isCurrent ? "border-red-700/50" : ""}
              `}
            >
              {i + 1}
            </div>
          );
        })}
      </div>

      <div className="flex justify-center gap-3">
        {!t.playing ? (
          <Button onClick={t.start} primary><Play size={16} /> Play</Button>
        ) : (
          <Button onClick={t.stop} primary><Pause size={16} /> Stop</Button>
        )}
      </div>
      <div className="mt-3"><Slider label="BPM" value={bpm} onChange={setBpm} min={40} max={160} suffix=" bpm" /></div>
    </div>
  );
}

// Sub-demo: bottom number changes which note type = 1 beat
function BottomNumberDemo() {
  const VARIANTS = [
    { sig: "4/2", note: "half", desc: "in 4/2, four half notes per bar (= 1 beat each)" },
    { sig: "4/4", note: "quarter", desc: "in 4/4, four quarter notes per bar (= 1 beat each)" },
    { sig: "4/8", note: "eighth", desc: "in 4/8, four eighth notes per bar (= 1 beat each)" },
  ];
  const [v, setV] = useState(1);
  const cfg = VARIANTS[v];
  const [bpm, setBpm] = useState(80);

  const onTick = useCallback((idx, when, audio) => {
    audio.click(when, idx % 4 === 0);
    audio.note(noteFreq(idx % 4 === 0 ? PITCH.G4 : PITCH.E4), when, 60 / bpm * 0.5);
  }, [bpm]);

  const t = useTransport({ bpm, subdivision: 1, totalSubdivisions: Infinity, onTick });
  const beatInBar = Math.floor(t.position % 4);

  return (
    <div className="border border-stone-900 bg-amber-50 p-4 sm:p-6" style={{ borderRadius: "2px" }}>
      <div className="flex flex-wrap gap-2 mb-4 justify-center">
        {VARIANTS.map((vv, i) => (
          <button
            key={vv.sig}
            onClick={() => { t.stop(); setV(i); }}
            className={`px-4 py-2 border mono-font ${v === i ? "border-stone-900 bg-stone-900 text-amber-50" : "border-stone-300 hover:border-stone-900"}`}
            style={{ borderRadius: "2px" }}
          >
            {vv.sig}
          </button>
        ))}
      </div>

      <p className="text-center mb-4 text-stone-700 italic">{cfg.desc}</p>

      <svg viewBox="0 0 600 110" className="w-full" style={{ maxHeight: "120px" }}>
        <Staff x={50} y={55} width={520} unit={5} />
        <TrebleClef x={70} y={55} unit={5} />
        <TimeSignature x={100} y={50} top={cfg.sig.split("/")[0]} bottom={cfg.sig.split("/")[1]} unit={5} />
        {[0, 1, 2, 3].map((i) => {
          const isPlayingBeat = t.playing && beatInBar === i;
          return (
            <g key={i} style={{ color: isPlayingBeat ? "#9a1f1f" : "#1c1917" }}>
              <Note x={150 + i * 100} y={50} type={cfg.note} stemUp={true} unit={6} />
              <text x={150 + i * 100} y={95} textAnchor="middle" fontSize={12} fill={isPlayingBeat ? "#9a1f1f" : "#666"} className="mono-font" fontWeight={i === 0 ? 700 : 500}>
                {i + 1}
              </text>
            </g>
          );
        })}
        <BarLine x={570} y={55} unit={10} thick />
      </svg>

      <div className="flex justify-center mt-2">
        {!t.playing ? (
          <Button onClick={t.start} primary><Play size={16} /> Play</Button>
        ) : (
          <Button onClick={t.stop} primary><Pause size={16} /> Stop</Button>
        )}
      </div>
      <div className="mt-3"><Slider label="BPM" value={bpm} onChange={setBpm} min={40} max={160} suffix=" bpm" /></div>
    </div>
  );
}
