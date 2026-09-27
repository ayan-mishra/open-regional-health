"use client";
import Link from "next/link";
export default function ErrorPage({ reset }: {
    error: Error & {
        digest?: string;
    };
    reset: () => void;
}) {
    return (<div className="status-shell">
      <main id="main-content" className="shell status-page">
        <p className="rubric">Corvid status</p>
        <h1>This view could not be opened</h1>
        <div className="status-card" role="alert">
          <h2>The requested information is temporarily unavailable</h2>
          <p>Corvid could not safely display the requested content. Try again, return home, or open the national dashboard.</p>
          <div className="status-actions">
            <button className="primary-button" type="button" onClick={reset}>Try again</button>
            <Link className="secondary-button" href="/">Go home</Link>
            <Link className="secondary-button" href="/dashboard">Open dashboard</Link>
          </div>
        </div>
      </main>
    </div>);
}
