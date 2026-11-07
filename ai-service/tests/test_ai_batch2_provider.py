"""LLM HTTP provider diagnostics without any network calls."""
import httpx
import pytest
from app import llm_client

@pytest.mark.parametrize('code,fragment', [
    (402, 'payment'), (401, 'API key'), (403, 'model access'),
    (502, 'temporarily unavailable'), (400, 'rejected'),
])
def test_provider_http_status_is_safe_and_actionable(monkeypatch, code, fragment):
    req = httpx.Request('POST', 'https://example.test/chat/completions')
    response = httpx.Response(code, request=req)
    def raise_status(_request):
        raise httpx.HTTPStatusError('unsafe provider body', request=req, response=response)
    monkeypatch.setattr(llm_client, '_call_with_timeout', raise_status)
    monkeypatch.setattr(llm_client, '_wait_for_pacing', lambda: None)
    with pytest.raises(llm_client.LlmError, match=fragment) as info:
        llm_client._post_with_retry({'messages': []})
    assert 'unsafe provider body' not in str(info.value)
