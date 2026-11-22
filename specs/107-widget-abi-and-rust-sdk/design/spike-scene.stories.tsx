// spike-scene (spec 107 section 6, AC-17): the 128 by 64 panel of scene `spike` at tick 60, composed by
// AC-11's rule: the image, the clock over it at the top-left at opacity 200, the scroll along the bottom.
import { Mono, Name, Note, type Row, Section, Sheet, Shot, Table } from "./spike-kit.tsx";
import {
  CLOCK, SCENE, SCROLL, clockText, compose, imageOffset, newLayer, sceneTimeMs, scrollColorIndex, scrollX,
  spikeImageAsset, updateClock, updateImage, updateScroll,
} from "./spike-pixels.ts";

export default { title: "spike-scene" };

const TICK = 60;
const TEXT = "panelator 60 Hz";
const PANEL = { w: 128, h: 64 };

function SceneShot() {
  const image = newLayer(128, 64);
  updateImage(image, TICK - (TICK % 2), spikeImageAsset());
  const clock = newLayer(CLOCK.size.w, CLOCK.size.h);
  updateClock(clock, sceneTimeMs(TICK), SCENE.utcOffsetS);
  const scroll = newLayer(128, 16);
  const index = scrollColorIndex(2, TICK, scroll.w, TEXT);
  updateScroll(scroll, TICK, TEXT, index);
  const frame = compose(PANEL.w, PANEL.h, [
    { layer: image, x: 0, y: 0, z: 0, opacity: 255 },
    { layer: clock, x: 0, y: 0, z: 1, opacity: 200 },
    { layer: scroll, x: 0, y: 48, z: 2, opacity: 255 },
  ]);
  const { time, date } = clockText(sceneTimeMs(TICK), SCENE.utcOffsetS);
  return (
    <Shot
      title={`scene spike, tick ${TICK}`}
      meta={`${time}, ${date}. Image offset ${imageOffset(TICK, 128)}; scroll text at x = ${scrollX(TICK, 128, TEXT)} in ${SCROLL.palette[index].name}.`}
      frame={frame}
      alt={`The panel: the gradient image, the clock showing ${time} over its top-left quarter, the scrolling text on a dark blue band along the bottom`}
    />
  );
}

const PLACEMENTS: Row[] = [
  [
    <Name name="spike-image">z 0, the bottom layer</Name>,
    <Mono>x 0, y 0, 128 × 64</Mono>,
    <>
      <Mono>opacity 255, config {"{}"}, seed 3</Mono>
      <Note>Opaque: it covers the black frame.</Note>
    </>,
  ],
  [
    <Name name="spike-clock">z 1, over the image</Name>,
    <Mono>x 0, y 0, 64 × 32</Mono>,
    <>
      <Mono>opacity 200, config {"{}"}, seed 1</Mono>
      <Note>Its transparent pixels leave the image as it is; its drawn pixels, the black ones included, are 200 parts of 255 their own colour, the rest the image's.</Note>
    </>,
  ],
  [
    <Name name="spike-scroll">z 2, on top</Name>,
    <Mono>x 0, y 48, 128 × 16</Mono>,
    <>
      <Mono>opacity 255, config {`{"text": "${TEXT}"}`}, seed 2</Mono>
      <Note>Its opaque background hides the image's bottom 16 rows.</Note>
    </>,
  ],
];

const BLEND: Row[] = [
  [
    <Name name="Black">halos, plate, disc</Name>,
    <Mono>0x000000FF at opacity 200</Mono>,
    <Note>Each channel is 55 × image / 255: at most 55, whatever the image holds. This is the ground every other clock colour sits on or beside.</Note>,
  ],
  [
    <Name name="White">time, date, quarter marks</Name>,
    <Mono>0xFFFFFFFF at opacity 200</Mono>,
    <Note>Each channel is 200 + 55 × image / 255. Against the black beside it: at least 10.5 to 1 at every image offset.</Note>,
  ],
  [
    <Name name="Cyan, amber, green">separator, bar, circle</Name>,
    <Mono>0x4FD8FFFF, 0xFFB000FF, 0x5CFF8AFF at opacity 200</Mono>,
    <Note>Against the black beside them: at least 7.4, 7.1 and 8.9 to 1 at every image offset.</Note>,
  ],
  [
    <Name name="Transparent">the rest of the clock's layer</Name>,
    <Mono>0x00000000</Mono>,
    <Note>The image, unchanged: between and inside the glyphs' halos, right of the date, around the disc.</Note>,
  ],
];

export const Default = () => (
  <Sheet
    screen="spike-scene"
    lead="The 128 by 64 panel of scene spike: the three widgets together as the board will run them. It shows overlap, z-order, a transparent layer over an image and a layer opacity below 255. The frame is tick 60, one of the scene's captured ticks."
    shots={<SceneShot />}
  >
    <Section title="Placements, bottom to top">
      <Table head={["Placement", "Panel pixels", "Layer"]} rows={PLACEMENTS} />
    </Section>
    <Section title="The clock's colours over the image">
      <Table head={["Colour", "Drawn as", "On the panel"]} rows={BLEND} />
    </Section>
  </Sheet>
);
