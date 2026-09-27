from datetime import date, datetime
from math import isfinite

from corvid.forecasting.types import EpiWeek
from corvid.ingestion.base import SourceSchemaError


def parse_date(value: object, *, field: str) -> date:
    if not isinstance(value, str):
        raise SourceSchemaError(f"{field} must be an ISO date string")
    try:
        if len(value) == 10:
            return date.fromisoformat(value)
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError as error:
        raise SourceSchemaError(f"{field} is not a valid ISO date") from error


def parse_float(value: object, *, field: str, required: bool = True) -> float | None:
    if value is None or value == "":
        if required:
            raise SourceSchemaError(f"{field} is required")
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise SourceSchemaError(f"{field} must be numeric")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise SourceSchemaError(f"{field} must be numeric") from error
    if not isfinite(parsed):
        raise SourceSchemaError(f"{field} must be finite")
    return parsed


def parse_percentage(
    value: object, *, field: str, required: bool = True
) -> float | None:
    parsed = parse_float(value, field=field, required=required)
    if parsed is not None and not 0 <= parsed <= 100:
        raise SourceSchemaError(f"{field} must be between 0 and 100")
    return parsed


def parse_nonnegative_float(
    value: object, *, field: str, required: bool = True
) -> float | None:
    parsed = parse_float(value, field=field, required=required)
    if parsed is not None and parsed < 0:
        raise SourceSchemaError(f"{field} must be nonnegative")
    return parsed


def parse_int(value: object, *, field: str, required: bool = False) -> int | None:
    if value is None or value == "":
        if required:
            raise SourceSchemaError(f"{field} is required")
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise SourceSchemaError(f"{field} must be an integer")
    if isinstance(value, float) and not value.is_integer():
        raise SourceSchemaError(f"{field} must be an integer")
    try:
        parsed = int(value)
    except (OverflowError, TypeError, ValueError) as error:
        raise SourceSchemaError(f"{field} must be an integer") from error
    return parsed


def parse_nonnegative_int(
    value: object, *, field: str, required: bool = False
) -> int | None:
    parsed = parse_int(value, field=field, required=required)
    if parsed is not None and parsed < 0:
        raise SourceSchemaError(f"{field} must be nonnegative")
    return parsed


def mmwr_week_interval(epiweek: int) -> tuple[date, date]:


    year, week = divmod(epiweek, 100)
    if year < 1900:
        raise SourceSchemaError("epiweek must be a valid six-digit CDC week")
    try:
        validated = EpiWeek(year, week)
    except ValueError as error:
        raise SourceSchemaError("epiweek exceeds the MMWR weeks in its year") from error
    return validated.start_date(), validated.end_date()
