import { ButtonLink, PageHeading, ReadingColumn } from "@/shared/ui";

export function NotFoundPage() {
  return (
    <ReadingColumn>
      <title>Page not found · panelator</title>
      <PageHeading
        eyebrow="Error 404"
        title="Page not found"
        lead="This address leads nowhere. Check it for a typo, or start again from the home page."
      />
      <div className="flex flex-col gap-3 tablet:flex-row">
        <ButtonLink variant="primary" to="/">
          Go to the home page
        </ButtonLink>
      </div>
    </ReadingColumn>
  );
}
