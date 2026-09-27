from datetime import date

import pytest
from corvid.forecasting.types import EpiWeek


def test_mmwr_calendar_is_sunday_through_saturday_across_year_boundary():
    week = EpiWeek.from_date(date(2021, 1, 1))
    assert week == EpiWeek(2020, 53)
    assert week.start_date() == date(2020, 12, 27)
    assert week.end_date() == date(2021, 1, 2)
    assert week.next() == EpiWeek(2021, 1)


def test_week_53_is_valid_only_in_an_mmwr_year_that_has_it():
    assert EpiWeek(2020, 53).end_date() == date(2021, 1, 2)
    with pytest.raises(ValueError, match="invalid MMWR week"):
        EpiWeek(2021, 53)


def test_from_end_date_rejects_non_saturday():
    with pytest.raises(ValueError, match="Saturday"):
        EpiWeek.from_end_date(date(2025, 1, 3))
