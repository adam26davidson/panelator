// Not found (spec 112 AC-8, section 7): the frame, a heading, one line saying the address leads
// nowhere, and the link home. No states.
import { Actions, ButtonLink, Frame, PageHeading, ReadingColumn } from "./web-kit.tsx";

export default { title: "not-found" };

export const Default = () => (
  <Frame>
    <ReadingColumn>
      <PageHeading
        eyebrow="Error 404"
        title="Page not found"
        lead="This address leads nowhere. Check it for a typo, or start again from the home page."
      />
      <Actions>
        <ButtonLink variant="primary" href="/">
          Go to the home page
        </ButtonLink>
      </Actions>
    </ReadingColumn>
  </Frame>
);
