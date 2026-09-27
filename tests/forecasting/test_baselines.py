from datetime import UTC, datetime

import pytest
from corvid.forecasting.baselines import (
    LinearTrend,
    MovingAverage,
    NoChange,
    SeasonalNaive,
)
from corvid.forecasting.types import EpiWeek, ModelEligibilityReason, WeeklyHistory


def test_no_change_predicts_latest_value(history_factory):
    history = history_factory([1.0, 1.4])
    target = history.points[-1].epiweek.next()
    model = NoChange()
    assert model.eligibility(history, target).eligible
    assert model.fit(history).predict_next(target).point_estimate == 1.4


def test_moving_average_requires_consecutive_weeks(history_factory):
    history = history_factory([1.0, 2.0, 3.0, 4.0])
    broken = WeeklyHistory(
        geography_id=history.geography_id,
        metric=history.metric,
        unit=history.unit,
        as_of=history.as_of,
        points=(history.points[0], history.points[1], history.points[3]),
    )
    eligibility = MovingAverage(window=3).eligibility(
        broken, broken.points[-1].epiweek.next()
    )
    assert eligibility.reason is ModelEligibilityReason.MISSING_CONTIGUOUS_WEEKS


def test_linear_trend_clamps_to_physical_upper_bound(history_factory):
    history = history_factory([93, 94, 95, 96, 97, 98, 99, 100])
    target = history.points[-1].epiweek.next()
    prediction = LinearTrend().fit(history).predict_next(target)
    assert prediction.point_estimate == 100
    assert prediction.unclamped_estimate == pytest.approx(101)
    assert prediction.clamped


def test_seasonal_naive_requires_40_prior_season_points(history_factory):
    history = history_factory([1.0] * 20)
    target = history.points[-1].epiweek.next()
    eligibility = SeasonalNaive().eligibility(history, target)
    assert (
        eligibility.reason is ModelEligibilityReason.INSUFFICIENT_PRIOR_SEASON_COVERAGE
    )


def test_week_53_has_no_fabricated_prior_week_fallback(history_factory):
    history = history_factory(
        [1.0],
        first_end=EpiWeek(2025, 52).end_date(),
        as_of=datetime(2025, 12, 30, tzinfo=UTC),
    )
    eligibility = SeasonalNaive(minimum_prior_season_points=1).eligibility(
        history, EpiWeek(2025, 53)
    )
    assert eligibility.reason is ModelEligibilityReason.MISSING_PRIOR_SEASON_WEEK


def test_target_must_follow_latest_input_week(history_factory):
    history = history_factory([1.0, 1.1])
    future = history.points[-1].epiweek.next().next()
    assert (
        NoChange().eligibility(history, future).reason
        is ModelEligibilityReason.TARGET_NOT_NEXT_WEEK
    )
