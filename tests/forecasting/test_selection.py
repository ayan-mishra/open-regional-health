from datetime import UTC, datetime

from corvid.domain.enums import Direction
from corvid.forecasting.backtest import BacktestPrediction
from corvid.forecasting.metrics import calculate_metrics
from corvid.forecasting.selection import select_model
from corvid.forecasting.types import EpiWeek, ModelEligibility, ModelEligibilityReason


def _prediction(model, prediction, observed, direction):
    week = EpiWeek(2025, 5)
    error = prediction - observed
    eligibility = ModelEligibility(True, ModelEligibilityReason.ELIGIBLE, 1, 10)
    return BacktestPrediction(
        model_key=model,
        model_version="v1",
        geography_id="ma",
        metric="ed_visit_percent",
        origin_as_of=datetime(2025, 1, 31, tzinfo=UTC),
        training_end_epiweek=week.previous(),
        target_epiweek=week,
        current_value_at_origin=1.0,
        point_prediction=prediction,
        predicted_direction=direction,
        observed_value=observed,
        observed_direction=Direction.RISING,
        fixed_lag_trajectory_direction=Direction.RISING,
        absolute_error=abs(error),
        squared_error=error * error,
        direction_correct=direction is Direction.RISING,
        fixed_lag_trajectory_correct=direction is Direction.RISING,
        knowledge_observation_ids=(1,),
        evaluation_policy_key="nssp-fixed-lag-56d-v1",
        evaluation_as_of=datetime(2025, 4, 1, tzinfo=UTC),
        evaluation_observation_id=2,
        evaluation_issue_identity="fixed",
        model_eligibility=eligibility,
        direction_threshold_pp=0.1,
    )


def test_point_metrics_never_compute_brier_and_preserve_null_denominators():
    prediction = _prediction("no_change", 1.0, 1.2, Direction.STABLE)
    metrics = calculate_metrics((prediction,))
    assert metrics.brier_score is None
    assert metrics.direction.precision[Direction.RISING] is None
    assert metrics.direction.support[Direction.RISING] == 1


def test_mvp_selection_keeps_no_change_even_when_challenger_mae_is_lower():
    no_change = _prediction("no_change", 1.0, 1.2, Direction.STABLE)
    challenger = _prediction("linear_trend_ols", 1.19, 1.2, Direction.RISING)
    selection = select_model((no_change, challenger), datetime(2025, 2, 1, tzinfo=UTC))
    assert selection.selected_model_key == "no_change"
    assert "challengers_retrospective_only" in selection.rationale_codes
