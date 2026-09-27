import Link from "next/link";
export default function NotFound() {
    return <div className="status-shell"><main id="main-content" className="shell status-page"><p className="rubric">Not found</p><h1>We could not find that page</h1><p className="measure">The address may have changed, or the requested geography may not be supported.</p><div className="status-actions"><Link className="primary-button" href="/">Go home</Link><Link className="secondary-button" href="/dashboard">Open dashboard</Link></div></main></div>;
}
