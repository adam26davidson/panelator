#!/usr/bin/env node
import {startTelegram,telegramCheck} from '../src/service/telegram-start.ts';
import {TelegramPoller} from '../src/telegram/poller.ts';
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../src/adapters/index.ts";
import { agentsDir, defaultConfigPath, expandHome, loadConfig, repoRoot } from "../src/config.ts";
import { createAppClient } from "../src/github/auth.ts";
import { GitHubClient } from "../src/github/client.ts";
import { LogNotifier } from "../src/notify/log.ts";
import { recordedNotifier } from "../src/notify/recorded.ts";
import { rateLimited } from "../src/notify/rate-limit.ts";
import { fastForwardMain, fetchOrigin } from "../src/service/git.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { ServiceLog } from "../src/service/log.ts";
import { Scheduler } from "../src/service/loop.ts";
import { probeHost } from "../src/service/host.ts";
import { statfsFreeSpace } from "../src/runner/host-space.ts";
import { systemdStopUnit, systemdUnitActive } from "../src/service/units.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

import {loadRegistry} from '../src/standing/registry.ts';
import {EVENT_NAMES} from '../src/standing/events.ts';
import {initializeAgents,listAgentStates} from '../src/standing/state.ts';
import {loadParameterDefinitions} from '../src/parameters/definitions.ts';
import {TelegramNotifier} from '../src/notify/telegram.ts';
import type {TelegramChannel} from '../src/telegram/channel.ts';
import {contactsCommand} from '../src/contacts/commands.ts';
import {checkInstallationScope,SCOPE_FIX} from '../src/contacts/scope.ts';
import {readContactLog} from '../src/contacts/log.ts';
import {ParameterStore} from '../src/parameters/store.ts';
import {setParameterModeCommand} from '../src/parameters/command.ts';
import {registryActionsCheck,loadActionLevels,applyAction} from '../src/actions/index.ts';
import {ActionLog} from '../src/actions/log.ts';
import {undoAction} from '../src/actions/undo.ts';
import {resolveProfile} from '../src/profiles/resolve.ts';
import {loadCatalogue,profileNames,checkCredentialNames} from '../src/credentials/catalogue.ts';
import {storeFromConfig,appPrivateKey,appPrivateKeySource} from '../src/credentials/store.ts';
import {credCommand} from '../src/credentials/commands.ts';
import {awsCli} from '../src/aws/cli.ts';
import {newAwsState,type AwsContext} from '../src/aws/context.ts';
import {awsCheck,awsPull,awsStatus} from '../src/aws/check.ts';
import {emit} from '../src/standing/events.ts';
import {loadMetricDefinitions,assertReadOnlySelect} from '../src/metrics/definitions.ts';
import {computeMetrics,historyRange,recordSnapshot,weekStart} from '../src/metrics/compute.ts';
import {formatReport} from '../src/metrics/format.ts';
import {openIndex} from '../src/events/index.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);

// Spec 088: --agents-dir exists for tests; the default is the checkout's agents/.
const agentsRoot = flag("--agents-dir") ?? agentsDir;
const cfg = loadConfig(flag("--config") ?? defaultConfigPath);
const paths = statePaths(cfg.state_dir);
await ensureStateDirs(paths);
const serviceLog = new ServiceLog(paths.serviceLog);
const binDir = dirname(fileURLToPath(import.meta.url));
const credStore=storeFromConfig(cfg);
if(args[0]==='telegram-check'){
 try{console.log(await telegramCheck(cfg,undefined,credStore));process.exit(0);}catch(e){console.error((e as Error).message);process.exit(1);}
}

/** I7: a configuration error the service cannot recover from by restarting; the unit's RestartPreventExitStatus=78 stops the loop. */
function fail(reason: string): never {
  serviceLog.write({ kind: "config-error", reason });
  console.error(`panelator-scheduler: ${reason}`);
  process.exit(78);
}

