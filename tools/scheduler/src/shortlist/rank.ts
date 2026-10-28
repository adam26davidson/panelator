import {parseSpec} from '../spec/parse.ts';
import {specPathFromIssueBody} from '../spec/link.ts';
import type { Config } from "../config.ts";
import type { IssueData } from "../types.ts";

export interface RecentMerges {
  feature: number;
  debt: number;
  system?: number;
  product?: number;
}

export function classOf(issue: IssueData, labels: Config["labels"]): "feature" | "debt" | "none" {
  if (issue.labels.some((l) => labels.feature_classes.includes(l))) return "feature";
  if (issue.labels.some((l) => labels.debt_classes.includes(l))) return "debt";
  return "none";
}

export type Work = 'system'|'product';
export function workOf(issue:IssueData,specText:string|null,readSpec:(path:string)=>string|null):Work {
  const fallback:Work=issue.labels.includes('class:product')?'product':'system';
  let text=specText; const seen=new Set<string>();
  while(text) {
    const parent=parseSpec(text).parent;
    if(!parent || seen.has(parent))break;
    if(parent==='docs/product-spec.md')return 'product';
    if(parent==='docs/delivery-system-design.md')return 'system';
    seen.add(parent);text=readSpec(parent);
  }
  return fallback;
}
export function classifyWork(issue:IssueData,readSpec:(path:string)=>string|null):Work {
  const path=specPathFromIssueBody(issue.body);return workOf(issue,path?readSpec(path):null,readSpec);
}
/** Priority, then the kind behind its configured share, then oldest. */
export function rankIssues(issues:IssueData[],labels:Config['labels'],recent:RecentMerges,share=0.75,work:(issue:IssueData)=>Work=i=>i.labels.includes('class:product')?'product':'system'):IssueData[] {
  const preferred:Work=(recent.system??0)<share*((recent.system??0)+(recent.product??0)+1)?'system':'product';
  return [...issues].sort((a,b)=>Number(b.labels.includes(labels.priority))-Number(a.labels.includes(labels.priority)) || Number(work(b)===preferred)-Number(work(a)===preferred) || a.createdAt.localeCompare(b.createdAt) || a.number-b.number);
}
