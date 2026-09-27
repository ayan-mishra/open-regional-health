import httpx2 as httpx
import pytest
from corvid.ingestion.base import SourceTransportError
from corvid.ingestion.client import SourceHttpClient, UnsafeSourceUrlError


def test_client_retries_only_safe_transient_gets() -> None:
    statuses = iter((503, 429, 200))
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(next(statuses), json={"ok": True})

    client = SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=3,
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        jitter=lambda: 0,
    )
    result = client.get("https://data.cdc.gov/resource/test.json")

    assert result.http_status == 200
    assert len(seen) == 3
    assert seen[0].headers["user-agent"].startswith("Corvid/")


def test_client_retries_connection_failures_for_safe_gets() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise httpx.ConnectError("temporarily offline", request=request)
        return httpx.Response(200, json={"ok": True})

    client = SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=3,
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        jitter=lambda: 0,
    )

    assert client.get("https://data.cdc.gov/resource/test.json").http_status == 200
    assert attempts == 3


def test_client_wraps_and_retries_midstream_read_failures() -> None:
    attempts = 0

    class BrokenStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"partial"
            raise httpx.ReadError("connection dropped")

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, stream=BrokenStream())

    client = SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=2,
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
        jitter=lambda: 0,
    )

    with pytest.raises(SourceTransportError, match="failed after bounded retries"):
        client.get("https://data.cdc.gov/resource/test.json")
    assert attempts == 2


def test_client_disables_proxy_environment_configuration(monkeypatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:8080")
    client = SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=1,
        transport=httpx.MockTransport(_unused_handler),
    )

    assert client._client._trust_env is False


@pytest.mark.parametrize("status", [300, 301, 302, 303, 307, 308, 399])
def test_client_rejects_all_redirect_responses(status: int) -> None:
    client = SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=3,
        transport=httpx.MockTransport(lambda _: httpx.Response(status)),
    )

    with pytest.raises(
        SourceTransportError, match=rf"source returned redirect HTTP {status}"
    ):
        client.get("https://data.cdc.gov/resource/test.json")


@pytest.mark.parametrize(
    "url",
    [
        "http://data.cdc.gov/resource/test.json",
        "https://evil.example/resource/test.json",
        "https://data.cdc.gov.evil.example/resource/test.json",
        "https://user:password@data.cdc.gov/resource/test.json",
    ],
)
def test_client_rejects_non_https_or_unconfigured_origins(url: str) -> None:
    client = SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=1,
        transport=httpx.MockTransport(_unused_handler),
    )
    with pytest.raises(UnsafeSourceUrlError):
        client.get(url)


def test_client_rejects_response_larger_than_configured_ceiling() -> None:
    client = SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=1,
        max_response_bytes=5,
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"123456")),
    )

    with pytest.raises(SourceTransportError, match="response exceeded"):
        client.get("https://data.cdc.gov/resource/test.json")


def _unused_handler(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"network transport should not be reached: {request.url}")
