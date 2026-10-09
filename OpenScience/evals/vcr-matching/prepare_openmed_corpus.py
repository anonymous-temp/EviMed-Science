#!/usr/bin/env python3
"""Prepare a small DrugProt batch from an exact, rights-reviewed public archive.

Only training/development records are selected. Gold is written separately and
must never be uploaded with inputs. This biomedical relation corpus does not
validate Chinese clinical matching, patient cohorts or treatment outcomes.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile

ARCHIVE_SHA = '679ca89698ca471a7fedc9af95acc8722c127c04eba19660fead406b5b9b52c9'
SOURCE = 'https://zenodo.org/records/5119892'
ROOT = Path(__file__).resolve().parents[2]
SEED = 'evimed-drugprot-pilot-1'


def rows(archive, name):
    return list(csv.reader(io.StringIO(archive.read(name).decode('utf8')), delimiter='\t'))


def utf16(text):
    return len(text.encode('utf-16-le')) // 2


def prepare(file, output):
    raw = file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_SHA:
        raise ValueError('archive_hash_mismatch')
    manifest = json.loads((ROOT / 'packages/contracts/openmed/data-rights.json').read_text())
    policy = next(row for row in manifest['resources'] if row['id'] == 'drugprot-5119892-pilot')
    if policy['decision'] != 'admitted' or 'evaluation' not in policy['purposes'] or policy['archiveSha256'] != ARCHIVE_SHA:
        raise ValueError('corpus_operation_not_admitted')
    archive = zipfile.ZipFile(io.BytesIO(raw))
    inputs, gold, selected, source_groups = [], [], [], set()
    for source_split, split, count in [('training', 'dev', 6), ('development', 'holdout', 4)]:
        prefix = f'drugprot-gs-training-development/{source_split}/drugprot_{source_split}_'
        abstracts = rows(archive, prefix + 'abstracs.tsv')
        chosen = sorted(abstracts, key=lambda row: hashlib.sha256((SEED + ':' + row[0]).encode()).hexdigest())[:count]
        ids = {row[0] for row in chosen}
        entities = rows(archive, prefix + 'entities.tsv')
        relations = rows(archive, prefix + 'relations.tsv')
        for pmid, title, abstract in chosen:
            if pmid in source_groups:
                raise ValueError('related_source_cross_split')
            source_groups.add(pmid)
            text = title + ' ' + abstract
            mentions = []
            for pid, identifier, kind, start, end, surface in entities:
                if pid != pmid:
                    continue
                start, end = int(start), int(end)
                if text[start:end] != surface:
                    raise ValueError('source_annotation_offset_mismatch')
                mentions.append({'id': identifier, 'documentId': pmid, 'type': 'GENE' if kind.startswith('GENE') else kind,
                                 'start': utf16(text[:start]), 'end': utf16(text[:end])})
            links = [{'type': kind, 'arg1': a.split(':', 1)[1], 'arg2': b.split(':', 1)[1]}
                     for pid, kind, a, b in relations if pid == pmid]
            case_id = f'drugprot-{pmid}'
            inputs.append({'id': case_id, 'sourceGroup': pmid, 'documentId': pmid, 'text': text, 'offsetUnit': 'utf16'})
            gold.append({'id': case_id, 'sourceGroup': pmid, 'dataClass': 'public_biomedical_abstract', 'split': split,
                         'task': 'relation', 'reference': {'entities': mentions, 'relations': links}})
            selected.append({'id': case_id, 'pmid': pmid, 'upstreamSplit': source_split, 'split': split,
                             'inputSha256': hashlib.sha256(text.encode()).hexdigest()})
    output.mkdir(parents=True, exist_ok=True)
    for name, value in [('inputs.json', {'dataClass': 'public_biomedical_abstracts', 'resourceId': 'drugprot-5119892-pilot', 'archiveSha256': ARCHIVE_SHA, 'cases': inputs}), ('reference.json', {'cases': gold}),
                        ('selection.json', {'schemaVersion': 1, 'source': SOURCE, 'archiveSha256': ARCHIVE_SHA, 'selectionSeed': SEED,
                                            'license': 'CC-BY-4.0', 'offsetTransformation': 'title + single space + abstract; codepoint to UTF-16',
                                            'labelTransformation': 'GENE-Y/GENE-N merged into GENE', 'cases': selected})]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    return selected


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    print(json.dumps({'prepared': len(prepare(args.archive, args.output)), 'output': str(args.output)}))
