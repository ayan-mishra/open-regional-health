from collections.abc import Iterable

from corvid.ingestion.base import Connector


class ConnectorRegistry:
    def __init__(self, connectors: Iterable[Connector] = ()) -> None:
        self._connectors: dict[str, Connector] = {}
        for connector in connectors:
            self.register(connector)

    def register(self, connector: Connector) -> None:
        if connector.source_key in self._connectors:
            raise ValueError(f"duplicate connector source key: {connector.source_key}")
        self._connectors[connector.source_key] = connector

    def get(self, source_key: str) -> Connector:
        try:
            return self._connectors[source_key]
        except KeyError as error:
            raise KeyError(f"unknown connector source key: {source_key}") from error

    def keys(self) -> tuple[str, ...]:
        return tuple(sorted(self._connectors))


def default_registry() -> ConnectorRegistry:
    from corvid.ingestion.fluview import FluViewConnector
    from corvid.ingestion.mass_dph import MassDphConnector
    from corvid.ingestion.nhsn import NhsnConnector
    from corvid.ingestion.nrevss import NrevssConnector
    from corvid.ingestion.nssp import NsspConnector
    from corvid.ingestion.wastewater import WastewaterConnector

    return ConnectorRegistry(
        [
            NsspConnector(),
            FluViewConnector(),
            NhsnConnector(),
            NrevssConnector(),
            WastewaterConnector(),
            MassDphConnector(),
        ]
    )