const {registry,parameters,levels,catalogue,metrics}=(()=>{try {
  const kinds=registryActionsCheck(join(agentsRoot,'actions.yaml'));
  const registry=loadRegistry(join(agentsRoot,'standing'),EVENT_NAMES,kinds);
  const parameters=new ParameterStore(paths,loadParameterDefinitions(join(agentsRoot,'parameters.yaml'),cfg,registry));
  const catalogue=loadCatalogue(join(agentsRoot,'credentials.yaml'),{profiles:profileNames(agentsRoot),agents:Object.keys(registry)});
  checkCredentialNames(catalogue,{profiles:Object.fromEntries(profileNames(agentsRoot).map(n=>[n,resolveProfile(agentsRoot,n).credentials??[]])),agents:Object.fromEntries(Object.values(registry).map(d=>[d.name,d.credentials??[]]))});
  return {registry,parameters,levels:loadActionLevels(join(agentsRoot,'actions.yaml')),catalogue,metrics:loadMetricDefinitions(join(agentsRoot,'metrics'))};
}catch(e){fail((e as Error).message);}})();
await initializeAgents(paths,registry,parameters,new Date());
const actionLog=new ActionLog(paths.actionsLog,paths);
// Spec 099 AC-6: one chain for every notification; the poller attaches the Telegram channel once it is up.
let attachedTelegram:TelegramChannel|null=null;
const notifier=rateLimited(recordedNotifier(TelegramNotifier(new LogNotifier(paths.serviceLog),{telegram:()=>attachedTelegram,alertsPath:paths.telegramAlerts,outboxPath:paths.telegramOutbox,now:()=>new Date(),log:rec=>serviceLog.write(rec)}),paths),{hours:cfg.notify_rate_limit_hours,repeatHours:cfg.notify_repeat_hours,path:paths.notifySent});
const awsContext:AwsContext={config:cfg.aws,paths,cli:cfg.aws?awsCli(cfg.aws):undefined,parameters,
 notifier,notifyHours:cfg.notify_rate_limit_hours,
 now:()=>new Date(),log:rec=>serviceLog.write(rec),emitEvent:(event,payload)=>emit(paths,registry,event,payload,new Date()),state:newAwsState()};

