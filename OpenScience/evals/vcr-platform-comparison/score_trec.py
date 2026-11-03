"""Evaluate frozen TREC qrels against real product retrieval receipts and views."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re


QRELS_SHA={2021:'ba7a2cddc90285e75cd76adcd483394a6c9bacf7017113222058ba6537e6d8ac',
           2022:'e569a531489e03f7b1fab03fe169c8ea66f4a59e8180fa9858b1a6e4bdcb0c5c',
           2023:'4f0cd4ad573e37d08002fb401bb7ab22a643537753880d9427c96119696582a3'}
CORPUS_SHA={2021:'184a5015039c6e9e8ac6d2dbb5214c641c464cb298c0065648b9dd3d6d6ee269',
            2022:'184a5015039c6e9e8ac6d2dbb5214c641c464cb298c0065648b9dd3d6d6ee269',
            2023:'62fad20f7c06da96cb597ae2cde5a5e141df8ac8a5bad5fb6e05fb3b1af53a6e'}
READ_TOOLS={'vcr_read','mcp__evimed__vcr_read'}


def retrieval_receipt(transcript,collection):
    """Last successful deepest search, without consulting qrels or model prose."""
    hits=[]
    for message in (transcript or {}).get('messages',[]):
        if message.get('role')!='tool':continue
        for part in message.get('parts',[]):
            if part.get('type')!='tool' or part.get('tool')not in READ_TOOLS or part.get('status')!='completed':continue
            args=part.get('input')or{}
            if not isinstance(args,dict)or args.get('what')!='candidates' or (args.get('filter')or{}).get('collection')!=collection['id']:continue
            output=part.get('output')
            if isinstance(output,str):
                try:output=json.loads(output)
                except ValueError:continue
            if not isinstance(output,dict)or output.get('status')not in ('success','warning'):continue
            obj=output.get('data')or{}
            if not isinstance(obj,dict)or obj.get('available')is not True or obj.get('status')!='ok':continue
            receipt=obj.get('retrieval');source=obj.get('collection');sequence=part.get('completedSeq')
            if not isinstance(receipt,dict)or not isinstance(source,dict)or type(sequence)is not int:continue
            if any(source.get(key)!=collection[key]for key in ('id','sourceVersion','databaseSha256')):continue
            ids=receipt.get('retrievedIds');limit=receipt.get('limit')
            if (not isinstance(ids,list)or len(ids)>500
                    or any(not isinstance(value,str)or not re.fullmatch(r'NCT\d{8}',value)for value in ids)
                    or len(set(ids))!=len(ids) or type(limit)is not int or not 1<=limit<=500 or len(ids)>limit):continue
            complete=len(ids)==500 or (receipt.get('truncated')is False and receipt.get('eligibleInFusionPool')==len(ids)
                and type(receipt.get('totalMatched'))is int and type(receipt.get('fusionPool'))is int
                and 0<=receipt['totalMatched']<=receipt['fusionPool'])
            hits.append({'limit':limit,'ids':ids,'sequence':sequence,'complete500':complete})
    if (transcript or {}).get('truncated')or (transcript or {}).get('exhausted')is not True:return None
    return max(hits,key=lambda row:(row['limit'],row['sequence']))if hits else None


def retrieval_ids(transcript,collection):
    receipt=retrieval_receipt(transcript,collection)
    return receipt['ids']if receipt and receipt['complete500']else None


def metrics(order,qrels,retrieved):
    def dcg(grades):return sum(grade/math.log2(i+2)for i,grade in enumerate(grades[:10]))
    grades=[qrels.get(ident,0)for ident in order[:10]]
    ideal=dcg(sorted(qrels.values(),reverse=True));eligible={ident for ident,grade in qrels.items()if grade==2}
    return {'ndcg10':dcg(grades)/ideal if ideal else None,
            'precision10_eligible':sum(grade==2 for grade in grades)/10,
            'recall500_eligible':len(set(retrieved or [])&eligible)/len(eligible)if retrieved is not None and eligible else None,
            'recall500_graded':sum(qrels.get(ident,0)for ident in retrieved)/sum(qrels.values())if retrieved is not None and sum(qrels.values())else None,
            'retrieved':None if retrieved is None else len(retrieved),'ranked':len(order)}


def score(campaign,qrels_file,collection_file,out):
    frozen=json.loads((campaign/'FROZEN.json').read_text());raw=qrels_file.read_bytes();collection_bytes=collection_file.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=frozen.get('goldSha256')or hashlib.sha256(collection_bytes).hexdigest()!=frozen.get('collectionManifestSha256'):
        raise ValueError('TREC inputs differ from the inference freeze')
    planned=frozen['planned']
    if len(set(planned))!=len(planned):raise ValueError('Duplicate planned topics')
    identities=[re.fullmatch(r'trec-(2021|2022|2023)-(\d+)',case)for case in planned]
    if not identities or any(value is None for value in identities)or len({value[1]for value in identities})!=1:raise ValueError('One TREC year per campaign')
    year=int(identities[0][1]);collection=json.loads(collection_bytes);qrels={}
    if hashlib.sha256(raw).hexdigest()!=QRELS_SHA[year]or collection.get('databaseSha256')!=CORPUS_SHA[year]:
        raise ValueError('The qrels or full-corpus snapshot does not belong to this campaign year')
    for line in raw.decode().splitlines():
        topic,_,trial,grade=line.split();grade=int(grade)
        if grade not in (0,1,2)or trial in qrels.setdefault(topic,{}):raise ValueError('Invalid qrels')
        qrels[topic][trial]=grade
    results=[]
    for case in frozen['planned']:
        matched=re.fullmatch(r'trec-(2021|2022|2023)-(\d+)',case)
        if not matched:raise ValueError('Unexpected TREC case identity')
        file=campaign/case/'case.json';record=json.loads(file.read_text())if file.exists()else{}
        if record and record.get('caseId')!=case:raise ValueError('Case identity mismatch')
        order=[];rank_issues=[];seen=set()
        for position,row in enumerate(record.get('matching',{}).get('patientTrials',{}).get('trials',[]),1):
            source=row.get('collection')or{}
            ident=row.get('registryId')
            valid=all(source.get(key)==collection[key]for key in ('id','sourceVersion','databaseSha256'))and isinstance(ident,str)and re.fullmatch(r'NCT\d{8}',ident)and ident not in seen
            if valid:order.append(ident);seen.add(ident)
            else:order.append(None);rank_issues.append({'position':position,'registryId':ident,'reason':'unverified_or_duplicate'})
        receipt=retrieval_receipt(record.get('transcript'),collection)
        retrieved=receipt['ids']if receipt and receipt['complete500']else None
        truth=qrels.get(matched[2]);measures=metrics(order,truth,retrieved)if truth else None
        results.append({'case':case,'year':int(matched[1]),'topic':matched[2],'judged':bool(truth),'execution':record.get('status','missing_artifact'),
                        'metrics':measures,'rankedIds':order,'rankingIssues':rank_issues,'retrievalObserved':receipt is not None,
                        'retrievalObservedDepth':len(receipt['ids'])if receipt else None,'retrievalComplete500':retrieved is not None})
    keys=('ndcg10','precision10_eligible','recall500_eligible','recall500_graded')
    summary={}
    for key in keys:
        values=[row['metrics'][key]for row in results if row['metrics']and row['metrics'][key]is not None]
        summary[key]={'mean':sum(values)/len(values)if values else None,'denominator':len(values)}
    result={'scope':'full frozen TREC corpus; linear-gain nDCG; unjudged trials have zero gain, not clinical ineligibility',
            'sourceSha':frozen['sourceSha'],'topics':len(results),'summary':summary,'rows':results,
            'retrievalSelection':'last successful deepest source-verified candidate-search receipt, no gold selection'}
    with out.open('x')as handle:json.dump(result,handle,indent=2)
    return summary


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for name in ('campaign','qrels','collection','out'):parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args();print(json.dumps(score(args.campaign,args.qrels,args.collection,args.out),indent=2))
