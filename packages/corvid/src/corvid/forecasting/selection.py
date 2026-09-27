from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from corvid.forecasting.backtest import BacktestPrediction
from corvid.forecasting.metrics import ModelMetrics, calculate_metrics


@dataclass(frozen=True, slots=True)
class ChallengerResult:
    model_key: str
    model_version: str
    metrics: ModelMetrics


@dataclass(frozen=True, slots=True)
class ModelSelection:
    selected_model_key: str
    selected_model_version: str
    selection_as_of: datetime
    scoring_window_origins: int
    selected_metrics: ModelMetrics
    fallback_to_no_change: bool
    rationale_codes: tuple[str, ...]
    challengers: tuple[ChallengerResult, ...]


def select_model(
    predictions: tuple[BacktestPrediction, ...], selection_as_of: datetime
) -> ModelSelection:


    if selection_as_of.tzinfo is None or selection_as_of.utcoffset() is None:
        raise ValueError("selection_as_of must be timezone-aware")
    prior = tuple(
        prediction
        for prediction in predictions
        if prediction.origin_as_of < selection_as_of
    )
    no_change = tuple(
        prediction for prediction in prior if prediction.model_key == "no_change"
    )
    if not no_change:
        raise ValueError("selection requires prior frozen no-change evaluations")
    by_model: dict[tuple[str, str], list[BacktestPrediction]] = {}
    for prediction in prior:
        if prediction.model_key != "no_change":
            by_model.setdefault(
                (prediction.model_key, prediction.model_version), []
            ).append(prediction)
    challengers = tuple(
        ChallengerResult(
            model_key=key,
            model_version=version,
            metrics=calculate_metrics(tuple(rows), no_change),
        )
        for (key, version), rows in sorted(by_model.items())
    )
    return ModelSelection(
        selected_model_key="no_change",
        selected_model_version="v1",
        selection_as_of=selection_as_of,
        scoring_window_origins=len(no_change),
        selected_metrics=calculate_metrics(no_change, no_change),
        fallback_to_no_change=False,
        rationale_codes=(
            "fixed_mvp_champion",
            "challengers_retrospective_only",
            "selection_uses_frozen_rolling_origin_oos_mae",
        ),
        challengers=challengers,
    )
