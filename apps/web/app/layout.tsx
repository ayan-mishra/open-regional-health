import type { Metadata } from "next";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./globals.css";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
    title: { default: "Corvid | United States health intelligence", template: "%s | Corvid" },
    description: "Disease, environmental, and health system intelligence across the contiguous United States.",
};
export default function RootLayout({ children }: Readonly<{
    children: React.ReactNode;
}>) {
    return <html lang="en" data-scroll-behavior="smooth"><body>
    <main className="desktop-required" aria-labelledby="desktop-required-title">
      <div>
        <p className="desktop-wordmark">CORVID</p>
        <h1 id="desktop-required-title">Open Corvid on desktop.</h1>
        <p>Use a desktop browser to explore the dashboard, forecasts, and population health tools.</p>
      </div>
    </main>
    <div className="site-content">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {children}
    </div>
  </body></html>;
}
