import unittest
from score_trec import retrieval_ids,retrieval_receipt,metrics


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


if __name__=='__main__':unittest.main()
