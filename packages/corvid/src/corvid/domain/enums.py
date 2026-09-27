from enum import StrEnum


class Disease(StrEnum):


    INFLUENZA = "influenza"
    COVID_19 = "covid-19"
    RSV = "rsv"


class UpstreamTrajectory(StrEnum):


    RISING = "rising"
    STABLE = "stable"
    FALLING = "falling"
    SPARSE = "sparse"
    INSUFFICIENT_DATA = "insufficient_data"
    UNAVAILABLE = "unavailable"
    UNKNOWN = "unknown"


class Direction(StrEnum):


    RISING = "rising"
    STABLE = "stable"
    FALLING = "falling"


class GeographyType(StrEnum):


    STATE = "state"
    HSA = "hsa"


class QualityFlag(StrEnum):


    VOLUNTARY_REPORTING = "voluntary_reporting"
    INCOMPLETE_COVERAGE = "incomplete_coverage"
    MISSING_COVERAGE = "missing_coverage"
    REVISED = "revised"
    EXPERIMENTAL = "experimental"
    STALE = "stale"
    SPARSE = "sparse"
    REPORTING_REGIME_TRANSITION = "reporting_regime_transition"
    INVALID_COVERAGE = "invalid_coverage"
    NON_DETECT = "non_detect"
    LIMITED_SENTINEL_COVERAGE = "limited_sentinel_coverage"
    MISSING_RELEASE_DATE = "missing_release_date"


class IngestionStatus(StrEnum):


    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    SCHEMA_ERROR = "schema_error"
    EMPTY = "empty"
    TRANSPORT_ERROR = "transport_error"
    VALIDATION_ERROR = "validation_error"
