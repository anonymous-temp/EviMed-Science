"""Explicit mocked independent scope evidence for downstream-only test fixtures."""
from new_meta.core.protocol_scope import scope_fields, scope_receipt
from new_meta.schemas.protocol import ProtocolScopeAssessment, ResearchProtocol


def approve_synthetic_protocol_scope(project, protocol=None):
    """Supply this new upstream precondition without bypassing admission validation."""
    if protocol is None:
        protocol = ResearchProtocol.model_validate(project.load_json("protocol.json"))
    topic = project.load_json(project.TOPIC_FILE)["topic"]
    assessment = ProtocolScopeAssessment(fields=[{
        "field": field, "status": "match", "basis": "not_explicit", "original_quote": topic,
        "rationale": "Mock independent review accepts this synthetic protocol; this test isolates downstream behavior.",
    } for field in scope_fields(protocol)])
    receipt = scope_receipt(topic, protocol, assessment)
    protocol._scope_receipt = receipt
    project.save_json("protocol_scope.json", receipt, subdir="analysis")
    return protocol
