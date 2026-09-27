from corvid.domain import GeographyRecord, GeographyType


class GeographyResolutionError(ValueError):
    pass


_HSA_DEFINITIONS = {
    "112": ("Berkshire (Pittsfield)", ("Berkshire",)),
    "68": ("Bristol (New Bedford)", ("Bristol",)),
    "74": ("Essex (Lynn)", ("Essex",)),
    "32": ("Hampden (Springfield) / Hampshire", ("Hampden", "Hampshire")),
    "22": (
        "Middlesex / Suffolk (Boston)",
        (
            "Barnstable",
            "Dukes",
            "Middlesex",
            "Nantucket",
            "Norfolk",
            "Plymouth",
            "Suffolk",
        ),
    ),
    "101": ("Worcester / Franklin", ("Worcester", "Franklin")),
}


MASSACHUSETTS_GEOGRAPHIES = (
    GeographyRecord(
        id="ma",
        geography_type=GeographyType.STATE,
        display_name="Massachusetts",
        state_code="MA",
        upstream_identifiers={"nssp_fips": "25000"},
    ),
    *(
        GeographyRecord(
            id=f"ma-hsa-{hsa_id}",
            geography_type=GeographyType.HSA,
            display_name=name,
            state_code="MA",
            upstream_identifiers={"nssp_hsa_nci_id": hsa_id},
            member_counties=counties,
            experimental=True,
        )
        for hsa_id, (name, counties) in _HSA_DEFINITIONS.items()
    ),
)


def resolve_nssp_geography(*, trend_source: str, hsa_nci_id: str, fips: str) -> str:
    if trend_source == "State" and fips == "25000":
        return "ma"
    if trend_source == "HSA" and hsa_nci_id in _HSA_DEFINITIONS:
        return f"ma-hsa-{hsa_nci_id}"
    raise GeographyResolutionError(
        f"unreviewed NSSP geography: {trend_source}/{hsa_nci_id}/{fips}"
    )