// Local administration works without service auth or the main-only checkout requirement.
if(args[0]==='events'&&args[1]==='backfill') {
  // Spec 026 AC-4: the records that exist before the event store, once; a second run records nothing.
  const {backfillEvents}=await import('../src/events/backfill.ts');
  const counts=await backfillEvents(paths,rec=>serviceLog.write(rec));
  console.log(JSON.stringify(counts,null,2));
  process.exit(0);
}
if(args[0]==='metrics'||(args[0]==='events'&&args[1]==='query')) {
  // Spec 027 AC-6: the maintainer's view; the index opens read-only and only --snapshot records an event.
  try {
    if(args[0]==='events') {
      if(!args[2])throw new Error('usage: events query "<sql>"');
      assertReadOnlySelect(args[2]);
      const db=openIndex(paths,{readOnly:true});
      for(const row of db.prepare(args[2]).all())console.log(JSON.stringify(row));
    } else if(args[1]==='show') {
      const def=metrics[args[2]];if(!def)throw new Error(`unknown metric ${args[2]}`);
      const db=openIndex(paths,{readOnly:true});
      const report=computeMetrics(db,metrics,{...historyRange(db,def,new Date()),names:[def.name]});
      console.log(JSON.stringify({definition:def,history:report.metrics[0]?.buckets},null,2));
    } else if(!args[1]||args[1].startsWith('--')) {
      const weeks=Number(flag('--weeks')??12);if(!Number.isInteger(weeks)||weeks<1)throw new Error('--weeks must be a positive integer');
      const to=new Date(),from=new Date(Date.parse(weekStart(to.getTime()))-(weeks-1)*7*86400000),db=openIndex(paths,{readOnly:true});
      const report=computeMetrics(db,metrics,{from,to,includeRetired:has('--all')});
      if(has('--snapshot'))await recordSnapshot(paths,report);
      console.log(has('--json')?JSON.stringify(report,null,2):formatReport(report));
    } else throw new Error('usage: metrics [--weeks n] [--json] [--snapshot] [--all]|show <name>; events backfill|query "<sql>"');
    process.exit(0);
  }catch(e){console.error((e as Error).message);process.exit(1);}
}
if(args[0]==='quota') {
  // Spec 013 AC-10: the quota book, with the claims and agents waiting on it.
  const {readBook,quotaSummary}=await import('../src/quota/book.ts');
  const book=await readBook(paths);
  console.log(JSON.stringify({...book,summary:await quotaSummary(paths,new Date())},null,2));
  process.exit(0);
}
if(args[0]==='console'&&args[1]==='state') {
  // Spec 051 AC-3: the laptop fallback; the snapshot as the console would receive it.
  const {buildConsoleState}=await import('../src/console/state.ts');
  console.log(JSON.stringify(await buildConsoleState({cfg,paths,parameters,log:actionLog,registry,metrics,now:()=>new Date()}),null,2));
  process.exit(0);
}
if(args[0]==='console'&&(args[1]==='deploy'||args[1]==='destroy')) {
  // Spec 051 AC-7: the hosting goes through spec 022's reservation and `aws` wrapper.
  const {deployConsole,destroyConsole}=await import('../src/console/deploy.ts');
  try {
    if(args[1]==='destroy')await destroyConsole(awsContext);
    else {
      const {execSync}=await import('node:child_process');
      const consoleDir=join(repoRoot,'console');
      const credentialsPath=cfg.console?.credentials_path??expandHome('~/.config/panelator/console.json');
      await deployConsole({ctx:awsContext,maintainer:cfg.maintainer,clientId:cfg.console?.github_client_id??flag('--client-id')??'',credentialsPath,domain:flag('--domain'),hostedZoneId:flag('--hosted-zone'),
        templatePath:join(consoleDir,'infra','stack.yaml'),print:l=>console.log(l),
        build:async()=>{
          execSync('pnpm -F @panelator/console build',{cwd:repoRoot,stdio:'inherit'});
          execSync('pnpm -F @panelator/console build:api',{cwd:repoRoot,stdio:'inherit'});
          return {appDir:join(consoleDir,'dist'),lambdaZip:join(consoleDir,'dist-api','lambda.zip')};
        }});
    }
    process.exit(0);
  } catch(e) {console.error(`panelator-scheduler: ${(e as Error).message}`);process.exit(1);}
}
if(args[0]==='aws-check'||args[0]==='aws') {
  // Spec 022 AC-3, AC-10: the setup check, the book, and a forced pull; no GitHub and no service auth.
  try {
    const out=args[0]==='aws-check'?await awsCheck(awsContext):args[1]==='pull'?await awsPull(awsContext):await awsStatus(awsContext,has('--json'));
    for(const line of out.lines)console.log(line);
    process.exit(out.exitCode);
  }catch(e){console.error((e as Error).message);process.exit(1);}
}
if(['param','agent','action','cred','contacts'].includes(args[0])) {
  let client:GitHubClient|undefined;
  const remote=async()=>client??=new GitHubClient(createAppClient(cfg.app,await appPrivateKey(cfg,credStore)).octokit,cfg.repo);
  const ctx={paths,parameters,log:actionLog,levels,now:()=>new Date(),gh:{rerunWorkflowRun:async(id:number)=>(await remote()).rerunWorkflowRun(id),cancelWorkflowRun:async(id:number)=>(await remote()).cancelWorkflowRun(id)},
   credentials:{store:credStore,catalogue,probe:{store:credStore,app:cfg.app,now:()=>new Date()},configPaths:{'github-app-key':cfg.app.private_key_path,'telegram-bot':cfg.telegram!.credentials_path}}};
  try {
    const [command,verb,name,value]=args;
    if(command==='param'&&verb==='list')console.log(JSON.stringify(await parameters.all(),null,2));
    else if(command==='agent'&&verb==='list')console.log(JSON.stringify(Object.fromEntries(Object.entries(await listAgentStates(paths)).map(([name,state])=>[name,{...state,pending_event_count:state.pending_events.length}])),null,2));
    else if(command==='cred') {
      const readStdin=async()=>{let text='';for await(const chunk of process.stdin)text+=chunk;return text;};
      const out=await credCommand(verb,name,{ctx,readStdin});
      for(const line of out.lines)console.log(line);
      process.exit(out.exitCode);
    }
    else if(command==='contacts'&&(verb==='list'||verb==='remove')){const out=await contactsCommand(verb,name,{paths,now:()=>new Date()});for(const l of out.lines)console.log(l);process.exit(out.exitCode);}
    else if(command==='contacts'&&verb==='log')console.log(JSON.stringify(await readContactLog(paths,flag('--since')),null,2));
    else if(command==='action'&&verb==='list')console.log(JSON.stringify(await actionLog.list(flag('--since')),null,2));
    else if(command==='param'&&verb==='set') {
      const def=parameters.definitions[name];if(!def)throw new Error(`undefined parameter ${name}`);
      const parsed=['number','boolean'].includes(def.type)?JSON.parse(value):value;
      const row=await applyAction(ctx,{agent:'maintainer',run_id:'command',kind:'set_parameter',args:{name,value:parsed},why:'Maintainer command line parameter change'},'maintainer');
      if(row.status!=='applied')throw new Error(row.reason);console.log(JSON.stringify(row));
    } else if(command==='param'&&verb==='mode') {
      console.log(JSON.stringify(await setParameterModeCommand(parameters,name,value)));
    } else if(command==='agent'&&['pause','resume','run'].includes(verb)) {
      if(!registry[name])throw new Error(`unknown agent ${name}`);
      const row=await applyAction(ctx,{agent:'maintainer',run_id:'command',kind:`${verb}_agent`,args:{name},why:`Maintainer command line ${verb} agent request`},'maintainer');
      if(row.status!=='applied')throw new Error(row.reason);console.log(JSON.stringify(row));
    } else if(command==='action'&&verb==='undo') {
      const row=await undoAction(ctx,name,'maintainer');if(row.status!=='applied')throw new Error(row.reason);console.log(JSON.stringify(row));
    } else throw new Error('usage: param list|set <name> <value>|mode <name> auto|locked; agent list|pause|resume|run <name>; action list [--since time]|undo <id>; contacts list|remove <party>|log [--since time]; cred set|list|check|import|remove; quota');
    process.exit(0);
  }catch(e){console.error((e as Error).message);process.exit(1);}
}
await actionLog.markStalePending();

