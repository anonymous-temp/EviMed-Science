"""Trusted R reference for published aggregate-data arithmetic, never candidate code."""
import json
import subprocess
import sys

request = json.load(sys.stdin)
specification = request['specification']
method = request['referenceMethod']
def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('Reference requires numeric inputs')
    return repr(value)
expressions = {}
if method == 'diagnostic-posterior':
    odds = number(specification['priorOdds']) if 'priorOdds' in specification else '(%s/(1-%s))' % (number(specification['priorProbability']), number(specification['priorProbability']))
    for label, ratio in specification['likelihoodRatios'].items():
        if not label.isidentifier():
            raise ValueError('Invalid result label')
        posterior_odds = '(%s*%s)' % (odds, number(ratio))
        expressions['results.'+label+'.posteriorOdds'] = posterior_odds
        expressions['results.'+label+'.posteriorProbability'] = '(%s/(1+%s))' % (posterior_odds, posterior_odds)
elif method == 'decision-net-benefit':
    total = number(specification['n'])
    threshold = number(specification['threshold'])
    odds = '(%s/(1-%s))' % (threshold, threshold)
    benefit = '((%s-%s*%s)/%s)' % (number(specification['truePositive']), odds, number(specification['falsePositive']), total)
    prevalence = '(%s/%s)' % (number(specification['eventCount']), total)
    all_benefit = '(%s-(1-%s)*%s)' % (prevalence, prevalence, odds)
    expressions = {'netBenefit': benefit, 'treatAll': all_benefit, 'treatNone': '0', 'netReductionPer100': '(100*(%s-%s)/%s)' % (benefit, all_benefit, odds)}
else:
    raise ValueError('Unsupported trusted reference method')
program = '\n'.join('cat(%s, "\\t", sprintf("%%.17g", %s), "\\n",sep="")' % (json.dumps(key), expression) for key, expression in expressions.items())
result = subprocess.run(['Rscript', '--vanilla', '-e', program], capture_output=True, text=True, check=True, timeout=30)
values = dict((line.split('\t')[0], float(line.split('\t')[1])) for line in result.stdout.strip().splitlines())
print(json.dumps({'numeric': values}, allow_nan=False))
