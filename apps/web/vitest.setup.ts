import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
process.env.CORVID_COUNTY_STORE_DIR = "/nonexistent/corvid-test/county-store";
process.env.CORVID_FORECAST_STORE_DIR = "/nonexistent/corvid-test/forecast-store";
process.env.CORVID_HISTORY_STORE_DIR = "/nonexistent/corvid-test/history-store";
process.env.CORVID_POPULATION_STORE_DIR = "/nonexistent/corvid-test/population-store";
afterEach(cleanup);
class ResizeObserverMock {
    observe() { }
    unobserve() { }
    disconnect() { }
}
global.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
        if (this.classList.contains("recharts-responsive-container")) {
            return DOMRect.fromRect({ width: 800, height: 390 });
        }
        return originalGetBoundingClientRect.call(this);
    },
});
