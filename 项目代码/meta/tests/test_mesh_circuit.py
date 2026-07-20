from new_meta.tools import mesh


def test_mesh_circuit_skips_network_after_consecutive_errors(monkeypatch) -> None:
    calls = {"n": 0}

    def fake_get(*args, **kwargs):
        calls["n"] += 1
        raise AssertionError("network should be skipped when circuit is open")

    monkeypatch.setattr(mesh.requests, "get", fake_get)
    monkeypatch.setattr(mesh, "_consecutive_mesh_errors", mesh._MAX_CONSECUTIVE_ERRORS)
    monkeypatch.setattr(mesh, "_mesh_circuit_open_logged", False)

    assert mesh._get_xml("https://example.test", {}) is None
    assert calls["n"] == 0

    monkeypatch.setattr(mesh, "_consecutive_mesh_errors", 0)
    monkeypatch.setattr(mesh, "_mesh_circuit_open_logged", False)
