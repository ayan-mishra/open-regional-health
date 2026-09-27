import pytest
from corvid.domain.enums import Direction
from corvid.forecasting.directions import classify_direction


@pytest.mark.parametrize(
    ("current", "predicted", "expected"),
    [
        (1.0, 1.10, Direction.RISING),
        (1.0, 1.09, Direction.STABLE),
        (1.0, 0.90, Direction.FALLING),
        (1.0, 0.91, Direction.STABLE),
    ],
)
def test_direction_threshold_boundaries(current, predicted, expected):
    assert classify_direction(current, predicted) is expected


def test_direction_rejects_nonfinite_values():
    with pytest.raises(ValueError, match="finite"):
        classify_direction(1.0, float("nan"))
