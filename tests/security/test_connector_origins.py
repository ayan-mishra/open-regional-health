import httpx2 as httpx
import pytest
from corvid.ingestion.base import SourceTransportError
from corvid.ingestion.client import SourceHttpClient, UnsafeSourceUrlError
from corvid.ingestion.registry import default_registry

TRUSTED_URL = "https://data.cdc.gov/resource/rdmq-nq56.json"


def make_client(handler=httpx.Response):
    def default_handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(200, content=b"[]")

    transport_handler = default_handler if handler is httpx.Response else handler
    return SourceHttpClient(
        allowed_origins={"https://data.cdc.gov"},
        timeout_seconds=1,
        retry_attempts=1,
        transport=httpx.MockTransport(transport_handler),
        sleep=lambda _: None,
        jitter=lambda: 0,
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://data.cdc.gov/resource/rdmq-nq56.json",
        "https://evil.example/resource/rdmq-nq56.json",
        "https://data.cdc.gov@evil.example/resource/rdmq-nq56.json",
        "https://127.0.0.1/latest",
        "https://data.cdc.gov:8443/resource/rdmq-nq56.json",
    ],
)
def test_connector_rejects_noncanonical_or_untrusted_origin(url):
    client = make_client()
    try:
        with pytest.raises(UnsafeSourceUrlError):
            client.get(url)
    finally:
        client.close()


def test_connector_rejects_redirect_without_following_it():
    requested: list[str] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(
            302,
            headers={"Location": "http://169.254.169.254/latest/meta-data"},
        )

    client = make_client(redirect)
    try:
        with pytest.raises(SourceTransportError, match="redirect"):
            client.get(TRUSTED_URL)
    finally:
        client.close()
    assert requested == [TRUSTED_URL]


def test_transport_ignores_environment_proxies_and_has_bounded_timeout():
    client = make_client()
    try:
        assert client._client._trust_env is False
        assert client._client.follow_redirects is False
        assert client._client.timeout.connect == 1
        assert client._client.timeout.read == 1
    finally:
        client.close()


def test_enabled_connector_endpoints_are_fixed_https_registry_values():
    registry = default_registry()
    for source_key in registry.keys():
        connector = registry.get(source_key)
        assert connector.allowed_origins
        assert all(
            origin.startswith("https://") for origin in connector.allowed_origins
        )
        endpoint = getattr(connector, "endpoint_url", None)
        if endpoint is not None:
            assert any(
                endpoint.startswith(f"{origin}/")
                for origin in connector.allowed_origins
            )
