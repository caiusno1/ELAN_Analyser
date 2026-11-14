import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyseAlignment, DEFAULT_ALIGNMENT, type AlignInstance } from "../../core/analysis/alignment.ts";
import { formatDuration, formatTime } from "../../core/analysis/common.ts";
import { pairTiers } from "../../core/analysis/cooccurrence.ts";
import { analyseTurnTaking, DEFAULT_TURN_TAKING, FLOOR_LABEL, type FloorSegment } from "../../core/analysis/turntaking.ts";
import { layerTiers, roleOf } from "../../core/corpus/corpus.ts";
import type { Annotation, Tier } from "../../core/eaf/model.ts";
import { forEachOverlap, lowerBoundStart } from "../../core/intervals.ts";
import { DEFAULT_TOKENIZER } from "../../core/text/tokenize.ts";
import { useLayers, useParticipantList, useThemeColors, useViewState, useWidth } from "../hooks.ts";
import { Button, Card, CheckList, defaultLayer, Field, LayerSelect, Segmented, Select, Toggle } from "../kit.tsx";
import { useStore } from "../store.ts";

const COLOR_TOKENS = [
  "series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7", "series-8", "series-other",
  "text", "text-2", "text-3", "surface", "surface-2", "surface-3", "grid", "border-strong", "accent", "hl-aligned", "critical", "warning", "bg",
] as const;

const LABEL_W = 148;
const RULER_H = 26;
const ROW_H = 30;
const FLOOR_H = 18;

interface Row {
  tier: Tier;
  layer: string;
  participant: string;
  color: string;
}

