from dataclasses import dataclass
from datetime import UTC, datetime

from corvid.domain import (
    Disease,
    GeographyRecord,
    GeographyType,
    ObservationRecord,
    SourceRecord,
)
from corvid.ingestion.base import FetchResult, SourceSchemaError
from corvid.ingestion.registry import ConnectorRegistry
from corvid.ingestion.runner import IngestionRunner
from corvid.storage import Database, LocalBlobStore
from corvid.storage.models import IngestionRunRow, ObservationRow, RawSnapshotRow
from sqlalchemy import select


@dataclass(frozen=True)
class FakeParsedRow:
    value: float


class FakeConnector:
    source_key = "fake"
    parser_version = "test-1"
    allowed_origins = frozenset({"https://example.test"})
    source = SourceRecord(
        key="fake",
        name="Fake",
        organization="Test",
        landing_page_url="https://example.test",
    )
    geographies = (
        GeographyRecord(
            id="ma",
            geography_type=GeographyType.STATE,
            display_name="Massachusetts",
            state_code="MA",
        ),
    )

    def __init__(self) -> None:
        self.fail_schema = False
        self.fail_unexpected = False

    def fetch(self, client: object) -> FetchResult:
        del client
        if self.fail_unexpected:
            raise RuntimeError("unexpected connector failure")
        return FetchResult(
            content=b'{"value": 1}',
            retrieved_at=datetime(2026, 7, 25, 12, tzinfo=UTC),
            request_url="https://example.test/data.json",
            http_status=200,
        )

    def parse(self, snapshot: bytes) -> list[FakeParsedRow]:
        assert snapshot
        if self.fail_schema:
            raise SourceSchemaError("changed schema")
        return [FakeParsedRow(1.0)]

    def normalize(
        self,
        records: list[FakeParsedRow],
        *,
        retrieved_at: datetime,
        raw_snapshot_id: int | None = None,
    ) -> list[ObservationRecord]:
        return [
            ObservationRecord(
                source_key="fake",
                upstream_id="fake:1",
                disease=Disease.INFLUENZA,
                metric="test_metric",
                value=records[0].value,
                unit="count",
                geography_id="ma",
                observation_start=retrieved_at.date(),
                observation_end=retrieved_at.date(),
                issue_date=None,
                retrieved_at=retrieved_at,
                raw_snapshot_id=raw_snapshot_id,
                issue_identity="snapshot:test",
            )
        ]


def test_runner_persists_snapshot_and_failure_without_deleting_last_success(
    tmp_path,
) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'runner.db'}")
    database.create_schema()
    connector = FakeConnector()
    runner = IngestionRunner(
        database=database,
        blob_store=LocalBlobStore(tmp_path),
        registry=ConnectorRegistry([connector]),
        client_factory=lambda _: object(),
    )

    succeeded = runner.run("fake")
    connector.fail_schema = True
    failed = runner.run("fake")

    assert succeeded.status.value == "succeeded"
    assert failed.status.value == "schema_error"
    with database.session() as session:
        assert len(session.scalars(select(RawSnapshotRow)).all()) == 1
        assert len(session.scalars(select(ObservationRow)).all()) == 1
        runs = session.scalars(
            select(IngestionRunRow).order_by(IngestionRunRow.id)
        ).all()
        assert [run.status for run in runs] == ["succeeded", "schema_error"]
    database.dispose()


def test_runner_finishes_run_after_unexpected_connector_failure(tmp_path) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'runner-unexpected.db'}")
    database.create_schema()
    connector = FakeConnector()
    connector.fail_unexpected = True
    runner = IngestionRunner(
        database=database,
        blob_store=LocalBlobStore(tmp_path),
        registry=ConnectorRegistry([connector]),
        client_factory=lambda _: object(),
    )

    failed = runner.run("fake")

    assert failed.status.value == "failed"
    with database.session() as session:
        run = session.scalar(select(IngestionRunRow))
        assert run is not None
        assert run.status == "failed"
        assert run.finished_at is not None
        assert run.error_message == "unexpected connector failure"
    database.dispose()