if (cfg.app.id === 0 || cfg.app.installation_id === 0) fail("GitHub App ids not set in agents/scheduler.yaml");
let privateKey: string;
let appKeySource: "store" | "file";
try {
  ({ key: privateKey, source: appKeySource } = await appPrivateKeySource(cfg, credStore));
} catch (e) {
  fail((e as Error).message);
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
const scope = await checkInstallationScope({ app, installationId: cfg.app.installation_id, repo: cfg.repo }).catch((e): { status: "failed"; reason: string } => ({ status: "failed", reason: `scope check failed: ${(e as Error).message}` }));
if (scope.status === "failed") {
  serviceLog.write({ kind: "contact-scope", reason: scope.reason });
  if (!has("--check-auth")) await notifier.notify({ issue: 0, gate: "infra", label: "contact-scope", text: `${scope.reason}; ${SCOPE_FIX}` }).catch(() => {});
}
if (has("--check-auth")) {
  console.log(`bot ${botLogin}, token expires ${token.expires_at}`);
  console.log(scope.status === "ok" ? `installation scope ok (${cfg.repo} only)` : `installation scope FAILED: ${scope.reason}; ${SCOPE_FIX}`);
  process.exit(0);
}
const stopRefresh = app.startTokenRefresh(paths);
const gh = new GitHubClient(app.octokit, cfg.repo);

const inhibitor = new SleepInhibitor({ enabled: cfg.systemd.inhibit, log: (rec) => serviceLog.write(rec) });
// The lock never outlives the process, whatever path ends it.
process.on("exit", () => inhibitor.release());
const telegram=await startTelegram(cfg,rec=>serviceLog.write(rec),undefined,credStore);
// Spec 072 AC-2: the credentials this process reads from the store, fixed for its life.
const fromStore=new Set<string>();
if(appKeySource==='store')fromStore.add('github-app-key');
if(telegram?.source==='store')fromStore.add('telegram-bot');
let exitCode = 0;
let restartRequested = false;
// Spec 051 AC-1, AC-3, AC-4: the console is off without a `console` block.
const consoleView={issues:new Map<number,{title:string;class:string}>(),next:[] as number[]};
let consolePoller:import('../src/console/poll.ts').ConsolePoller|null=null;
let consoleWatch:{close():void}|null=null;
let consoleDep:{pusher:import('../src/console/push.ts').ConsolePusher;view:typeof consoleView}|undefined;
let telegramPollerRef:TelegramPoller|null=null;
if(cfg.console){
  const {ConsolePusher}=await import('../src/console/push.ts');
  const {buildConsoleState}=await import('../src/console/state.ts');
  const pusher=new ConsolePusher({cfg:cfg.console,fetch:globalThis.fetch,now:()=>new Date(),log:rec=>serviceLog.write(rec),
    build:()=>buildConsoleState({cfg,paths,parameters,log:actionLog,registry,metrics,now:()=>new Date(),issues:()=>consoleView.issues,upNext:()=>consoleView.next,telegramUsername:()=>telegramPollerRef?.username??null})});
  // AC-3: a question, claim, action or parameter write is seen on its state file and pushed, debounced by the pusher.
  const {watchConsoleSources}=await import('../src/console/watch.ts');
  consoleWatch=watchConsoleSources(paths,()=>pusher.notify(),rec=>serviceLog.write(rec));
  consoleDep={pusher,view:consoleView};
}else serviceLog.write({kind:'console',status:'off'});
const scheduler: Scheduler = new Scheduler({
  cfg, paths, gh, telegram: null,registry,metrics,credentials:{store:credStore,catalogue,warnDays:cfg.credentials.warn_days},plainFiles:{store:credStore,paths:{'github-app-key':cfg.app.private_key_path,...(cfg.telegram?{'telegram-bot':cfg.telegram.credentials_path}:{})},fromStore}, parameters, notifier,
  stages: loadStageDefinitions(join(agentsRoot, "stages")), agentsDir: agentsRoot, repoDir: repoRoot, binDir, configPath: flag("--config") ?? defaultConfigPath, catalogue, scope: () => checkInstallationScope({ app, installationId: cfg.app.installation_id, repo: cfg.repo }), checkContext: { store: credStore, app: cfg.app, now: () => new Date() },
  adapterFor: (h) => adapterFor(h), systemdScope: cfg.systemd.scope, now: () => new Date(),
  unitActive: (unit) => systemdUnitActive(unit, { enabled: cfg.systemd.scope }),
  stopUnit: (unit) => systemdStopUnit(unit, { enabled: cfg.systemd.scope }),
  refreshToken: () => app.refreshTokenFile(paths).then(() => {}),
  log: (rec) => serviceLog.write(rec), fetchOrigin: () => fetchOrigin(repoRoot),
  aws: awsContext, botLogin, serviceLog, inhibitor, console: consoleDep,
  // Spec 100: the real host probe (GitHub's hosts over the global fetch, statfs); the scheduler builds its host monitor around it.
  probeHost: () => probeHost({ paths, fetch: globalThis.fetch, freeSpace: statfsFreeSpace, log: (rec) => serviceLog.write(rec) }),
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
    void telegramPoller?.stop();void consolePoller?.stop();consoleWatch?.close();
  },
});

