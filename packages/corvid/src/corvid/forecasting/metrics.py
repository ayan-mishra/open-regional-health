from __future__ import annotations

from dataclasses import dataclass
from math import sqrt
from statistics import fmean, median

from corvid.domain.enums import Direction
from corvid.forecasting.backtest import BacktestPrediction


@dataclass(frozen=True, slots=True)
class DirectionMetrics:
    n_scored: int
    accuracy: float | None
    precision: dict[Direction, float | None]
    recall: dict[Direction, float | None]
    support: dict[Direction, int]
    prevalence: dict[Direction, float | None]
    confusion_matrix: dict[Direction, dict[Direction, int]]
    balanced_accuracy: float | None
    macro_f1: float | None


@dataclass(frozen=True, slots=True)
class ModelMetrics:
    n_scored: int
    mae_pp: float | None
    rmse_pp: float | None
    mean_error_pp: float | None
    median_absolute_error_pp: float | None
    direction: DirectionMetrics
    brier_score: None
    no_change_mae_delta_pp: float | None = None
    no_change_mae_improvement_ratio: float | None = None
    relative_mae_vs_no_change: float | None = None
    october_may_direction: DirectionMetrics | None = None
    june_september_direction: DirectionMetrics | None = None


def direction_metrics(predictions: tuple[BacktestPrediction, ...]) -> DirectionMetrics:
    classes = tuple(Direction)
    confusion = {
        observed: {predicted: 0 for predicted in classes} for observed in classes
    }
    for prediction in predictions:
        confusion[prediction.observed_direction][prediction.predicted_direction] += 1
    count = len(predictions)
    support = {direction: sum(confusion[direction].values()) for direction in classes}
    precision: dict[Direction, float | None] = {}
    recall: dict[Direction, float | None] = {}
    f1_values: list[float] = []
    for direction in classes:
        true_positive = confusion[direction][direction]
        predicted_count = sum(confusion[actual][direction] for actual in classes)
        precision[direction] = (
            true_positive / predicted_count if predicted_count else None
        )
        recall[direction] = (
            true_positive / support[direction] if support[direction] else None
        )
        precision_value = precision[direction]
        recall_value = recall[direction]
        if precision_value is not None and recall_value is not None:
            denominator = precision_value + recall_value
            f1_values.append(
                2 * precision_value * recall_value / denominator if denominator else 0.0
            )
    defined_recalls = [value for value in recall.values() if value is not None]
    correct = sum(confusion[direction][direction] for direction in classes)
    return DirectionMetrics(
        n_scored=count,
        accuracy=correct / count if count else None,
        precision=precision,
        recall=recall,
        support=support,
        prevalence={
            direction: support[direction] / count if count else None
            for direction in classes
        },
        confusion_matrix=confusion,
        balanced_accuracy=fmean(defined_recalls) if defined_recalls else None,
        macro_f1=fmean(f1_values) if f1_values else None,
    )


def calculate_metrics(
    predictions: tuple[BacktestPrediction, ...],
    no_change_predictions: tuple[BacktestPrediction, ...] = (),
) -> ModelMetrics:


    errors = tuple(
        prediction.point_prediction - prediction.observed_value
        for prediction in predictions
    )
    candidate_by_origin = {
        (prediction.origin_as_of, prediction.target_epiweek): prediction
        for prediction in predictions
    }
    no_change_by_origin = {
        (prediction.origin_as_of, prediction.target_epiweek): prediction
        for prediction in no_change_predictions
    }
    common = tuple(sorted(candidate_by_origin.keys() & no_change_by_origin.keys()))
    candidate_mae = (
        fmean(candidate_by_origin[key].absolute_error for key in common)
        if common
        else None
    )
    baseline_mae = (
        fmean(no_change_by_origin[key].absolute_error for key in common)
        if common
        else None
    )
    delta = (
        baseline_mae - candidate_mae
        if baseline_mae is not None and candidate_mae is not None
        else None
    )
    improvement = (
        delta / baseline_mae
        if delta is not None and baseline_mae not in (None, 0.0)
        else None
    )
    winter = tuple(
        prediction
        for prediction in predictions
        if prediction.target_epiweek.end_date().month in {10, 11, 12, 1, 2, 3, 4, 5}
    )
    summer = tuple(prediction for prediction in predictions if prediction not in winter)
    return ModelMetrics(
        n_scored=len(predictions),
        mae_pp=fmean(abs(error) for error in errors) if errors else None,
        rmse_pp=sqrt(fmean(error * error for error in errors)) if errors else None,
        mean_error_pp=fmean(errors) if errors else None,
        median_absolute_error_pp=median(abs(error) for error in errors)
        if errors
        else None,
        direction=direction_metrics(predictions),
        brier_score=None,
        no_change_mae_delta_pp=delta,
        no_change_mae_improvement_ratio=improvement,
        relative_mae_vs_no_change=(
            candidate_mae / baseline_mae
            if candidate_mae is not None and baseline_mae not in (None, 0.0)
            else None
        ),
        october_may_direction=direction_metrics(winter),
        june_september_direction=direction_metrics(summer),
    )
