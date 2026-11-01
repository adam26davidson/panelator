export type ViewportName = "mobile" | "tablet" | "desktop";

export interface Viewport {
  name: ViewportName;
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** File-name suffix before `.png`: desktop is the bare name. */
  suffix: string;
}

export const VIEWPORTS: readonly Viewport[] = [
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 2, suffix: "" },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, suffix: ".mobile" },
  { name: "tablet", width: 820, height: 1180, deviceScaleFactor: 2, suffix: ".tablet" },
];
