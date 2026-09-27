from dataclasses import replace
from datetime import UTC, datetime

import pytest
from corvid.domain.enums import IngestionStatus
from corvid.domain.models import RawSnapshotRecord
from corvid.storage.models import RawSnapshotRow
from corvid.storage.repositories import (
    AppendOnlyViolationError,
    ProvenanceConflictError,
    SnapshotRepository,
)


def snapshot() -> RawSnapshotRecord:
    return RawSnapshotRecord(
        source_key="nssp",
        retrieved_at=datetime(2026, 1, 17, 12, tzinfo=UTC),
        request_url=(
            "https://user:password@example.test/data?token=secret&"
            "subscription-key=also-secret&week=1#fragment"
        ),
        request_parameters={
            "api_key": "secret",
            "nested": {"password": "hidden", "week": 1},
        },
        response_headers={
            "Authorization": "Bearer secret",
            "Set-Cookie": "session=secret",
            "Content-Type": "application/json",
            "ETag": "abc",
        },
        http_status=200,
        sha256="a" * 64,
        blob_path="raw/nssp/2026/01/" + "a" * 64 + ".bin",
        parser_version="1",
        status=IngestionStatus.SUCCEEDED,
        error_message=(
            "failed https://error-user:error-pass@example.test/data?sig=error-secret "
            "Authorization=Bearer error-bearer"
        ),
    )


def test_snapshot_repository_redacts_secrets_and_is_idempotent(session):
    repository = SnapshotRepository(session)
    record = snapshot()

    first_id = repository.insert_snapshot(record)
    second_id = repository.insert_snapshot(record)
    row = session.get(RawSnapshotRow, first_id)

    assert first_id == second_id
    assert row is not None
    assert "secret" not in row.request_url
    assert "password" not in row.request_url
    assert "fragment" not in row.request_url
    assert row.request_parameters == {
        "api_key": "[REDACTED]",
        "nested": {"password": "[REDACTED]", "week": 1},
    }
    assert row.response_headers == {
        "content-type": "application/json",
        "etag": "abc",
    }
    assert row.error_message is not None
    assert "error-secret" not in row.error_message
    assert "error-pass" not in row.error_message
    assert "error-bearer" not in row.error_message
    assert repository.count() == 1


def test_snapshot_repository_rejects_conflicts_and_mutation(session):
    repository = SnapshotRepository(session)
    record = snapshot()
    snapshot_id = repository.insert_snapshot(record)

    with pytest.raises(ProvenanceConflictError):
        repository.insert_snapshot(replace(record, blob_path="different.bin"))
    with pytest.raises(AppendOnlyViolationError):
        repository.update_snapshot(snapshot_id)
    with pytest.raises(AppendOnlyViolationError):
        repository.delete_snapshot(snapshot_id)

    assert repository.count() == 1


@pytest.mark.parametrize(
    "header_name",
    ["Authorization", "Proxy-Authorization"],
)
def test_snapshot_error_redacts_complete_basic_authorization_value(
    session, header_name
):
    repository = SnapshotRepository(session)
    encoded_credentials = "dXNlcjpwYXNz"
    record = replace(
        snapshot(),
        error_message=f"request failed; {header_name}: Basic {encoded_credentials}",
    )

    snapshot_id = repository.insert_snapshot(record)
    row = session.get(RawSnapshotRow, snapshot_id)

    assert row is not None
    assert row.error_message is not None
    assert encoded_credentials not in row.error_message
    assert "Basic" not in row.error_message


def test_snapshot_error_redacts_malformed_embedded_url_without_raising(session):
    repository = SnapshotRepository(session)
    record = replace(
        snapshot(),
        error_message="request failed for https://[invalid",
    )

    snapshot_id = repository.insert_snapshot(record)
    row = session.get(RawSnapshotRow, snapshot_id)

    assert row is not None
    assert row.error_message == "request failed for [REDACTED]"
