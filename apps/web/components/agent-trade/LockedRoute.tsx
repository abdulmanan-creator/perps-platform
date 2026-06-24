import { AppShell } from "./AppShell";

export function LockedRoute({
  title,
  kicker,
}: {
  title: string;
  kicker: string;
}) {
  return (
    <AppShell>
      <main className="at-placeholder">
        <div>
          <p className="at-kicker">{kicker}</p>
          <h1>{title}</h1>
          <p>
            This route is intentionally reserved while the current MVP focuses
            on the terminal, market discovery, portfolio risk, onboarding, and
            safe connector handoff. It is not wired to live trading actions.
          </p>
        </div>
      </main>
    </AppShell>
  );
}
