import re
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, overload
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from corvid.domain.enums import Disease, QualityFlag
from corvid.domain.models import (
    ForecastRecord,
    GeographyRecord,
    ObservationRecord,
    RawSnapshotRecord,
    SourceRecord,
    enum_values,
)
from corvid.domain.types import JsonObject, JsonValue, thaw_json, thaw_json_object
from corvid.forecasting.backtest import BacktestPrediction
from corvid.forecasting.types import (
    EpiWeek,
    KnowledgeSetRequest,
    SelectedObservation,
    WeeklyPoint,
)
from corvid.storage.models import (
    BacktestResultRow,
    EvidenceLinkRow,
    ForecastRow,
    ForecastRunRow,
    GeographyRow,
    IngestionRunRow,
    ObservationRow,
    RawSnapshotRow,
    SourceRow,
)


class ProvenanceConflictError(ValueError):
    pass


class AppendOnlyViolationError(RuntimeError):
    pass


class SourceRepository:


    def __init__(self, session: Session) -> None:
        self._session = session

    def upsert_source(self, record: SourceRecord) -> SourceRow:
        row = self._session.get(SourceRow, record.key)
        values = {
            "name": record.name,
            "organization": record.organization,
            "landing_page_url": record.landing_page_url,
            "endpoint_url": record.endpoint_url,
            "update_cadence": record.update_cadence,
            "license_name": record.license_name,
            "allowed_use": record.allowed_use,
            "known_delay": record.known_delay,
            "revision_policy": record.revision_policy,
        }
        if row is None:
            row = SourceRow(key=record.key, **values)
            self._session.add(row)
        else:
            for name, value in values.items():
                setattr(row, name, value)
        self._session.flush()
        return row

    def get(self, source_key: str) -> SourceRow | None:


        return self._session.get(SourceRow, source_key)


class GeographyRepository:


    def __init__(self, session: Session) -> None:
        self._session = session

    def upsert_geography(self, record: GeographyRecord) -> GeographyRow:
        row = self._session.get(GeographyRow, record.id)
        values = {
            "geography_type": record.geography_type.value,
            "display_name": record.display_name,
            "state_code": record.state_code,
            "upstream_identifiers": thaw_json_object(record.upstream_identifiers),
            "member_counties": list(record.member_counties),
            "experimental": record.experimental,
        }
        if row is None:
            row = GeographyRow(id=record.id, **values)
            self._session.add(row)
        else:
            for name, value in values.items():
                setattr(row, name, value)
        self._session.flush()
        return row

    def get(self, geography_id: str) -> GeographyRow | None:


        return self._session.get(GeographyRow, geography_id)


_SENSITIVE_NAMES = (
    r"authorization|credential|password|(?:client[_-]?)?secret|token|"
    r"(?:api|access|subscription)[_-]?key|signature|sig|session"
)
_SENSITIVE_KEY = re.compile(rf"(?:{_SENSITIVE_NAMES})$", re.IGNORECASE)
_SENSITIVE_ASSIGNMENT = re.compile(rf"(?i)({_SENSITIVE_NAMES})(\s*[=:]\s*)[^\s,;&]+")
_AUTHORIZATION_VALUE = re.compile(
    r"(?i)\b((?:proxy-)?authorization)(\s*[=:]\s*)[^\r\n,;]+"
)
_EMBEDDED_URL = re.compile(r"https?://[^\s,;]+", re.IGNORECASE)
_SAFE_RESPONSE_HEADERS = frozenset(
    {
        "content-type",
        "content-length",
        "date",
        "etag",
        "last-modified",
        "retry-after",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "x-request-id",
    }
)
_REDACTED = "[REDACTED]"


def _is_sensitive_key(key: str) -> bool:
    return _SENSITIVE_KEY.search(key) is not None


def _redact_json(value: JsonValue, key: str | None = None) -> JsonValue:
    if key is not None and _is_sensitive_key(key):
        return _REDACTED
    if isinstance(value, Mapping):
        return {
            child_key: _redact_json(child_value, child_key)
            for child_key, child_value in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, str):
        return [_redact_json(item) for item in value]
    return value


