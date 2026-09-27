from dataclasses import dataclass
from typing import Literal

type IngestionMode = Literal["research", "commercial"]
type CommercialPolicy = Literal["allowed", "requires_review", "denied"]


_POLICIES: dict[str, CommercialPolicy] = {
    "nssp_ed": "allowed",
    "nhsn_hospital": "allowed",
    "nrevss_naat": "allowed",
    "nwss_influenza_a": "allowed",
    "fluview_ili": "requires_review",
    "mass_dph_archive": "requires_review",
}


@dataclass(frozen=True, slots=True)
class SourcePolicy:
    source_key: str
    commercial_policy: CommercialPolicy

    @classmethod
    def for_source(cls, source_key: str) -> "SourcePolicy":
        return cls(source_key, _POLICIES.get(source_key, "denied"))

    def is_allowed(self, mode: IngestionMode) -> bool:
        if self.source_key not in _POLICIES:
            return False
        if mode == "research":
            return True
        return self.commercial_policy == "allowed"