const telegramPoller=telegram?new TelegramPoller(telegram.client,paths.telegramOffset,cfg.telegram!.long_poll_timeout_s,u=>scheduler.handleTelegramUpdate(u),rec=>serviceLog.write(rec),undefined,u=>scheduler.confirmTelegramUpdate(u),()=>{attachedTelegram=telegram;scheduler.setTelegram(telegram);}):null;
telegramPoller?.start();
telegramPollerRef=telegramPoller;
if(cfg.console&&consoleDep){
  const {ConsolePoller}=await import('../src/console/poll.ts');
  const action=():import('../src/actions/index.ts').ActionContext=>({paths,parameters,log:actionLog,levels,now:()=>new Date(),gh:{rerunWorkflowRun:async()=>{throw new Error('not offered by the console');},cancelWorkflowRun:async()=>{throw new Error('not offered by the console');}}});
  consolePoller=new ConsolePoller({cfg:cfg.console,fetch:globalThis.fetch,action,pusher:consoleDep.pusher,log:rec=>serviceLog.write(rec)});
  consolePoller.start();
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => {scheduler.stop(sig);void telegramPoller?.stop();void consolePoller?.stop();consoleWatch?.close();});

if (has("--once")) {
  const info = await scheduler.tick();
  console.log(JSON.stringify(info));
  while (scheduler.active > 0) await new Promise((r) => setTimeout(r, 1000));
  scheduler.stop("once");
}
await scheduler.run();
await telegramPoller?.stop();
await consolePoller?.stop();consoleWatch?.close();
stopRefresh();
process.exit(exitCode);
