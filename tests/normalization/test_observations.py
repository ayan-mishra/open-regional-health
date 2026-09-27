from math import inf, nan

import pytest
from corvid.ingestion.base import SourceSchemaError
from corvid.normalization.observations import (
    parse_date,
    parse_float,
    parse_int,
    parse_nonnegative_float,
    parse_nonnegative_int,
    parse_percentage,
)


@pytest.mark.parametrize(
    "value", ["2026-08-01garbage", "2026-08-01Tnot-a-time", "2026-08-01Zjunk"]
)
def test_parse_date_rejects_trailing_non_iso_content(value: str) -> None:
    with pytest.raises(SourceSchemaError, match="valid ISO date"):
        parse_date(value, field="observation_date")


@pytest.mark.parametrize(
    "value", ["2026-08-01", "2026-08-01T12:34:56", "2026-08-01T12:34:56Z"]
)
def test_parse_date_accepts_iso_dates_and_timestamps(value: str) -> None:
    assert parse_date(value, field="observation_date").isoformat() == "2026-08-01"


@pytest.mark.parametrize("value", ["nan", "NaN", "inf", "-inf", nan, inf, -inf])
def test_parse_float_rejects_non_finite_publisher_values(value: object) -> None:
    with pytest.raises(SourceSchemaError, match="finite"):
        parse_float(value, field="metric")


def test_parse_int_rejects_fractional_numbers_instead_of_truncating() -> None:
    with pytest.raises(SourceSchemaError, match="integer"):
        parse_int(3.7, field="count", required=True)


def test_parse_int_accepts_integral_json_numbers() -> None:
    assert parse_int(3.0, field="count", required=True) == 3


@pytest.mark.parametrize("value", [-0.01, "100.01"])
def test_parse_percentage_rejects_values_outside_zero_to_one_hundred(
    value: object,
) -> None:
    with pytest.raises(SourceSchemaError, match="between 0 and 100"):
        parse_percentage(value, field="share")


@pytest.mark.parametrize("value", [0, "42.5", 100])
def test_parse_percentage_accepts_the_closed_percentage_range(value: object) -> None:
    assert parse_percentage(value, field="share") == float(value)


@pytest.mark.parametrize("value", [-1, "-0.01"])
def test_parse_nonnegative_float_rejects_negative_values(value: object) -> None:
    with pytest.raises(SourceSchemaError, match="nonnegative"):
        parse_nonnegative_float(value, field="concentration")


def test_parse_nonnegative_int_rejects_negative_counts() -> None:
    with pytest.raises(SourceSchemaError, match="nonnegative"):
        parse_nonnegative_int(-1, field="count")
