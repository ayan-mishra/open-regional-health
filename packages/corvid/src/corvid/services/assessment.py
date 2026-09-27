from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Literal

from corvid.domain.enums import Direction, Disease, GeographyType, QualityFlag
from corvid.domain.models import ForecastRecord
from corvid.domain.types import JsonObject, freeze_json_object
from corvid.forecasting.baselines import default_model_factories
from corvid.forecasting.confidence import (
    DataQuality,
    ForecastStatus,
    HistoricalSkill,
    QualityReason,
    QualitySkillAssessment,
    QualitySkillInput,
    assess_quality_and_skill,
    publication_target,
)
from corvid.forecasting.directions import (
    DEFAULT_DIRECTION_THRESHOLD_PP,
    DIRECTION_THRESHOLD_VERSION,
    classify_direction,
)
from corvid.forecasting.metrics import ModelMetrics
from corvid.forecasting.types import (
    EpiWeek,
    KnowledgeSetRequest,
    ModelEligibility,
    ModelPrediction,
    WeeklyHistory,
    WeeklyPoint,
)
from corvid.storage.database import Database, UnitOfWork
from corvid.storage.models import BacktestResultRow

TARGET_SOURCE_KEY = "nssp_ed"
TARGET_METRIC = "ed_visit_percent"
TARGET_UNIT = "percentage_points"
WITHHELD_MODEL_KEY = "withheld_by_quality_policy"


@dataclass(frozen=True, slots=True)
class EvidenceItem:
    id: str
    kind: Literal["observation", "baseline", "performance", "freshness", "limitation"]
    rank: int
    summary_template_key: str
    source_key: str | None = None
    source_name: str | None = None
    source_landing_page_url: str | None = None
    geography_id: str | None = None
    metric: str | None = None
    value: float | None = None
    unit: str | None = None
    observation_start: date | None = None
    observation_end: date | None = None
    issued_at: datetime | None = None
    retrieved_at: datetime | None = None
    raw_snapshot_id: int | None = None
    observation_id: int | None = None
    quality_flags: tuple[QualityFlag, ...] = ()
    details: JsonObject = freeze_json_object({})

    def __post_init__(self) -> None:
        if self.rank < 1:
            raise ValueError("evidence rank must be positive")
        object.__setattr__(self, "details", freeze_json_object(self.details))


@dataclass(frozen=True, slots=True)
class Assessment:
    id: str
    schema_version: Literal["1.0"]
    published_at: datetime
    geography_id: str
    geography_type: GeographyType
    is_experimental: bool
    disease: Disease
    target_metric: str
    target_unit: Literal["percentage_points"]
    latest_observation: WeeklyPoint
    target_epiweek: EpiWeek
    reference_date: date
    horizon: Literal[0]
    forecast_label: Literal["current-week nowcast"]
    forecast_status: ForecastStatus
    point_estimate: float | None
    direction: Direction | None
    direction_threshold_pp: float
    direction_threshold_version: str
    forecast_run_id: str | None
    selected_model_key: str | None
    selected_model_version: str | None
    data_quality: DataQuality
    historical_skill: HistoricalSkill
    quality_skill: QualitySkillAssessment
    baselines: tuple[ModelPrediction | ModelEligibility, ...]
    recent_performance: ModelMetrics | None
    evidence: tuple[EvidenceItem, ...]
    warnings: tuple[str, ...]
    limitations: tuple[str, ...]
    mode: Literal["demo", "live"]


