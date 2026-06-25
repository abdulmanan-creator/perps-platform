import { NextResponse } from "next/server";

import { createServerAgentProvider } from "@/lib/agent-trade/agent-provider-factory";
import {
  invalidAgentOutputRefusal,
  parseAgentAnalysis,
  parseAgentInput,
} from "@/lib/agent-trade/agent-validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 400 });
  }

  const input = parseAgentInput(body);
  if (!input) {
    return NextResponse.json({ message: "Invalid AgentInput body." }, { status: 400 });
  }

  const provider = createServerAgentProvider();
  const rawAnalysis = await provider.analyzeMarket(input);
  const analysis = parseAgentAnalysis(rawAnalysis) ?? invalidAgentOutputRefusal(input);
  return NextResponse.json(analysis, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
