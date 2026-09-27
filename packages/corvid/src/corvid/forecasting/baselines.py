from __future__ import annotations

from dataclasses import dataclass
from statistics import fmean

from corvid.forecasting.types import (
    EpiWeek,
    ModelEligibility,
    ModelEligibilityReason,
    ModelPrediction,
    WeeklyHistory,
    WeeklyPoint,
)


def _result(
    eligible: bool,
    reason: ModelEligibilityReason,
    required: int,
    available: int,
    detail: str | None = None,
) -> ModelEligibility:
    return ModelEligibility(eligible, reason, required, available, detail)


def _common_eligibility(
    history: WeeklyHistory, target: EpiWeek, required: int
) -> ModelEligibility | None:
    if history.unit != "percentage_points":
        return _result(
            False,
            ModelEligibilityReason.INCOMPATIBLE_UNIT,
            required,
            len(history.points),
        )
    if len(history.points) < required:
        return _result(
            False,
            ModelEligibilityReason.INSUFFICIENT_HISTORY,
            required,
            len(history.points),
        )
    if history.points[-1].epiweek.next() != target:
        return _result(
            False,
            ModelEligibilityReason.TARGET_NOT_NEXT_WEEK,
            required,
            len(history.points),
        )
    if history.points[-1].observation_end >= history.as_of.date():
        return _result(
            False,
            ModelEligibilityReason.INCOMPLETE_WEEK,
            required,
            len(history.points),
        )
    return None


def _is_consecutive(points: tuple[WeeklyPoint, ...]) -> bool:
    return all(
        previous.epiweek.next() == current.epiweek
        for previous, current in zip(points, points[1:], strict=False)
    )


def _clamp(value: float) -> tuple[float, bool]:
    clamped = min(100.0, max(0.0, value))
    return clamped, clamped != value


@dataclass(frozen=True, slots=True)
class _Fitted:
    key: str
    version: str
    history: WeeklyHistory
    window: int
    method: str
    prior_season_minimum: int = 40

    def predict_next(self, target: EpiWeek) -> ModelPrediction:
        inputs: tuple[WeeklyPoint, ...]
        if self.method == "no_change":
            inputs = (self.history.points[-1],)
            raw = inputs[-1].value
        elif self.method == "moving_average":
            inputs = self.history.points[-self.window :]
            raw = fmean(point.value for point in inputs)
        elif self.method == "linear_trend":
            inputs = self.history.points[-self.window :]
            values = tuple(point.value for point in inputs)
            mean_x = (len(values) - 1) / 2
            mean_y = fmean(values)
            denominator = sum((index - mean_x) ** 2 for index in range(len(values)))
            slope = (
                sum(
                    (index - mean_x) * (value - mean_y)
                    for index, value in enumerate(values)
                )
                / denominator
            )
            intercept = mean_y - slope * mean_x
            raw = intercept + slope * len(values)
        elif self.method == "seasonal_naive":
            prior = EpiWeek(target.year - 1, target.week)
            inputs = tuple(
                point for point in self.history.points if point.epiweek == prior
            )
            if not inputs:
                raise ValueError("seasonal-naive target is no longer eligible")
            raw = inputs[0].value
        else:
            raise AssertionError(f"unknown baseline method: {self.method}")
        estimate, was_clamped = _clamp(raw)
        return ModelPrediction(
            model_key=self.key,
            model_version=self.version,
            target_epiweek=target,
            point_estimate=estimate,
            training_end_epiweek=self.history.points[-1].epiweek,
            input_observation_ids=tuple(point.observation_id for point in inputs),
            unclamped_estimate=raw if was_clamped else None,
            clamped=was_clamped,
        )


@dataclass(frozen=True, slots=True)
class NoChange:
    key = "no_change"
    version = "v1"

    def create(self) -> NoChange:
        return type(self)()

    def eligibility(self, history: WeeklyHistory, target: EpiWeek) -> ModelEligibility:
        common = _common_eligibility(history, target, 1)
        return common or _result(
            True, ModelEligibilityReason.ELIGIBLE, 1, len(history.points)
        )

    def fit(self, history: WeeklyHistory) -> _Fitted:
        return _Fitted(self.key, self.version, history, 1, "no_change")


