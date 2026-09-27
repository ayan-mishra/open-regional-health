from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from enum import StrEnum
from typing import Protocol, cast

from sqlalchemy import select

from corvid.domain import Disease, IngestionStatus
from corvid.forecasting import default_model_factories
from corvid.forecasting.backtest import Backtester, ForecastOrigin
from corvid.forecasting.types import ForecastModelFactory, KnowledgeSetRequest
from corvid.ingestion.runner import IngestionSummary
from corvid.services.assessment import AssessmentService
from corvid.storage import Database, UnitOfWork
from corvid.storage.models import ObservationRow


class StageStatus(StrEnum):
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass(frozen=True, slots=True)
class StageResult:
    status: StageStatus
    count: int = 0
    message: str | None = None


@dataclass(frozen=True, slots=True)
class PipelineSummary:
    status: StageStatus
    source_results: dict[str, StageResult]
    backtest: StageResult
    forecast: StageResult
    warnings: tuple[str, ...] = ()

    @property
    def required_stages_succeeded(self) -> bool:
        primary_failure = any(
            result.status is StageStatus.FAILED and "primary" in (result.message or "")
            for result in self.source_results.values()
        )
        return (
            not primary_failure
            and self.backtest.status is StageStatus.SUCCEEDED
            and self.forecast.status is StageStatus.SUCCEEDED
        )


class IngestionRunnerProtocol(Protocol):
    def run(self, source_key: str) -> IngestionSummary: ...


class PipelineOrchestrator:


    def __init__(
        self,
        *,
        runner: IngestionRunnerProtocol,
        primary_source_key: str,
        has_valid_primary: Callable[[datetime], bool],
        run_backtests: Callable[[datetime], int],
        publish_forecasts: Callable[[datetime], int],
    ) -> None:
        self._runner = runner
        self._primary_source_key = primary_source_key
        self._has_valid_primary = has_valid_primary
        self._run_backtests = run_backtests
        self._publish_forecasts = publish_forecasts

    def run(self, source_keys: Sequence[str], as_of: datetime) -> PipelineSummary:
        if as_of.tzinfo is None or as_of.utcoffset() is None:
            raise ValueError("as_of must be timezone-aware")
        as_of = as_of.astimezone(UTC)
        source_results: dict[str, StageResult] = {}
        warnings: list[str] = []
        for source_key in source_keys:
            try:
                result = self._runner.run(source_key)
            except Exception:
                result = IngestionSummary(
                    source_key=source_key,
                    status=IngestionStatus.FAILED,
                    rejected_count=1,
                )
            succeeded = result.status is IngestionStatus.SUCCEEDED
            message = None
            if not succeeded:
                role = (
                    "primary"
                    if source_key == self._primary_source_key
                    else "optional"
                )
                message = f"{role} source {source_key} ended with {result.status.value}"
                warnings.append(message)
            source_results[source_key] = StageResult(
                StageStatus.SUCCEEDED if succeeded else StageStatus.FAILED,
                count=result.inserted_count,
                message=message,
            )

        if not self._has_valid_primary(as_of):
            skipped = StageResult(
                StageStatus.SKIPPED,
                message="forecast refused: primary source has no valid prior data",
            )
            return PipelineSummary(
                status=StageStatus.FAILED,
                source_results=source_results,
                backtest=skipped,
                forecast=skipped,
                warnings=tuple(warnings),
            )

        try:
            backtest_count = self._run_backtests(as_of)
            backtest = StageResult(StageStatus.SUCCEEDED, count=backtest_count)
        except Exception:
            backtest = StageResult(StageStatus.FAILED, message="backtest stage failed")

        try:
            forecast_count = self._publish_forecasts(as_of)
            forecast = StageResult(
                StageStatus.SUCCEEDED if forecast_count > 0 else StageStatus.FAILED,
                count=forecast_count,
                message=None
                if forecast_count > 0
                else "forecast stage produced no assessments",
            )
        except Exception:
            forecast = StageResult(StageStatus.FAILED, message="forecast stage failed")

        required_failed = (
            backtest.status is StageStatus.FAILED
            or forecast.status is StageStatus.FAILED
        )
        optional_failed = any(
            key != self._primary_source_key and result.status is StageStatus.FAILED
            for key, result in source_results.items()
        )
        primary_failed = source_results.get(
            self._primary_source_key, StageResult(StageStatus.FAILED)
        ).status is StageStatus.FAILED
        status = (
            StageStatus.FAILED
            if required_failed
            else StageStatus.PARTIAL
            if optional_failed or primary_failed
            else StageStatus.SUCCEEDED
        )
        return PipelineSummary(
            status=status,
            source_results=source_results,
            backtest=backtest,
            forecast=forecast,
            warnings=tuple(warnings),
        )


