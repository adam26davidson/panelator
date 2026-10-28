#!/usr/bin/env node
import {startTelegram,telegramCheck} from '../src/service/telegram-start.ts';
import {TelegramPoller} from '../src/telegram/poller.ts';
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../src/adapters/index.ts";
import { agentsDir, defaultConfigPath, loadConfig, repoRoot } from "../src/config.ts";
import { createAppClient } from "../src/github/auth.ts";
import { GitHubClient } from "../src/github/client.ts";
import { LogNotifier } from "../src/notify/log.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import { fastForwardMain, fetchOrigin } from "../src/service/git.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { ServiceLog } from "../src/service/log.ts";
import { Scheduler } from "../src/service/loop.ts";
import { systemdStopUnit, systemdUnitActive } from "../src/service/units.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

import {loadRegistry} from '../src/standing/registry.ts';
import {EVENT_NAMES,emit} from '../src/standing/events.ts';
import {initializeAgents,listAgentStates} from '../src/standing/state.ts';
import {loadParameterDefinitions} from '../src/parameters/definitions.ts';
import {ParameterStore,withStateLock} from '../src/parameters/store.ts';
import {registryActionsCheck,loadActionLevels,applyAction} from '../src/actions/index.ts';
import {ActionLog} from '../src/actions/log.ts';
import {undoAction} from '../src/actions/undo.ts';
import {onFindingsQueued} from '../src/state/findings.ts';
import {loadMetricDefinitions,assertReadOnlySelect} from '../src/metrics/definitions.ts';
import {computeMetrics,historyRange,recordSnapshot} from '../src/metrics/compute.ts';
import {formatReport} from '../src/metrics/format.ts';
import {openIndex} from '../src/events/index.ts';
import {backfillEvents} from '../src/events/backfill.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);

const cfg = loadConfig(flag("--config") ?? defaultConfigPath);
const paths = statePaths(cfg.state_dir);
await ensureStateDirs(paths);
const serviceLog = new ServiceLog(paths.serviceLog);
const binDir = dirname(fileURLToPath(import.meta.url));
if(args[0]==='telegram-check'){
 try{console.log(await telegramCheck(cfg));process.exit(0);}catch(e){console.error((e as Error).message);process.exit(1);}
}

/** I7: a configuration error the service cannot recover from by restarting; the unit's RestartPreventExitStatus=78 stops the loop. */
function fail(reason: string): never {
  serviceLog.write({ kind: "config-error", reason });
  console.error(`panelator-scheduler: ${reason}`);
  process.exit(78);
}

const {registry,parameters,levels,metrics}=(()=>{try {
  const kinds=registryActionsCheck(join(agentsDir,'actions.yaml'));
  const registry=loadRegistry(join(agentsDir,'standing'),EVENT_NAMES,kinds);
  const parameters=new ParameterStore(paths,loadParameterDefinitions(join(agentsDir,'parameters.yaml'),cfg,registry));
  return {registry,parameters,levels:loadActionLevels(join(agentsDir,'actions.yaml')),metrics:loadMetricDefinitions(join(agentsDir,'metrics'))};
}catch(e){fail((e as Error).message);}})();
await initializeAgents(paths,registry,parameters,new Date());
const actionLog=new ActionLog(paths.actionsLog,paths);
const emitEvent=(event:string,payload:unknown)=>emit(paths,registry,event,payload);
onFindingsQueued(paths,(count,offset)=>emitEvent('finding_queued',{count,offset}));

