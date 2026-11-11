"""Structural checks only; semantic acceptance is the recorded hand audit and Qwen run."""
import json
import unittest
import measure

class MeasurementTests(unittest.TestCase):
    def test_controls_preserve_request_and_remove_all_format_in_none(self):
        case = measure.rf.load_cases()[0]
        texts = {'persona':'persona','guidance':'guidance'}
        none = measure.request(case,'partial','none',texts)
        self.assertEqual(none['messages'][1]['content'],case['partial']['ask'])
        self.assertEqual(len(none['messages']),2)
        self.assertNotIn('tools',none)
        pasted = measure.request(case,'partial','pasted',texts)
        self.assertIn(measure.format_text(case),pasted['messages'][1]['content'])
        self.assertTrue(pasted['messages'][1]['content'].endswith(case['partial']['ask']))
        recalled = measure.request(case,'partial','recalled',texts)
        self.assertIn('openviking-context',recalled['messages'][1]['content'])
        self.assertEqual(recalled['messages'][2]['content'],case['partial']['ask'])
        self.assertEqual(recalled['messages'][-1]['role'],'tool')
    def test_exact_evidence_required(self):
        data = {'claims':[], 'usable':True,'allGiven':True,'added':[{'quote':'approved','reason':'missing approval'}]}
        self.assertEqual(len(measure.parse_verdict(json.dumps(data),'All approved')['added']),1)
        with self.assertRaises(ValueError): measure.parse_verdict(json.dumps(data),'Approval unknown')
        data['added'][0]['quote']=''
        with self.assertRaises(ValueError): measure.parse_verdict(json.dumps(data),'Approval unknown')
    def test_no_whitespace_normalized_quote_invention(self):
        data = {'claims':[], 'usable':True,'allGiven':True,'added':[{'quote':'20 items','reason':'new count'}]}
        with self.assertRaises(ValueError): measure.parse_verdict(json.dumps(data),'2 0 items')
    def test_judge_schema_and_unusable_not_success(self):
        for data in ({'claims':[], 'usable':'yes','allGiven':True,'added':[]},{'claims':[], 'usable':False,'allGiven':True,'added':[]}):
            with self.assertRaises(ValueError): measure.parse_verdict(json.dumps(data),'')
        data={'claims':[], 'usable':False,'allGiven':False,'added':[]}
        self.assertFalse(measure.parse_verdict(json.dumps(data),'')['usable'])
    def test_bracket_projection_preserves_outer_assertions(self):
        self.assertEqual(measure.bracket_projection('All approved [date]; [if true: consent]'), 'All approved  ⟦BRACKETED SPAN⟧ ;  ⟦BRACKETED SPAN⟧ ')
        self.assertEqual(measure.bracket_projection('Tested 【n [example]】 samples'), 'Tested  ⟦BRACKETED SPAN⟧  samples')
        self.assertEqual(measure.bracket_projection('Literal [unclosed'), 'Literal [unclosed')
    def test_unsupported_inventory_cannot_be_reported_clean(self):
        data={'claims':[{'quote':'Approved','support':'NONE','unsupported':True}], 'usable':True,'allGiven':True,'added':[]}
        with self.assertRaises(ValueError): measure.parse_verdict(json.dumps(data),'Approved')
    def test_numbers_are_candidates_not_semantic_verdict(self):
        case=measure.rf.load_cases()[0]
        self.assertTrue(measure.rf.added_numbers(case,'partial','[Example: 20 minutes]'))
        verdict=measure.parse_verdict(json.dumps({'claims':[], 'usable':True,'allGiven':True,'added':[]}),'[Example: 20 minutes]')
        self.assertEqual(verdict['added'],[])

if __name__=='__main__': unittest.main()
