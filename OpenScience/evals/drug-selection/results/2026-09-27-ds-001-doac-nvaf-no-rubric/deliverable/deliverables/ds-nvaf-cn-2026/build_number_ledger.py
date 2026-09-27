#!/usr/bin/env python3
"""Build a derived numeric ledger from the locally preserved source text.

Reads the preserved abstract / label-section / full-text files that back this
deliverable and writes every numeric token they contain, together with the file
each token came from. The ledger is a derived index (it adds nothing that is not
in the preserved sources); it exists so that every number printed in the report
can be resolved to the source text it came from.

Writes checks/source-numbers.json.
"""
import hashlib
import json
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = "/workspace"
OUTDIR = os.path.join(BASE, "checks")
OUT = os.path.join(OUTDIR, "source-numbers.json")

# source id -> preserved file that backs it (workspace-relative)
FILES = {
    "LBL-APX-01": ".evimed-sources/drug-labels/2877f799b94cb43d/3b563f9743fdb6a5e8be046bb974a1f058d919867cbfab8560b77a25fe7d5673/label.json",
    "LBL-RIV-01": ".evimed-sources/drug-labels/9f37d75d1a4db582/a8e4f9d15acc6ae5efae5b80d988cd39de6f3d0cfa978d4bada2ccbcf0275102/label.json",
    "LBL-DAB-01": ".evimed-sources/drug-labels/3e5f7b3ee3043aac/d2b2eeb4e51a17bb01295a2cf7e12087c17bc5aabc7bd66526dc48ad4934ff19/label.json",
    "RCT-RELY": ".evimed-sources/pubmed/PMID19717844/4bd34c69b7778e9ab35e6d548393d5e589a96c56ab41f443a648023324b61fe5/abstract.md",
    "RCT-ARISTOTLE": ".evimed-sources/pubmed/PMID21870978/e2b75e0422cce0f9099be6b69167dc2ab01d9a1b594dfcbf159bb277a9784419/abstract.md",
    "RCT-ROCKET": ".evimed-sources/pubmed/PMID21830957/438ce78f43b9df76cb09db26677e62cf8c081bdcfdfaa1f4ff2b2520fb22094d/abstract.md",
    "AGE-ARISTOTLE": ".evimed-sources/pubmed/PMID24561548/c8666f096ffec37228f8d32c4951be7083e26be0b7935b8ec769644a4c369eeb/abstract.md",
    "AGE-ROCKET": ".evimed-sources/pubmed/PMID24895454/7ac60e8ca2e12649321e9d8272cb500a8ee7a583c537c696b14fdd5b05659166/abstract.md",
    "AGE-RELY": ".evimed-sources/pubmed/PMID28213368/366e2c4f5ced72783881abf850b6bfa7e93418127a9595168fa14c6f72248b7d/abstract.md",
    "REN-ROCKET": ".evimed-sources/pubmed/PMID21873708/fb36000e5a38ad90d641f95306e9857d15145a709bab8e4f25ff2933c10367a2/abstract.md",
    "REN-JROCKET": ".evimed-sources/pubmed/PMID23229461/33096d4f5130ce266f8040ca7fb39ee7bd14db09dd7e49b8f2bcb97687427519/abstract.md",
    "MA-ASIAN-3": ".evimed-sources/pubmed/PMID24455237/0b69563ff5093767c14ff5eb27d30271d61d77c0b3b75bf6d6ec8050c0fcdbb0/abstract.md",
    "CN-DAB-ELDERLY": ".evimed-sources/pubmed/PMID26392326/ccf57f08f3cc9e4061534d8cb6267a8eb376b45f70dc12b11d96f3b08282e831/abstract.md",
    "ASIA-META": ".evimed-sources/pubmed/PMID33968307/ab2394c3e4d83e257750477b00e94426644758689dbd002c7647c4259a8a297d/abstract.md",
    "MA-APX-RIV": ".evimed-sources/pubmed/PMID34949473/6d18d8c12377e747350a70e573dbe44374e7c39c3fd83166ab5b9e60639fae22/abstract.md",
    "MA-DOAC-NET": ".evimed-sources/pubmed/PMID33993379/ca69be9e3a6e1083aa92a5aba9c73863e37a65e9d9970f5b99c392a080f72eec/abstract.md",
    "GDL-CN-AF-2015": ".evimed-sources/evimed-guidelines/822b2e1823408936/2e920cb0e730eac1c2848327dffe24aeb5ef6354c5dc934e0cae9a442a091f02/guideline.md",
    "J-ELD-AF": ".evimed-sources/pubmed/PMID32451850/22c45427d425869bbcefa53558317a365da4775bcc68bf7aae3cca3f70acbd28/abstract.md",
    "APPROP-80": ".evimed-sources/pubmed/PMID34486094/6c9d714c8985543cba244f9c5dd2376334ccf1c73f56a3520b56ecd5f9a7048e/abstract.md",
    "OCTO-KOR": ".evimed-sources/pubmed/PMID30845196/d186394ac5e79240f2c8bb09939de0b682028ac3add3a719f0ae53b9ce0f8919/abstract.md",
    "CN-DAB-REAL": ".evimed-sources/pubmed/PMID26354766/7a49013bc113581bc4ea19b8cbef39eba038974cbf39cb886c0c65282d28d33e/abstract.md",
    "PK-ELDERLY-JP": ".evimed-sources/pubmed/PMID30216091/8023b977ed57d0714844c0fd99f147d6531e73246f4bba07594185031d98a57f/abstract.md",
    "RCT-ELDERLY-3ARM": ".evimed-sources/pubmed/PMID39248072/26eaa158a936a08e1d7cc49c90414f69739deee1c743b0b7ec1396e5205cee28/abstract.md",
    "SCORE-HASBLED": ".evimed-sources/pubmed/PMID20299623/1629025d3ed9f91e3ed8d6b003fefaaf9d2543e2c51ff74ba5d601dd999a1ae9/abstract.md",
    "CN-DUE-APX": ".evimed-sources/web-pages/39206328a1b4c6ed/e8224f53234d3aed655586275d7d82cb60cf734e1fa8cd3144eb316d6fc63c11/page.md",
    "GDL-CN-AF-2023": ".evimed-sources/evimed-guidelines/46ccdfba7dee4c19/81030bd1263d75a20f5f8fa751fb98f628f9dd6aedd2b16bc0ddd1032ee1a510/guideline.md",
}


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    per_source = {}
    all_numbers = set()
    missing = []
    for sid, rel in FILES.items():
        path = os.path.join(WORKSPACE, rel)
        if not os.path.exists(path):
            missing.append(sid)
            continue
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        nums = sorted(set(re.findall(r"\d+(?:\.\d+)?", text)))
        per_source[sid] = {
            "file": rel,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "numberCount": len(nums),
        }
        all_numbers.update(nums)

    payload = {
        "note": "Derived numeric ledger: every numeric token present in the preserved source text backing this deliverable. Derived index only; nothing is added that is not in the preserved sources.",
        "sourceCount": len(per_source),
        "missingPreservedSources": missing,
        "unionNumberCount": len(all_numbers),
        "numbers": sorted(all_numbers),
        "perSource": per_source,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("sources indexed:", len(per_source), "missing:", missing)
    print("union numeric tokens:", len(all_numbers))


if __name__ == "__main__":
    main()
