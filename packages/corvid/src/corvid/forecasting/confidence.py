from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from enum import StrEnum
from zoneinfo import ZoneInfo

from corvid.domain.enums import GeographyType, QualityFlag
from corvid.forecasting.types import EpiWeek, WeeklyPoint

PUBLICATION_ZONE = ZoneInfo("America/New_York")
PUBLICATION_TIME = time(18, 0)


class ForecastStatus(StrEnum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"


class DataQuality(StrEnum):
    ADEQUATE = "adequate"
    LIMITED = "limited"
    UNKNOWN = "unknown"


class HistoricalSkill(StrEnum):
    UNESTABLISHED = "unestablished"
    NOT_BETTER_THAN_NO_CHANGE = "not_better_than_no_change"
    BETTER_THAN_NO_CHANGE = "better_than_no_change"


class QualityReason(StrEnum):
    EXPECTED_WEEK_MISSING = "expected_week_missing"
    STALE_PRIMARY_TARGET = "stale_primary_target"
    MISSING_COVERAGE = "missing_coverage"
    INSUFFICIENT_COVERAGE = "insufficient_coverage"
    SPARSE_HSA = "sparse_hsa"
    MISSING_AUTHENTIC_VINTAGES = "missing_authentic_vintages"
    INSUFFICIENT_HSA_PERFORMANCE = "insufficient_hsa_performance"
    EXPERIMENTAL_HSA_LIMIT = "experimental_hsa_limit"
    POINT_FORECAST_NOT_CALIBRATED = "point_forecast_not_calibrated"


@dataclass(frozen=True, slots=True)
class PublicationTarget:
    scheduled_origin: datetime
    reference_date: date
    target_epiweek: EpiWeek
    horizon: int = 0
    label: str = "current-week nowcast"


def publication_target(as_of: datetime) -> PublicationTarget:


    if as_of.tzinfo is None or as_of.utcoffset() is None:
        raise ValueError("as_of must be timezone-aware")
    local = as_of.astimezone(PUBLICATION_ZONE)
    days_since_friday = (local.weekday() - 4) % 7
    friday = local.date() - timedelta(days=days_since_friday)
    scheduled_local = datetime.combine(friday, PUBLICATION_TIME, PUBLICATION_ZONE)
    if local < scheduled_local:
        friday -= timedelta(days=7)
        scheduled_local = datetime.combine(friday, PUBLICATION_TIME, PUBLICATION_ZONE)
    reference_date = friday + timedelta(days=1)
    return PublicationTarget(
        scheduled_origin=scheduled_local.astimezone(ZoneInfo("UTC")),
        reference_date=reference_date,
        target_epiweek=EpiWeek.from_end_date(reference_date),
    )


@dataclass(frozen=True, slots=True)
class QualitySkillInput:
    geography_type: GeographyType
    latest_observation: WeeklyPoint | None
    expected_input_epiweek: EpiWeek
    as_of: datetime
    sparse: bool = False
    authentic_vintages: bool = False
    paired_valid_origins: int = 0
    complete_october_may_windows: int = 0
    skill_lower_bound_positive: bool = False
    minimum_hsa_coverage: float = 0.30
    stale_after_days: int = 21


@dataclass(frozen=True, slots=True)
class QualitySkillAssessment:
    policy_key: str
    forecast_status: ForecastStatus
    data_quality: DataQuality
    historical_skill: HistoricalSkill
    reasons: tuple[QualityReason, ...]
    paired_valid_origins: int
    complete_october_may_windows: int


def assess_quality_and_skill(value: QualitySkillInput) -> QualitySkillAssessment:


    reasons: list[QualityReason] = [QualityReason.POINT_FORECAST_NOT_CALIBRATED]
    latest = value.latest_observation
    if latest is None or latest.epiweek != value.expected_input_epiweek:
        reasons.append(QualityReason.EXPECTED_WEEK_MISSING)
    if latest is not None:
        age_days = (value.as_of.date() - latest.observation_end).days
        if age_days > value.stale_after_days:
            reasons.append(QualityReason.STALE_PRIMARY_TARGET)
    else:
        age_days = value.stale_after_days + 1

    hsa_ineligible = False
    if value.geography_type is GeographyType.HSA:
        reasons.append(QualityReason.EXPERIMENTAL_HSA_LIMIT)


        hsa_ineligible = True
        if not value.authentic_vintages:
            reasons.append(QualityReason.MISSING_AUTHENTIC_VINTAGES)
        if value.sparse or (
            latest is not None and QualityFlag.SPARSE in latest.quality_flags
        ):
            reasons.append(QualityReason.SPARSE_HSA)
        coverage = latest.reporting_coverage if latest is not None else None
        if coverage is None:
            reasons.append(QualityReason.MISSING_COVERAGE)
        elif coverage < value.minimum_hsa_coverage:
            reasons.append(QualityReason.INSUFFICIENT_COVERAGE)
        if value.paired_valid_origins < 52 or value.complete_october_may_windows < 2:
            reasons.append(QualityReason.INSUFFICIENT_HSA_PERFORMANCE)

    unavailable = (
        latest is None
        or latest.epiweek != value.expected_input_epiweek
        or age_days > value.stale_after_days
        or hsa_ineligible
    )
    coverage = latest.reporting_coverage if latest is not None else None
    if unavailable:
        status = ForecastStatus.UNAVAILABLE
        quality = DataQuality.UNKNOWN if latest is None else DataQuality.LIMITED
    else:
        status = ForecastStatus.AVAILABLE
        quality = (
            DataQuality.LIMITED
            if value.geography_type is GeographyType.HSA or coverage is None
            else DataQuality.ADEQUATE
        )
        if coverage is None:
            reasons.append(QualityReason.MISSING_COVERAGE)

    if value.paired_valid_origins < 52 or value.complete_october_may_windows < 2:
        skill = HistoricalSkill.UNESTABLISHED
    elif value.skill_lower_bound_positive:
        skill = HistoricalSkill.BETTER_THAN_NO_CHANGE
    else:
        skill = HistoricalSkill.NOT_BETTER_THAN_NO_CHANGE
    return QualitySkillAssessment(
        policy_key="quality-skill-policy-v1",
        forecast_status=status,
        data_quality=quality,
        historical_skill=skill,
        reasons=tuple(dict.fromkeys(reasons)),
        paired_valid_origins=value.paired_valid_origins,
        complete_october_may_windows=value.complete_october_may_windows,
    )
