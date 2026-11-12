"""Offline scoring of complete TrialGPT responses; missing and malformed entries stay in denominator."""
import json
import re
from collections import Counter

LABELS = {'inclusion': {'included', 'not included', 'not applicable', 'not enough information'},
          'exclusion': {'excluded', 'not excluded', 'not applicable', 'not enough information'}}


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result and result[key] != value:
            raise ValueError('conflicting duplicate JSON key')
        result[key] = value
    return result


OBJECT_SCHEMAS = (
    ('reasoning', 'sentence_ids', 'label'),
    ('reasoning', 'sentence_ids', 'eligibility'),
    ('reasoning', 'sentence_ids', 'eligibility_label'),
    ('element_1_brief_reasoning', 'element_2_sentence_id', 'element_3_eligibility_label'),
    ('element_1', 'element_2', 'element_3'),
    ('Element 1', 'Element 2', 'Element 3'),
)


def parse(body, request, normalize_shapes=True):
    try:
        if not isinstance(body,dict) or not isinstance(body['choices'][0],dict) or not isinstance(body['choices'][0].get('message'),dict):
            return {}
        choice = body['choices'][0]
        if choice.get('finish_reason') not in (None, 'stop'):
            return {}
        content = choice['message']['content']
        fence = re.fullmatch(r'\s*```(?:json)?\s*\n(.*?)\n```\s*', content, re.DOTALL | re.IGNORECASE)
        if fence:
            content = fence.group(1)
        obj = json.loads(content, object_pairs_hook=unique_pairs)
        if not isinstance(obj, dict):
            return {}
    except (KeyError, IndexError, TypeError, ValueError):
        return {}
    ids = set(map(int, re.findall(r'(?m)^(\d+)\. ', request['user'].split('Here is the clinical trial:')[0])))
    result = {}
    for key, value in obj.items():
        if key not in request['expected_indexes']:
            continue
        if normalize_shapes and isinstance(value, dict):
            schemas = [schema for schema in OBJECT_SCHEMAS if set(value) == set(schema)]
            if len(schemas) != 1:
                continue
            value = [value[k] for k in schemas[0]]
        if not isinstance(value, list) or len(value) != 3:
            continue
        reason, evidence, label = value
        if (not isinstance(reason, str) or not isinstance(evidence, list)
                or any(type(n) is not int or n not in ids for n in evidence)
                or not isinstance(label, str) or label not in LABELS[request['criterion_type']]):
            continue
        result[key] = (reason, evidence, label)
    return result


def score(requests, bodies, gold, patients=None, reference='expert', normalize_shapes=True):
    if reference not in ('expert', 'gpt4'):
        raise ValueError('reference must be expert or gpt4')
    gold = [r for r in gold if patients is None or r['patient_id'] in patients]
    truth = {str(r['annotation_id']): r for r in gold}
    if len(truth) != len(gold):
        raise ValueError('duplicate gold annotation')
    predictions = {}
    strict_count = 0
    for req in requests:
        parsed = parse(bodies.get(req['id'], {}), req, normalize_shapes=normalize_shapes)
        strict = parse(bodies.get(req['id'], {}), req, normalize_shapes=False)
        for aid, mapping in req['criterion_map'].items():
            if aid in truth and mapping['status'] == 'matched':
                if mapping['indexes'][0] in strict:
                    strict_count += 1
                prediction = parsed.get(mapping['indexes'][0])
                if prediction is not None:
                    if aid in predictions:
                        raise ValueError('duplicate annotation mapping')
                    predictions[aid] = prediction
    labels = ['included', 'not included', 'excluded', 'not excluded', 'not applicable', 'not enough information']
    confusion = Counter()
    evidence_correct = 0
    correct = 0
    prediction_rows = []
    case_flags = []
    for aid, row in truth.items():
        pred = predictions.get(aid)
        actual = row[reference + '_eligibility']
        predicted = pred[2] if pred else 'missing'
        correct += actual == predicted
        confusion[(actual, predicted)] += 1
        prediction_rows.append({'annotation_id': row['annotation_id'], 'patient_id': row['patient_id'], 'trial_id': row.get('trial_id'), 'criterion_type': row['criterion_type'], 'gold': actual, 'prediction': predicted, 'evidence': pred[1] if pred else None})
        if pred and set(pred[1]) == set(json.loads(row[reference + '_sentences'])):
            evidence_correct += 1
        if pred and actual != ('included' if row['criterion_type'] == 'inclusion' else 'not excluded') and pred[2] == ('included' if row['criterion_type'] == 'inclusion' else 'not excluded'):
            case_flags.append({'annotation_id': row['annotation_id'], 'patient_id': row['patient_id'], 'gold': actual, 'prediction': pred[2], 'flag': 'false_favorable_vs_' + reference})
    f1 = {}
    for label in labels:
        tp = confusion[label, label]
        fp = sum(n for (actual, predicted), n in confusion.items() if predicted == label and actual != label)
        fn = sum(n for (actual, predicted), n in confusion.items() if actual == label and predicted != label)
        f1[label] = 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None
    observed = [v for v in f1.values() if v is not None]
    false_favorable = len(case_flags)
    unknown_gold = sum(n for (a, _), n in confusion.items() if a == 'not enough information')
    unknown_pred = sum(n for (_, b), n in confusion.items() if b == 'not enough information')
    unknown_correct = confusion['not enough information', 'not enough information']
    return {'wire_schema_compliant_predictions': strict_count, 'equivalent_shape_predictions': len(predictions) - strict_count if normalize_shapes else 0, 'shape_normalization': normalize_shapes, 'reference': reference, 'correct': correct, 'accuracy': correct / len(gold) if gold else None, 'prediction_rows': prediction_rows, 'case_flags': case_flags, 'unknown_gold': unknown_gold, 'unknown_predictions': unknown_pred,
            'unknown_correct': unknown_correct, 'false_favorable_over_all': false_favorable / len(gold) if gold else None,
            'denominator': len(gold), 'valid_predictions': len(predictions), 'macro_f1': sum(observed) / len(observed) if observed else None,
            'label_f1': f1, 'evidence_exact_over_all': evidence_correct / len(gold) if gold else None,
            'false_favorable_count': false_favorable,
            'confusion': [{'gold': a, 'prediction': b, 'count': n} for (a, b), n in sorted(confusion.items())]}


def cached_gpt4_control(gold, patients=None):
    """Compare cached GPT-4 annotations directly with expert labels, offline."""
    rows = [row for row in gold if patients is None or row['patient_id'] in patients]
    correct = sum(row['expert_eligibility'] == row['gpt4_eligibility'] for row in rows)
    evidence = sum(set(json.loads(row['expert_sentences'])) == set(json.loads(row['gpt4_sentences'])) for row in rows)
    return {'reference': 'expert', 'prediction_source': 'cached_gpt4', 'denominator': len(rows),
            'correct': correct, 'accuracy': correct / len(rows) if rows else None,
            'evidence_exact_over_all': evidence / len(rows) if rows else None,
            'prediction_rows': [{'annotation_id': row['annotation_id'], 'patient_id': row['patient_id'],
                                 'criterion_type': row['criterion_type'], 'gold': row['expert_eligibility'],
                                 'prediction': row['gpt4_eligibility']} for row in rows]}
