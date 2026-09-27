import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { LocationPicker } from "@/components/location-picker";
describe("LocationPicker", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("disables county selection and retries when the county asset cannot load", async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ ok: true, json: async () => ({ counties: [{ fips: "25017", name: "Middlesex" }] }) });
        vi.stubGlobal("fetch", fetchMock);
        function Harness() {
            const [value, setValue] = useState({ stateCode: "MA", countyFips: "", countyName: "" });
            return <LocationPicker value={value} onChange={setValue}/>;
        }
        render(<Harness />);
        expect(await screen.findByRole("alert")).toHaveTextContent(/could not load counties/i);
        expect(screen.getByLabelText("County")).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: /try again/i }));
        await waitFor(() => expect(screen.getByRole("option", { name: "Middlesex County" })).toBeVisible());
        expect(screen.getByLabelText("County")).toBeEnabled();
    });
});
