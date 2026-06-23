import { AppShell } from "@/components/agent-trade/AppShell";
import { TerminalClient } from "@/components/agent-trade/TerminalClient";

export default function TerminalPage() {
  return (
    <AppShell>
      <TerminalClient />
    </AppShell>
  );
}