class AssessmentService:


    def __init__(
        self,
        database: Database,
        *,
        mode: Literal["demo", "live"] = "demo",
        source_key: str = TARGET_SOURCE_KEY,
        metric: str = TARGET_METRIC,
        disease: Disease = Disease.INFLUENZA,
        code_version: str = "corvid-mvp-v1",
    ) -> None:
        self._database = database
        self._mode = mode
        self._source_key = source_key
        self._metric = metric
        self._disease = disease
        self._code_version = code_version

    def publish_latest(self, geography_id: str, as_of: datetime) -> Assessment:
        if as_of.tzinfo is None or as_of.utcoffset() is None:
            raise ValueError("as_of must be timezone-aware")
        as_of = as_of.astimezone(UTC)
        schedule = publication_target(as_of)
        knowledge_cutoff = as_of if self._mode == "live" else schedule.scheduled_origin
        with UnitOfWork(self._database) as work:
            geography = work.geographies.get(geography_id)
            if geography is None:
                raise LookupError(f"unknown geography: {geography_id}")
            geography_type = GeographyType(geography.geography_type)
            source = work.sources.get(self._source_key)
            request = KnowledgeSetRequest(
                geography_id=geography_id,
                metric=self._metric,
                source_key=self._source_key,


                as_of=knowledge_cutoff,
                excluded_quality_flags=(),
                require_authentic_vintage=False,
                disease=self._disease,
            )
            selected = work.observations.observations_as_known_at(request)
            if not selected:
                raise LookupError(
                    f"no public target observations exist for geography: {geography_id}"
                )
            history = WeeklyHistory(
                geography_id=geography_id,
                metric=self._metric,
                unit="percentage_points",
                as_of=knowledge_cutoff,
                points=tuple(item.observation for item in selected),
            )
            latest = history.points[-1]
            rows = work.backtests.rows_before(
                geography_id,
                schedule.scheduled_origin,
                disease=self._disease,
                metric=self._metric,
            )
            no_change_rows = tuple(row for row in rows if row.model_key == "no_change")
            complete_windows = _complete_october_may_windows(no_change_rows)
            authentic_vintages = len(history.points) >= 52 and all(
                point.authentic_vintage for point in history.points[-52:]
            )
            quality = assess_quality_and_skill(
                QualitySkillInput(
                    geography_type=geography_type,
                    latest_observation=latest,
                    expected_input_epiweek=schedule.target_epiweek.previous(),
                    as_of=knowledge_cutoff,
                    sparse=QualityFlag.SPARSE in latest.quality_flags,
                    authentic_vintages=authentic_vintages,
                    paired_valid_origins=len(no_change_rows),
                    complete_october_may_windows=complete_windows,
                    skill_lower_bound_positive=False,
                )
            )
            baseline_outputs = _baseline_outputs(history, schedule.target_epiweek)
            warnings = _warnings(quality)
            limitations = _limitations(geography_type, self._disease)
            point_estimate: float | None = None
            direction: Direction | None = None
            run_id: str | None = None
            selected_key: str | None = None
            selected_version: str | None = None
            persisted_model_key = WITHHELD_MODEL_KEY
            persisted_model_version = quality.policy_key
            persisted_direction = Direction.STABLE
            evidence_observation_ids: tuple[int, ...] = (latest.observation_id,)
            if quality.forecast_status is ForecastStatus.AVAILABLE:
                champion = default_model_factories()[0]
                eligibility = champion.eligibility(history, schedule.target_epiweek)
                if eligibility.eligible:
                    prediction = champion.fit(history).predict_next(
                        schedule.target_epiweek
                    )
                    point_estimate = prediction.point_estimate
                    direction = classify_direction(
                        latest.value,
                        point_estimate,
                        DEFAULT_DIRECTION_THRESHOLD_PP,
                    )
                    selected_key = prediction.model_key
                    selected_version = prediction.model_version
                    persisted_model_key = prediction.model_key
                    persisted_model_version = prediction.model_version
                    persisted_direction = direction
                    evidence_observation_ids = prediction.input_observation_ids
            run_key = (
                f"nowcast:{self._disease.value}:{geography_id}:"
                f"{schedule.target_epiweek.year}W{schedule.target_epiweek.week:02d}:"
                f"obs{latest.observation_id}:{persisted_model_version}"
            )
            published_at = as_of
            persisted_knowledge_cutoff = knowledge_cutoff
            prior_publication = work.forecasts.latest_published(
                geography_id,
                source_key=self._source_key,
                metric=self._metric,
                disease=self._disease,
            )
            if (
                prior_publication is not None
                and prior_publication[0].run_key == run_key
            ):
                published_at = prior_publication[0].created_at
                persisted_knowledge_cutoff = prior_publication[0].training_cutoff
            persisted_id = work.forecasts.save_forecast_run(
                run_key=run_key,
                model_key=persisted_model_key,
                model_version=persisted_model_version,
                training_cutoff=persisted_knowledge_cutoff,
                feature_set={"target_series_only": True},
                configuration={
                    "forecast_horizon": 0,
                    "forecast_label": "current-week nowcast",
                    "target_source_key": self._source_key,
                    "target_metric": self._metric,
                    "target_disease": self._disease.value,
                    "scheduled_origin": schedule.scheduled_origin.isoformat(),
                    "knowledge_cutoff": persisted_knowledge_cutoff.isoformat(),
                    "target_unit": TARGET_UNIT,
                    "mode": self._mode,
                    "direction_threshold_pp": DEFAULT_DIRECTION_THRESHOLD_PP,
                    "direction_threshold_version": DIRECTION_THRESHOLD_VERSION,
                    "moving_average_window": 4,
                    "linear_trend_window": 8,
                    "quality_policy": quality.policy_key,
                    "confidence_score": None,
                    "probabilistic": False,
                },
                code_version=self._code_version,
                forecasts=(
                    ForecastRecord(
                        geography_id=geography_id,
                        target_start=schedule.target_epiweek.start_date(),
                        target_end=schedule.target_epiweek.end_date(),
                        point_estimate=point_estimate,
                        direction=persisted_direction,

                        confidence=0.0,
                        evidence_observation_ids=evidence_observation_ids,
                        source_availability={
                            "latest_observation_id": latest.observation_id,
                            "latest_availability_at": (
                                latest.availability_at.isoformat()
                                if latest.availability_at is not None
                                else None
                            ),
                        },
                        metadata={
                            "forecast_status": quality.forecast_status.value,
                            "data_quality": quality.data_quality.value,
                            "historical_skill": quality.historical_skill.value,
                            "quality_reasons": [
                                reason.value for reason in quality.reasons
                            ],
                            "quality_policy": quality.policy_key,
                            "paired_valid_origins": quality.paired_valid_origins,
                            "complete_october_may_windows": (
                                quality.complete_october_may_windows
                            ),
                            "warnings": list(warnings),
                            "limitations": list(limitations),
                            "confidence_score": None,
                            "brier_score": None,
                        },
                    ),
                ),
                published_at=published_at,
            )
            run_id = str(persisted_id)
            evidence = _evidence(
                geography_id=geography_id,
                latest=latest,
                source=source,
                baselines=baseline_outputs,
                quality=quality,
                experimental=geography.experimental,
                metric=self._metric,
            )
            return Assessment(
                id=(
                    f"assessment:{self._disease.value}:{geography_id}:"
                    f"{schedule.target_epiweek.year}-W{schedule.target_epiweek.week:02d}"
                ),
                schema_version="1.0",
                published_at=published_at,
                geography_id=geography_id,
                geography_type=geography_type,
                is_experimental=geography.experimental,
                disease=self._disease,
                target_metric=self._metric,
                target_unit="percentage_points",
                latest_observation=latest,
                target_epiweek=schedule.target_epiweek,
                reference_date=schedule.reference_date,
                horizon=0,
                forecast_label="current-week nowcast",
                forecast_status=quality.forecast_status,
                point_estimate=point_estimate,
                direction=direction,
                direction_threshold_pp=DEFAULT_DIRECTION_THRESHOLD_PP,
                direction_threshold_version=DIRECTION_THRESHOLD_VERSION,
                forecast_run_id=run_id,
                selected_model_key=selected_key,
                selected_model_version=selected_version,
                data_quality=quality.data_quality,
                historical_skill=quality.historical_skill,
                quality_skill=quality,
                baselines=baseline_outputs,
                recent_performance=None,
                evidence=evidence,
                warnings=warnings,
                limitations=limitations,
                mode=self._mode,
            )

    def latest_published(self, geography_id: str) -> Assessment:


        with UnitOfWork(self._database) as work:
            published = work.forecasts.latest_published(
                geography_id,
                source_key=self._source_key,
                metric=self._metric,
                disease=self._disease,
            )
            if published is None:
                raise LookupError(
                    f"no published assessment exists for geography: {geography_id}"
                )
            run, forecast = published
            geography = work.geographies.get(geography_id)
            if geography is None:
                raise LookupError(f"unknown geography: {geography_id}")
            source = work.sources.get(self._source_key)
            selected = work.observations.observations_as_known_at(
                KnowledgeSetRequest(
                    geography_id=geography_id,
                    metric=self._metric,
                    source_key=self._source_key,
                    as_of=run.training_cutoff,
                    excluded_quality_flags=(),
                    require_authentic_vintage=False,
                    disease=self._disease,
                )
            )
            latest_id = _required_int(
                forecast.source_availability, "latest_observation_id"
            )
            latest_selected = next(
                (
                    item
                    for item in selected
                    if item.observation.observation_id == latest_id
                ),
                None,
            )
            if latest_selected is None:
                raise ValueError(
                    "persisted assessment does not reference an eligible observation"
                )
            history = WeeklyHistory(
                geography_id=geography_id,
                metric=self._metric,
                unit="percentage_points",
                as_of=run.training_cutoff,
                points=tuple(item.observation for item in selected),
            )
            target = EpiWeek.from_end_date(forecast.target_end)
            baselines = _baseline_outputs(history, target)
            details = forecast.details
            quality = QualitySkillAssessment(
                policy_key=_required_str(details, "quality_policy"),
                forecast_status=ForecastStatus(
                    _required_str(details, "forecast_status")
                ),
                data_quality=DataQuality(_required_str(details, "data_quality")),
                historical_skill=HistoricalSkill(
                    _required_str(details, "historical_skill")
                ),
                reasons=tuple(
                    QualityReason(value)
                    for value in _required_str_list(details, "quality_reasons")
                ),
                paired_valid_origins=_required_int(details, "paired_valid_origins"),
                complete_october_may_windows=_required_int(
                    details, "complete_october_may_windows"
                ),
            )
            geography_type = GeographyType(geography.geography_type)
            mode_value = _required_str(run.configuration, "mode")
            mode: Literal["demo", "live"]
            if mode_value == "demo":
                mode = "demo"
            elif mode_value == "live":
                mode = "live"
            else:
                raise ValueError("persisted assessment has an invalid mode")
            latest = latest_selected.observation
            evidence = _evidence(
                geography_id=geography_id,
                latest=latest,
                source=source,
                baselines=baselines,
                quality=quality,
                experimental=geography.experimental,
                metric=self._metric,
            )
            return Assessment(
                id=(
                    f"assessment:{self._disease.value}:"
                    f"{geography_id}:"
                    f"{target.year}-W{target.week:02d}"
                ),
                schema_version="1.0",
                published_at=run.created_at,
                geography_id=geography_id,
                geography_type=geography_type,
                is_experimental=geography.experimental,
                disease=self._disease,
                target_metric=self._metric,
                target_unit="percentage_points",
                latest_observation=latest,
                target_epiweek=target,
                reference_date=forecast.target_end,
                horizon=0,
                forecast_label="current-week nowcast",
                forecast_status=quality.forecast_status,
                point_estimate=forecast.point_estimate,
                direction=(
                    Direction(forecast.direction)
                    if quality.forecast_status is ForecastStatus.AVAILABLE
                    else None
                ),
                direction_threshold_pp=float(
                    _required_number(run.configuration, "direction_threshold_pp")
                ),
                direction_threshold_version=_required_str(
                    run.configuration, "direction_threshold_version"
                ),
                forecast_run_id=str(run.id),
                selected_model_key=(
                    run.model_key
                    if quality.forecast_status is ForecastStatus.AVAILABLE
                    else None
                ),
                selected_model_version=(
                    run.model_version
                    if quality.forecast_status is ForecastStatus.AVAILABLE
                    else None
                ),
                data_quality=quality.data_quality,
                historical_skill=quality.historical_skill,
                quality_skill=quality,
                baselines=baselines,
                recent_performance=None,
                evidence=evidence,
                warnings=tuple(_required_str_list(details, "warnings")),
                limitations=tuple(_required_str_list(details, "limitations")),
                mode=mode,
            )


