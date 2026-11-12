import unittest
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import score_trec
from score_trec import retrieval_ids,retrieval_receipt,metrics,fixed_candidate_comparison


class TrecTests(unittest.TestCase):
    def test_receipt_selection_never_uses_assistant_text_or_foreign_sources(self):
        collection={'id':'set','sourceVersion':'v','databaseSha256':'a'*64}
        result={'available':True,'status':'ok','collection':collection,'retrieval':{'limit':500,'retrievedIds':['NCT00000001'],
            'truncated':False,'eligibleInFusionPool':1,'totalMatched':1,'fusionPool':1}}
        transcript={'exhausted':True,'messages':[{'role':'tool','parts':[{'type':'text','text':str(result)}]}]}
        self.assertIsNone(retrieval_ids(transcript,collection))
        transcript['messages'][0]['parts'].append({'type':'tool','tool':'mcp__evimed__vcr_read','status':'completed','completedSeq':2,
            'input':{'what':'candidates','filter':{'collection':'set'}},'output':{'status':'success','data':result}})
        self.assertEqual(retrieval_ids(transcript,collection),['NCT00000001'])
        self.assertIsNone(retrieval_ids(transcript,{**collection,'sourceVersion':'other'}))
        transcript['truncated']=True;self.assertIsNone(retrieval_ids(transcript,collection))

    def test_shallow_incomplete_search_and_echoed_source_are_not_recall500(self):
        collection={'id':'set','sourceVersion':'v','databaseSha256':'a'*64}
        result={'available':True,'status':'ok','collection':collection,'retrieval':{'limit':10,'retrievedIds':['NCT00000001'],'truncated':True}}
        part={'type':'tool','tool':'vcr_read','status':'completed','completedSeq':3,'input':{'what':'candidates','filter':{'collection':'set'}},'output':{'status':'success','data':result}}
        transcript={'exhausted':True,'messages':[{'role':'tool','parts':[part]}]}
        self.assertIsNone(retrieval_ids(transcript,collection));self.assertEqual(len(retrieval_receipt(transcript,collection)['ids']),1)
        part['input']['what']='subject_document';self.assertIsNone(retrieval_receipt(transcript,collection))
        part['input']['what']='candidates';transcript['exhausted']=False;self.assertIsNone(retrieval_receipt(transcript,collection))

    def test_eligible_and_graded_recall_remain_distinct(self):
        result=metrics(['NCT00000001'],{'NCT00000001':1,'NCT00000002':2},['NCT00000001'])
        self.assertEqual(result['precision10_eligible'],0)
        self.assertEqual(result['recall500_eligible'],0)
        self.assertAlmostEqual(result['recall500_graded'],1/3)

    def test_unverified_rank_does_not_promote_an_eligible_trial(self):
        order=[None]+['NCT00000001']*9+['NCT00000002']
        self.assertEqual(metrics(order,{'NCT00000002':2},None)['precision10_eligible'],0)

    def test_real_pagination_warning_keeps_the_complete_500_id_receipt(self):
        collection={'id':'set','sourceVersion':'v','databaseSha256':'a'*64}
        ids=[f'NCT{i:08d}'for i in range(500)]
        part={'type':'tool','tool':'mcp__evimed__vcr_read','status':'completed','completedSeq':8,
            'input':{'what':'candidates','filter':{'collection':'set','limit':500}},
            'output':{'status':'warning','data':{'available':True,'status':'ok','collection':collection,'more':True,
                'retrieval':{'limit':500,'retrievedIds':ids,'truncated':True}}}}
        self.assertEqual(retrieval_ids({'exhausted':True,'messages':[{'role':'tool','parts':[part]}]},collection),ids)

    def test_fixed_candidate_comparison_uses_the_same_candidates(self):
        retrieved=['NCT00000001','NCT00000002','NCT00000003','NCT00000004']
        saved=['NCT00000003','NCT00000001','NCT00000004']
        qrels={'NCT00000001':2,'NCT00000002':2,'NCT00000003':1,'NCT00000004':0}
        comparison=fixed_candidate_comparison(saved,[],retrieved,qrels)
        self.assertEqual(comparison['status'],'available')
        self.assertEqual(comparison['selectedCount'],3)
        self.assertEqual(comparison['retrievalOrder'],['NCT00000001','NCT00000003','NCT00000004'])
        self.assertAlmostEqual(comparison['retrieval']['ndcg10'],metrics(comparison['retrievalOrder'],qrels,None)['ndcg10'])
        self.assertAlmostEqual(comparison['saved']['ndcg10'],metrics(saved,qrels,None)['ndcg10'])
        self.assertGreater(comparison['retrieval']['ndcg10'],comparison['saved']['ndcg10'])

    def test_fixed_candidate_comparison_does_not_hide_missing_evidence(self):
        n1,n2='NCT00000001','NCT00000002'
        qrels={n1:2,n2:1}
        cases=[([],[],[n1],qrels,'empty_ranking'),
               ([n1],[],None,qrels,'retrieval_unavailable'),
               ([None],[{'position':1}], [n1],qrels,'unverified_ranking'),
               ([n2],[],[n1],qrels,'candidate_outside_retrieval'),
               ([n1,n1],[],[n1],qrels,'unverified_ranking'),
               ([n1],[],[n1],None,'unjudged_topic')]
        for order,issues,retrieved,judgments,reason in cases:
            with self.subTest(reason=reason):
                result=fixed_candidate_comparison(order,issues,retrieved,judgments)
                self.assertEqual(result['status'],reason)
                self.assertNotIn('saved',result)

    def test_score_preserves_primary_metrics_and_records_scorer_digest(self):
        with TemporaryDirectory() as temp:
            root=Path(temp);campaign=root/'campaign';case=campaign/'trec-2022-1';case.mkdir(parents=True)
            collection={'id':'set','sourceVersion':'v','databaseSha256':'a'*64}
            collection_bytes=json.dumps(collection).encode();(root/'collection.json').write_bytes(collection_bytes)
            qrels_bytes=b'1 0 NCT00000001 2\n1 0 NCT00000002 1\n1 0 NCT00000003 0\n'
            (root/'qrels.txt').write_bytes(qrels_bytes)
            sha=lambda data:hashlib.sha256(data).hexdigest()
            (campaign/'FROZEN.json').write_text(json.dumps({'sourceSha':'product-sha',
                'planned':['trec-2022-1'],'goldSha256':sha(qrels_bytes),'collectionManifestSha256':sha(collection_bytes)}))
            retrieved=['NCT00000001','NCT00000002','NCT00000003'];saved=retrieved[1::-1]
            receipt={'available':True,'status':'ok','collection':collection,'retrieval':{'limit':500,
                'retrievedIds':retrieved,'truncated':False,'eligibleInFusionPool':3,'totalMatched':3,'fusionPool':3}}
            transcript={'exhausted':True,'messages':[{'role':'tool','parts':[{'type':'tool','tool':'vcr_read',
                'status':'completed','completedSeq':2,'input':{'what':'candidates','filter':{'collection':'set'}},
                'output':{'status':'success','data':receipt}}]}]}
            record={'caseId':'trec-2022-1','status':'settled','transcript':transcript,'matching':{'patientTrials':
                {'trials':[{'registryId':ident,'collection':collection}for ident in saved]}}}
            (case/'case.json').write_text(json.dumps(record))
            with patch.dict(score_trec.QRELS_SHA,{2022:sha(qrels_bytes)}),patch.dict(score_trec.CORPUS_SHA,{2022:'a'*64}):
                score_trec.score(campaign,root/'qrels.txt',root/'collection.json',root/'score.json')
            result=json.loads((root/'score.json').read_text());row=result['rows'][0]
            expected=metrics(saved,dict(zip(retrieved,[2,1,0])),retrieved)
            self.assertEqual(row['metrics'],expected)
            self.assertEqual(row['rankedIds'],saved)
            self.assertTrue(row['retrievalComplete500'])
            self.assertEqual(row['fixedCandidateComparison']['retrievalOrder'],saved[::-1])
            self.assertEqual(result['scorerSha256'],sha(Path(score_trec.__file__).read_bytes()))


if __name__=='__main__':unittest.main()
