import type { ReactNode } from "react";

/** Small stroke icons (16 px grid). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const icons = {
  corpus: <Icon><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" /></Icon>,
  tiers: <Icon><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /><path d="M5 3v2M9.5 7v2M7 11v2" /></Icon>,
  derive: <Icon><circle cx="5.5" cy="8" r="3" /><circle cx="10.5" cy="8" r="3" /></Icon>,
  timeline: <Icon><path d="M2 4.5h7M5 8h9M3 11.5h6" /><path d="M11.5 2.5v11" /></Icon>,
  search: <Icon><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></Icon>,
  descriptives: <Icon><path d="M3 13V7M6.5 13V3.5M10 13V9M13.5 13V5.5" /></Icon>,
  alignment: <Icon><path d="M2.5 4.5h6M2.5 11.5h6" /><path d="M10 4.5c2.5 0 3 2 3 3.5s-.5 3.5-3 3.5" /><path d="M11.5 10l-1.6 1.5 1.6 1.5" /></Icon>,
  cooccurrence: <Icon><rect x="2.5" y="2.5" width="4.5" height="4.5" /><rect x="9" y="2.5" width="4.5" height="4.5" /><rect x="2.5" y="9" width="4.5" height="4.5" /><rect x="9" y="9" width="4.5" height="4.5" /></Icon>,
  turntaking: <Icon><path d="M2.5 5h6.5M7 11h6.5" /><path d="M9 5l-1.8-1.8M9 5L7.2 6.8M7 11l1.8-1.8M7 11l1.8 1.8" /></Icon>,
  timing: <Icon><circle cx="8" cy="8.5" r="5" /><path d="M8 5.5v3l2 1.5M6.5 2h3" /></Icon>,
  sequences: <Icon><circle cx="3.5" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="12.5" cy="8" r="1.5" /><path d="M5 8h1.5M9.5 8H11" /></Icon>,
  recurrence: <Icon><rect x="2.5" y="2.5" width="11" height="11" /><path d="M4.5 11.5l7-7M4.5 7l2.5-2.5M9 11.5l2.5-2.5" /></Icon>,
  temporal: <Icon><path d="M2 12l2.5-5 2 3 2.5-6.5 2 5L13.5 6" /></Icon>,
  lexicon: <Icon><path d="M3 3h4.5v10H3zM8.5 3H13v10H8.5z" /><path d="M4.5 5.5h1.5M4.5 7.5h1.5M10 5.5h1.5" /></Icon>,
  agreement: <Icon><path d="M2.5 8.5l2.5 2.5 4-5" /><path d="M8.5 11l1 1 4-5" /></Icon>,
  statistics: <Icon><path d="M2 13c2.2 0 2.7-9.5 6-9.5S11.800 13 14 13" /><path d="M8 3.500V13" /></Icon>,
  methods: <Icon><path d="M4 2.5h8v11H4z" /><path d="M6 5.500h4M6 8h4M6 10.500h2.500" /></Icon>,
  upload: <Icon><path d="M8 10.500V3M5 5.500L8 2.500l3 3M3 10.500V13h10v-2.500" /></Icon>,
  download: <Icon><path d="M8 2.500V10M5 7.500l3 3 3-3M3 10.500V13h10v-2.500" /></Icon>,
  trash: <Icon><path d="M3 4.500h10M6 4.500V3h4v1.500M4.500 4.500l.5 8.500h6l.5-8.500" /></Icon>,
  plus: <Icon><path d="M8 3.500v9M3.500 8h9" /></Icon>,
  close: <Icon><path d="M4 4l8 8M12 4l-8 8" /></Icon>,
  info: <Icon><circle cx="8" cy="8" r="5.500" /><path d="M8 7.500V11M8 5.200v.1" /></Icon>,
  alert: <Icon><path d="M8 2.500l6 10.500H2z" /><path d="M8 6.500V9.500M8 11.300v.1" /></Icon>,
  table: <Icon><rect x="2.500" y="3" width="11" height="10" /><path d="M2.500 6.500h11M2.500 9.800h11M6.500 3v10" /></Icon>,
  chart: <Icon><path d="M2.500 13.500h11M4.500 11V8M8 11V4.500M11.500 11V6.500" /></Icon>,
  copy: <Icon><rect x="5.500" y="5.500" width="8" height="8" /><path d="M10.500 5.500v-3h-8v8h3" /></Icon>,
  play: <Icon><path d="M5 3.500l7 4.500-7 4.500z" /></Icon>,
  send: <Icon><path d="M2.500 8h9M8.500 4.500L12 8l-3.500 3.500" /></Icon>,
  zoomIn: <Icon><circle cx="7" cy="7" r="4" /><path d="M10 10l3.500 3.500M5.500 7h3M7 5.500v3" /></Icon>,
  zoomOut: <Icon><circle cx="7" cy="7" r="4" /><path d="M10 10l3.500 3.500M5.500 7h3" /></Icon>,
  fit: <Icon><path d="M2.500 6V2.500H6M10 2.500h3.500V6M13.500 10v3.500H10M6 13.500H2.500V10" /></Icon>,
  reset: <Icon><path d="M3 8a5 5 0 1 0 1.500-3.500" /><path d="M3 3v2.500h2.500" /></Icon>,
} as const;

export type IconName = keyof typeof icons;

/** The app mark: three tier strips with annotation blocks and a playhead. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="0.5" y="0.5" width="25" height="25" rx="6" style={{ fill: "var(--accent)" }} />
      <rect x="4.500" y="6" width="8" height="3.200" rx="1" style={{ fill: "var(--accent-fg)" }} />
      <rect x="14.500" y="6" width="5" height="3.200" rx="1" style={{ fill: "var(--accent-fg)", opacity: 0.55 }} />
      <rect x="7.500" y="11.400" width="11" height="3.200" rx="1" style={{ fill: "var(--accent-fg)", opacity: 0.8 }} />
      <rect x="4.500" y="16.800" width="5" height="3.200" rx="1" style={{ fill: "var(--accent-fg)", opacity: 0.55 }} />
      <rect x="11.500" y="16.800" width="9" height="3.200" rx="1" style={{ fill: "var(--accent-fg)" }} />
    </svg>
  );
}