def _baseline_outputs(
    history: WeeklyHistory, target: EpiWeek
) -> tuple[ModelPrediction | ModelEligibility, ...]:
    outputs: list[ModelPrediction | ModelEligibility] = []
    for factory in default_model_factories():
        model = factory.create()
        eligibility = model.eligibility(history, target)
        outputs.append(
            model.fit(history).predict_next(target)
            if eligibility.eligible
            else eligibility
        )
    return tuple(outputs)


def _complete_october_may_windows(rows: tuple[BacktestResultRow, ...]) -> int:
    by_season: dict[int, set[int]] = {}
    for row in rows:
        target_end = row.target_end
        season = target_end.year if target_end.month >= 10 else target_end.year - 1
        by_season.setdefault(season, set()).add(target_end.month)
    required = {10, 11, 12, 1, 2, 3, 4, 5}
    return sum(months >= required for months in by_season.values())


def _evidence(
    *,
    geography_id: str,
    latest: WeeklyPoint,
    source: object | None,
    baselines: tuple[ModelPrediction | ModelEligibility, ...],
    quality: QualitySkillAssessment,
    experimental: bool,
    metric: str,
) -> tuple[EvidenceItem, ...]:
    items: list[EvidenceItem] = [
        EvidenceItem(
            id=f"obs:{latest.observation_id}",
            kind="observation",
            rank=1,
            summary_template_key="latest_primary_observation",
            source_key=getattr(source, "key", None),
            source_name=getattr(source, "name", None),
            source_landing_page_url=getattr(source, "landing_page_url", None),
            geography_id=geography_id,
            metric=metric,
            value=latest.value,
            unit=TARGET_UNIT,
            observation_start=latest.epiweek.start_date(),
            observation_end=latest.observation_end,
            issued_at=latest.issue_at,
            retrieved_at=latest.retrieved_at,
            raw_snapshot_id=latest.raw_snapshot_id,
            observation_id=latest.observation_id,
            quality_flags=latest.quality_flags,
            details={"issue_identity": latest.issue_identity},
        )
    ]
    for index, baseline in enumerate(baselines, start=2):
        if isinstance(baseline, ModelPrediction):
            identifier = baseline.model_key
            details: JsonObject = {
                "model_version": baseline.model_version,
                "eligible": True,
                "clamped": baseline.clamped,
            }
            value = baseline.point_estimate
        else:
            identifier = f"ineligible-{index}"
            details = {
                "eligible": False,
                "reason": baseline.reason.value,
                "required_points": baseline.required_points,
                "available_points": baseline.available_points,
            }
            value = None
        items.append(
            EvidenceItem(
                id=f"baseline:{identifier}",
                kind="baseline",
                rank=index,
                summary_template_key="baseline_result",
                geography_id=geography_id,
                metric=metric,
                value=value,
                unit=TARGET_UNIT,
                details=details,
            )
        )
    if experimental:
        items.append(
            EvidenceItem(
                id="limitation:hsa-care-seeking-region",
                kind="limitation",
                rank=len(items) + 1,
                summary_template_key="hsa_care_seeking_region",
                geography_id=geography_id,
                details={"forecast_status": quality.forecast_status.value},
            )
        )
    return tuple(sorted(items, key=lambda item: (item.rank, item.id)))


