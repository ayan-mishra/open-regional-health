from datetime import UTC, date, datetime

import pytest
from corvid.forecasting.types import EpiWeek, WeeklyHistory, WeeklyPoint


@pytest.fixture
def history_factory():
    def build(
        values: list[float],
        *,
        first_end: date = date(2025, 1, 4),
        as_of: datetime = datetime(2025, 7, 1, 23, tzinfo=UTC),
    ) -> WeeklyHistory:
        first = EpiWeek.from_end_date(first_end)
        points: list[WeeklyPoint] = []
        week = first
        for index, value in enumerate(values, start=1):
            points.append(
                WeeklyPoint(
                    epiweek=week,
                    value=value,
                    observation_id=index,
                    observation_end=week.end_date(),
                    issue_at=None,
                    retrieved_at=as_of,
                    authentic_vintage=True,
                )
            )
            week = week.next()
        return WeeklyHistory(
            geography_id="ma",
            metric="ed_visit_percent",
            unit="percentage_points",
            as_of=as_of,
            points=tuple(points),
        )

    return build
