from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from corvid.domain import IngestionStatus, RawSnapshotRecord
from corvid.ingestion.base import (
    SourceSchemaError,
    SourceTransportError,
    SourceValidationError,
)
from corvid.ingestion.client import SourceHttpClient
from corvid.ingestion.registry import ConnectorRegistry
from corvid.storage import Database, LocalBlobStore, UnitOfWork
from corvid.storage.repositories import ProvenanceConflictError


@dataclass(frozen=True, slots=True)
class IngestionSummary:
    source_key: str
    status: IngestionStatus
    inserted_count: int = 0
    rejected_count: int = 0
    most_recent_observation_date: date | None = None
    error_message: str | None = None


class IngestionRunner:


    def __init__(
        self,
        *,
        database: Database,
        blob_store: LocalBlobStore,
        registry: ConnectorRegistry,
        client_factory: Callable[[frozenset[str]], Any] | None = None,
        timeout_seconds: float = 20,
        retry_attempts: int = 3,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._database = database
        self._blob_store = blob_store
        self._registry = registry
        self._client_factory = client_factory or (
            lambda origins: SourceHttpClient(
                allowed_origins=origins,
                timeout_seconds=timeout_seconds,
                retry_attempts=retry_attempts,
            )
        )
        self._clock = clock

    def run(self, source_key: str) -> IngestionSummary:
        connector = self._registry.get(source_key)
        started_at = self._clock()
        with UnitOfWork(self._database) as uow:
            uow.sources.upsert_source(connector.source)
            run_id = uow.ingestion_runs.start(
                source_key=source_key,
                started_at=started_at,
                parser_version=connector.parser_version,
            )
        try:
            return self._run_started(connector, run_id, source_key)
        except Exception as error:
            return self._fail(run_id, source_key, IngestionStatus.FAILED, error)

    def _run_started(
        self, connector: Any, run_id: int, source_key: str
    ) -> IngestionSummary:
        client = self._client_factory(connector.allowed_origins)
        try:
            fetched = connector.fetch(client)
        except (SourceTransportError, OSError) as error:
            return self._fail(
                run_id, source_key, IngestionStatus.TRANSPORT_ERROR, error
            )
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                close()

        try:
            blob = self._blob_store.put(
                source_key, fetched.retrieved_at, fetched.content
            )
        except OSError as error:
            return self._fail(run_id, source_key, IngestionStatus.FAILED, error)
        with UnitOfWork(self._database) as uow:
            snapshot_id = uow.snapshots.insert_snapshot(
                RawSnapshotRecord(
                    source_key=source_key,
                    retrieved_at=fetched.retrieved_at,
                    request_url=fetched.request_url,
                    request_parameters=fetched.request_parameters,
                    http_status=fetched.http_status,
                    response_headers=fetched.response_headers,
                    sha256=blob.sha256,
                    blob_path=str(blob.path),
                    parser_version=connector.parser_version,
                    status=IngestionStatus.SUCCEEDED,
                )
            )
        try:
            parsed = connector.parse(fetched.content)
            observations = connector.normalize(
                parsed,
                retrieved_at=fetched.retrieved_at,
                raw_snapshot_id=snapshot_id,
            )
        except SourceSchemaError as error:
            return self._fail(run_id, source_key, IngestionStatus.SCHEMA_ERROR, error)
        except (SourceValidationError, ValueError) as error:
            return self._fail(
                run_id, source_key, IngestionStatus.VALIDATION_ERROR, error
            )

        if not observations:
            self._finish(run_id, IngestionStatus.EMPTY)
            return IngestionSummary(source_key=source_key, status=IngestionStatus.EMPTY)

        try:
            with UnitOfWork(self._database) as uow:
                for geography in connector.geographies:
                    uow.geographies.upsert_geography(geography)
                inserted = uow.observations.insert_observations(observations)
                most_recent = max(row.observation_end for row in observations)
                uow.ingestion_runs.finish(
                    run_id,
                    status=IngestionStatus.SUCCEEDED.value,
                    finished_at=self._clock(),
                    inserted_count=inserted,
                    most_recent_observation_date=most_recent,
                )
        except (ProvenanceConflictError, ValueError) as error:
            return self._fail(
                run_id, source_key, IngestionStatus.VALIDATION_ERROR, error
            )
        return IngestionSummary(
            source_key=source_key,
            status=IngestionStatus.SUCCEEDED,
            inserted_count=inserted,
            most_recent_observation_date=most_recent,
        )

    def _finish(self, run_id: int, status: IngestionStatus) -> None:
        with UnitOfWork(self._database) as uow:
            uow.ingestion_runs.finish(
                run_id, status=status.value, finished_at=self._clock()
            )

    def _fail(
        self,
        run_id: int,
        source_key: str,
        status: IngestionStatus,
        error: BaseException,
    ) -> IngestionSummary:
        message = str(error)
        with UnitOfWork(self._database) as uow:
            uow.ingestion_runs.finish(
                run_id,
                status=status.value,
                finished_at=self._clock(),
                rejected_count=1,
                error_message=message,
            )
        return IngestionSummary(
            source_key=source_key,
            status=status,
            rejected_count=1,
            error_message=message,
        )
