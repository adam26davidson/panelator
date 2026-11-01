/** The viewports every named screen is rendered at (spec 029): an iPhone-class, an iPad-class and a laptop width, in CSS pixels. */
export const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

export const DEVICE_SCALE = 2;

export type ViewportName = (typeof VIEWPORTS)[number]["name"];

/** `<screen>.png` is desktop; the others are `<screen>.<viewport>.png`; a state is `<screen>--<state>` with the state kebab-cased. */
export function renderFileName(screen: string, viewport: ViewportName, state?: string): string {
  const base = state ? `${screen}--${kebab(state)}` : screen;
  return viewport === "desktop" ? `${base}.png` : `${base}.${viewport}.png`;
}

export function kebab(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
