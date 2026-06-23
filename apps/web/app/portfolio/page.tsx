import { AppShell } from "@/components/agent-trade/AppShell";
import { PortfolioClient } from "@/components/agent-trade/PortfolioClient";

export default function PortfolioPage() {
  return (
    <AppShell>
      <PortfolioClient />
    </AppShell>
  );
}
