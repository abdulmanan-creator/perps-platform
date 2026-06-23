import { AppShell } from "@/components/agent-trade/AppShell";
import { MarketsClient } from "@/components/agent-trade/MarketsClient";

export default function MarketsPage() {
  return (
    <AppShell>
      <MarketsClient />
    </AppShell>
  );
}
