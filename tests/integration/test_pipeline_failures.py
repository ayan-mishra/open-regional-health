from datetime import UTC, date, datetime

from corvid.domain import IngestionStatus
from corvid.ingestion.runner import IngestionSummary
from corvid.services.pipeline import PipelineOrchestrator, StageStatus


class StubRunner:
    def __init__(self, outcomes: dict[str, IngestionSummary]) -> None:
        self.outcomes = outcomes

    def run(self, source_key: str) -> IngestionSummary:
        return self.outcomes[source_key]


def _summary(source_key: str, status: IngestionStatus) -> IngestionSummary:
    return IngestionSummary(
        source_key=source_key,
        status=status,
        most_recent_observation_date=(
            date(2025, 2, 8) if status is IngestionStatus.SUCCEEDED else None
        ),
        error_message=None if status is IngestionStatus.SUCCEEDED else "source failed",
    )


def test_optional_source_failure_preserves_forecast_with_visible_warning():
    published: list[str] = []
    orchestrator = PipelineOrchestrator(
        runner=StubRunner(
            {
                "nssp_ed": _summary("nssp_ed", IngestionStatus.SUCCEEDED),
                "fluview_ili": _summary(
                    "fluview_ili", IngestionStatus.TRANSPORT_ERROR
                ),
            }
        ),
        primary_source_key="nssp_ed",
        has_valid_primary=lambda as_of: True,
        run_backtests=lambda as_of: 4,
        publish_forecasts=lambda as_of: published.append("ma") or 1,
    )

    summary = orchestrator.run(
        ("nssp_ed", "fluview_ili"), datetime(2025, 2, 14, 23, tzinfo=UTC)
    )

    assert summary.status is StageStatus.PARTIAL
    assert summary.forecast.status is StageStatus.SUCCEEDED
    assert summary.source_results["fluview_ili"].status is StageStatus.FAILED
    assert any("fluview_ili" in warning for warning in summary.warnings)
    assert published == ["ma"]


def test_primary_failure_without_valid_prior_data_refuses_forecast():
    published: list[str] = []
    orchestrator = PipelineOrchestrator(
        runner=StubRunner(
            {
                "nssp_ed": _summary("nssp_ed", IngestionStatus.TRANSPORT_ERROR),
                "fluview_ili": _summary("fluview_ili", IngestionStatus.SUCCEEDED),
            }
        ),
        primary_source_key="nssp_ed",
        has_valid_primary=lambda as_of: False,
        run_backtests=lambda as_of: 0,
        publish_forecasts=lambda as_of: published.append("ma") or 1,
    )

    summary = orchestrator.run(
        ("nssp_ed", "fluview_ili"), datetime(2025, 2, 14, 23, tzinfo=UTC)
    )

    assert summary.status is StageStatus.FAILED
    assert summary.forecast.status is StageStatus.SKIPPED
    assert "valid prior data" in (summary.forecast.message or "")
    assert published == []


def test_zero_published_assessments_fails_the_required_forecast_stage():
    orchestrator = PipelineOrchestrator(
        runner=StubRunner(
            {"nssp_ed": _summary("nssp_ed", IngestionStatus.SUCCEEDED)}
        ),
        primary_source_key="nssp_ed",
        has_valid_primary=lambda as_of: True,
        run_backtests=lambda as_of: 0,
        publish_forecasts=lambda as_of: 0,
    )

    summary = orchestrator.run(
        ("nssp_ed",), datetime(2025, 2, 14, 23, tzinfo=UTC)
    )

    assert summary.status is StageStatus.FAILED
    assert summary.forecast.status is StageStatus.FAILED
    assert summary.forecast.count == 0
    assert "no assessments" in (summary.forecast.message or "")
    assert not summary.required_stages_succeeded
