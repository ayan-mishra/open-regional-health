from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Protocol

from corvid.domain.enums import Direction, Disease
from corvid.forecasting.directions import classify_direction
from corvid.forecasting.types import (
    EpiWeek,
    EvaluationTargetPolicy,
    ForecastModelFactory,
    KnowledgeSetRequest,
    ModelEligibility,
    SelectedObservation,
    WeeklyHistory,
)


class KnowledgeRepository(Protocol):
    def observations_as_known_at(
        self, request: KnowledgeSetRequest
    ) -> tuple[SelectedObservation, ...]: ...


@dataclass(frozen=True, slots=True)
class ForecastOrigin:
    as_of: datetime
    expected_target: EpiWeek

    def __post_init__(self) -> None:
        if self.as_of.tzinfo is None or self.as_of.utcoffset() is None:
            raise ValueError("origin as_of must be timezone-aware")
        if self.as_of.utcoffset() != UTC.utcoffset(self.as_of):
            raise ValueError("origin as_of must be normalized to UTC")


@dataclass(frozen=True, slots=True)
class BacktestPrediction:
    model_key: str
    model_version: str
    geography_id: str
    metric: str
    origin_as_of: datetime
    training_end_epiweek: EpiWeek
    target_epiweek: EpiWeek
    current_value_at_origin: float
    point_prediction: float
    predicted_direction: Direction
    observed_value: float
    observed_direction: Direction
    fixed_lag_trajectory_direction: Direction
    absolute_error: float
    squared_error: float
    direction_correct: bool
    fixed_lag_trajectory_correct: bool
    knowledge_observation_ids: tuple[int, ...]
    evaluation_policy_key: str
    evaluation_as_of: datetime
    evaluation_observation_id: int
    evaluation_issue_identity: str
    model_eligibility: ModelEligibility
    direction_threshold_pp: float
    disease: Disease = Disease.INFLUENZA
    direction_threshold_version: str = "direction-threshold-v1"


class Backtester:


    def __init__(self, repository: KnowledgeRepository) -> None:
        self._repository = repository

    def knowledge_set(self, request: KnowledgeSetRequest) -> WeeklyHistory:
        selected = self._repository.observations_as_known_at(request)
        return WeeklyHistory(
            geography_id=request.geography_id,
            metric=request.metric,
            unit=request.unit,
            as_of=request.as_of,
            points=tuple(item.observation for item in selected),
        )

    def run(
        self,
        factories: Sequence[ForecastModelFactory],
        request: KnowledgeSetRequest,
        origins: Sequence[ForecastOrigin],
        direction_threshold_pp: float = 0.10,
        evaluation_policy: EvaluationTargetPolicy | None = None,
    ) -> tuple[BacktestPrediction, ...]:
        evaluation_policy = evaluation_policy or EvaluationTargetPolicy()
        if tuple(origins) != tuple(sorted(origins, key=lambda origin: origin.as_of)):
            raise ValueError("rolling origins must be chronological")
        results: list[BacktestPrediction] = []
        for origin in origins:
            origin_request = replace(request, as_of=origin.as_of)
            history = self.knowledge_set(origin_request)
            if not history.points:
                continue
            if history.points[-1].epiweek != origin.expected_target.previous():
                continue
            evaluation_as_of = evaluation_policy.evaluation_as_of(
                origin.expected_target
            )
            evaluation_request = replace(request, as_of=evaluation_as_of)
            evaluation = self._repository.observations_as_known_at(evaluation_request)
            evaluation_by_week = {item.observation.epiweek: item for item in evaluation}
            target_truth = evaluation_by_week.get(origin.expected_target)
            revised_current = evaluation_by_week.get(origin.expected_target.previous())
            if target_truth is None or revised_current is None:
                continue
            current_value = history.points[-1].value
            observed_value = target_truth.observation.value
            issued_observed_direction = classify_direction(
                current_value, observed_value, direction_threshold_pp
            )
            fixed_lag_direction = classify_direction(
                revised_current.observation.value,
                observed_value,
                direction_threshold_pp,
            )
            for factory in factories:
                model = factory.create()
                eligibility = model.eligibility(history, origin.expected_target)
                if not eligibility.eligible:
                    continue
                prediction = model.fit(history).predict_next(origin.expected_target)
                predicted_direction = classify_direction(
                    current_value,
                    prediction.point_estimate,
                    direction_threshold_pp,
                )
                error = prediction.point_estimate - observed_value
                results.append(
                    BacktestPrediction(
                        model_key=prediction.model_key,
                        model_version=prediction.model_version,
                        geography_id=request.geography_id,
                        metric=request.metric,
                        disease=request.disease,
                        origin_as_of=origin.as_of,
                        training_end_epiweek=prediction.training_end_epiweek,
                        target_epiweek=origin.expected_target,
                        current_value_at_origin=current_value,
                        point_prediction=prediction.point_estimate,
                        predicted_direction=predicted_direction,
                        observed_value=observed_value,
                        observed_direction=issued_observed_direction,
                        fixed_lag_trajectory_direction=fixed_lag_direction,
                        absolute_error=abs(error),
                        squared_error=error * error,
                        direction_correct=predicted_direction
                        is issued_observed_direction,
                        fixed_lag_trajectory_correct=predicted_direction
                        is fixed_lag_direction,
                        knowledge_observation_ids=prediction.input_observation_ids,
                        evaluation_policy_key=evaluation_policy.key,
                        evaluation_as_of=evaluation_as_of,
                        evaluation_observation_id=target_truth.observation.observation_id,
                        evaluation_issue_identity=target_truth.issue_identity,
                        model_eligibility=eligibility,
                        direction_threshold_pp=direction_threshold_pp,
                    )
                )
        return tuple(results)
