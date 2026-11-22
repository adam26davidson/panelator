// spike-clock (spec 107 section 6, AC-17): the 64 by 32 layer at 1 Hz. States: even-second (23:59:58,
// the circle filled) and odd-second (23:59:59, the circle outlined), which are ticks 0 and 60 of scene
// `spike-clock`, so each frame can be laid beside its golden frame.
import { Color, Mono, Name, Note, type Row, Section, Sheet, Shot, Table } from "./spike-kit.tsx";
import { CLOCK, COLOR, SCENE, clockText, newLayer, onBlack, sceneTimeMs, updateClock } from "./spike-pixels.ts";

export default { title: "spike-clock" };

const STATES = { "even-second": 0, "odd-second": 60 } as const;
type State = keyof typeof STATES;

function ClockShot({ state }: { state: State }) {
  const tick = STATES[state];
  const ms = sceneTimeMs(tick);
  const { time, date, second } = clockText(ms, SCENE.utcOffsetS);
  const layer = newLayer(CLOCK.size.w, CLOCK.size.h);
  updateClock(layer, ms, SCENE.utcOffsetS);
  const circle = second % 2 === 0 ? "filled" : "outlined";
  return (
    <Shot
      title={state}
      meta={`Tick ${tick} of scene spike-clock: ${time}, ${date}. Bar fill ${second} wide, circle ${circle}.`}
      frame={onBlack(layer)}
      alt={`The clock layer showing ${time} over a seconds bar, the date ${date} and a ${circle} circle`}
    />
  );
}

const g = CLOCK;
const ELEMENTS: Row[] = [
  [
    <Name name="1. Clear"><Mono>draw_fill</Mono></Name>,
    <Mono>the whole layer</Mono>,
    <Color color={COLOR.transparent} name="transparent" />,
  ],
  [
    <Name name="2. Time halo"><Mono>draw_text</Mono>, font 2, four times</Name>,
    <>
      <Mono>the time at (-1, 0), (1, 0), (0, -1) and (0, 1)</Mono>
      <Note>One pixel left, right, up and down of the time. Invisible on black; over an image it edges every glyph.</Note>
    </>,
    <Color color={g.halo.color} name="black, opaque" />,
  ],
  [
    <Name name="3. Time, HH:MM:SS"><Mono>draw_text</Mono>, font 2 (Spleen 8x16)</Name>,
    <>
      <Mono>x {g.time.x}, y {g.time.y}, 64 × 16</Mono>
      <Note>Eight cells of 8 × 16, the layer's full width. The digits ink rows 2 to 11.</Note>
    </>,
    <Color color={g.time.color} name="white" />,
  ],
  [
    <Name name="4. Plate"><Mono>draw_rect</Mono>, filled</Name>,
    <>
      <Mono>x {g.plate.x}, y {g.plate.y}, {g.plate.w} × {g.plate.h}</Mono>
      <Note>Rows 13 to 23, the layer's full width: the ground under elements 5 to 8.</Note>
    </>,
    <Color color={g.plate.color} name="black, opaque" />,
  ],
  [
    <Name name="5. Separator"><Mono>draw_line</Mono></Name>,
    <>
      <Mono>({g.separator.x0}, {g.separator.y0}) to ({g.separator.x1}, {g.separator.y1})</Mono>
      <Note>Inside the time's cell rows, below every digit's ink.</Note>
    </>,
    <Color color={g.separator.color} name="cyan" />,
  ],
  [
    <Name name="6. Seconds bar, outline"><Mono>draw_rect</Mono>, not filled</Name>,
    <Mono>x {g.barOutline.x}, y {g.barOutline.y}, {g.barOutline.w} × {g.barOutline.h}</Mono>,
    <Color color={g.barOutline.color} name="cyan" />,
  ],
  [
    <Name name="7. Seconds bar, fill"><Mono>draw_rect</Mono>, filled</Name>,
    <>
      <Mono>x {g.barFill.x}, y {g.barFill.y}, second × {g.barFill.h}</Mono>
      <Note>One column a second, 0 to 59: nothing at second 0, one column left empty at 59.</Note>
    </>,
    <Color color={g.barFill.color} name="amber" />,
  ],
  [
    <Name name="8. Quarter marks"><Mono>draw_pixel</Mono>, four times</Name>,
    <>
      <Mono>({g.marks.xs[0]}, 22) ({g.marks.xs[1]}, 22) ({g.marks.xs[2]}, 22) ({g.marks.xs[3]}, 22)</Mono>
      <Note>Seconds 0, 15, 30 and 45, each at x = 2 + second, on the row under the outline.</Note>
    </>,
    <Color color={g.marks.color} name="white" />,
  ],
  [
    <Name name="9. Date halo"><Mono>draw_text</Mono>, font 1, four times</Name>,
    <>
      <Mono>the date at (0, 24), (2, 24), (1, 23) and (1, 25)</Mono>
      <Note>The same four offsets as the time's halo.</Note>
    </>,
    <Color color={g.halo.color} name="black, opaque" />,
  ],
  [
    <Name name="10. Date, YYYY-MM-DD"><Mono>draw_text</Mono>, font 1 (Spleen 5x8)</Name>,
    <>
      <Mono>x {g.date.x}, y {g.date.y}, 50 × 8</Mono>
      <Note>Ten cells of 5 × 8. The digits ink rows 25 to 30.</Note>
    </>,
    <Color color={g.date.color} name="white" />,
  ],
  [
    <Name name="11. Disc"><Mono>draw_circle</Mono>, filled</Name>,
    <>
      <Mono>centre ({g.disc.cx}, {g.disc.cy}), radius {g.disc.r}</Mono>
      <Note>The ground under the seconds circle, one pixel larger all round.</Note>
    </>,
    <Color color={g.disc.color} name="black, opaque" />,
  ],
  [
    <Name name="12. Seconds circle"><Mono>draw_circle</Mono>, filled on even seconds, outlined on odd</Name>,
    <>
      <Mono>centre ({g.circle.cx}, {g.circle.cy}), radius {g.circle.r}</Mono>
      <Note>Covers x 56 to 62, y 24 to 30.</Note>
    </>,
    <Color color={g.circle.color} name="green" />,
  ],
];

function Screen({ states, state }: { states: State[]; state?: State }) {
  return (
    <Sheet
      screen="spike-clock"
      state={state}
      lead="The 64 by 32 layer, updated at 1 Hz. Every update clears the layer to transparent and draws the twelve elements below, in this order, at fixed layer pixels; a layer of another size clips them. Four of them are opaque black: they do not show here, on black, and keep the others readable over an image (screen spike-scene)."
      shots={states.map((s) => <ClockShot key={s} state={s} />)}
    >
      <Section title="Elements, in draw order">
        <Table head={["Element", "Layer pixels", "Colour"]} rows={ELEMENTS} />
      </Section>
    </Sheet>
  );
}

export const Default = () => <Screen states={["even-second", "odd-second"]} />;
export const EvenSecond = () => <Screen states={["even-second"]} state="even-second" />;
export const OddSecond = () => <Screen states={["odd-second"]} state="odd-second" />;
