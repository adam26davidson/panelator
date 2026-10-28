import type { GitHubClient } from "../github/client.ts";
import type { StatePaths } from "../state/paths.ts";
import { record } from "./store.ts";

/** Every issue the scheduler creates goes through here, so `issue.filed` is recorded beside it (spec 012 AC-2). */
export async function createIssueRecorded(
  paths: StatePaths, gh: Pick<GitHubClient, "createIssue">, now: Date,
  input: { title: string; body: string; labels: string[]; by: string; class: string; marker: string },
): Promise<number> {
  const number = await gh.createIssue(input.title, input.body, input.labels);
  await record(paths, "issue.filed", now, { number, by: input.by, class: input.class, labels: input.labels, marker: input.marker, body: input.body }, { issue: number });
  return number;
}
