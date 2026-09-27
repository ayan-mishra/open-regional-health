import { AppSidebar } from "@/components/app-sidebar";
import { RavenLoadingScreen } from "@/components/raven-loading-screen";
export default function PopulationHealthLoading() {
    return <div className="status-shell">
    <AppSidebar status={<><i data-state="loading"/>Opening population health</>}/>
    <main id="main-content" className="shell" role="status">
      <RavenLoadingScreen compact context="brief" title="Opening population health." detail="The region picker appears first. Publisher data is requested only after you choose a region."/>
    </main>
  </div>;
}
