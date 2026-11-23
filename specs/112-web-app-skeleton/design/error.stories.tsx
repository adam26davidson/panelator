// A route that failed (spec 112 AC-9, section 7): the frame stays; a heading, one line saying
// something went wrong on this page, a reload control and the link home. No technical detail: the
// error's message and stack go to the browser console only. No states.
import { Actions, Button, ButtonLink, Frame, PageHeading, ReadingColumn } from "./web-kit.tsx";

export default { title: "error" };

export const Default = () => (
  <Frame>
    <ReadingColumn>
      <PageHeading
        tone="danger"
        eyebrow="Page error"
        title="Something went wrong"
        lead="This page ran into a problem and cannot be shown. Reloading it may fix that."
      />
      <Actions>
        <Button variant="primary">Reload the page</Button>
        <ButtonLink variant="secondary" href="/">
          Go to the home page
        </ButtonLink>
      </Actions>
    </ReadingColumn>
  </Frame>
);
