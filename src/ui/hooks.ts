import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listLayers, listMetaVariables, listParticipants, type LayerInfo } from "../core/corpus/corpus.ts";
import { useStore } from "./store.ts";

/** Like useState, but the value survives switching between views. */
export function useViewState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const stored = useStore((s) => s.viewState[key]) as T | undefined;
  const value = stored === undefined ? initial : stored;
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const cur = useStore.getState().viewState[key] as T | undefined;
      const prev = cur === undefined ? initial : cur;
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      useStore.getState().setViewState(key, v);
    },
    // `initial` is only the fallback before the first write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

export function useLayers(): LayerInfo[] {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  return useMemo(() => listLayers(files, scheme), [files, scheme]);
}

export function useParticipantList(): string[] {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  return useMemo(() => listParticipants(files, scheme), [files, scheme]);
}

export function useMetaVariables(): string[] {
  const files = useStore((s) => s.files);
  return useMemo(() => listMetaVariables(files), [files]);
}

/** Width of an element, tracked with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Resolved values of CSS custom properties, refreshed when the colour scheme changes. */
export function useThemeColors<K extends string>(names: readonly K[]): Record<K, string> {
  const read = useCallback(() => {
    const cs = getComputedStyle(document.documentElement);
    const out = {} as Record<K, string>;
    for (const n of names) out[n] = cs.getPropertyValue(`--${n}`).trim() || "#888888";
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names.join(",")]);
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const update = () => setColors(read());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    update();
    return () => {
      mq.removeEventListener("change", update);
      mo.disconnect();
    };
  }, [read]);
  return colors;
}

/** Run a function after the input has been stable for `delay` ms. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}
