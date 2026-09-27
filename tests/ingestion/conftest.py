import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).parents[2] / "data" / "fixtures"


def load_json_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))
