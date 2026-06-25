import { AppShell } from "@/components/agent-trade/AppShell";
import { OnboardingClient } from "@/components/agent-trade/OnboardingClient";

export default function SettingsPage() {
  return (
    <AppShell>
      <OnboardingClient surface="settings" />
    </AppShell>
  );
}