// Metrics and the event store are read on the laptop as the service user; only --snapshot and backfill write events.
if(args[0]==='metrics'||args[0]==='events') {
  try {
    if(args[0]==='events'&&args[1]==='backfill')console.log(JSON.stringify(await backfillEvents(paths,rec=>serviceLog.write(rec)),null,2));
    else if(args[0]==='events'&&args[1]==='query') {
      if(!args[2])throw new Error('usage: events query "<sql>"');
      assertReadOnlySelect(args[2]);
      const db=openIndex(paths,{readOnly:true});
      for(const row of db.prepare(args[2]).all())console.log(JSON.stringify(row));
    } else if(args[0]==='metrics'&&args[1]==='show') {
      const def=metrics[args[2]];if(!def)throw new Error(`unknown metric ${args[2]}`);
      const db=openIndex(paths,{readOnly:true}),{from,to}=historyRange(db,def,new Date());
      const report=computeMetrics(db,metrics,{from,to,names:[def.name]});
      console.log(JSON.stringify({definition:def,history:report.metrics[0]?.buckets},null,2));
    } else if(args[0]==='metrics'&&!args[1]?.length||args[0]==='metrics'&&args[1]?.startsWith('--')) {
      const weeks=Number(flag('--weeks')??12);if(!Number.isInteger(weeks)||weeks<1)throw new Error('--weeks must be a positive integer');
      const to=new Date(),from=new Date(to.getTime()-weeks*7*86400000),db=openIndex(paths,{readOnly:true});
      const report=computeMetrics(db,metrics,{from,to,includeRetired:has('--all')});
      if(has('--snapshot'))await recordSnapshot(paths,report);
      console.log(has('--json')?JSON.stringify(report,null,2):formatReport(report));
    } else throw new Error('usage: metrics [--weeks n] [--json] [--snapshot] [--all]|show <name>; events backfill|query "<sql>"');
    process.exit(0);
  }catch(e){console.error((e as Error).message);process.exit(1);}
}
// Local administration works without service auth or the main-only checkout requirement.
if(['param','agent','action'].includes(args[0])) {
  let client:GitHubClient|undefined;
  const remote=async()=>client??=new GitHubClient(createAppClient(cfg.app,readFileSync(cfg.app.private_key_path,'utf8')).octokit,cfg.repo);
  const ctx={paths,parameters,log:actionLog,levels,now:()=>new Date(),gh:{rerunWorkflowRun:async(id:number)=>(await remote()).rerunWorkflowRun(id),cancelWorkflowRun:async(id:number)=>(await remote()).cancelWorkflowRun(id)}};
  try {
    const [command,verb,name,value]=args;
    if(command==='param'&&verb==='list')console.log(JSON.stringify(await parameters.all(),null,2));
    else if(command==='agent'&&verb==='list')console.log(JSON.stringify(Object.fromEntries(Object.entries(await listAgentStates(paths)).map(([name,state])=>[name,{...state,pending_event_count:state.pending_events.length}])),null,2));
    else if(command==='action'&&verb==='list')console.log(JSON.stringify(await actionLog.list(flag('--since')),null,2));
    else if(command==='param'&&verb==='set') {
      const def=parameters.definitions[name];if(!def)throw new Error(`undefined parameter ${name}`);
      const parsed=['number','boolean'].includes(def.type)?JSON.parse(value):value;
      const row=await applyAction(ctx,{agent:'maintainer',run_id:'command',kind:'set_parameter',args:{name,value:parsed},why:'Maintainer command line parameter change'},'maintainer');
      if(row.status!=='applied')throw new Error(row.reason);console.log(JSON.stringify(row));
    } else if(command==='param'&&verb==='mode') {
      await withStateLock(actionLog.path+'.operation',async()=>{
        const pending=await actionLog.writePending({agent:'maintainer',run_id:'command',kind:'parameter_mode',args:{name,value},why:'Maintainer command line parameter mode change',undo:null});
        try {await parameters.setParameterMode(name,value as 'auto'|'locked','maintainer');await actionLog.settle(pending.id,'applied');}catch(e){await actionLog.settle(pending.id,'refused',(e as Error).message);throw e;}
      });
    } else if(command==='agent'&&['pause','resume','run'].includes(verb)) {
      if(!registry[name])throw new Error(`unknown agent ${name}`);
      const row=await applyAction(ctx,{agent:'maintainer',run_id:'command',kind:`${verb}_agent`,args:{name},why:`Maintainer command line ${verb} agent request`},'maintainer');
      if(row.status!=='applied')throw new Error(row.reason);console.log(JSON.stringify(row));
    } else if(command==='action'&&verb==='undo') {
      const row=await undoAction(ctx,name,'maintainer');if(row.status!=='applied')throw new Error(row.reason);console.log(JSON.stringify(row));
    } else throw new Error('usage: param list|set <name> <value>|mode <name> auto|locked; agent list|pause|resume|run <name>; action list [--since time]|undo <id>');
    process.exit(0);
  }catch(e){console.error((e as Error).message);process.exit(1);}
}
await actionLog.markStalePending();