interface Hover {
  x: number;
  y: number;
  row: Row;
  ann: Annotation;
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function niceStep(msPerPx: number): number {
  const target = msPerPx * 90;
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
  return steps.find((s) => s >= target) ?? 3600000;
}

export function TimelineView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const focus = useStore((s) => s.focus);
  const participants = useParticipantList();
  const layers = useLayers();
  const colors = useThemeColors(COLOR_TOKENS);
  const [fileId, setFileId] = useViewState("timeline.file", files[0]?.id ?? "");
  const [groupBy, setGroupBy] = useViewState<"participant" | "layer">("timeline.group", "participant");
  const [hidden, setHidden] = useViewState<string[]>("timeline.hidden", []);
  const [showAlign, setShowAlign] = useViewState("timeline.align", false);
  const [alignLayer, setAlignLayer] = useViewState("timeline.alignLayer", defaultLayer(layers, "text", /speech|utter|trans|text|word/i));
  const [showCooc, setShowCooc] = useViewState("timeline.cooc", false);
  const [coocX, setCoocX] = useViewState("timeline.coocX", defaultLayer(layers, "categorical", /gest/i));
  const [coocY, setCoocY] = useViewState("timeline.coocY", defaultLayer(layers, "text", /speech|utter|trans/i));
  const [showFloor, setShowFloor] = useViewState("timeline.floor", false);
  const [floorLayer, setFloorLayer] = useViewState("timeline.floorLayer", defaultLayer(layers, "text", /speech|utter|trans/i));
  const file = files.find((f) => f.id === fileId) ?? files[0];
  const duration = Math.max(file?.doc.duration ?? 0, 1000);
  const [range, setRange] = useState<[number, number]>([0, duration]);
  const [hover, setHover] = useState<Hover | undefined>();
  const [selected, setSelected] = useState<{ row: Row; ann: Annotation } | undefined>();
  const [mark, setMark] = useState<{ start: number; end: number } | undefined>();
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; t0: number; t1: number; moved: boolean } | undefined>(undefined);

  // Jump to a place requested from another view.
  useEffect(() => {
    if (!focus) return;
    const target = files.find((f) => f.id === focus.fileId);
    if (!target) return;
    setFileId(target.id);
    const span = Math.max(focus.end - focus.start, 400);
    const pad = Math.max(span * 1.5, 2500);
    setRange([Math.max(0, focus.start - pad), Math.min(Math.max(target.doc.duration, focus.end), focus.end + pad)]);
    setMark({ start: focus.start, end: focus.end });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // A different file starts fully zoomed out (unless we just jumped into it).
  const lastFile = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!file) return;
    if (lastFile.current !== undefined && lastFile.current !== file.id && !(focus && focus.fileId === file.id)) {
      setRange([0, Math.max(file.doc.duration, 1000)]);
      setMark(undefined);
    }
    lastFile.current = file.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  const rows = useMemo<Row[]>(() => {
    if (!file) return [];
    const all = file.doc.tiers.map((tier) => {
      const role = roleOf(scheme, tier.id);
      const i = participants.indexOf(role.participant);
      return { tier, layer: role.layer, participant: role.participant, color: i >= 0 && i < 8 ? colors[`series-${i + 1}` as "series-1"] : colors["series-other"] };
    });
    const visible = all.filter((r) => !hidden.includes(r.layer));
    const layerOrder = layers.map((l) => l.name);
    return visible.sort((a, b) =>
      groupBy === "participant"
        ? (a.participant || "￿").localeCompare(b.participant || "￿") || layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer)
        : layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer) || a.participant.localeCompare(b.participant),
    );
  }, [file, scheme, participants, colors, hidden, groupBy, layers]);

  // ---- overlays ---------------------------------------------------------------------------
  const alignment = useMemo(() => {
    if (!file || !showAlign || !alignLayer) return undefined;
    return analyseAlignment([file], scheme, { ...DEFAULT_ALIGNMENT, layer: alignLayer, tokenizer: DEFAULT_TOKENIZER }).files[0];
  }, [file, scheme, showAlign, alignLayer]);
  const floor = useMemo<FloorSegment[] | undefined>(() => {
    if (!file || !showFloor || !floorLayer) return undefined;
    return analyseTurnTaking([file], scheme, { ...DEFAULT_TURN_TAKING, layer: floorLayer }).files[0]?.segments;
  }, [file, scheme, showFloor, floorLayer]);
  const coocBands = useMemo(() => {
    if (!file || !showCooc || !coocX || !coocY) return [];
    const xs = layerTiers([file], scheme, coocX);
    const ys = layerTiers([file], scheme, coocY);
    const bands: { xTier: string; yTier: string; start: number; end: number }[] = [];
    for (const [i, j] of pairTiers(xs, ys, "same")) {
      forEachOverlap(xs[i]!.tier.annotations, ys[j]!.tier.annotations, (_a, _b, s, e) => {
        if (e > s) bands.push({ xTier: xs[i]!.tier.id, yTier: ys[j]!.tier.id, start: s, end: e });
      });
    }
    return bands;
  }, [file, scheme, showCooc, coocX, coocY]);

  const floorOffset = floor ? FLOOR_H + 6 : 0;
  const height = RULER_H + floorOffset + rows.length * ROW_H + 8;
  const plotW = Math.max(50, width - LABEL_W);
  const [t0, t1] = range;
  const msPerPx = (t1 - t0) / plotW;
  const xOf = useCallback((t: number) => LABEL_W + (t - t0) / msPerPx, [t0, msPerPx]);

  const clampRange = useCallback((a: number, b: number): [number, number] => {
    let span = Math.min(Math.max(b - a, 200), duration);
    let start = a;
    if (start < 0) start = 0;
    if (start + span > duration) start = Math.max(0, duration - span);
    span = Math.min(span, duration);
    return [start, start + span];
  }, [duration]);

  const zoom = useCallback((factor: number, centre?: number) => {
    setRange(([a, b]) => {
      const c = centre ?? (a + b) / 2;
      const span = (b - a) * factor;
      const left = c - ((c - a) / (b - a)) * span;
      return clampRange(left, left + span);
    });
  }, [clampRange]);

  // ---- drawing ------------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, width, height);
    const font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.font = font;
    ctx.textBaseline = "middle";

    // Ruler and vertical grid.
    const step = niceStep(msPerPx);
    const withMs = step < 1000;
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors["text-3"];
    ctx.lineWidth = 1;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(formatTime(t, withMs), x + 4, 11);
    }
    ctx.strokeStyle = colors["border-strong"];
    ctx.beginPath();
    ctx.moveTo(LABEL_W, RULER_H + 0.5);
    ctx.lineTo(width, RULER_H + 0.5);
    ctx.stroke();

    const rowY = (i: number) => RULER_H + floorOffset + i * ROW_H;
    const rowIndex = new Map(rows.map((r, i) => [r.tier.id, i]));

    // Focus mark (the place another view pointed to).
    if (mark) {
      const a = Math.max(LABEL_W, xOf(mark.start));
      const b = Math.min(width, xOf(mark.end));
      if (b > a) {
        ctx.fillStyle = withAlpha(colors.accent, 0.12);
        ctx.fillRect(a, RULER_H, Math.max(b - a, 2), height - RULER_H);
      }
    }

    // Co-occurrence bands between the two tiers of each overlapping pair.
    if (coocBands.length) {
      ctx.fillStyle = withAlpha(colors["series-3"], 0.22);
      for (const band of coocBands) {
        if (band.end < t0 || band.start > t1) continue;
        const ix = rowIndex.get(band.xTier);
        const iy = rowIndex.get(band.yTier);
        if (ix === undefined || iy === undefined) continue;
        const top = rowY(Math.min(ix, iy)) + 3;
        const bottom = rowY(Math.max(ix, iy)) + ROW_H - 3;
        const a = Math.max(LABEL_W, xOf(band.start));
        const b = Math.min(width, xOf(band.end));
        ctx.fillRect(a, top, Math.max(b - a, 1), bottom - top);
      }
    }

    // Floor states.
    if (floor) {
      const y = RULER_H + 4;
      const colorOf: Record<string, string> = {
        gap: colors["text-3"], pause: colors["surface-3"], "overlap-between": colors.critical, "overlap-within": colors.warning,
      };
      for (const s of floor) {
        if (s.end < t0 || s.start > t1 || s.kind === "speech" || s.kind === "silence") continue;
        const a = Math.max(LABEL_W, xOf(s.start));
        const b = Math.min(width, xOf(s.end));
        ctx.fillStyle = colorOf[s.kind] ?? colors["text-3"];
        ctx.fillRect(a, y, Math.max(b - a, 1), FLOOR_H - 4);
      }
    }

    // Tier rows.
    rows.forEach((row, i) => {
      const y = rowY(i);
      if (i > 0) {
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
      }
      const anns = row.tier.annotations;
      // First annotation that can be visible: step back a little for long annotations.
      let k = Math.max(0, lowerBoundStart(anns, t0) - 1);
      while (k > 0 && anns[k - 1]!.end > t0) k--;
      for (; k < anns.length && anns[k]!.start <= t1; k++) {
        const a = anns[k]!;
        if (a.end < t0) continue;
        const x1 = Math.max(LABEL_W, xOf(a.start));
        const x2 = Math.min(width, xOf(a.end));
        const w = Math.max(x2 - x1, 1);
        const isSel = selected?.ann === a;
        const isHover = hover?.ann === a;
        ctx.fillStyle = withAlpha(row.color, isSel ? 0.5 : isHover ? 0.38 : 0.22);
        ctx.fillRect(x1, y + 5, w, ROW_H - 10);
        ctx.fillStyle = row.color;
        ctx.fillRect(x1, y + 5, Math.min(2, w), ROW_H - 10);
        if (isSel) {
          ctx.strokeStyle = colors.text;
          ctx.strokeRect(x1 + 0.5, y + 5.5, w - 1, ROW_H - 11);
        }
        if (w > 26 && a.value) {
          const chars = Math.floor((w - 8) / 6.1);
          const text = a.value.length > chars ? `${a.value.slice(0, Math.max(1, chars - 1))}…` : a.value;
          ctx.fillStyle = colors.text;
          ctx.fillText(text, x1 + 5, y + ROW_H / 2);
        }
      }
    });

    // Lexical alignment: a mark under each re-used expression, and a link to its prime on hover.
    if (alignment) {
      const tierOf = new Map(alignment.units.map((u) => [u.index, u.tierId]));
      const draw = (inst: AlignInstance, strong: boolean) => {
        const i = rowIndex.get(tierOf.get(inst.unit) ?? "");
        if (i === undefined || inst.end < t0 || inst.start > t1) return;
        const y = rowY(i);
        const a = Math.max(LABEL_W, xOf(inst.start));
        const b = Math.min(width, xOf(inst.end));
        ctx.fillStyle = strong ? colors["series-2"] : colors["series-4"];
        ctx.fillRect(a, y + ROW_H - 7, Math.max(b - a, 2), 4);
        if (strong) {
          const pi = rowIndex.get(tierOf.get(inst.primeUnit) ?? "");
          if (pi === undefined) return;
          const px = xOf(inst.primeTime);
          const py = rowY(pi) + ROW_H / 2;
          ctx.strokeStyle = colors["series-2"];
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(Math.max(LABEL_W, px), py);
          ctx.bezierCurveTo(px, py + (y - rowY(pi)) * 0.5 + 14, a, y + ROW_H / 2 - 14, a, y + ROW_H - 5);
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.fillStyle = colors["series-2"];
          ctx.beginPath();
          ctx.arc(Math.max(LABEL_W, px), py, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      const active = hover ?? selected;
      for (const inst of alignment.instances) draw(inst, false);
      if (active) {
        for (const inst of alignment.instances) {
          if (tierOf.get(inst.unit) === active.row.tier.id && inst.start >= active.ann.start - 1 && inst.end <= active.ann.end + 1) draw(inst, true);
        }
      }
    }

    // Label column (drawn last so that annotations never run under it).
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, LABEL_W, height);
    ctx.strokeStyle = colors["border-strong"];
    ctx.beginPath();
    ctx.moveTo(LABEL_W + 0.5, 0);
    ctx.lineTo(LABEL_W + 0.5, height);
    ctx.stroke();
    if (floor) {
      ctx.fillStyle = colors["text-3"];
      ctx.fillText("floor", 12, RULER_H + 4 + (FLOOR_H - 4) / 2);
    }
    rows.forEach((row, i) => {
      const y = rowY(i) + ROW_H / 2;
      if (row.participant) {
        ctx.fillStyle = row.color;
        ctx.fillRect(12, y - 4, 8, 8);
      }
      ctx.fillStyle = colors["text-2"];
      const label = row.participant ? `${row.participant} · ${row.layer}` : row.layer;
      ctx.fillText(label.length > 19 ? `${label.slice(0, 18)}…` : label, row.participant ? 26 : 12, y);
    });
  }, [width, height, rows, colors, t0, t1, msPerPx, xOf, hover, selected, mark, alignment, floor, coocBands, floorOffset]);

  // ---- interaction ----------------------------------------------------------------------------
  const hit = (clientX: number, clientY: number): { row: Row; ann: Annotation } | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < LABEL_W) return undefined;
    const i = Math.floor((y - RULER_H - floorOffset) / ROW_H);
    const row = rows[i];
    if (!row) return undefined;
    const t = t0 + (x - LABEL_W) * msPerPx;
    const anns = row.tier.annotations;
    const slack = 2 * msPerPx;
    let k = Math.max(0, lowerBoundStart(anns, t) - 1);
    while (k > 0 && anns[k - 1]!.end > t) k--;
    for (; k < anns.length && anns[k]!.start <= t + slack; k++) {
      if (anns[k]!.end >= t - slack) return { row, ann: anns[k]! };
    }
    return undefined;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - LABEL_W;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(Math.exp(e.deltaY * 0.004), t0 + x * msPerPx);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setRange(([a, b]) => clampRange(a + e.deltaX * msPerPx, b + e.deltaX * msPerPx));
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoom, clampRange, t0, msPerPx]);

  if (!file) return null;
  const selDur = selected ? selected.ann.end - selected.ann.start : 0;
  const alignCount = alignment?.instances.length ?? 0;

  return (
    <div className="stack">
      <Card flush>
        <div className="row" style={{ padding: "0 14px 10px" }}>
          <div style={{ flex: "0 1 240px", minWidth: 150 }}>
            <Select value={file.id} onChange={setFileId} options={files.map((f) => ({ value: f.id, label: f.name }))} />
          </div>
          <Segmented value={groupBy} onChange={setGroupBy} options={[{ value: "participant", label: "By participant" }, { value: "layer", label: "By layer" }]} />
          <span className="spacer" />
          <span className="mono faint">{formatTime(t0, false)} – {formatTime(t1, false)} of {formatTime(duration, false)}</span>
          <Button small icon="zoomIn" title="Zoom in" onClick={() => zoom(0.5)} />
          <Button small icon="zoomOut" title="Zoom out" onClick={() => zoom(2)} />
          <Button small icon="fit" title="Show the whole recording" onClick={() => setRange([0, duration])} />
        </div>
        <div className="timeline" ref={wrapRef} style={{ border: 0, borderTop: "1px solid var(--border)", borderRadius: 0 }}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Timeline of ${file.name}: ${rows.length} tiers`}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, t0, t1, moved: false };
              e.currentTarget.setPointerCapture(e.pointerId);
              e.currentTarget.classList.add("dragging");
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d) {
                const dx = e.clientX - d.x;
                if (Math.abs(dx) > 3) d.moved = true;
                if (d.moved) {
                  const shift = -dx * ((d.t1 - d.t0) / plotW);
                  setRange(clampRange(d.t0 + shift, d.t1 + shift));
                }
                return;
              }
              const h = hit(e.clientX, e.clientY);
              setHover(h ? { ...h, x: e.clientX, y: e.clientY } : undefined);
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = undefined;
              e.currentTarget.classList.remove("dragging");
              if (d && !d.moved) setSelected(hit(e.clientX, e.clientY));
            }}
            onPointerLeave={() => setHover(undefined)}
            onDoubleClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              zoom(0.4, t0 + (e.clientX - rect.left - LABEL_W) * msPerPx);
            }}
          />
        </div>
        <div className="table-foot">
          {selected ? (
            <>
              <strong style={{ color: "var(--text)" }}>{selected.ann.value || "(empty)"}</strong>
              <span className="mono">{formatTime(selected.ann.start)} – {formatTime(selected.ann.end)}</span>
              <span>{formatDuration(selDur)}</span>
              <span>tier {selected.row.tier.id}</span>
              {selected.ann.timeInferred && <span className="chip" title="This annotation has no time alignment of its own; its interval comes from the parent annotation.">time from parent</span>}
            </>
          ) : (
            <span>Drag to move, double-click or Ctrl + wheel to zoom, click an annotation for details.</span>
          )}
        </div>
      </Card>

      <div className="cols-3">
        <Card title="Lexical alignment" sub="Mark words re-used from the other speaker.">
          <Toggle id="tl-align" checked={showAlign} onChange={setShowAlign}>Highlight alignment</Toggle>
          <Field label="Transcription layer" htmlFor="tl-align-layer">
            <LayerSelect id="tl-align-layer" value={alignLayer} onChange={setAlignLayer} kinds={["text"]} />
          </Field>
          {showAlign && (
            <p className="muted" style={{ marginTop: 8 }}>
              {alignment ? (
                <>
                  <strong className="num" style={{ color: "var(--text)" }}>{alignCount}</strong> alignment instance{alignCount === 1 ? "" : "s"} in this file (
                  {alignment.bySpeaker.map((m) => `${m.speaker}: ${m.instances}`).join(", ")}). Hover an utterance to see where its re-used words were said before.
                </>
              ) : (
                "This layer needs at least two speakers in the file."
              )}
            </p>
          )}
        </Card>
        <Card title="Co-occurrence" sub="Shade where two layers overlap (same participant).">
          <Toggle id="tl-cooc" checked={showCooc} onChange={setShowCooc}>Highlight overlaps</Toggle>
          <div className="field-row" style={{ marginTop: 9 }}>
            <Field label="Layer" htmlFor="tl-cooc-x"><LayerSelect id="tl-cooc-x" value={coocX} onChange={setCoocX} /></Field>
            <Field label="with layer" htmlFor="tl-cooc-y"><LayerSelect id="tl-cooc-y" value={coocY} onChange={setCoocY} /></Field>
          </div>
          {showCooc && <p className="muted" style={{ marginTop: 8 }}><strong className="num" style={{ color: "var(--text)" }}>{coocBands.length}</strong> overlapping pairs in this file.</p>}
        </Card>
        <Card title="Gaps and overlaps" sub="Turn-taking states from the speech tiers.">
          <Toggle id="tl-floor" checked={showFloor} onChange={setShowFloor}>Show the floor strip</Toggle>
          <Field label="Speech layer" htmlFor="tl-floor-layer"><LayerSelect id="tl-floor-layer" value={floorLayer} onChange={setFloorLayer} /></Field>
          {showFloor && (
            <div className="chart-legend" style={{ marginTop: 8 }}>
              <span className="key"><span className="swatch" style={{ background: "var(--text-3)" }} />{FLOOR_LABEL.gap}</span>
              <span className="key"><span className="swatch" style={{ background: "var(--critical)" }} />{FLOOR_LABEL["overlap-between"]}</span>
              <span className="key"><span className="swatch" style={{ background: "var(--warning)" }} />{FLOOR_LABEL["overlap-within"]}</span>
              <span className="key"><span className="swatch" style={{ background: "var(--surface-3)" }} />{FLOOR_LABEL.pause}</span>
            </div>
          )}
        </Card>
      </div>

      <Card title="Layers shown">
        <CheckList
          options={layers.map((l) => ({ value: l.name, label: `${l.name} (${l.annotationCount.toLocaleString("en-US")})` }))}
          selected={layers.map((l) => l.name).filter((n) => !hidden.includes(n))}
          onChange={(sel) => setHidden(layers.map((l) => l.name).filter((n) => !sel.includes(n)))}
        />
      </Card>

      {hover && (
        <div className="chart-tip" style={{ left: Math.max(4, Math.min(hover.x + 14, window.innerWidth - 340)), top: Math.min(hover.y + 16, window.innerHeight - 120) }}>
          <strong>{hover.ann.value || "(empty)"}</strong>
          <div className="tip-row"><span className="mono">{formatTime(hover.ann.start)} – {formatTime(hover.ann.end)}</span></div>
          <div className="tip-row"><strong>{formatDuration(hover.ann.end - hover.ann.start)}</strong><span>{hover.row.tier.id}</span></div>
        </div>
      )}
    </div>
  );
}
