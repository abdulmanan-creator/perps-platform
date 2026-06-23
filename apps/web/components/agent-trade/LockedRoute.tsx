import { AppShell } from "./AppShell";

export function LockedRoute({
  title,
  milestone,
}: {
  title: string;
  milestone: "Milestone 2" | "Milestone 3";
}) {
  return (
    <AppShell>
      <main className="at-placeholder">
        <div>
          <p className="at-kicker">{milestone}</p>
          <h1>{title}</h1>
          <p>
            This route is intentionally present but not built in Milestone 1.
            The current gate is limited to the terminal, embedded agent, ticket
            handoff, paper trading, and guarded exchange path.
          </p>
        </div>
      </main>
    </AppShell>
  );
}