if (cfg.app.id === 0 || cfg.app.installation_id === 0) fail("GitHub App ids not set in agents/scheduler.yaml");
let privateKey: string;
try {
  privateKey = readFileSync(cfg.app.private_key_path, "utf8");
} catch (e) {
  fail(`cannot read the GitHub App private key at ${cfg.app.private_key_path}: ${(e as Error).message}`);
}
let branch = "";
try {
  branch = execFileSync("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  /* detached HEAD */
}
if (branch !== "main") fail("service checkout must be on main");
// Stages push with the App token through the credential helper, which only applies to https remotes.
const origin = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
if (!origin.startsWith("https://")) fail(`origin must be an https URL (stages cannot push over SSH); got ${origin}`);

const app = createAppClient(cfg.app, privateKey);
const token = await app.refreshTokenFile(paths);
const botLogin = await app.botLogin();
if (has("--check-auth")) {
  console.log(`bot ${botLogin}, token expires ${token.expires_at}`);
  process.exit(0);
}
const stopRefresh = app.startTokenRefresh(paths);
const gh = new GitHubClient(app.octokit, cfg.repo);

const telegram=await startTelegram(cfg,rec=>serviceLog.write(rec));
let exitCode = 0;
let restartRequested = false;
const scheduler: Scheduler = new Scheduler({
  cfg, paths, gh, telegram,registry, metrics, parameters, emitEvent, notifier: rateLimited(new LogNotifier(paths.serviceLog,paths), cfg.notify_rate_limit_hours),
  stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: repoRoot, binDir,
  adapterFor: (h) => adapterFor(h), systemdScope: cfg.systemd.scope, now: () => new Date(),
  unitActive: (unit) => systemdUnitActive(unit, { enabled: cfg.systemd.scope }),
  stopUnit: (unit) => systemdStopUnit(unit, { enabled: cfg.systemd.scope }),
  refreshToken: () => app.refreshTokenFile(paths).then(() => {}),
  log: (rec) => serviceLog.write(rec), fetchOrigin: () => fetchOrigin(repoRoot),
  botLogin, serviceLog, inhibitor: new SleepInhibitor({ enabled: cfg.systemd.inhibit }),
  fastForward: () => fastForwardMain(repoRoot), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
  // Called on every idle tick while a restart is pending; only the first call acts.
  // The process exits 75 (EX_TEMPFAIL) once run() returns, so Restart=on-failure restarts it.
  requestRestart: () => {
    if (restartRequested) return;
    restartRequested = true;
    serviceLog.write({ kind: "restart", reason: "tools/scheduler or agents changed on main" });
    exitCode = 75;
    stopRefresh();
    scheduler.stop("restart");
    void telegramPoller?.stop();
  },
});

const telegramPoller=telegram?new TelegramPoller(telegram.client,paths.telegramOffset,cfg.telegram!.long_poll_timeout_s,u=>scheduler.handleTelegramUpdate(u),rec=>serviceLog.write(rec),undefined,u=>scheduler.confirmTelegramUpdate(u)):null;
telegramPoller?.start();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => {scheduler.stop(sig);void telegramPoller?.stop();});

if (has("--once")) {
  const info = await scheduler.tick();
  console.log(JSON.stringify(info));
  while (scheduler.active > 0) await new Promise((r) => setTimeout(r, 1000));
  scheduler.stop("once");
}
await scheduler.run();
await telegramPoller?.stop();
stopRefresh();
process.exit(exitCode);
