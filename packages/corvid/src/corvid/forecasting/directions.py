from decimal import Decimal
from math import isfinite

from corvid.domain.enums import Direction

DIRECTION_THRESHOLD_VERSION = "direction-threshold-v1"
DEFAULT_DIRECTION_THRESHOLD_PP = 0.10


def classify_direction(
    current: float,
    predicted: float,
    threshold_pp: float = DEFAULT_DIRECTION_THRESHOLD_PP,
) -> Direction:


    if not all(isfinite(value) for value in (current, predicted, threshold_pp)):
        raise ValueError("direction inputs must be finite")
    if threshold_pp <= 0:
        raise ValueError("threshold_pp must be positive")
    change = Decimal(str(predicted)) - Decimal(str(current))
    threshold = Decimal(str(threshold_pp))
    if change >= threshold:
        return Direction.RISING
    if change <= -threshold:
        return Direction.FALLING
    return Direction.STABLE
