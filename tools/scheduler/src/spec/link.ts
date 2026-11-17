const SPEC_LINE = /^Spec:\s*(specs\/\d{3}-[a-z0-9][a-z0-9-]*\/spec\.md)\s*$/m;

/** The spec path an issue body names, or null. Only `specs/NNN-slug/spec.md` is accepted. */
export function specPathFromIssueBody(body: string): string | null {
  const m = SPEC_LINE.exec(body);
  return m ? m[1] : null;
}

/** Spec 071 AC-4: the body with the path on its `Spec:` line replaced, every other byte kept; a body with no line is returned unchanged. */
export function withSpecPath(body: string, path: string): string {
  return body.replace(SPEC_LINE, (line, old: string) => line.replace(old, () => path));
}
