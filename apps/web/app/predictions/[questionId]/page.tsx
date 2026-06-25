import { AppShell } from "@/components/agent-trade/AppShell";
import { PredictionDetailClient } from "@/components/agent-trade/PredictionDetailClient";

export default function PredictionDetailPage({ params }: { params: { questionId: string } }) {
  const questionId = Number(params.questionId);
  return (
    <AppShell>
      <PredictionDetailClient questionId={Number.isFinite(questionId) ? questionId : -1} />
    </AppShell>
  );
}
