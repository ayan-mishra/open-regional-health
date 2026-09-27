"use client";
import styles from "./raven-loading-screen.module.css";
type LoadingContext = "route" | "dashboard" | "forecast" | "brief";
const STATUS_LABELS: Record<LoadingContext, string> = {
    route: "Loading Corvid",
    dashboard: "Loading dashboard",
    forecast: "Loading forecasts",
    brief: "Loading your area",
};
export function RavenLoadingScreen({ context = "route", title, detail, compact = false, }: {
    context?: LoadingContext;
    title: string;
    detail: string;
    compact?: boolean;
}) {
    return <section id={compact ? undefined : "main-content"} className={`${styles.screen} ${compact ? styles.compact : ""}`} role="status" aria-busy="true" aria-live="polite" aria-atomic="true">
    <div className={styles.centerpiece}>
      <p className={styles.fieldNote}>{STATUS_LABELS[context]}</p>
      <h1>{title}</h1>
      <p className={styles.detail}>{detail}</p>
      <div className={styles.track} aria-hidden="true"><i /></div>
    </div>
  </section>;
}
