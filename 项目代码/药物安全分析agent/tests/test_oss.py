from safety_agent.api.oss import _object_key_component


def test_oss_object_key_components_are_tenant_safe_and_stable():
    first = _object_key_component("../tenant/患者 A")
    second = _object_key_component("../tenant/患者 A")

    assert first == second
    assert "/" not in first
    assert ".." not in first
    assert len(first) <= 109
