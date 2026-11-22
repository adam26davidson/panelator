import type { ReactNode } from "react";

const svg = (d: ReactNode, size = 18) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);

type I = (s?: number) => ReactNode;
export const Icon: Record<
  | "chevron"
  | "external"
  | "lock"
  | "check"
  | "x"
  | "undo"
  | "pause"
  | "play"
  | "inbox"
  | "home"
  | "list"
  | "bot"
  | "sliders"
  | "question"
  | "chart"
  | "github",
  I
> = {
  chevron: (s) => svg(<path d="m9 6 6 6-6 6" />, s),
  external: (s) =>
    svg(
      <>
        <path d="M14 4h6v6" />
        <path d="M20 4 10 14" />
        <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </>,
      s,
    ),
  lock: (s) =>
    svg(
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>,
      s,
    ),
  check: (s) => svg(<path d="m5 12 5 5 9-10" />, s),
  x: (s) =>
    svg(
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6 6 18" />
      </>,
      s,
    ),
  undo: (s) =>
    svg(
      <>
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
      </>,
      s,
    ),
  pause: (s) =>
    svg(
      <>
        <path d="M9 5v14" />
        <path d="M15 5v14" />
      </>,
      s,
    ),
  play: (s) => svg(<path d="M7 4v16l13-8z" />, s),
  inbox: (s) =>
    svg(
      <>
        <path d="M3 13h5l2 3h4l2-3h5" />
        <path d="M5 5h14l2 8v6H3v-6z" />
      </>,
      s,
    ),
  home: (s) =>
    svg(
      <>
        <path d="M3 11 12 4l9 7" />
        <path d="M5 10v10h14V10" />
      </>,
      s,
    ),
  list: (s) =>
    svg(
      <>
        <path d="M8 6h12" />
        <path d="M8 12h12" />
        <path d="M8 18h12" />
        <path d="M4 6h.01M4 12h.01M4 18h.01" />
      </>,
      s,
    ),
  bot: (s) =>
    svg(
      <>
        <rect x="4" y="8" width="16" height="12" rx="3" />
        <path d="M12 8V4" />
        <path d="M9 14h.01M15 14h.01" />
      </>,
      s,
    ),
  sliders: (s) =>
    svg(
      <>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </>,
      s,
    ),
  question: (s) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
        <path d="M12 17h.01" />
      </>,
      s,
    ),
  chart: (s) =>
    svg(
      <>
        <path d="M4 20V4" />
        <path d="M4 20h16" />
        <path d="m7 15 4-5 3 3 5-7" />
      </>,
      s,
    ),
  github: (s) => (
    <svg width={s ?? 20} height={s ?? 20} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
};
