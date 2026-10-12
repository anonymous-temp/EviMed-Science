/** Deployment-owned engineering limits. These settings never grant a research runtime credentials,
 * network access, evaluator visibility or permission to modify production source. */
export const EVOLUTION_CONFIG_SCHEMA=Object.freeze({
  // 2026-10-12: raised from 50 to 100 with the owner's reallocation. The first six days spent 99% of 109 CNY on 37 paper-scouting runs that all ended
  // "waiting for material"; the extra money is for the modules' own improvement loops (below), not for more scouting.
  evolutionDailyBudgetCny:{env:'OPEN_SCIENCE_EVOLUTION_DAILY_BUDGET_CNY',default:100,min:0.01,max:10000},
  evolutionRunBudgetCny:{env:'OPEN_SCIENCE_EVOLUTION_RUN_BUDGET_CNY',default:10,min:0.01,max:1000},
  evolutionMaxConcurrency:{env:'OPEN_SCIENCE_EVOLUTION_MAX_CONCURRENCY',default:1,min:1,max:4,integer:true},
  evolutionLightConcurrency:{env:'OPEN_SCIENCE_EVOLUTION_LIGHT_CONCURRENCY',default:2,min:1,max:2,integer:true},
  evolutionMaxDecisionCards:{env:'OPEN_SCIENCE_EVOLUTION_MAX_DECISION_CARDS',default:3,min:1,max:3,integer:true},
  evolutionOperatorSignalFloor:{env:'OPEN_SCIENCE_EVOLUTION_OPERATOR_SIGNAL_FLOOR',default:1,min:1,max:5,integer:true},
  evolutionSelfResearchScreenLimit:{env:'OPEN_SCIENCE_EVOLUTION_SELF_RESEARCH_SCREEN_LIMIT',default:300,min:1,max:2000,integer:true},
  evolutionSelfResearchShortlistLimit:{env:'OPEN_SCIENCE_EVOLUTION_SELF_RESEARCH_SHORTLIST_LIMIT',default:30,min:1,max:200,integer:true},
  evolutionSelfResearchFullTextLimit:{env:'OPEN_SCIENCE_EVOLUTION_SELF_RESEARCH_FULL_TEXT_LIMIT',default:12,min:1,max:50,integer:true},
  evolutionSelfResearchCardLimit:{env:'OPEN_SCIENCE_EVOLUTION_SELF_RESEARCH_CARD_LIMIT',default:8,min:1,max:50,integer:true},
  evolutionSourceRequestLapseDays:{env:'OPEN_SCIENCE_EVOLUTION_SOURCE_REQUEST_LAPSE_DAYS',default:30,min:1,max:365,integer:true},
  evolutionSelfResearchTextChars:{env:'OPEN_SCIENCE_EVOLUTION_SELF_RESEARCH_TEXT_CHARS',default:60000,min:5000,max:200000,integer:true},
  // 2026-10-12: eight to two. A scouting run costs about 2.7 CNY and, live, every one of 37 ended on a card nobody could act on.
  evolutionMaxPaperScoutsPerDay:{env:'OPEN_SCIENCE_EVOLUTION_MAX_PAPER_SCOUTS_PER_DAY',default:2,min:0,max:200,integer:true},
  // The most of a day's budget that scouting runs of every origin (a paper, the daily scan, a lead, a re-scout) may hold. The count above bounds how many
  // papers are admitted; this bounds what they and the other scouts may cost, so a scout can no longer borrow the money a module's loop is waiting for.
  // Zero closes scouting by budget. 0.2 of 100 CNY is room for about seven runs at the live price.
  evolutionScoutBudgetShare:{env:'OPEN_SCIENCE_EVOLUTION_SCOUT_BUDGET_SHARE',default:0.2,min:0,max:1},
  // The share of a day's budget kept for the modules' own loops (their weekly research, repair and baseline missions and the transfer probes). Jobs of the
  // platform (scouts, builds, evaluations, audits, self-research) cannot borrow the part of it the loops have not yet taken; the loops themselves may take
  // more than the share when the day has money left. Together with the scout share it must leave room for the rest: the two may not exceed 1.
  evolutionModuleLoopBudgetShare:{env:'OPEN_SCIENCE_EVOLUTION_MODULE_LOOP_BUDGET_SHARE',default:0.5,min:0,max:1},
  evolutionDecisionTimeoutMs:{env:'OPEN_SCIENCE_EVOLUTION_DECISION_TIMEOUT_MS',default:86400000,min:1000,max:7*86400000,integer:true},
  evolutionPollMs:{env:'OPEN_SCIENCE_EVOLUTION_POLL_MS',default:15000,min:100,max:3600000,integer:true},
  evolutionLeaseMs:{env:'OPEN_SCIENCE_EVOLUTION_LEASE_MS',default:120000,min:1000,max:86400000,integer:true},
  evolutionRetryMs:{env:'OPEN_SCIENCE_EVOLUTION_RETRY_MS',default:60000,min:100,max:86400000,integer:true},
  evolutionEvaluationTimeoutMs:{env:'OPEN_SCIENCE_EVOLUTION_EVALUATION_TIMEOUT_MS',default:3600000,min:1000,max:8*3600000,integer:true},
  evolutionMaxJobAttempts:{env:'OPEN_SCIENCE_EVOLUTION_MAX_JOB_ATTEMPTS',default:3,min:1,max:10,integer:true},
  evolutionMaxBuildAttempts:{env:'OPEN_SCIENCE_EVOLUTION_MAX_BUILD_ATTEMPTS',default:3,min:1,max:10,integer:true},
  evolutionMaxArtifactBytes:{env:'OPEN_SCIENCE_EVOLUTION_MAX_ARTIFACT_BYTES',default:2000000,min:1024,max:4*1024*1024,integer:true},
  evolutionSelfCheckMaxBytes:{env:'OPEN_SCIENCE_EVOLUTION_SELF_CHECK_MAX_BYTES',default:4*1024*1024,min:1024,max:16*1024*1024,integer:true},
  evolutionSelfCheckMaxRows:{env:'OPEN_SCIENCE_EVOLUTION_SELF_CHECK_MAX_ROWS',default:10000,min:20,max:100000,integer:true},
  evolutionSelfCheckSampleRows:{env:'OPEN_SCIENCE_EVOLUTION_SELF_CHECK_SAMPLE_ROWS',default:256,min:20,max:2048,integer:true},
  evolutionExecutionMaxConcurrency:{env:'OPEN_SCIENCE_EVOLUTION_EXECUTION_MAX_CONCURRENCY',default:1,min:1,max:4,integer:true},
  evolutionExecutionTimeoutMs:{env:'OPEN_SCIENCE_EVOLUTION_EXECUTION_TIMEOUT_MS',default:30000,min:1000,max:30000,integer:true},
  evolutionToolMaxConcurrentPerProject:{env:'OPEN_SCIENCE_EVOLUTION_TOOL_MAX_CONCURRENT_PER_PROJECT',default:2,min:1,max:4,integer:true},
  evolutionToolCallsPerMinute:{env:'OPEN_SCIENCE_EVOLUTION_TOOL_CALLS_PER_MINUTE',default:60,min:1,max:1000,integer:true},
});
/** Closed validation findings never echo URLs, credentials, archive contents or customer values.
 * @param {any} config @returns {{code:string,key:string}[]} */
