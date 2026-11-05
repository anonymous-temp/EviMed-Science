/** Deployment-owned engineering limits. These settings never grant a research runtime credentials,
 * network access, evaluator visibility or permission to modify production source. */
export const EVOLUTION_CONFIG_SCHEMA=Object.freeze({
  evolutionMaxConcurrency:{env:'OPEN_SCIENCE_EVOLUTION_MAX_CONCURRENCY',default:1,min:1,max:4,integer:true},
  evolutionMaxDecisionCards:{env:'OPEN_SCIENCE_EVOLUTION_MAX_DECISION_CARDS',default:3,min:1,max:3,integer:true},
  evolutionOperatorSignalFloor:{env:'OPEN_SCIENCE_EVOLUTION_OPERATOR_SIGNAL_FLOOR',default:1,min:1,max:5,integer:true},
  // How long what serving writes at a rate is kept (`evolutionRetention.mjs`): a signal and a lead occurrence, which the offline lab's export counts over the last two months, and a processed event nothing reads again. The least is the export's window; the key is not the old OPEN_SCIENCE_EVOLUTION_RECORD_RETENTION_DAYS because production pins that one at 14, a meaning this retention must not inherit.
  evolutionSignalRetentionDays:{env:'OPEN_SCIENCE_EVOLUTION_SIGNAL_RETENTION_DAYS',default:180,min:62,max:365,integer:true},
  // The rows one daily pass deletes, oldest first: a bound on the pass (one transaction), not on what is kept.
  evolutionRetentionBatchRows:{env:'OPEN_SCIENCE_EVOLUTION_RETENTION_BATCH_ROWS',default:5000,min:100,max:50000,integer:true},
  evolutionDecisionTimeoutMs:{env:'OPEN_SCIENCE_EVOLUTION_DECISION_TIMEOUT_MS',default:86400000,min:1000,max:7*86400000,integer:true},
  evolutionPollMs:{env:'OPEN_SCIENCE_EVOLUTION_POLL_MS',default:15000,min:100,max:3600000,integer:true},
  evolutionLeaseMs:{env:'OPEN_SCIENCE_EVOLUTION_LEASE_MS',default:120000,min:1000,max:86400000,integer:true},
  evolutionRetryMs:{env:'OPEN_SCIENCE_EVOLUTION_RETRY_MS',default:60000,min:100,max:86400000,integer:true},
  evolutionMaxJobAttempts:{env:'OPEN_SCIENCE_EVOLUTION_MAX_JOB_ATTEMPTS',default:3,min:1,max:10,integer:true},
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
  if(config.evolutionEnabled!==undefined&&typeof config.evolutionEnabled!=='boolean')issues.push({code:'evolution_setting_invalid',key:'evolutionEnabled'});
  for(const [key,field]of Object.entries(EVOLUTION_CONFIG_SCHEMA)){
    const value=config[key]??field.default;
    if(typeof value!=='number'||!Number.isFinite(value)||value<field.min||value>field.max||('integer'in field&&field.integer&&!Number.isInteger(value)))issues.push({code:'evolution_setting_invalid',key});
  }
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
