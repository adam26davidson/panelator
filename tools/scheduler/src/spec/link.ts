const SPEC_LINE = /^Spec:\s*(specs\/\d{3}-[a-z0-9][a-z0-9-]*\/spec\.md)\s*$/m;

/** The spec path an issue body names, or null. Only `specs/NNN-slug/spec.md` is accepted. */
export function specPathFromIssueBody(body: string): string | null {
  const m = SPEC_LINE.exec(body);
  return m ? m[1] : null;
}
