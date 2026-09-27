import { AppSidebar } from "@/components/app-sidebar";
export default function ForecastsLoading() {
    return <div className="status-shell"><AppSidebar current="forecasts" status={<><i data-state="loading"/>Opening forecasts</>}/><main id="main-content" className="shell status-page" role="status"><p className="rubric">Monthly outlook</p><h1>Your forecasts are opening.</h1><p className="measure">Loading the prepared current forecast.</p></main></div>;
}
