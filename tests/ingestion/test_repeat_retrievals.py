import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from corvid.ingestion.base import Connector, FetchResult
from corvid.ingestion.fluview import FluViewConnector
from corvid.ingestion.nrevss import NrevssConnector
from corvid.ingestion.registry import ConnectorRegistry
from corvid.ingestion.runner import IngestionRunner
from corvid.ingestion.wastewater import WastewaterConnector
from corvid.storage import Database, LocalBlobStore
from corvid.storage.models import ObservationRow, RawSnapshotRow
from sqlalchemy import func, select

from tests.ingestion.conftest import load_json_fixture


class _SequenceClient:
    def __init__(self, sequence: "_FetchSequence") -> None:
        self._sequence = sequence

    def get(self, url: str, *, params: object) -> FetchResult:
        del params
        return self._sequence.next(url)

    def close(self) -> None:
        return None


class _FetchSequence:
    def __init__(self, payloads: list[bytes]) -> None:
        self._payloads = payloads
        self._index = 0
        self._origin = datetime(2026, 7, 25, 12, tzinfo=UTC)

    def client(self, _: frozenset[str]) -> _SequenceClient:
        return _SequenceClient(self)

    def next(self, url: str) -> FetchResult:
        payload = self._payloads[self._index]
        retrieved_at = self._origin + timedelta(hours=self._index)
        self._index += 1
        return FetchResult(
            content=payload,
            retrieved_at=retrieved_at,
            request_url=url,
            http_status=200,
        )


def _changed_fluview(payload: Any) -> Any:
    payload["epidata"][0]["ili"] = "9.9"
    return payload


def _changed_wastewater(payload: Any) -> Any:
    payload[0]["pcr_target_avg_conc"] = "9.9"
    return payload


def _changed_nrevss(payload: Any) -> Any:
    payload[0]["percent_pos_3wma"] = "9.9"
    return payload


@pytest.mark.parametrize(
    ("connector", "fixture", "change", "expected_observations"),
    [
        (FluViewConnector(), "fluview_ma.json", _changed_fluview, 4),
        (NrevssConnector(), "nrevss_ma.json", _changed_nrevss, 4),
        (
            WastewaterConnector(),
            "nwss_influenza_a_ma.json",
            _changed_wastewater,
            2,
        ),
    ],
)
def test_later_retrieval_preserves_snapshot_and_replays_scientific_issue(
    connector: Connector,
    fixture: str,
    change: Any,
    expected_observations: int,
    tmp_path: Path,
) -> None:
    original = load_json_fixture(fixture)
    replay = json.loads(json.dumps(original))
    changed = change(json.loads(json.dumps(original)))
    payloads = [
        json.dumps(original, sort_keys=True).encode(),
        json.dumps(replay, sort_keys=True).encode(),
        json.dumps(changed, sort_keys=True).encode(),
    ]
    sequence = _FetchSequence(payloads)
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'repeat.db'}")
    database.create_schema()
    runner = IngestionRunner(
        database=database,
        blob_store=LocalBlobStore(tmp_path),
        registry=ConnectorRegistry([connector]),
        client_factory=sequence.client,
    )

    first = runner.run(connector.source_key)
    second = runner.run(connector.source_key)
    conflict = runner.run(connector.source_key)

    assert first.status.value == "succeeded"
    assert first.inserted_count == expected_observations
    assert second.status.value == "succeeded"
    assert second.inserted_count == 0
    assert conflict.status.value == "validation_error"
    with database.session() as session:
        assert session.scalar(select(func.count()).select_from(RawSnapshotRow)) == 3
        assert (
            session.scalar(select(func.count()).select_from(ObservationRow))
            == expected_observations
        )
    database.dispose()
