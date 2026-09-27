from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from time import sleep as default_sleep
from urllib.parse import urlsplit

import httpx2 as httpx

from corvid.ingestion.base import FetchResult, SourceTransportError


class UnsafeSourceUrlError(ValueError):
    pass


class SourceHttpClient:


    def __init__(
        self,
        *,
        allowed_origins: set[str] | frozenset[str],
        timeout_seconds: float,
        retry_attempts: int,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = default_sleep,
        jitter: Callable[[], float] = lambda: 0.05,
        max_response_bytes: int = 25 * 1024 * 1024,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if retry_attempts < 1:
            raise ValueError("retry_attempts must be at least one")
        if max_response_bytes < 1:
            raise ValueError("max_response_bytes must be positive")
        self._allowed_origins = frozenset(
            self._validated_origin(origin) for origin in allowed_origins
        )
        self._retry_attempts = retry_attempts
        self._sleep = sleep
        self._jitter = jitter
        self._max_response_bytes = max_response_bytes
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout_seconds),
            transport=transport,
            headers={"User-Agent": "Corvid/0.1 surveillance-ingestion"},
            follow_redirects=False,
            trust_env=False,
        )

    def close(self) -> None:
        self._client.close()

    def get(
        self,
        url: str,
        *,
        params: Mapping[str, str | int] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> FetchResult:
        self._require_allowed(url)
        for attempt in range(self._retry_attempts):
            response: httpx.Response | None = None
            try:
                request = self._client.build_request(
                    "GET", url, params=params, headers=headers
                )
                response = self._client.send(request, stream=True)
                if response.status_code == 429 or response.status_code >= 500:
                    if attempt + 1 == self._retry_attempts:
                        raise SourceTransportError(
                            f"source returned retryable HTTP {response.status_code}"
                        )
                    self._backoff(attempt)
                    continue
                if 300 <= response.status_code < 400:
                    raise SourceTransportError(
                        f"source returned redirect HTTP {response.status_code}"
                    )
                if response.is_error:
                    raise SourceTransportError(
                        f"source returned non-retryable HTTP {response.status_code}"
                    )
                content = bytearray()
                for chunk in response.iter_bytes():
                    if len(content) + len(chunk) > self._max_response_bytes:
                        raise SourceTransportError(
                            "source response exceeded configured byte ceiling"
                        )
                    content.extend(chunk)
                return FetchResult(
                    content=bytes(content),
                    retrieved_at=datetime.now(UTC),
                    request_url=str(response.request.url),
                    request_parameters=dict(params or {}),
                    http_status=response.status_code,
                    response_headers=self._safe_headers(response.headers),
                )
            except httpx.TimeoutException as error:
                if attempt + 1 == self._retry_attempts:
                    raise SourceTransportError(
                        "source request timed out after bounded retries"
                    ) from error
                self._backoff(attempt)
                continue
            except httpx.RequestError as error:
                if attempt + 1 == self._retry_attempts:
                    raise SourceTransportError(
                        "source request failed after bounded retries"
                    ) from error
                self._backoff(attempt)
                continue
            finally:
                if response is not None:
                    response.close()
        raise AssertionError("retry loop must return or raise")

    def _backoff(self, attempt: int) -> None:
        self._sleep(min(0.25 * (2**attempt) + self._jitter(), 2.0))

    def _require_allowed(self, url: str) -> None:
        parsed = urlsplit(url)
        if parsed.username is not None or parsed.password is not None:
            raise UnsafeSourceUrlError("source URL must not contain user information")
        origin = self._origin(parsed.scheme, parsed.hostname, parsed.port)
        if origin not in self._allowed_origins:
            raise UnsafeSourceUrlError(f"source origin is not allowed: {origin}")

    @classmethod
    def _validated_origin(cls, origin: str) -> str:
        parsed = urlsplit(origin)
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError("allowed origins cannot include paths or query strings")
        return cls._origin(parsed.scheme, parsed.hostname, parsed.port)

    @staticmethod
    def _origin(scheme: str, hostname: str | None, port: int | None) -> str:
        if scheme != "https" or hostname is None:
            raise UnsafeSourceUrlError("only absolute HTTPS source URLs are allowed")
        default_port = port is None or port == 443
        return f"https://{hostname.lower()}" + ("" if default_port else f":{port}")

    @staticmethod
    def _safe_headers(headers: httpx.Headers) -> dict[str, str]:
        allowed = {"content-type", "etag", "last-modified", "retry-after"}
        return {
            key.lower(): value
            for key, value in headers.items()
            if key.lower() in allowed
        }
