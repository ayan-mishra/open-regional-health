from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from enum import StrEnum
from math import isfinite
from typing import Literal, Protocol, Self

from corvid.domain.enums import Disease, QualityFlag


def _require_utc(value: datetime, name: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
    if value.utcoffset() != timedelta(0):
        raise ValueError(f"{name} must be normalized to UTC")


def _week_one_start(year: int) -> date:


    january_fourth = date(year, 1, 4)
    days_since_sunday = (january_fourth.weekday() + 1) % 7
    return january_fourth - timedelta(days=days_since_sunday)


@dataclass(frozen=True, slots=True, order=True)
class EpiWeek:


    year: int
    week: int

    def __post_init__(self) -> None:
        if not 1 <= self.week <= self.weeks_in_year(self.year):
            raise ValueError(f"invalid MMWR week {self.year}-W{self.week:02d}")

    @staticmethod
    def weeks_in_year(year: int) -> int:
        return (_week_one_start(year + 1) - _week_one_start(year)).days // 7

    @classmethod
    def from_date(cls, value: date) -> Self:
        year = value.year
        if value < _week_one_start(year):
            year -= 1
        elif value >= _week_one_start(year + 1):
            year += 1
        week = ((value - _week_one_start(year)).days // 7) + 1
        return cls(year, week)

    @classmethod
    def from_end_date(cls, saturday: date) -> Self:
        if saturday.weekday() != 5:
            raise ValueError("MMWR observation end must be a Saturday")
        return cls.from_date(saturday)

    def start_date(self) -> date:
        return _week_one_start(self.year) + timedelta(weeks=self.week - 1)

    def end_date(self) -> date:
        return self.start_date() + timedelta(days=6)

    def next(self) -> Self:
        return type(self).from_date(self.end_date() + timedelta(days=1))

    def previous(self) -> Self:
        return type(self).from_date(self.start_date() - timedelta(days=1))

    @property
    def season_start_year(self) -> int:
        return (
            self.end_date().year
            if self.end_date().month >= 7
            else self.end_date().year - 1
        )


@dataclass(frozen=True, slots=True)
class WeeklyPoint:
    epiweek: EpiWeek
    value: float
    observation_id: int
    observation_end: date
    issue_at: datetime | None
    retrieved_at: datetime
    quality_flags: tuple[QualityFlag, ...] = ()
    reporting_coverage: float | None = None
    availability_at: datetime | None = None
    issue_identity: str = ""
    raw_snapshot_id: int | None = None
    authentic_vintage: bool = False

    def __post_init__(self) -> None:
        if not isfinite(self.value):
            raise ValueError("weekly values must be finite")
        if self.observation_end != self.epiweek.end_date():
            raise ValueError("observation_end must equal the MMWR week end")
        _require_utc(self.retrieved_at, "retrieved_at")
        if self.issue_at is not None:
            _require_utc(self.issue_at, "issue_at")
        if self.availability_at is not None:
            _require_utc(self.availability_at, "availability_at")
        if (
            self.reporting_coverage is not None
            and not 0 <= self.reporting_coverage <= 1
        ):
            raise ValueError("reporting_coverage must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class WeeklyHistory:
    geography_id: str
    metric: str
    unit: Literal["percentage_points"]
    as_of: datetime
    points: tuple[WeeklyPoint, ...]

    def __post_init__(self) -> None:
        _require_utc(self.as_of, "as_of")
        epiweeks = tuple(point.epiweek for point in self.points)
        if epiweeks != tuple(sorted(epiweeks)):
            raise ValueError("weekly points must be strictly ascending")
        if len(epiweeks) != len(set(epiweeks)):
            raise ValueError("weekly points must have unique epiweeks")
        if any(
            point.availability_at is not None and point.availability_at > self.as_of
            for point in self.points
        ):
            raise ValueError("history cannot contain observations unavailable at as_of")


class ModelEligibilityReason(StrEnum):
    ELIGIBLE = "eligible"
    INSUFFICIENT_HISTORY = "insufficient_history"
    MISSING_CONTIGUOUS_WEEKS = "missing_contiguous_weeks"
    MISSING_PRIOR_SEASON_WEEK = "missing_prior_season_week"
    INSUFFICIENT_PRIOR_SEASON_COVERAGE = "insufficient_prior_season_coverage"
    NONFINITE_VALUE = "nonfinite_value"
    INCOMPATIBLE_UNIT = "incompatible_unit"
    TARGET_NOT_NEXT_WEEK = "target_not_next_week"
    INCOMPLETE_WEEK = "incomplete_week"
    UNKNOWN_AVAILABILITY = "unknown_availability"


@dataclass(frozen=True, slots=True)
class ModelEligibility:
    eligible: bool
    reason: ModelEligibilityReason
    required_points: int
    available_points: int
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class ModelPrediction:
    model_key: str
    model_version: str
    target_epiweek: EpiWeek
    point_estimate: float
    training_end_epiweek: EpiWeek
    input_observation_ids: tuple[int, ...]
    unclamped_estimate: float | None = None
    clamped: bool = False


class FittedForecastModel(Protocol):
    key: str
    version: str

    def predict_next(self, target: EpiWeek) -> ModelPrediction: ...


class ForecastModel(Protocol):
    key: str
    version: str

    def eligibility(
        self, history: WeeklyHistory, target: EpiWeek
    ) -> ModelEligibility: ...

    def fit(self, history: WeeklyHistory) -> FittedForecastModel: ...


class ForecastModelFactory(Protocol):
    key: str
    version: str

    def create(self) -> ForecastModel: ...


@dataclass(frozen=True, slots=True)
class KnowledgeSetRequest:
    geography_id: str
    metric: str
    source_key: str
    as_of: datetime
    unit: Literal["percentage_points"] = "percentage_points"
    include_quality_flags: tuple[QualityFlag, ...] = ()
    excluded_quality_flags: tuple[QualityFlag, ...] = (
        QualityFlag.STALE,
        QualityFlag.INCOMPLETE_COVERAGE,
        QualityFlag.MISSING_COVERAGE,
        QualityFlag.VOLUNTARY_REPORTING,
    )
    require_authentic_vintage: bool = True
    disease: Disease = Disease.INFLUENZA

    def __post_init__(self) -> None:
        _require_utc(self.as_of, "as_of")


@dataclass(frozen=True, slots=True)
class SelectedObservation:
    observation: WeeklyPoint
    availability_at: datetime
    raw_snapshot_id: int | None
    issue_identity: str


@dataclass(frozen=True, slots=True)
class EvaluationTargetPolicy:
    key: str = "nssp-fixed-lag-56d-v1"
    revision_freeze_days: int = 56

    def evaluation_as_of(self, target: EpiWeek) -> datetime:
        return datetime.combine(
            target.end_date() + timedelta(days=self.revision_freeze_days),
            time(23, 59, 59),
            tzinfo=UTC,
        )
