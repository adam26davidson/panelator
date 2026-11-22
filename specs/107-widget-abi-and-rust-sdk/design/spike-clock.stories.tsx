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
    <Name name="2. Time, HH:MM:SS"><Mono>draw_text</Mono>, font 2 (Spleen 8x16)</Name>,
    <>
      <Mono>x {g.time.x}, y {g.time.y}, 64 × 16</Mono>
      <Note>Eight cells of 8 × 16, the layer's full width. The digits ink rows 2 to 11.</Note>
    </>,
    <Color color={g.time.color} name="white" />,
  ],
  [
    <Name name="3. Separator"><Mono>draw_line</Mono></Name>,
    <>
      <Mono>({g.separator.x0}, {g.separator.y0}) to ({g.separator.x1}, {g.separator.y1})</Mono>
      <Note>Inside the time's cell rows, below every digit's ink.</Note>
    </>,
    <Color color={g.separator.color} name="cyan" />,
  ],
  [
    <Name name="4. Seconds bar, outline"><Mono>draw_rect</Mono>, not filled</Name>,
    <Mono>x {g.barOutline.x}, y {g.barOutline.y}, {g.barOutline.w} × {g.barOutline.h}</Mono>,
    <Color color={g.barOutline.color} name="cyan" />,
  ],
  [
    <Name name="5. Seconds bar, fill"><Mono>draw_rect</Mono>, filled</Name>,
    <>
      <Mono>x {g.barFill.x}, y {g.barFill.y}, second × {g.barFill.h}</Mono>
      <Note>One column a second, 0 to 59: nothing at second 0, one column left empty at 59.</Note>
    </>,
    <Color color={g.barFill.color} name="amber" />,
  ],
  [
    <Name name="6. Quarter marks"><Mono>draw_pixel</Mono>, four times</Name>,
    <>
      <Mono>({g.marks.xs[0]}, 22) ({g.marks.xs[1]}, 22) ({g.marks.xs[2]}, 22) ({g.marks.xs[3]}, 22)</Mono>
      <Note>Seconds 0, 15, 30 and 45, each at x = 2 + second, on the row under the outline.</Note>
    </>,
    <Color color={g.marks.color} name="white" />,
  ],
  [
    <Name name="7. Date, YYYY-MM-DD"><Mono>draw_text</Mono>, font 1 (Spleen 5x8)</Name>,
    <>
      <Mono>x {g.date.x}, y {g.date.y}, 50 × 8</Mono>
      <Note>Ten cells of 5 × 8. The digits ink rows 25 to 30.</Note>
    </>,
    <Color color={g.date.color} name="white" />,
  ],
  [
    <Name name="8. Seconds circle"><Mono>draw_circle</Mono>, filled on even seconds, outlined on odd</Name>,
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
      lead="The 64 by 32 layer, updated at 1 Hz. Every update clears the layer to transparent and draws the eight elements below, in this order, at fixed layer pixels; a layer of another size clips them."
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