export function validateEvolutionConfiguration(config){
  const issues=[];
  if(config.evolutionSearchPaused!==undefined&&typeof config.evolutionSearchPaused!=='boolean')issues.push({code:'evolution_setting_invalid',key:'evolutionSearchPaused'});
  if(config.evolutionEnabled!==undefined&&typeof config.evolutionEnabled!=='boolean')issues.push({code:'evolution_setting_invalid',key:'evolutionEnabled'});
  if(config.evolutionEvaluationNetwork!==undefined&&(typeof config.evolutionEvaluationNetwork!=='string'||config.evolutionEvaluationNetwork!==''&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.evolutionEvaluationNetwork)))issues.push({code:'evolution_setting_invalid',key:'evolutionEvaluationNetwork'});
  for(const [key,field]of Object.entries(EVOLUTION_CONFIG_SCHEMA)){
    const value=config[key]??field.default;
    if(typeof value!=='number'||!Number.isFinite(value)||value<field.min||value>field.max||('integer'in field&&field.integer&&!Number.isInteger(value)))issues.push({code:'evolution_setting_invalid',key});
  }
  if(issues.every(issue=>issue.key!=='evolutionScoutBudgetShare'&&issue.key!=='evolutionModuleLoopBudgetShare')
    &&(config.evolutionScoutBudgetShare??EVOLUTION_CONFIG_SCHEMA.evolutionScoutBudgetShare.default)+(config.evolutionModuleLoopBudgetShare??EVOLUTION_CONFIG_SCHEMA.evolutionModuleLoopBudgetShare.default)>1+1e-9)issues.push({code:'evolution_setting_invalid',key:'evolutionModuleLoopBudgetShare'});
  const entries=config.evolutionDependencyAllowlist??[],ids=new Set();
  if(!Array.isArray(entries)||entries.length>64)return[...issues,{code:'evolution_dependency_allowlist_invalid',key:'evolutionDependencyAllowlist'}];
  for(const entry of entries){
    let valid=entry&&typeof entry==='object'&&!Array.isArray(entry)&&Object.keys(entry).sort().join(',')==='digest,filename,id,url,version'
      &&/^[A-Za-z0-9_-]{1,100}$/.test(entry.id??'')&&!ids.has(entry.id)&&typeof entry.version==='string'&&entry.version.length>0&&entry.version.length<=100
      &&/^sha256:[a-f0-9]{64}$/.test(entry.digest??'')&&/^[-A-Za-z0-9_.]+\.(?:whl|zip|tar\.gz)$/.test(entry.filename??'');
    try{const url=new URL(entry.url);valid=valid&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.search&&url.hostname.includes('.')&&!/^(?:localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname);}catch{valid=false;}
    if(!valid)issues.push({code:'evolution_dependency_allowlist_invalid',key:'evolutionDependencyAllowlist'});else ids.add(entry.id);
  }
  return issues;
}
