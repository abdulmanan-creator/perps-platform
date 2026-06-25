import { AppShell } from "@/components/agent-trade/AppShell";
import { PredictionsClient } from "@/components/agent-trade/PredictionsClient";

export default function PredictionsPage() {
  return (
    <AppShell>
      <PredictionsClient />
    </AppShell>
  );
}
