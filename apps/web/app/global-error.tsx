"use client";
import Link from "next/link";
export default function GlobalError() {
    return (<html lang="en">
      <body>
        <main role="alert" style={{ margin: "10vh auto", maxWidth: 640, padding: 24, fontFamily: "system-ui, sans-serif" }}>
          <p style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>Corvid status</p>
          <h1>Corvid could not open this page</h1>
          <p>The service encountered an unexpected error. No account or health data is shown in this message.</p>
          <button type="button" onClick={() => window.location.reload()} style={{ minHeight: 44, padding: "0 18px" }}>Try again</button>
          <p><Link href="/">Return home</Link></p>
        </main>
      </body>
    </html>);
}
