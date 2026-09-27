import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HistoryMonthPicker } from "@/components/history-month-picker";
function ControlledPicker({ initialValue = "" }: {
    initialValue?: string;
}) {
    const [value, setValue] = useState(initialValue);
    return <HistoryMonthPicker ariaLabel="Historical month" label="Historical month" min="2018-01" max="2024-08" value={value} onChange={setValue}/>;
}
describe("HistoryMonthPicker", () => {
    it("uses a button-only picker and selects a bounded month", () => {
        const onChange = vi.fn();
        render(<HistoryMonthPicker ariaLabel="Historical month" label="Historical month" min="2024-01" max="2024-08" value="2024-03" onChange={onChange}/>);
        const trigger = screen.getByRole("button", { name: "Historical month" });
        expect(trigger).toHaveTextContent("March 2024");
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(document.querySelector("input")).not.toBeInTheDocument();
        fireEvent.click(trigger);
        expect(screen.getByRole("dialog", { name: "Choose historical month" })).toBeVisible();
        expect(screen.getByRole("button", { name: "September 2024" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "April 2024" }));
        expect(onChange).toHaveBeenCalledWith("2024-04");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
    it("supports year navigation, keyboard dismissal, and resetting to current data", () => {
        render(<ControlledPicker initialValue="2023-06"/>);
        const trigger = screen.getByRole("button", { name: "Historical month" });
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole("button", { name: "Next year" }));
        expect(screen.getByRole("group", { name: "Months in 2024" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Use current data" }));
        expect(trigger).toHaveTextContent("Current");
        fireEvent.click(trigger);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
