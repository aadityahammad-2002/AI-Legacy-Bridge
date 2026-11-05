"""Run with pytest after installing ai-service requirements."""
from unittest.mock import MagicMock, patch
from app import graph_store


def test_repository_graph_cleanup_scoped_and_idempotent():
    driver = MagicMock()
    result = driver.session.return_value.__enter__.return_value.run.return_value
    result.consume.return_value.counters.nodes_deleted = 3
    with patch.object(graph_store, "get_driver", return_value=driver):
        assert graph_store.delete_repository("00000000-0000-0000-0000-000000000001") == 3
    query, = driver.session.return_value.__enter__.return_value.run.call_args.args
    assert "repository_id" in query and "DETACH DELETE" in query
    assert driver.session.return_value.__enter__.return_value.run.call_args.kwargs == {
        "repo_id": "00000000-0000-0000-0000-000000000001"
    }
