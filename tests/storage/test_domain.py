from dataclasses import replace
from datetime import date
from math import inf, nan

import pytest
from conftest import observation


@pytest.mark.parametrize("value", [nan, inf, -inf])
def test_observation_rejects_non_finite_values(value):
    with pytest.raises(ValueError, match="finite"):
        observation(issue_date=date(2026, 1, 10), value=value)


def test_observation_metadata_is_deeply_immutable():
    metadata = {"method": {"codes": ["a"]}}
    record = replace(
        observation(issue_date=date(2026, 1, 10), value=1.2), metadata=metadata
    )

    with pytest.raises((TypeError, AttributeError)):
        record.metadata["method"]["codes"].append("b")
