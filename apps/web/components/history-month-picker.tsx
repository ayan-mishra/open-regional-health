"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "./history-month-picker.module.css";
type HistoryMonthPickerProps = {
    ariaLabel: string;
    inset?: boolean;
    label: string;
    min: string;
    max: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
};
const MONTHS = Array.from({ length: 12 }, (_, month) => ({
    long: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2020, month, 1))),
    short: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2020, month, 1))),
}));
function parsePeriod(period: string) {
    const match = /^(\d{4})-(\d{2})$/.exec(period);
    if (!match)
        return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { year, month } : null;
}
function periodFor(year: number, month: number) {
    return `${year}-${String(month).padStart(2, "0")}`;
}
function shiftPeriod(period: string, offset: number) {
    const parsed = parsePeriod(period);
    if (!parsed)
        return period;
    const date = new Date(Date.UTC(parsed.year, parsed.month - 1 + offset, 1));
    return periodFor(date.getUTCFullYear(), date.getUTCMonth() + 1);
}
function formatPeriod(period: string) {
    const parsed = parsePeriod(period);
    if (!parsed)
        return "Current";
    return `${MONTHS[parsed.month - 1].long} ${parsed.year}`;
}
export function HistoryMonthPicker({ ariaLabel, inset = false, label, min, max, value, onChange, disabled = false }: HistoryMonthPickerProps) {
    const dialogId = useId();
    const descriptionId = useId();
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const selected = parsePeriod(value);
    const minimum = parsePeriod(min);
    const maximum = parsePeriod(max);
    const [open, setOpen] = useState(false);
    const [viewYear, setViewYear] = useState(selected?.year ?? maximum?.year ?? new Date().getUTCFullYear());
    useEffect(() => {
        if (!open)
            return;
        const closeOnOutsideClick = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node))
                setOpen(false);
        };
        const closeOnEscape = (event: globalThis.KeyboardEvent) => {
            if (event.key !== "Escape")
                return;
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
        };
        document.addEventListener("mousedown", closeOnOutsideClick);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("mousedown", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [open]);
    useEffect(() => {
        if (!open)
            return;
        const focusPeriod = value || max;
        rootRef.current?.querySelector<HTMLButtonElement>(`[data-period="${focusPeriod}"]`)?.focus();
    }, [max, open, value, viewYear]);
    const focusMonth = (period: string) => {
        if (period < min || period > max)
            return;
        const target = parsePeriod(period);
        if (!target)
            return;
        setViewYear(target.year);
        window.requestAnimationFrame(() => {
            rootRef.current?.querySelector<HTMLButtonElement>(`[data-period="${period}"]`)?.focus();
        });
    };
    const handleMonthKeyDown = (event: KeyboardEvent<HTMLButtonElement>, period: string) => {
        const offsets: Partial<Record<KeyboardEvent["key"], number>> = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -3,
            ArrowDown: 3,
            PageUp: -12,
            PageDown: 12,
        };
        const offset = offsets[event.key];
        if (offset !== undefined) {
            event.preventDefault();
            focusMonth(shiftPeriod(period, offset));
            return;
        }
        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const edge = event.key === "Home" ? periodFor(viewYear, 1) : periodFor(viewYear, 12);
            focusMonth(edge < min ? min : edge > max ? max : edge);
        }
    };
    const selectPeriod = (period: string) => {
        onChange(period);
        setOpen(false);
        triggerRef.current?.focus();
    };
    const previousYearDisabled = minimum ? viewYear <= minimum.year : false;
    const nextYearDisabled = maximum ? viewYear >= maximum.year : false;
    const togglePicker = () => {
        if (!open)
            setViewYear(selected?.year ?? maximum?.year ?? new Date().getUTCFullYear());
        setOpen(!open);
    };
    return <div className={`${styles.field} ${inset ? styles.inset : ""}`}>
    <span className={styles.fieldLabel}>{label}</span>
    <div className={styles.picker} ref={rootRef}>
      <span id={descriptionId} className={styles.visuallyHidden}>Selected value: {formatPeriod(value)}</span>
      <button ref={triggerRef} type="button" className={styles.trigger} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined} aria-describedby={descriptionId} disabled={disabled} onClick={togglePicker}>
        <span className={styles.value}>{formatPeriod(value)}</span>
        <svg className={styles.calendarIcon} viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M5.5 3v3M14.5 3v3M3.5 7.5h13M5 4.5h10a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 15 16.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M6.5 10h1M9.5 10h1M12.5 10h1M6.5 13h1M9.5 13h1M12.5 13h1" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
      {open ? <div id={dialogId} className={styles.popover} role="dialog" aria-label="Choose historical month">
        <div className={styles.yearNav}>
          <button type="button" aria-label="Previous year" disabled={previousYearDisabled} onClick={() => setViewYear((year) => year - 1)}>&larr;</button>
          <strong aria-live="polite">{viewYear}</strong>
          <button type="button" aria-label="Next year" disabled={nextYearDisabled} onClick={() => setViewYear((year) => year + 1)}>&rarr;</button>
        </div>
        <div className={styles.monthGrid} role="group" aria-label={`Months in ${viewYear}`}>
          {MONTHS.map((month, index) => {
                const period = periodFor(viewYear, index + 1);
                const disabled = period < min || period > max;
                return <button key={month.short} type="button" data-period={period} disabled={disabled} aria-label={`${month.long} ${viewYear}`} aria-pressed={value === period} onClick={() => selectPeriod(period)} onKeyDown={(event) => handleMonthKeyDown(event, period)}>{month.short}</button>;
            })}
        </div>
        <button type="button" className={styles.current} aria-pressed={!value} onClick={() => selectPeriod("")}>Use current data</button>
      </div> : null}
    </div>
  </div>;
}
