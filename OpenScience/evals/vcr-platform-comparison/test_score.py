import json
import hashlib
from pathlib import Path
import tempfile
import unittest

from alignment import align,score_aligned
from score import extract,score


class ProductProjectionTests(unittest.TestCase):
    def test_only_verified_product_views_are_scored_and_kind_is_preserved(self):
        collection={"id":"set","sourceVersion":"v1","databaseSha256":"a"*64}
        source={"id":"NCT00000001:exclusion","version":"b"*64,"trial_id":"NCT00000001",
                "criterion_type":"exclusion","text":"Active infection"}
        reference={"sources":[source],"gold_units":[{"id":"g","patient_id":"p","trial_id":"NCT00000001",
                    "source_id":source["id"],"source_version":source["version"],"criterion_type":"exclusion","text":source["text"]}]}
        case={"caseId":"p","cleanup":{"deleted":True},"trialDetails":[{"id":"trial-id","registryId":"NCT00000001",
            "detail":{"patientTrials":{"trials":[{"id":"trial-id","registryId":"NCT00000001","collection":collection}],
            "selected":{"id":"trial-id","criteria":[{"criterionId":"c","kind":"exclusion","text":"Active infection",
              "state":"not_satisfied","applicable":True,"decidedBy":"model"}]}}}}]}
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory);(root/'p').mkdir();file=root/'p/case.json';file.write_text(json.dumps(case))
            units,issues,_=extract(root,reference,collection)
            self.assertEqual(issues,[])
            report=align({**reference,"platform_units":units})
            self.assertEqual(score_aligned(report,units,{"g":"excluded"})["correct"],1)
            case["trialDetails"][0]["detail"]["patientTrials"]["trials"][0]["collection"]={**collection,"sourceVersion":"other"}
            file.write_text(json.dumps(case));units,issues,_=extract(root,reference,collection)
            self.assertEqual(issues[0]["kind"],"unverified_source_collection")
            self.assertEqual(align({**reference,"platform_units":units})["scorable"],0)

    def test_scoring_rejects_unfrozen_collection_before_reading_cases(self):
        here=Path(__file__).parent;digest=lambda file:hashlib.sha256(file.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory);campaign=root/'campaign';campaign.mkdir()
            ref=root/'ref.json';ref.write_text('{"sources":[],"gold_units":[]}')
            gold=root/'gold.json';gold.write_text('[]');collection=root/'collection.json';collection.write_text('{"id":"foreign"}')
            frozen={"alignmentCodeSha256":digest(here/'alignment.py'),"alignmentPolicySha256":digest(here/'alignment-policy.json'),
                "referenceSha256":digest(ref),"goldSha256":digest(gold),"collectionManifestSha256":"a"*64,"planned":[]}
            (campaign/'FROZEN.json').write_text(json.dumps(frozen))
            with self.assertRaises(ValueError):score(campaign,ref,collection,gold,root/'out')
            self.assertFalse((root/'out').exists())

    def test_case_identity_and_missing_artifacts(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory);(root/'wrong').mkdir();(root/'wrong/case.json').write_text('{"caseId":"p"}')
            with self.assertRaises(ValueError):extract(root,{"sources":[]},{},['p'])
            (root/'wrong/case.json').unlink()
            _,issues,cases=extract(root,{"sources":[]},{},['p'])
            self.assertEqual(cases[0]['status'],'missing_artifact')
            self.assertEqual(issues[0]['kind'],'missing_case_artifact')


if __name__=='__main__':unittest.main()
