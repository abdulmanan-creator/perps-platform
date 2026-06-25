import { handleAgentAnalysisPost } from "@/lib/agent-trade/agent-analysis-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return await handleAgentAnalysisPost(request);
}
