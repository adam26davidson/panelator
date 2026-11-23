import { useEffect } from "react";
import { Button, ButtonLink, PageHeading, ReadingColumn } from "@/shared/ui";

/**
 * Shown in place of a route that failed. The error goes to the browser console and nowhere on the page; `onLeave` runs
 * when the user leaves by the link home, so the caller can clear the error.
 */
export function ErrorPage({ error, onLeave }: { error: unknown; onLeave?: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ReadingColumn>
      <title>Something went wrong · panelator</title>
      <PageHeading
        tone="danger"
        eyebrow="Page error"
        title="Something went wrong"
        lead="This page ran into a problem and cannot be shown. Reloading it may fix that."
      />
      <div className="flex flex-col gap-3 tablet:flex-row">
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
        <ButtonLink variant="secondary" to="/" onClick={onLeave}>
          Go to the home page
        </ButtonLink>
      </div>
    </ReadingColumn>
  );
}
