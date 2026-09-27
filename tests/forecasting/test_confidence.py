from datetime import UTC, datetime

from corvid.domain.enums import GeographyType, QualityFlag
from corvid.forecasting.confidence import (
    DataQuality,
    ForecastStatus,
    QualityReason,
    QualitySkillInput,
    assess_quality_and_skill,
    publication_target,
)
from corvid.forecasting.types import EpiWeek, WeeklyPoint


def _point(*, coverage=0.9, authentic=True, sparse=False):
    epiweek = EpiWeek.from_end_date(
        publication_target(ORIGIN).reference_date
    ).previous()
    return WeeklyPoint(
        epiweek=epiweek,
        value=2.0,
        observation_id=1,
        observation_end=epiweek.end_date(),
        issue_at=None,
        retrieved_at=ORIGIN,
        quality_flags=(QualityFlag.SPARSE,) if sparse else (),
        reporting_coverage=coverage,
        authentic_vintage=authentic,
    )


ORIGIN = datetime(2025, 2, 14, 23, tzinfo=UTC)


def test_friday_publication_is_current_week_horizon_zero():
    target = publication_target(ORIGIN)
    assert target.reference_date.isoformat() == "2025-02-15"
    assert target.target_epiweek.end_date() == target.reference_date
    assert target.horizon == 0
    assert target.label == "current-week nowcast"


def test_hsa_requires_vintages_coverage_sparsity_and_performance():
    latest = _point(coverage=None, authentic=False, sparse=True)
    result = assess_quality_and_skill(
        QualitySkillInput(
            geography_type=GeographyType.HSA,
            latest_observation=latest,
            expected_input_epiweek=latest.epiweek,
            as_of=ORIGIN,
        )
    )
    assert result.forecast_status is ForecastStatus.UNAVAILABLE
    assert QualityReason.MISSING_AUTHENTIC_VINTAGES in result.reasons
    assert QualityReason.SPARSE_HSA in result.reasons
    assert QualityReason.MISSING_COVERAGE in result.reasons
    assert QualityReason.INSUFFICIENT_HSA_PERFORMANCE in result.reasons


def test_hsa_public_nowcast_remains_hard_gated_when_diagnostics_pass():
    latest = _point()
    result = assess_quality_and_skill(
        QualitySkillInput(
            geography_type=GeographyType.HSA,
            latest_observation=latest,
            expected_input_epiweek=latest.epiweek,
            as_of=ORIGIN,
            authentic_vintages=True,
            paired_valid_origins=52,
            complete_october_may_windows=2,
        )
    )
    assert result.forecast_status is ForecastStatus.UNAVAILABLE
    assert result.data_quality is DataQuality.LIMITED
    assert QualityReason.EXPERIMENTAL_HSA_LIMIT in result.reasons


def test_stale_primary_is_unavailable_not_low_confidence():
    latest = _point()
    stale_as_of = datetime(2025, 3, 10, tzinfo=UTC)
    result = assess_quality_and_skill(
        QualitySkillInput(
            geography_type=GeographyType.STATE,
            latest_observation=latest,
            expected_input_epiweek=latest.epiweek,
            as_of=stale_as_of,
        )
    )
    assert result.forecast_status is ForecastStatus.UNAVAILABLE
    assert QualityReason.STALE_PRIMARY_TARGET in result.reasons