def _sanitize_request_url(request_url: str) -> str:
    parsed = urlsplit(request_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise ValueError("request_url must be an absolute HTTP(S) URL")
    hostname = parsed.hostname
    if ":" in hostname:
        hostname = f"[{hostname}]"
    port = f":{parsed.port}" if parsed.port is not None else ""
    query = urlencode(
        [
            (key, _REDACTED if _is_sensitive_key(key) else value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        ]
    )
    return urlunsplit((parsed.scheme, f"{hostname}{port}", parsed.path, query, ""))


def _sanitize_response_headers(headers: JsonObject) -> dict[str, JsonValue]:
    return {
        key.lower(): thaw_json(value)
        for key, value in headers.items()
        if key.lower() in _SAFE_RESPONSE_HEADERS
    }


def _sanitize_embedded_url(match: re.Match[str]) -> str:
    try:
        return _sanitize_request_url(match.group(0))
    except (UnicodeError, ValueError):
        return _REDACTED


def _redact_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = _EMBEDDED_URL.sub(_sanitize_embedded_url, value)
    value = _AUTHORIZATION_VALUE.sub(rf"\1\2{_REDACTED}", value)
    value = re.sub(r"(?i)(bearer\s+)[^\s,;]+", rf"\1{_REDACTED}", value)
    return _SENSITIVE_ASSIGNMENT.sub(rf"\1\2{_REDACTED}", value)


class SnapshotRepository:


    def __init__(self, session: Session) -> None:
        self._session = session

    def insert_snapshot(self, record: RawSnapshotRecord) -> int:
        payload = self._sanitize_payload(record)
        existing = self._find_snapshot(record)
        if existing is not None:
            self._require_exact_replay(existing, payload)
            return existing.id
        try:
            with self._session.begin_nested():
                row = RawSnapshotRow(**payload)
                self._session.add(row)
                self._session.flush()
        except IntegrityError:
            existing = self._find_snapshot(record)
            if existing is None:
                raise
            self._require_exact_replay(existing, payload)
            return existing.id
        return row.id

    def count(self) -> int:
        return (
            self._session.scalar(select(func.count()).select_from(RawSnapshotRow)) or 0
        )

    def update_snapshot(self, snapshot_id: int) -> None:
        del snapshot_id
        raise AppendOnlyViolationError("raw snapshots are append-only")

    def delete_snapshot(self, snapshot_id: int) -> None:
        del snapshot_id
        raise AppendOnlyViolationError("raw snapshots are append-only")

    def _find_snapshot(self, record: RawSnapshotRecord) -> RawSnapshotRow | None:
        return self._session.scalar(
            select(RawSnapshotRow).where(
                RawSnapshotRow.source_key == record.source_key,
                RawSnapshotRow.retrieved_at == record.retrieved_at,
                RawSnapshotRow.sha256 == record.sha256,
            )
        )

    @staticmethod
    def _sanitize_payload(record: RawSnapshotRecord) -> dict[str, Any]:
        sanitized_parameters = _redact_json(record.request_parameters)
        if not isinstance(sanitized_parameters, Mapping):
            raise TypeError("request_parameters must be a JSON object")
        return {
            "source_key": record.source_key,
            "retrieved_at": record.retrieved_at,
            "request_url": _sanitize_request_url(record.request_url),
            "request_parameters": thaw_json_object(sanitized_parameters),
            "http_status": record.http_status,
            "response_headers": _sanitize_response_headers(record.response_headers),
            "sha256": record.sha256,
            "blob_path": record.blob_path,
            "parser_version": record.parser_version,
            "status": record.status.value,
            "error_message": _redact_text(record.error_message),
        }

    @staticmethod
    def _require_exact_replay(
        existing: RawSnapshotRow, payload: dict[str, Any]
    ) -> None:
        persisted = (
            existing.request_url,
            existing.request_parameters,
            existing.http_status,
            existing.response_headers,
            existing.blob_path,
            existing.parser_version,
            existing.status,
            existing.error_message,
        )
        replayed = tuple(
            payload[key]
            for key in (
                "request_url",
                "request_parameters",
                "http_status",
                "response_headers",
                "blob_path",
                "parser_version",
                "status",
                "error_message",
            )
        )
        if persisted != replayed:
            raise ProvenanceConflictError(
                "raw snapshot identity was replayed with different content"
            )


class IngestionRunRepository:


    def __init__(self, session: Session) -> None:
        self._session = session

    def start(
        self, *, source_key: str, started_at: datetime, parser_version: str
    ) -> int:
        row = IngestionRunRow(
            source_key=source_key,
            started_at=started_at,
            status="running",
            parser_version=parser_version,
        )
        self._session.add(row)
        self._session.flush()
        return row.id

    def finish(
        self,
        run_id: int,
        *,
        status: str,
        finished_at: datetime,
        inserted_count: int = 0,
        rejected_count: int = 0,
        warnings: Sequence[str] = (),
        most_recent_observation_date: date | None = None,
        error_message: str | None = None,
    ) -> None:
        row = self._session.get(IngestionRunRow, run_id)
        if row is None:
            raise LookupError(f"unknown ingestion run: {run_id}")
        row.status = status
        row.finished_at = finished_at
        row.inserted_count = inserted_count
        row.rejected_count = rejected_count
        row.warnings = list(warnings)
        row.most_recent_observation_date = most_recent_observation_date
        row.error_message = _redact_text(error_message)
        self._session.flush()


def _is_authentic_vintage(
    row: ObservationRow, snapshot: RawSnapshotRow | None
) -> bool:


    vintage_kind = row.details.get("vintage_kind")
    if (
        row.details.get("demonstration") is True
        or row.details.get("synthetic") is True
        or vintage_kind in {"synthetic", "synthetic_demo", "authentic_simulated"}
    ):
        return False
    return (
        snapshot is not None
        or row.details.get("authentic_vintage") is True
        or vintage_kind == "authentic"
    )


class ObservationRepository:


    def __init__(self, session: Session) -> None:
        self._session = session

    def insert_many(self, records: Sequence[ObservationRecord]) -> int:


        return self.insert_observations(records)

    def insert_observations(self, records: Sequence[ObservationRecord]) -> int:


        inserted = 0
        for record in records:
            existing = self._find_issue_version(record)
            if existing is not None:
                self._require_exact_replay(existing, record)
                continue
            try:
                with self._session.begin_nested():
                    self._session.add(self._to_row(record))
                    self._session.flush()
            except IntegrityError:
                existing = self._find_issue_version(record)
                if existing is None:
                    raise
                self._require_exact_replay(existing, record)
                continue
            inserted += 1
        return inserted

    def count(self) -> int:
        return (
            self._session.scalar(select(func.count()).select_from(ObservationRow)) or 0
        )

    def latest_observation(
        self,
        geography_id: str,
        metric: str,
        *,
        source_key: str | None = None,
    ) -> ObservationRecord | None:
        statement = (
            select(ObservationRow)
            .where(
                ObservationRow.geography_id == geography_id,
                ObservationRow.metric == metric,
            )
            .order_by(
                ObservationRow.observation_end.desc(),
                ObservationRow.issue_date.desc().nulls_last(),
                ObservationRow.retrieved_at.desc(),
            )
            .limit(1)
        )
        if source_key is not None:
            statement = statement.where(ObservationRow.source_key == source_key)
        row = self._session.scalar(statement)
        return self._to_record(row) if row is not None else None

    @overload
    def observations_as_known_at(
        self,
        geography_id: str,
        as_of: date | datetime,
        *,
        metric: str | None = None,
        source_key: str | None = None,
    ) -> list[ObservationRecord]: ...

    @overload
    def observations_as_known_at(
        self,
        geography_id: KnowledgeSetRequest,
        as_of: None = None,
        *,
        metric: None = None,
        source_key: None = None,
    ) -> tuple[SelectedObservation, ...]: ...

    def observations_as_known_at(
        self,
        geography_id: str | KnowledgeSetRequest,
        as_of: date | datetime | None = None,
        *,
        metric: str | None = None,
        source_key: str | None = None,
    ) -> list[ObservationRecord] | tuple[SelectedObservation, ...]:


        if isinstance(geography_id, KnowledgeSetRequest):
            if as_of is not None or metric is not None or source_key is not None:
                raise TypeError(
                    "KnowledgeSetRequest cannot be combined with legacy filters"
                )
            return self._selected_knowledge_set(geography_id)
        if as_of is None:
            raise TypeError("as_of is required")

        if isinstance(as_of, datetime):
            if as_of.tzinfo is None or as_of.utcoffset() is None:
                raise ValueError("as_of must be timezone-aware")
            as_of_timestamp = as_of.astimezone(UTC)
            cutoff = as_of_timestamp.date()
        else:
            cutoff = as_of
            as_of_timestamp = datetime.combine(as_of, time.max, tzinfo=UTC)
        availability = and_(
            ObservationRow.retrieved_at <= as_of_timestamp,
            or_(
                ObservationRow.issue_date <= cutoff,
                ObservationRow.issue_date.is_(None),
            ),
        )
        ranked = select(
            ObservationRow.id.label("observation_id"),
            func.row_number()
            .over(
                partition_by=(
                    ObservationRow.source_key,
                    ObservationRow.upstream_id,
                    ObservationRow.geography_id,
                    ObservationRow.metric,
                    ObservationRow.observation_start,
                    ObservationRow.observation_end,
                ),
                order_by=(
                    ObservationRow.issue_date.desc().nulls_last(),
                    ObservationRow.retrieved_at.desc(),
                ),
            )
            .label("issue_rank"),
        ).where(ObservationRow.geography_id == geography_id, availability)
        if metric is not None:
            ranked = ranked.where(ObservationRow.metric == metric)
        if source_key is not None:
            ranked = ranked.where(ObservationRow.source_key == source_key)
        ranked_rows = ranked.subquery()
        statement: Select[tuple[ObservationRow]] = (
            select(ObservationRow)
            .join(ranked_rows, ranked_rows.c.observation_id == ObservationRow.id)
            .where(ranked_rows.c.issue_rank == 1)
            .order_by(
                ObservationRow.observation_end,
                ObservationRow.source_key,
                ObservationRow.upstream_id,
            )
        )
        return [self._to_record(row) for row in self._session.scalars(statement)]

    def _selected_knowledge_set(
        self, request: KnowledgeSetRequest
    ) -> tuple[SelectedObservation, ...]:


        rows = list(
            self._session.scalars(
                select(ObservationRow)
                .where(
                    ObservationRow.geography_id == request.geography_id,
                    ObservationRow.metric == request.metric,
                    ObservationRow.disease == request.disease.value,
                    ObservationRow.source_key == request.source_key,
                    ObservationRow.retrieved_at <= request.as_of,
                )
                .order_by(ObservationRow.observation_end, ObservationRow.id)
            )
        )
        selected: dict[tuple[object, ...], tuple[datetime, str, ObservationRow]] = {}
        for row in rows:
            snapshot = (
                self._session.get(RawSnapshotRow, row.raw_snapshot_id)
                if row.raw_snapshot_id is not None
                else None
            )
            issue_at = (
                datetime.combine(
                    row.issue_date + timedelta(days=1), time.min, tzinfo=UTC
                )
                if row.issue_date is not None
                else None
            )
            provenance_times = [row.retrieved_at]
            if issue_at is not None:
                provenance_times.append(issue_at)
            if snapshot is not None:
                provenance_times.append(snapshot.retrieved_at)
            availability_at = max(provenance_times)
            if availability_at > request.as_of:
                continue
            flags = tuple(QualityFlag(value) for value in row.quality_flags)
            excluded = set(request.excluded_quality_flags) - set(
                request.include_quality_flags
            )
            if any(flag in excluded for flag in flags):
                continue
            authentic_vintage = _is_authentic_vintage(row, snapshot)
            if request.require_authentic_vintage and not authentic_vintage:
                continue
            key = (
                row.source_key,
                row.upstream_id,
                row.geography_id,
                row.metric,
                row.disease,
                row.observation_start,
                row.observation_end,
            )
            candidate = (availability_at, row.issue_identity, row)
            prior = selected.get(key)
            if prior is None or candidate[:2] > prior[:2]:
                selected[key] = candidate



        by_week: dict[EpiWeek, list[tuple[datetime, str, ObservationRow]]] = {}
        for candidate in selected.values():
            row = candidate[2]
            try:
                epiweek = EpiWeek.from_end_date(row.observation_end)
            except ValueError:
                continue
            by_week.setdefault(epiweek, []).append(candidate)

        result: list[SelectedObservation] = []
        for epiweek in sorted(by_week):
            candidates = by_week[epiweek]
            values = {candidate[2].value for candidate in candidates}
            if len(values) != 1:
                continue
            availability_at, _, row = max(
                candidates, key=lambda candidate: (candidate[0], candidate[1])
            )
            issue_at = (
                datetime.combine(
                    row.issue_date + timedelta(days=1), time.min, tzinfo=UTC
                )
                if row.issue_date is not None
                else None
            )
            authentic_vintage = _is_authentic_vintage(
                row,
                self._session.get(RawSnapshotRow, row.raw_snapshot_id)
                if row.raw_snapshot_id is not None
                else None,
            )
            point = WeeklyPoint(
                epiweek=epiweek,
                value=row.value,
                observation_id=row.id,
                observation_end=row.observation_end,
                issue_at=issue_at,
                retrieved_at=row.retrieved_at,
                quality_flags=tuple(QualityFlag(value) for value in row.quality_flags),
                reporting_coverage=row.reporting_coverage,
                availability_at=availability_at,
                issue_identity=row.issue_identity,
                raw_snapshot_id=row.raw_snapshot_id,
                authentic_vintage=authentic_vintage,
            )
            result.append(
                SelectedObservation(
                    observation=point,
                    availability_at=availability_at,
                    raw_snapshot_id=row.raw_snapshot_id,
                    issue_identity=row.issue_identity,
                )
            )
        return tuple(result)

    def _find_issue_version(self, record: ObservationRecord) -> ObservationRow | None:
        statement = select(ObservationRow).where(
            ObservationRow.source_key == record.source_key,
            ObservationRow.upstream_id == record.upstream_id,
            ObservationRow.geography_id == record.geography_id,
            ObservationRow.metric == record.metric,
            ObservationRow.observation_start == record.observation_start,
            ObservationRow.observation_end == record.observation_end,
            ObservationRow.issue_identity == record.canonical_issue_identity,
        )
        return self._session.scalar(statement)

    @staticmethod
    def _require_exact_replay(
        existing: ObservationRow, record: ObservationRecord
    ) -> None:



        persisted_payload = (
            existing.disease,
            existing.value,
            existing.unit,
            existing.issue_date,
            existing.revision,
            existing.quality_flags,
            existing.reporting_coverage,
            existing.details,
        )
        replayed_payload = (
            record.disease.value,
            record.value,
            record.unit,
            record.issue_date,
            record.revision,
            enum_values(record.quality_flags),
            record.reporting_coverage,
            thaw_json_object(record.metadata),
        )
        if persisted_payload != replayed_payload:
            raise ProvenanceConflictError(
                "observation issue identity was replayed with different content"
            )

    @staticmethod
    def _to_row(record: ObservationRecord) -> ObservationRow:
        return ObservationRow(
            source_key=record.source_key,
            upstream_id=record.upstream_id,
            disease=record.disease.value,
            metric=record.metric,
            value=record.value,
            unit=record.unit,
            geography_id=record.geography_id,
            observation_start=record.observation_start,
            observation_end=record.observation_end,
            issue_date=record.issue_date,
            issue_identity=record.canonical_issue_identity,
            retrieved_at=record.retrieved_at,
            raw_snapshot_id=record.raw_snapshot_id,
            revision=record.revision,
            quality_flags=enum_values(record.quality_flags),
            reporting_coverage=record.reporting_coverage,
            details=thaw_json_object(record.metadata),
        )

    @staticmethod
    def _to_record(row: ObservationRow) -> ObservationRecord:
        return ObservationRecord(
            source_key=row.source_key,
            upstream_id=row.upstream_id,
            disease=Disease(row.disease),
            metric=row.metric,
            value=row.value,
            unit=row.unit,
            geography_id=row.geography_id,
            observation_start=row.observation_start,
            observation_end=row.observation_end,
            issue_date=row.issue_date,
            issue_identity=row.issue_identity,
            retrieved_at=row.retrieved_at,
            raw_snapshot_id=row.raw_snapshot_id,
            revision=row.revision,
            quality_flags=tuple(QualityFlag(value) for value in row.quality_flags),
            reporting_coverage=row.reporting_coverage,
            metadata=row.details,
        )


class ForecastRepository:


    def __init__(self, session: Session) -> None:
        self._session = session

    def save_forecast_run(
        self,
        *,
        run_key: str,
        model_key: str,
        model_version: str,
        training_cutoff: datetime,
        feature_set: JsonObject,
        configuration: JsonObject,
        code_version: str,
        forecasts: Sequence[ForecastRecord],
        published_at: datetime | None = None,
    ) -> int:
        if training_cutoff.tzinfo is None or training_cutoff.utcoffset() is None:
            raise ValueError("training_cutoff must be timezone-aware")
        training_cutoff = training_cutoff.astimezone(UTC)
        if published_at is None:
            published_at = training_cutoff
        if published_at.tzinfo is None or published_at.utcoffset() is None:
            raise ValueError("published_at must be timezone-aware")
        published_at = published_at.astimezone(UTC)
        existing = self._find_run(run_key)
        if existing is not None:
            self._require_exact_run_replay(
                existing,
                model_key=model_key,
                model_version=model_version,
                training_cutoff=training_cutoff,
                feature_set=feature_set,
                configuration=configuration,
                code_version=code_version,
                forecasts=forecasts,
                published_at=published_at,
            )
            return existing.id
        try:
            with self._session.begin_nested():
                run = ForecastRunRow(
                    run_key=run_key,
                    model_key=model_key,
                    model_version=model_version,
                    training_cutoff=training_cutoff,
                    feature_set=thaw_json_object(feature_set),
                    configuration=thaw_json_object(configuration),
                    code_version=code_version,
                    created_at=published_at,
                )
                self._session.add(run)
                self._session.flush()
                for forecast in forecasts:
                    row = ForecastRow(
                        forecast_run_id=run.id,
                        geography_id=forecast.geography_id,
                        target_start=forecast.target_start,
                        target_end=forecast.target_end,
                        point_estimate=forecast.point_estimate,
                        direction=forecast.direction.value,
                        confidence=forecast.confidence,
                        source_availability=thaw_json_object(
                            forecast.source_availability
                        ),
                        details=thaw_json_object(forecast.metadata),
                    )
                    self._session.add(row)
                    self._session.flush()
                    self._session.add_all(
                        EvidenceLinkRow(
                            forecast_id=row.id,
                            observation_id=observation_id,
                            rank=rank,
                        )
                        for rank, observation_id in enumerate(
                            forecast.evidence_observation_ids, start=1
                        )
                    )
                self._session.flush()
        except IntegrityError:
            existing = self._find_run(run_key)
            if existing is None:
                raise
            self._require_exact_run_replay(
                existing,
                model_key=model_key,
                model_version=model_version,
                training_cutoff=training_cutoff,
                feature_set=feature_set,
                configuration=configuration,
                code_version=code_version,
                forecasts=forecasts,
                published_at=published_at,
            )
            return existing.id
        return run.id

    def latest_published(
        self,
        geography_id: str,
        *,
        source_key: str,
        metric: str,
        disease: Disease = Disease.INFLUENZA,
    ) -> tuple[ForecastRunRow, ForecastRow] | None:


        target_disease = ForecastRunRow.configuration["target_disease"].as_string()
        disease_filter = target_disease == disease.value
        if disease is Disease.INFLUENZA:
            disease_filter = or_(disease_filter, target_disease.is_(None))
        row = self._session.execute(
            select(ForecastRunRow, ForecastRow)
            .join(ForecastRow, ForecastRow.forecast_run_id == ForecastRunRow.id)
            .where(
                ForecastRow.geography_id == geography_id,
                ForecastRunRow.configuration["target_source_key"].as_string()
                == source_key,
                ForecastRunRow.configuration["target_metric"].as_string() == metric,
                disease_filter,
                ForecastRunRow.configuration["forecast_horizon"].as_integer() == 0,
                ForecastRunRow.configuration["forecast_label"].as_string()
                == "current-week nowcast",
            )
            .order_by(
                ForecastRunRow.created_at.desc(),
                ForecastRow.target_end.desc(),
                ForecastRow.id.desc(),
            )
            .limit(1)
        ).first()
        return (row[0], row[1]) if row is not None else None

    def _find_run(self, run_key: str) -> ForecastRunRow | None:
        return self._session.scalar(
            select(ForecastRunRow).where(ForecastRunRow.run_key == run_key)
        )

    def _require_exact_run_replay(
        self,
        existing: ForecastRunRow,
        *,
        model_key: str,
        model_version: str,
        training_cutoff: datetime,
        feature_set: JsonObject,
        configuration: JsonObject,
        code_version: str,
        forecasts: Sequence[ForecastRecord],
        published_at: datetime,
    ) -> None:
        persisted_run = (
            existing.model_key,
            existing.model_version,
            existing.training_cutoff,
            existing.feature_set,
            existing.configuration,
            existing.code_version,
            existing.created_at,
        )
        replayed_run = (
            model_key,
            model_version,
            training_cutoff,
            thaw_json_object(feature_set),
            thaw_json_object(configuration),
            code_version,
            published_at,
        )
        persisted_forecasts = list(
            self._session.scalars(
                select(ForecastRow)
                .where(ForecastRow.forecast_run_id == existing.id)
                .order_by(ForecastRow.id)
            )
        )
        if persisted_run != replayed_run or len(persisted_forecasts) != len(forecasts):
            raise ProvenanceConflictError(
                "forecast run key was replayed with different content"
            )
        for persisted, replayed in zip(persisted_forecasts, forecasts, strict=True):
            evidence_ids = tuple(
                self._session.scalars(
                    select(EvidenceLinkRow.observation_id)
                    .where(EvidenceLinkRow.forecast_id == persisted.id)
                    .order_by(EvidenceLinkRow.rank)
                )
            )
            persisted_payload = (
                persisted.geography_id,
                persisted.target_start,
                persisted.target_end,
                persisted.direction,
                persisted.confidence,
                persisted.point_estimate,
                evidence_ids,
                persisted.source_availability,
                persisted.details,
            )
            replayed_payload = (
                replayed.geography_id,
                replayed.target_start,
                replayed.target_end,
                replayed.direction.value,
                replayed.confidence,
                replayed.point_estimate,
                replayed.evidence_observation_ids,
                thaw_json_object(replayed.source_availability),
                thaw_json_object(replayed.metadata),
            )
            if persisted_payload != replayed_payload:
                raise ProvenanceConflictError(
                    "forecast run key was replayed with different content"
                )


class BacktestRepository:


    def __init__(self, session: Session) -> None:
        self._session = session

    def save_predictions(self, predictions: Sequence[BacktestPrediction]) -> int:
        inserted = 0
        for prediction in predictions:
            payload = self._payload(prediction)
            existing = self._find(prediction)
            if existing is not None:
                self._require_exact(existing, payload)
                continue
            try:
                with self._session.begin_nested():
                    self._session.add(BacktestResultRow(**payload))
                    self._session.flush()
            except IntegrityError:
                existing = self._find(prediction)
                if existing is None:
                    raise
                self._require_exact(existing, payload)
                continue
            inserted += 1
        return inserted

    def rows_before(
        self,
        geography_id: str,
        as_of: datetime,
        *,
        disease: Disease = Disease.INFLUENZA,
        metric: str = "ed_visit_percent",
    ) -> tuple[BacktestResultRow, ...]:
        if as_of.tzinfo is None or as_of.utcoffset() is None:
            raise ValueError("as_of must be timezone-aware")
        return tuple(
            self._session.scalars(
                select(BacktestResultRow)
                .where(
                    BacktestResultRow.geography_id == geography_id,
                    BacktestResultRow.disease == disease.value,
                    BacktestResultRow.metric == metric,
                    BacktestResultRow.forecast_origin < as_of,
                )
                .order_by(
                    BacktestResultRow.forecast_origin, BacktestResultRow.model_key
                )
            )
        )

    def _find(self, prediction: BacktestPrediction) -> BacktestResultRow | None:
        return self._session.scalar(
            select(BacktestResultRow).where(
                BacktestResultRow.model_key == prediction.model_key,
                BacktestResultRow.model_version == prediction.model_version,
                BacktestResultRow.geography_id == prediction.geography_id,
                BacktestResultRow.disease == prediction.disease.value,
                BacktestResultRow.metric == prediction.metric,
                BacktestResultRow.forecast_origin == prediction.origin_as_of,
                BacktestResultRow.target_end == prediction.target_epiweek.end_date(),
            )
        )

    @staticmethod
    def _payload(prediction: BacktestPrediction) -> dict[str, Any]:
        return {
            "model_key": prediction.model_key,
            "model_version": prediction.model_version,
            "geography_id": prediction.geography_id,
            "disease": prediction.disease.value,
            "metric": prediction.metric,
            "evaluation_start": prediction.target_epiweek.start_date(),
            "evaluation_end": prediction.target_epiweek.end_date(),
            "forecast_origin": prediction.origin_as_of,
            "target_end": prediction.target_epiweek.end_date(),
            "predicted_value": prediction.point_prediction,
            "observed_value": prediction.observed_value,
            "predicted_direction": prediction.predicted_direction.value,
            "observed_direction": prediction.observed_direction.value,
            "direction_correct": prediction.direction_correct,
            "absolute_error": prediction.absolute_error,
            "squared_error": prediction.squared_error,
            "confidence": None,
            "baseline_metadata": {
                "metric": prediction.metric,
                "training_end_epiweek": {
                    "year": prediction.training_end_epiweek.year,
                    "week": prediction.training_end_epiweek.week,
                },
                "current_value_at_origin": prediction.current_value_at_origin,
                "fixed_lag_trajectory_direction": (
                    prediction.fixed_lag_trajectory_direction.value
                ),
                "fixed_lag_trajectory_correct": prediction.fixed_lag_trajectory_correct,
                "knowledge_observation_ids": list(prediction.knowledge_observation_ids),
                "evaluation_policy_key": prediction.evaluation_policy_key,
                "evaluation_as_of": prediction.evaluation_as_of.isoformat(),
                "evaluation_observation_id": prediction.evaluation_observation_id,
                "evaluation_issue_identity": prediction.evaluation_issue_identity,
                "eligibility_reason": prediction.model_eligibility.reason.value,
                "direction_threshold_pp": prediction.direction_threshold_pp,
                "direction_threshold_version": prediction.direction_threshold_version,
                "forecast_type": "point",
                "brier_score": None,
            },
        }

    @staticmethod
    def _require_exact(existing: BacktestResultRow, payload: dict[str, Any]) -> None:
        keys = (
            "evaluation_start",
            "evaluation_end",
            "predicted_value",
            "observed_value",
            "predicted_direction",
            "observed_direction",
            "direction_correct",
            "absolute_error",
            "squared_error",
            "confidence",
            "baseline_metadata",
        )
        if tuple(getattr(existing, key) for key in keys) != tuple(
            payload[key] for key in keys
        ):
            raise ProvenanceConflictError(
                "frozen backtest row was replayed with different content"
            )