def has_fresh_primary(
    database: Database,
    *,
    source_key: str,
    metric: str,
    geography_id: str,
    as_of: datetime,
    stale_after_days: int = 21,
    disease: Disease = Disease.INFLUENZA,
) -> bool:
    with UnitOfWork(database) as work:
        selected = work.observations.observations_as_known_at(
            KnowledgeSetRequest(
                geography_id=geography_id,
                metric=metric,
                source_key=source_key,
                as_of=as_of.astimezone(UTC),
                require_authentic_vintage=False,
                disease=disease,
            )
        )
        latest = selected[-1].observation if selected else None
    return latest is not None and (
        as_of.date() - latest.observation_end
    ).days <= stale_after_days


def target_geography_ids(
    database: Database,
    *,
    source_key: str,
    metric: str,
    disease: Disease = Disease.INFLUENZA,
) -> tuple[str, ...]:


    with database.session() as session:
        return tuple(
            session.scalars(
                select(ObservationRow.geography_id)
                .where(
                    ObservationRow.source_key == source_key,
                    ObservationRow.metric == metric,
                    ObservationRow.disease == disease.value,
                )
                .distinct()
                .order_by(ObservationRow.geography_id)
            )
        )


def run_database_backtests(
    database: Database,
    *,
    geography_ids: Sequence[str],
    source_key: str,
    metric: str,
    as_of: datetime,
    disease: Disease = Disease.INFLUENZA,
) -> int:


    inserted = 0
    with UnitOfWork(database) as work:
        for geography_id in geography_ids:
            request = KnowledgeSetRequest(
                geography_id=geography_id,
                metric=metric,
                source_key=source_key,
                as_of=as_of,
                require_authentic_vintage=True,
                disease=disease,
            )
            selected = work.observations.observations_as_known_at(request)
            weeks = tuple(item.observation.epiweek for item in selected)
            week_set = set(weeks)
            origins: list[ForecastOrigin] = []
            for target in weeks[1:]:
                origin_at = datetime.combine(
                    target.end_date() - timedelta(days=1), time(23, 0), tzinfo=UTC
                )
                evaluation_complete = target.end_date() + timedelta(days=56)
                if (
                    target.previous() in week_set
                    and origin_at <= as_of
                    and evaluation_complete <= as_of.date()
                ):
                    origins.append(ForecastOrigin(origin_at, target))
            factories = cast(
                Sequence[ForecastModelFactory], default_model_factories()
            )
            predictions = Backtester(work.observations).run(factories, request, origins)
            inserted += work.backtests.save_predictions(predictions)
    return inserted


def publish_database_forecasts(
    database: Database,
    *,
    source_key: str,
    metric: str,
    mode: str,
    as_of: datetime,
    disease: Disease = Disease.INFLUENZA,
    statewide_only: bool = False,
) -> int:


    geography_ids = target_geography_ids(
        database, source_key=source_key, metric=metric, disease=disease
    )
    service = AssessmentService(
        database,
        mode="demo" if mode == "demo" else "live",
        source_key=source_key,
        metric=metric,
        disease=disease,
    )
    published = 0
    for geography_id in geography_ids:
        if statewide_only and geography_id != "ma":
            continue
        assessment = service.publish_latest(geography_id, as_of)
        if assessment.forecast_run_id is not None:
            published += 1
    return published


def run_database_backtests_for_diseases(
    database: Database,
    *,
    source_key: str,
    metric: str,
    as_of: datetime,
) -> int:


    return sum(
        run_database_backtests(
            database,
            geography_ids=("ma",),
            source_key=source_key,
            metric=metric,
            as_of=as_of,
            disease=disease,
        )
        for disease in Disease
    )


def publish_statewide_disease_assessments(
    database: Database,
    *,
    source_key: str,
    metric: str,
    mode: str,
    as_of: datetime,
) -> int:


    return sum(
        publish_database_forecasts(
            database,
            source_key=source_key,
            metric=metric,
            mode=mode,
            as_of=as_of,
            disease=disease,
            statewide_only=True,
        )
        for disease in Disease
    )


def date_is_fresh(value: date, as_of: datetime, *, days: int = 21) -> bool:


    return (as_of.date() - value).days <= days
