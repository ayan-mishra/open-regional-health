"use client";
import Link from "next/link";
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import styles from "./app-sidebar.module.css";
export type AppRoute = "dashboard" | "forecasts" | "population-health";
const NAV: ReadonlyArray<{
    id: AppRoute;
    href: string;
    label: string;
    icon: ReactNode;
}> = [
    { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: <path d="M3 10.5 10 4l7 6.5M5 9.5V16h10V9.5"/> },
    { id: "forecasts", href: "/forecasts", label: "Forecasts", icon: <path d="M3 14.5 7.5 9l3.5 3.5L17 5.5M17 5.5h-4m4 0v4"/> },
    { id: "population-health", href: "/population-health", label: "Population health", icon: <path d="M10 17s-6-3.8-6-8a3.4 3.4 0 0 1 6-2 3.4 3.4 0 0 1 6 2c0 4.2-6 8-6 8Z"/> },
];
const SIDEBAR_KEY = "corvid-sidebar";
const SIDEBAR_EVENT = "corvid-sidebar-change";
let collapsedWithoutStorage: boolean | null = null;
function subscribeToSidebar(listener: () => void) {
    window.addEventListener(SIDEBAR_EVENT, listener);
    window.addEventListener("storage", listener);
    return () => {
        window.removeEventListener(SIDEBAR_EVENT, listener);
        window.removeEventListener("storage", listener);
    };
}
function readCollapsed() {
    if (collapsedWithoutStorage !== null)
        return collapsedWithoutStorage;
    try {
        return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    }
    catch {
        return false;
    }
}
function collapsedOnServer() {
    return false;
}
export function AppSidebar({ current, status }: {
    current?: AppRoute;
    status?: ReactNode;
}) {
    const collapsed = useSyncExternalStore(subscribeToSidebar, readCollapsed, collapsedOnServer);
    useEffect(() => {
        document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
    }, [collapsed]);
    const toggle = useCallback(() => {
        const nextCollapsed = !readCollapsed();
        try {
            window.localStorage.setItem(SIDEBAR_KEY, nextCollapsed ? "collapsed" : "expanded");
            collapsedWithoutStorage = null;
        }
        catch {
            collapsedWithoutStorage = nextCollapsed;
        }
        window.dispatchEvent(new Event(SIDEBAR_EVENT));
    }, []);
    return <div className={styles.sidebar} data-surface="app" data-collapsed={collapsed ? "" : undefined}>
    <div className={styles.head}>
      <Link className={styles.brand} href="/dashboard" aria-label="Corvid dashboard"><span aria-hidden="true">C</span><strong>CORVID</strong></Link>
      <button className={styles.collapse} type="button" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand navigation" : "Collapse navigation"}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3v14M12.5 7.5 10 10l2.5 2.5"/></svg>
      </button>
    </div>
    <nav className={styles.nav} aria-label="Workspace navigation">
      {NAV.map((item) => <Link key={item.id} href={item.href} aria-current={current === item.id ? "page" : undefined} title={item.label}>
        <svg viewBox="0 0 20 20" aria-hidden="true">{item.icon}</svg><span>{item.label}</span>
      </Link>)}
    </nav>
    <div className={styles.foot}>{status ? <div className={styles.status}>{status}</div> : null}</div>
  </div>;
}
