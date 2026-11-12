import unittest
from score import formal, packet
from report import wilson, mcnemar
class Scoring(unittest.TestCase):
    def test_formats(self):
        self.assertTrue(formal({'type':'json','expected':{'n':2}},'{"n":2}'))
        for text in ['```json\n{"n":2}\n```','{"n":true}','{"n":2,"extra":1}']:
            self.assertFalse(formal({'type':'json','expected':{'n':2}},text))
        self.assertTrue(formal({'type':'headings','expected':['A','B']},'## A\nx\n## B\ny'))
        self.assertFalse(formal({'type':'headings','expected':['A','B']},'# A\nx\n## B\ny'))
        self.assertFalse(formal({'type':'prefix_lines','expected':['A:','B:']},'A:\nB: x'))
        self.assertTrue(formal({'type':'csv','expected':[['date','count'],['2026-01-01','3']]},'date,count\n2026-01-01,3'))
        self.assertFalse(formal({'type':'table','expected':['Claim','Source','Limit']},'| Claim | Limit | Source |'))
    def test_table_requires_source_bound_rows(self):
        spec={'type':'table','expected':['Claim','Source','Limit'],'sources':['A','B']}
        header='| Claim | Source | Limit |\n|---|---|---|\n'
        self.assertTrue(formal(spec,header+'| C | A | L |\n| D | B | M |'))
        self.assertFalse(formal(spec,header+'Claims for A and B are discussed in prose.'))
        self.assertFalse(formal(spec,header+'| C | B | L |\n| D | B | M |'))
    def test_display_equivalent_emphasis_is_not_a_format_failure(self):
        self.assertTrue(formal({'type':'headings','expected':['A','B']},'## **A**\nx\n## B\ny'))
        self.assertTrue(formal({'type':'prefix_lines','expected':['Audience:','Change:']},'**Audience:** Readers\nChange: Available'))
        self.assertTrue(formal({'type':'table','expected':['Claim','Source','Limit'],'sources':['A']},'| **Claim** | Source | Limit |\n|---|---|---|\n| Text | **A** | Limited |'))
    def test_blinding(self):
        item={'exam':'Question','quality':'Correct answer','behavior':{'principle':'P'},'code':None}
        p,_=packet(item,{'arm':'D','turns':[{'reply':'Answer'}],'memory':{}})
        self.assertNotIn('arm',p)
        self.assertNotIn('learning',p)
        self.assertNotIn('openingContext',p)
        self.assertNotIn('exposurePreference',p)
    def test_statistics(self):
        self.assertAlmostEqual(wilson(0,10)[1],.2775327999)
        self.assertIsNone(wilson(0,0))
        a={str(i):False for i in range(6)}; b={str(i):True for i in range(6)}
        self.assertEqual(mcnemar(a,b)['exactP'],.03125)
        self.assertEqual(mcnemar(a,a)['exactP'],1)
        self.assertEqual(mcnemar(a,{'unknown':True})['n'],0)
if __name__=='__main__':unittest.main()
