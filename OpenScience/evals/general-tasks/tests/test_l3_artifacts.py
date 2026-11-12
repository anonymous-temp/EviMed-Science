"""Regression fixtures: page labels versus data, nonmedical caveats, optional clarification and standalone numbering."""
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'judges'))
import checks
import textio

class L3Artifacts(unittest.TestCase):
    def test_slide_fields_and_margin_labels_not_clinical_values(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'deck.pptx'
            def shape(text,y,extra=''):
                return f'<p:sp><p:nvSpPr><p:nvPr>{extra}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1" y="{y}"/><a:ext cx="80" cy="10"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
            ns='xmlns:p="'+textio.NS['p']+'" xmlns:a="'+textio.NS['a']+'"'
            with zipfile.ZipFile(p,'w') as z:
                z.writestr('ppt/presentation.xml',f'<p:presentation {ns}><p:sldSz cx="1000" cy="1000"/></p:presentation>')
                z.writestr('ppt/slides/slide1.xml',f'<p:sld {ns}>'+shape('01 / 01',950)+shape('01',400)+shape('88',500,'<p:ph type="sldNum"/>')+shape('99%',950)+'</p:sld>')
            result=textio.pptx_content_text(p)
            self.assertNotIn('01 / 01',result); self.assertNotIn('88',result)
            self.assertIn('01',result); self.assertIn('99%',result)
    def test_sequential_section_headers_after_cover_are_not_measurements(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'deck.pptx'
            ns='xmlns:p="'+textio.NS['p']+'" xmlns:a="'+textio.NS['a']+'"'
            with zipfile.ZipFile(p,'w') as z:
                z.writestr('ppt/presentation.xml',f'<p:presentation {ns}><p:sldSz cx="1000" cy="1000"/></p:presentation>')
                z.writestr('ppt/slides/slide1.xml',f'<p:sld {ns}/>')
                for i in range(1,4):
                    text=f'{i:02d}\u3000Section with 44% accuracy'
                    z.writestr(f'ppt/slides/slide{i+1}.xml',f'<p:sld {ns}><p:sp><p:spPr><a:xfrm><a:off x="1" y="20"/><a:ext cx="800" cy="50"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>')
            result=textio.pptx_content_text(p)
            self.assertNotIn('01',result)
            self.assertNotIn('02',result)
            self.assertIn('44%',result)
    def test_standalone_ordered_numbers_are_three_items(self):
        self.assertEqual(checks._items('1\n\nFirst\n\n2\n\nSecond\n\n3\n\nThird'),3)
        self.assertEqual(checks._items('1\nFirst\n7\nSecond'),0)
    def test_finance_caveat_not_medical(self):
        self.assertIsNone(checks.FORBIDDEN['medical_disclaimer'].search('不构成投资建议'))
        self.assertIsNotNone(checks.FORBIDDEN['medical_disclaimer'].search('不构成医学建议'))
if __name__=='__main__':unittest.main()