def _required_str(values: Mapping[str, object], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"persisted assessment field {key} must be text")
    return value


def _required_int(values: Mapping[str, object], key: str) -> int:
    value = values.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"persisted assessment field {key} must be an integer")
    return value


def _required_number(values: Mapping[str, object], key: str) -> int | float:
    value = values.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"persisted assessment field {key} must be numeric")
    return value


def _required_str_list(values: Mapping[str, object], key: str) -> list[str]:
    value = values.get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"persisted assessment field {key} must be a text list")
    return value


def _warnings(quality: QualitySkillAssessment) -> tuple[str, ...]:
    messages = {
        "expected_week_missing": (
            "The expected prior-week NSSP release is unavailable; "
            "no current nowcast was issued."
        ),
        "stale_primary_target": (
            "The primary target is more than 21 days old; "
            "no current nowcast was issued."
        ),
        "point_forecast_not_calibrated": (
            "This point baseline does not provide calibrated probabilities."
        ),
    }
    return tuple(
        messages[reason.value] for reason in quality.reasons if reason.value in messages
    )


def _limitations(
    geography_type: GeographyType, disease: Disease
) -> tuple[str, ...]:
    disease_label = {
        Disease.INFLUENZA: "influenza",
        Disease.RSV: "RSV",
        Disease.COVID_19: "COVID-19",
    }[disease]
    common = (
        "This estimates the share of participating ED visits attributed to "
        f"{disease_label}, "
        "not individual risk or incidence.",
        "The 0.10 percentage-point direction threshold is an operational deadband, "
        "not CDC's trajectory method.",
    )
    if geography_type is GeographyType.HSA:
        return common + (
            "HSA values describe facilities in a care-seeking region, not residents "
            "of each repeated county label.",
        )
    return common
