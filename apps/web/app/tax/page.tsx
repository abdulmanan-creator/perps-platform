import { AppShell } from "@/components/agent-trade/AppShell";
import { TaxCenterClient } from "@/components/agent-trade/TaxCenterClient";

export default function TaxPage() {
  return (
    <AppShell>
      <TaxCenterClient />
    </AppShell>
  );
}
