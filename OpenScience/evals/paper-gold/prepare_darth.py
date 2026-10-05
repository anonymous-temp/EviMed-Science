"""Preserve published DARTH author code and reproduce both tables outside runtime mounts.

Expected numbers come only from separately preserved primary-paper table transcriptions.
The production artifact receives matrices and reward specifications, never expected results.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

JSON_R = '''
json_value <- function(x) {
 if (is.matrix(x)) return(paste0('[',paste(apply(x,1,function(row)json_value(as.numeric(row))),collapse=','),']'))
 if (is.list(x)) {
  values <- vapply(x,json_value,character(1))
  if (!is.null(names(x))) return(paste0('{',paste(paste0('"',names(x),'":',values),collapse=','),'}'))
  return(paste0('[',paste(values,collapse=','),']'))
 }
 if (length(x)>1) return(paste0('[',paste(format(x,digits=17,scientific=FALSE,trim=TRUE),collapse=','),']'))
 as.character(x)
}
strategies <- list()
labels <- c('soc','a','b','ab')
for(i in 1:4) {
 transitions <- if(exists('a_P_SoC')) get(c('a_P_SoC','a_P_strA','a_P_strB','a_P_strAB')[i]) else array(rep(get(c('m_P','m_P_strA','m_P_strB','m_P_strAB')[i]),n_cycles),c(n_states,n_states,n_cycles))
 cost_rewards <- matrix(rep(l_c[[i]],each=n_states),nrow=n_states)
 utility_rewards <- matrix(rep(l_u[[i]],each=n_states),nrow=n_states)
 dimnames(cost_rewards) <- dimnames(utility_rewards) <- list(v_names_states,v_names_states)
 if(exists('du_HS1')) {
  utility_rewards['H','S1'] <- utility_rewards['H','S1'] - du_HS1
  cost_rewards['H','S1'] <- cost_rewards['H','S1'] + ic_HS1
  cost_rewards[-n_states,'D'] <- cost_rewards[-n_states,'D'] + ic_D
 }
 strategies[[labels[i]]] <- list(transitionMatrices=lapply(1:n_cycles,function(t)transitions[,,t]),costRewards=cost_rewards,utilityRewards=utility_rewards)
}
specification <- list(initial=as.numeric(c(1,0,0,0)),strategies=strategies,costWeights=as.numeric(v_dwc*v_wcc),utilityWeights=as.numeric(v_dwe*v_wcc))
cat('SPECIFICATION:',json_value(specification),'\\n',sep='')
write.csv(data.frame(cost=v_tot_cost,qaly=v_tot_qaly),stdout(),row.names=FALSE)
'''

def fetch(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise

def prepare(data_dir, method_id):
    directory = data_dir / 'paper-gold' / 'economics'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    cases = []
    for kind, repo in [('independent', 'cohort-modeling-tutorial-intro'), ('dependent', 'cohort-modeling-tutorial-timedep')]:
        identity = 'darth-time-' + kind
        primary = json.loads((directory / (identity + '.json')).read_text())
        commit = json.loads(fetch('https://api.github.com/repos/DARTH-git/' + repo + '/commits/main'))['sha']
        files = ['R/Functions.R', 'analysis/cSTM_time_indep.R' if kind == 'independent' else 'analysis/cSTM_time_dep_simulation.R']
        if kind == 'dependent':
            files.append('data/LifeTable_USA_Mx_2015.csv')
        artifacts = {}
        for name in files:
            content = fetch(f'https://raw.githubusercontent.com/DARTH-git/{repo}/{commit}/{name}')
            target = directory / (repo + '-' + Path(name).name)
            target.write_bytes(content)
            os.chmod(target, 0o600)
            artifacts[name] = hashlib.sha256(content).hexdigest()
        source = (directory / (repo + '-' + Path(files[1]).name)).read_text()
        program = source[source.index('# Model input ----'):source.index('# Cost-effectiveness analysis (CEA) ----')]
        program = program[:program.index('# Plot Outputs ----')] + program[program.index('# State Rewards ----'):]
        if kind == 'dependent':
            program = program.replace('"data/LifeTable_USA_Mx_2015.csv"', json.dumps(str(directory / (repo + '-LifeTable_USA_Mx_2015.csv'))))
            program = re.sub(r'v_r_mort_by_age <- lt_usa_2015 %>%[\s\S]*?as.matrix\(\)', 'v_r_mort_by_age <- as.matrix(lt_usa_2015[lt_usa_2015$Age >= n_age_init & lt_usa_2015$Age < n_age_max, "Total", drop=FALSE])', program)
        program = 'source(' + json.dumps(str(directory / (repo + '-Functions.R'))) + ')\n' + program + '\n' + JSON_R
        entry = directory / (identity + '-reference.R')
        entry.write_text(program)
        os.chmod(entry, 0o600)
        completed = subprocess.run(['Rscript', '--vanilla', str(entry)], capture_output=True, text=True, check=True, timeout=120)
        lines = completed.stdout.splitlines()
        specification = json.loads(next(line[len('SPECIFICATION:'):] for line in lines if line.startswith('SPECIFICATION:')))
        start = lines.index('"cost","qaly"')
        rows = list(csv.DictReader(io.StringIO('\n'.join(lines[start:]))))
        numeric = {}
        independent = {}
        for index, label in enumerate(['soc', 'a', 'b', 'ab']):
            for metric, printed_name in [('cost', 'cost'), ('qaly', 'qalys')]:
                key = f'{label}.{metric}'
                reference = primary['numeric'][f'{label}_{printed_name}']
                value = float(rows[index][metric])
                if abs(value - reference['value']) > reference['absoluteTolerance']:
                    raise ValueError(f'Published specification mismatch: {identity}/{key}')
                numeric[key] = {**reference, 'outputPath': key}
                independent[key] = value
        cases.append({'id': identity, 'kind': 'published', 'hidden': True, 'publicationId': primary['doi'], 'input': {'specification': specification}, 'numeric': numeric, 'sourceHash': hashlib.sha256(json.dumps(primary, sort_keys=True).encode()).hexdigest(), 'authorCode': {'commit': commit, 'files': artifacts}, 'independentQa': {'writer': 'primary_table_transcription', 'reviewer': 'published_author_R_reproduction', 'passed': True}, 'independentImplementation': {'implementationId': 'published_DARTH_R', 'numeric': independent}})
    definition = {'methodId': method_id, 'frozen': True, 'cases': cases, 'note': 'Both published tables independently reproduced with pinned author R code; gold stays in control-plane storage.'}
    destination = data_dir / 'paper-gold' / 'candidate-cases'
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = destination / (method_id + '.json')
    encoded = json.dumps(definition, separators=(',', ':'))
    if target.exists():
        if json.loads(target.read_text()) != definition:
            raise ValueError('Frozen evaluator already exists with different bytes.')
    else:
        with target.open('x') as output:
            output.write(encoded)
        os.chmod(target, 0o600)
    return {'methodId': method_id, 'caseIds': [case['id'] for case in cases], 'hash': hashlib.sha256(encoded.encode()).hexdigest(), 'publishedReferenceCount': len(cases)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--method-id', default='cohort-state-transition')
    options = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', options.method_id):
        raise ValueError('Invalid method identity.')
    print(json.dumps(prepare(options.data_dir.resolve(), options.method_id)))