@dataclass(frozen=True, slots=True)
class MovingAverage:
    window: int = 4
    key = "moving_average"
    version = "v1"

    def __post_init__(self) -> None:
        if self.window < 2:
            raise ValueError("moving-average window must be at least two")

    def create(self) -> MovingAverage:
        return type(self)(self.window)

    def eligibility(self, history: WeeklyHistory, target: EpiWeek) -> ModelEligibility:
        common = _common_eligibility(history, target, self.window)
        if common is not None:
            return common
        window = history.points[-self.window :]
        if not _is_consecutive(window):
            return _result(
                False,
                ModelEligibilityReason.MISSING_CONTIGUOUS_WEEKS,
                self.window,
                len(history.points),
            )
        return _result(
            True, ModelEligibilityReason.ELIGIBLE, self.window, len(history.points)
        )

    def fit(self, history: WeeklyHistory) -> _Fitted:
        return _Fitted(self.key, self.version, history, self.window, "moving_average")


@dataclass(frozen=True, slots=True)
class LinearTrend:
    window: int = 8
    key = "linear_trend_ols"
    version = "v1"

    def __post_init__(self) -> None:
        if self.window < 2:
            raise ValueError("linear-trend window must be at least two")

    def create(self) -> LinearTrend:
        return type(self)(self.window)

    def eligibility(self, history: WeeklyHistory, target: EpiWeek) -> ModelEligibility:
        common = _common_eligibility(history, target, self.window)
        if common is not None:
            return common
        window = history.points[-self.window :]
        if not _is_consecutive(window):
            return _result(
                False,
                ModelEligibilityReason.MISSING_CONTIGUOUS_WEEKS,
                self.window,
                len(history.points),
            )
        return _result(
            True, ModelEligibilityReason.ELIGIBLE, self.window, len(history.points)
        )

    def fit(self, history: WeeklyHistory) -> _Fitted:
        return _Fitted(self.key, self.version, history, self.window, "linear_trend")


@dataclass(frozen=True, slots=True)
class SeasonalNaive:
    minimum_prior_season_points: int = 40
    key = "seasonal_naive"
    version = "v1"

    def __post_init__(self) -> None:
        if self.minimum_prior_season_points < 1:
            raise ValueError("prior-season minimum must be positive")

    def create(self) -> SeasonalNaive:
        return type(self)(self.minimum_prior_season_points)

    def eligibility(self, history: WeeklyHistory, target: EpiWeek) -> ModelEligibility:
        common = _common_eligibility(history, target, 1)
        if common is not None:
            return common
        try:
            prior_epiweek = EpiWeek(target.year - 1, target.week)
        except ValueError:
            return _result(
                False,
                ModelEligibilityReason.MISSING_PRIOR_SEASON_WEEK,
                self.minimum_prior_season_points,
                len(history.points),
                "the previous MMWR year has no matching week 53",
            )
        prior_season = target.season_start_year - 1
        season_points = tuple(
            point
            for point in history.points
            if point.epiweek.season_start_year == prior_season
        )
        if len(season_points) < self.minimum_prior_season_points:
            return _result(
                False,
                ModelEligibilityReason.INSUFFICIENT_PRIOR_SEASON_COVERAGE,
                self.minimum_prior_season_points,
                len(season_points),
            )
        if not any(point.epiweek == prior_epiweek for point in season_points):
            return _result(
                False,
                ModelEligibilityReason.MISSING_PRIOR_SEASON_WEEK,
                self.minimum_prior_season_points,
                len(season_points),
            )
        return _result(
            True,
            ModelEligibilityReason.ELIGIBLE,
            self.minimum_prior_season_points,
            len(season_points),
        )

    def fit(self, history: WeeklyHistory) -> _Fitted:
        return _Fitted(
            self.key,
            self.version,
            history,
            1,
            "seasonal_naive",
            self.minimum_prior_season_points,
        )


def default_model_factories() -> tuple[
    NoChange, MovingAverage, SeasonalNaive, LinearTrend
]:
    return (NoChange(), MovingAverage(), SeasonalNaive(), LinearTrend())
