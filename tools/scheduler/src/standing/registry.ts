import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { splitFrontmatter, sharedDefinitionChecks, parseAgentDefinition } from '../stages/definition.ts';
import type { StandingDefinition } from '../types.ts';
import { schemaDir } from '../schema/validate.ts';

export function parseDuration(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value);
  if (!m || !Number.isFinite(Number(m[1]))) throw new Error(`invalid duration: ${value}`);
  return Number(m[1]) * ({m:60000,h:3600000,d:86400000}[m[2]]!);
}
export function parseStandingDefinition(markdown: string, events: readonly string[], actions: readonly string[]): StandingDefinition {
  const {frontmatter, body} = splitFrontmatter(markdown);
  const fm = parse(frontmatter) as Record<string, unknown>;
  const keys = ['name','kind','trigger','harness','model','fallback','independent','tier','effort','bounds','permission','worktree','profile','input','output','actions'];
  for (const k of Object.keys(fm)) if (!keys.includes(k)) throw new Error(`unknown key ${k}`);
  for (const k of ['name','kind','harness','model','tier','permission','worktree','profile','input','output']) if (typeof fm[k] !== 'string' || !fm[k]) throw new Error(`${k} is required`);
  if (!/^[a-z][a-z0-9-]*$/.test(String(fm.name))) throw new Error('name must be a safe file name');
  if (fm.kind !== 'standing') throw new Error('kind must be standing');
  sharedDefinitionChecks(fm);
  if (fm.worktree !== 'fresh' && fm.worktree !== 'none') throw new Error('worktree must be fresh or none');
  const t = fm.trigger as StandingDefinition['trigger'];
  if (!t || typeof t !== 'object' || Array.isArray(t) || !Object.keys(t).length || Object.keys(t).some(k => !['schedule','events'].includes(k))) throw new Error('trigger must have schedule or events');
  if (t.schedule !== undefined && (typeof t.schedule !== 'string' || parseDuration(t.schedule) < 3600000 || parseDuration(t.schedule) > 30*86400000)) throw new Error('trigger.schedule must be between 1h and 30d');
  if (t.events !== undefined && (!Array.isArray(t.events) || !t.events.length || t.events.some(e => !events.includes(e)))) throw new Error('trigger.events unknown or empty');
  const allowed = fm.actions ?? [];
  if (!Array.isArray(allowed) || allowed.some(k => typeof k !== 'string' || !actions.includes(k))) throw new Error('actions contains unknown kind');
  if(fm.effort!==undefined && typeof fm.effort!=='string')throw new Error('effort must be a string');
  if(!/^[a-z][a-z0-9-]*$/.test(String(fm.profile)) || fm.profile==='from-issue')throw new Error('profile must be none or a profile name');
  if(!/^[a-z][a-z0-9-]*$/.test(String(fm.input)))throw new Error('input must be a schema name');
  const output = String(fm.output);
  if (!/^[a-z][a-z0-9-]*$/.test(output)) throw new Error('output invalid schema name');
  if (output !== 'standing-result') {
    let schema: {allOf?: {$ref?: string}[]};
    try { schema = JSON.parse(readFileSync(join(schemaDir, `${output}.json`), 'utf8')); } catch { throw new Error('output schema missing'); }
    if (!schema.allOf?.some(r => r.$ref === 'standing-result.json')) throw new Error('output must extend standing-result');
  }
  if (!existsSync(join(schemaDir, `${fm.input}.json`))) throw new Error('input schema missing');
  return {...fm, actions: allowed, prompt: body} as unknown as StandingDefinition;
}
export function loadRegistry(dir: string, knownEvents: readonly string[], actionKinds: readonly string[]): Record<string, StandingDefinition> {
  const out: Record<string, StandingDefinition> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    try {
      const def = parseAgentDefinition(readFileSync(join(dir,f),'utf8'), knownEvents, actionKinds);
      if(def.kind!=='standing')throw new Error('kind must be standing');
      if (`${def.name}.md` !== f) throw new Error('name must equal file name');
      out[def.name] = def;
    } catch(e) { throw new Error(`${join(dir,f)}: ${(e as Error).message}`); }
  }
  return out;
}
export function renderStandingPrompt(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values,key)) throw new Error(`unknown placeholder: ${key}`);
    return typeof values[key] === 'string' ? values[key] as string : JSON.stringify(values[key]);
  });
}
