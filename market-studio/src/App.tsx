import { useMemo, useState } from "react";

type Screen = "studio" | "form" | "review" | "preview" | "success";

interface MarketDraft {
  title: string;
  cleanedTitle: string;
  category: string;
  subcategory: string;
  format: string;
  resolutionDate: string;
  resolutionTime: string;
  source: string;
  cleanedSource: string;
  criteria: string;
  cleanedCriteria: string;
  warning: string;
}

interface AppliedSuggestions {
  title: boolean;
  source: boolean;
  criteria: boolean;
}

interface ProposalCard {
  id: string;
  title: string;
  category: string;
  topic: string;
  format: string;
  status: string;
  resolutionDate: string;
  votes: number;
  comments: number;
  clarityScore: number;
  signal: string;
}

const topicChips = [
  "AI",
  "Crypto",
  "Macro",
  "Public companies",
  "Sports",
  "Politics",
  "Culture",
  "Custom",
];

const publicTabs = [
  "Trending proposals",
  "Top voted",
  "New proposals",
  "Under review",
  "Launch candidates",
  "Live markets",
];

const creatorTabs = ["My drafts", "Needs my action", "Submitted by me"];

const metaDraft: MarketDraft = {
  title: "Will Meta do more large-scale layoffs by end of year?",
  cleanedTitle:
    "Will Meta announce or be credibly reported to conduct additional large-scale layoffs of 1,000+ employees by December 31, 2026, 11:59 PM ET?",
  category: "Public companies",
  subcategory: "Tech",
  format: "Binary Yes/No",
  resolutionDate: "Dec 31, 2026",
  resolutionTime: "11:59 PM ET",
  source:
    "Meta official statements or SEC filings; if Meta does not confirm directly, requires corroboration from at least two major outlets such as Reuters, Bloomberg, or WSJ.",
  cleanedSource:
    "Meta official statements or SEC filings; if Meta does not confirm directly, requires corroboration from at least two major outlets such as Reuters, Bloomberg, or WSJ.",
  criteria:
    "Resolves YES if Meta announces, confirms, or is credibly reported by two or more major outlets to conduct an additional layoff of 1,000+ employees in a single action before Dec 31, 2026, 11:59 PM ET. Contractor and vendor reductions do not count. Resolves NO otherwise.",
  cleanedCriteria:
    "Resolves YES if Meta announces, confirms, or is credibly reported by two or more major outlets to conduct an additional layoff of 1,000+ employees in a single action before Dec 31, 2026, 11:59 PM ET. Contractor and vendor reductions do not count. Role-specific reductions count only if the same action affects 1,000+ direct Meta employees. Resolves NO otherwise.",
  warning:
    "Clarify whether contractors count, whether role-specific cuts count, and which sources are authoritative.",
};

const proposalCards: ProposalCard[] = [
  {
    id: "meta-layoffs",
    title: metaDraft.title,
    category: "Public companies / Tech",
    topic: "Public companies",
    format: "Binary Yes/No",
    status: "Proposed",
    resolutionDate: "Dec 31, 2026",
    votes: 284,
    comments: 37,
    clarityScore: 78,
    signal: "High public-company demand",
  },
  {
    id: "btc-year-end",
    title: "Will BTC close above $120k by year-end?",
    category: "Crypto",
    topic: "Crypto",
    format: "Binary Yes/No",
    status: "Launch candidate",
    resolutionDate: "Dec 31, 2026",
    votes: 412,
    comments: 64,
    clarityScore: 91,
    signal: "Reviewed with liquidity partners",
  },
  {
    id: "fed-cut",
    title: "Will the Fed cut rates at the next FOMC meeting?",
    category: "Macro",
    topic: "Macro",
    format: "Binary Yes/No",
    status: "Under review",
    resolutionDate: "Sep 16, 2026",
    votes: 198,
    comments: 22,
    clarityScore: 86,
    signal: "Source criteria looks clean",
  },
  {
    id: "world-cup",
    title: "Will France win the 2026 World Cup?",
    category: "Sports",
    topic: "Sports",
    format: "Binary Yes/No",
    status: "Proposed",
    resolutionDate: "Jul 19, 2026",
    votes: 143,
    comments: 18,
    clarityScore: 83,
    signal: "Simple resolution source",
  },
];

const initialApplied: AppliedSuggestions = {
  title: false,
  source: false,
  criteria: false,
};

function App() {
  const [screen, setScreen] = useState<Screen>("studio");
  const [draft, setDraft] = useState<MarketDraft>(metaDraft);
  const [applied, setApplied] = useState<AppliedSuggestions>(initialApplied);
  const [activeTopic, setActiveTopic] = useState("All");
  const [activePublicTab, setActivePublicTab] = useState(publicTabs[0]);
  const [activeCreatorTab, setActiveCreatorTab] = useState(creatorTabs[0]);
  const [marketIdea, setMarketIdea] = useState("");
  const [hasVoted, setHasVoted] = useState(false);

  const filteredCards = useMemo(() => {
    if (activeTopic === "All") {
      return proposalCards;
    }

    return proposalCards.filter((card) => card.topic === activeTopic);
  }, [activeTopic]);

  const clarityScore = useMemo(() => {
    const appliedCount = Number(applied.title) + Number(applied.source) + Number(applied.criteria);
    return 78 + appliedCount * 6;
  }, [applied]);

  const openMetaForm = () => {
    setDraft(metaDraft);
    setApplied(initialApplied);
    setScreen("form");
  };

  const openMetaReview = () => {
    setDraft(metaDraft);
    setApplied(initialApplied);
    setScreen("review");
  };

  const applySuggestion = (field: keyof AppliedSuggestions) => {
    if (field === "title") {
      setDraft((current) => ({ ...current, title: current.cleanedTitle }));
    } else if (field === "source") {
      setDraft((current) => ({ ...current, source: current.cleanedSource }));
    } else if (field === "criteria") {
      setDraft((current) => ({ ...current, criteria: current.cleanedCriteria }));
    } else {
      throw new Error(`Unexpected suggestion field: ${field}`);
    }

    setApplied((current) => ({ ...current, [field]: true }));
  };

  const submitProposal = () => {
    setScreen("success");
  };

  return (
    <div className="app-shell">
      <Header onStudio={() => setScreen("studio")} onPropose={openMetaForm} />
      <main>
        {screen === "studio" ? (
          <StudioScreen
            activeCreatorTab={activeCreatorTab}
            activePublicTab={activePublicTab}
            activeTopic={activeTopic}
            cards={filteredCards}
            hasVoted={hasVoted}
            marketIdea={marketIdea}
            onCreatorTab={setActiveCreatorTab}
            onIdea={setMarketIdea}
            onPropose={openMetaForm}
            onPublicTab={setActivePublicTab}
            onRefine={openMetaReview}
            onTopic={setActiveTopic}
            onUseTemplate={openMetaForm}
            onVote={() => setHasVoted((current) => !current)}
          />
        ) : undefined}
        {screen === "form" ? (
          <FormScreen
            draft={draft}
            onBack={() => setScreen("studio")}
            onDraft={setDraft}
            onReview={() => setScreen("review")}
          />
        ) : undefined}
        {screen === "review" ? (
          <ReviewScreen
            applied={applied}
            clarityScore={clarityScore}
            draft={draft}
            onApply={applySuggestion}
            onBack={() => setScreen("form")}
            onDraft={setDraft}
            onPreview={() => setScreen("preview")}
          />
        ) : undefined}
        {screen === "preview" ? (
          <PreviewScreen
            applied={applied}
            clarityScore={clarityScore}
            draft={draft}
            onBack={() => setScreen("review")}
            onSubmit={submitProposal}
          />
        ) : undefined}
        {screen === "success" ? (
          <SuccessScreen
            draft={draft}
            onStudio={() => {
              setActiveCreatorTab("Submitted by me");
              setScreen("studio");
            }}
          />
        ) : undefined}
      </main>
      <div className="debug-label">screen={screen}</div>
    </div>
  );
}

interface HeaderProps {
  onPropose: () => void;
  onStudio: () => void;
}

function Header({ onPropose, onStudio }: HeaderProps) {
  return (
    <header className="topbar">
      <button className="brand" onClick={onStudio} type="button">
        <span className="brand-mark">A</span>
        <span>
          <strong>Agent.trade</strong>
          <small>Market Studio</small>
        </span>
      </button>
      <nav aria-label="Primary navigation">
        <button type="button">Markets</button>
        <button type="button">Portfolio</button>
        <button type="button">Activity</button>
        <button type="button">Studio</button>
      </nav>
      <button className="primary-action" onClick={onPropose} type="button">
        Propose market
      </button>
    </header>
  );
}

interface StudioScreenProps {
  activeCreatorTab: string;
  activePublicTab: string;
  activeTopic: string;
  cards: ProposalCard[];
  hasVoted: boolean;
  marketIdea: string;
  onCreatorTab: (tab: string) => void;
  onIdea: (value: string) => void;
  onPropose: () => void;
  onPublicTab: (tab: string) => void;
  onRefine: () => void;
  onTopic: (topic: string) => void;
  onUseTemplate: () => void;
  onVote: () => void;
}

function StudioScreen({
  activeCreatorTab,
  activePublicTab,
  activeTopic,
  cards,
  hasVoted,
  marketIdea,
  onCreatorTab,
  onIdea,
  onPropose,
  onPublicTab,
  onRefine,
  onTopic,
  onUseTemplate,
  onVote,
}: StudioScreenProps) {
  return (
    <section className="studio-layout screen-panel">
      <div className="studio-main">
        <div className="compact-hero">
          <div>
            <p className="eyebrow">Candidate market intake</p>
            <h1>Market Studio</h1>
            <p>
              Top voted proposals may be reviewed with liquidity partners for HIP-4 launch.
            </p>
          </div>
          <button className="primary-action large" onClick={onPropose} type="button">
            Propose market
          </button>
        </div>

        <label className="idea-input">
          <span>What market should exist?</span>
          <input
            onChange={(event) => onIdea(event.target.value)}
            placeholder="What market should exist?"
            value={marketIdea}
          />
        </label>

        <div className="chip-row" aria-label="Topic filters">
          <button
            className={activeTopic === "All" ? "chip active" : "chip"}
            onClick={() => onTopic("All")}
            type="button"
          >
            All
          </button>
          {topicChips.map((topic) => (
            <button
              className={activeTopic === topic ? "chip active" : "chip"}
              key={topic}
              onClick={() => onTopic(topic)}
              type="button"
            >
              {topic}
            </button>
          ))}
        </div>

        <div className="tab-row" aria-label="Public proposal sections">
          {publicTabs.map((tab) => (
            <button
              className={activePublicTab === tab ? "tab active" : "tab"}
              key={tab}
              onClick={() => onPublicTab(tab)}
              type="button"
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="section-heading">
          <span>{activePublicTab}</span>
          <small>{cards.length} visible</small>
        </div>

        <div className="proposal-grid">
          {cards.map((card) => (
            <MarketCard
              card={card}
              hasVoted={card.id === "meta-layoffs" ? hasVoted : false}
              key={card.id}
              onRefine={card.id === "meta-layoffs" ? onRefine : undefined}
              onUseTemplate={card.id === "meta-layoffs" ? onUseTemplate : undefined}
              onVote={card.id === "meta-layoffs" ? onVote : undefined}
            />
          ))}
          {cards.length === 0 ? (
            <div className="empty-state">
              No seeded proposals match this topic in the prototype.
            </div>
          ) : undefined}
        </div>
      </div>

      <aside className="creator-rail">
        <div className="rail-card">
          <div className="rail-title">
            <span>Creator area</span>
            <small>Local prototype</small>
          </div>
          <div className="vertical-tabs">
            {creatorTabs.map((tab) => (
              <button
                className={activeCreatorTab === tab ? "side-tab active" : "side-tab"}
                key={tab}
                onClick={() => onCreatorTab(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="creator-list">
            <div>
              <strong>Meta layoffs template</strong>
              <span>Draft ready for AI review</span>
            </div>
            <div>
              <strong>World Cup winner</strong>
              <span>Needs source cleanup</span>
            </div>
          </div>
        </div>
      </aside>
    </section>
  );
}

interface MarketCardProps {
  card: ProposalCard;
  hasVoted: boolean;
  onRefine?: () => void;
  onUseTemplate?: () => void;
  onVote?: () => void;
}

function MarketCard({ card, hasVoted, onRefine, onUseTemplate, onVote }: MarketCardProps) {
  return (
    <article className="market-card">
      <div className="card-topline">
        <span>{card.category}</span>
        <span className="status-pill">{card.status}</span>
      </div>
      <h2>{card.title}</h2>
      <div className="detail-grid">
        <span>Format</span>
        <strong>{card.format}</strong>
        <span>Resolution</span>
        <strong>{card.resolutionDate}</strong>
      </div>
      <div className="metrics-row">
        <Metric label="Votes" value={hasVoted ? card.votes + 1 : card.votes} />
        <Metric label="Comments" value={card.comments} />
        <Metric label="Clarity" value={`${card.clarityScore}`} />
      </div>
      <p className="signal">{card.signal}</p>
      <div className="card-actions">
        <button className={hasVoted ? "secondary active" : "secondary"} onClick={onVote} type="button">
          {hasVoted ? "Voted" : "Vote"}
        </button>
        <button className="secondary" onClick={onUseTemplate} type="button">
          Use as template
        </button>
        <button className="secondary" onClick={onRefine} type="button">
          Refine criteria
        </button>
      </div>
    </article>
  );
}

interface MetricProps {
  label: string;
  value: number | string;
}

function Metric({ label, value }: MetricProps) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

interface FormScreenProps {
  draft: MarketDraft;
  onBack: () => void;
  onDraft: (draft: MarketDraft) => void;
  onReview: () => void;
}

function FormScreen({ draft, onBack, onDraft, onReview }: FormScreenProps) {
  return (
    <section className="two-column screen-panel">
      <div className="form-column">
        <ScreenKicker label="Prefilled form" title="Candidate market details" />
        <DraftFields draft={draft} onDraft={onDraft} />
        <div className="warning-strip">
          <strong>AI warning</strong>
          <span>{draft.warning}</span>
        </div>
        <div className="footer-actions">
          <button className="secondary" onClick={onBack} type="button">
            Back to Market Studio
          </button>
          <button className="primary-action" onClick={onReview} type="button">
            Review with Agent.trade
          </button>
        </div>
      </div>
      <aside className="context-column">
        <PreviewMini draft={draft} />
        <div className="note-box">
          <strong>Launch note</strong>
          <span>
            Submitting sends this candidate market into review. It does not launch a live market.
          </span>
        </div>
      </aside>
    </section>
  );
}

interface ReviewScreenProps {
  applied: AppliedSuggestions;
  clarityScore: number;
  draft: MarketDraft;
  onApply: (field: keyof AppliedSuggestions) => void;
  onBack: () => void;
  onDraft: (draft: MarketDraft) => void;
  onPreview: () => void;
}

function ReviewScreen({
  applied,
  clarityScore,
  draft,
  onApply,
  onBack,
  onDraft,
  onPreview,
}: ReviewScreenProps) {
  return (
    <section className="two-column screen-panel">
      <div className="form-column">
        <ScreenKicker label="AI refinement" title="Review candidate market" />
        <div className="score-panel">
          <div>
            <span>Clarity score</span>
            <strong>{clarityScore}</strong>
          </div>
          <p>
            Agent.trade checks title specificity, resolution source, edge cases, and duplicate risk.
          </p>
        </div>

        <SuggestionCard
          applied={applied.title}
          body={draft.cleanedTitle}
          label="Suggested cleaned title"
          onApply={() => onApply("title")}
        />
        <SuggestionCard
          applied={applied.source}
          body={draft.cleanedSource}
          label="Source clarification"
          onApply={() => onApply("source")}
        />
        <SuggestionCard
          applied={applied.criteria}
          body={draft.cleanedCriteria}
          label="Resolution criteria cleanup"
          onApply={() => onApply("criteria")}
        />

        <DraftFields compact draft={draft} onDraft={onDraft} />

        <div className="footer-actions">
          <button className="secondary" onClick={onBack} type="button">
            Back to form
          </button>
          <button className="primary-action" onClick={onPreview} type="button">
            Preview proposal
          </button>
        </div>
      </div>
      <aside className="context-column">
        <div className="checklist-panel">
          <h3>Review checklist</h3>
          <ChecklistRow checked label="Outcome is objectively resolvable" />
          <ChecklistRow checked={applied.source} label="Resolution source is authoritative" />
          <ChecklistRow checked label="Date and timezone are explicit" />
          <ChecklistRow checked={applied.criteria} label="Edge cases are addressed" />
          <ChecklistRow checked label="No exact duplicate detected" />
        </div>
        <div className="note-box">
          <strong>Next step</strong>
          <span>Preview the public proposal before submitting it for review.</span>
        </div>
      </aside>
    </section>
  );
}

interface PreviewScreenProps {
  applied: AppliedSuggestions;
  clarityScore: number;
  draft: MarketDraft;
  onBack: () => void;
  onSubmit: () => void;
}

function PreviewScreen({ applied, clarityScore, draft, onBack, onSubmit }: PreviewScreenProps) {
  const appliedCount = Number(applied.title) + Number(applied.source) + Number(applied.criteria);

  return (
    <section className="preview-screen screen-panel">
      <ScreenKicker label="Proposal preview" title="Submit candidate market for review" />
      <div className="preview-grid">
        <article className="proposal-preview">
          <div className="card-topline">
            <span>{draft.category} / {draft.subcategory}</span>
            <span className="status-pill">Candidate market</span>
          </div>
          <h2>{draft.title}</h2>
          <div className="detail-grid wide">
            <span>Format</span>
            <strong>{draft.format}</strong>
            <span>Resolution date</span>
            <strong>{draft.resolutionDate}, {draft.resolutionTime}</strong>
            <span>Resolution source</span>
            <strong>{draft.source}</strong>
            <span>Criteria</span>
            <strong>{draft.criteria}</strong>
          </div>
        </article>
        <aside className="submission-panel">
          <div className="score-panel compact-score">
            <div>
              <span>Clarity score</span>
              <strong>{clarityScore}</strong>
            </div>
            <p>{appliedCount}/3 suggestions applied</p>
          </div>
          <div className="note-box">
            <strong>Review path</strong>
            <span>
              Top voted proposals may be reviewed with liquidity partners for HIP-4 launch.
            </span>
          </div>
          <div className="footer-actions stacked">
            <button className="secondary" onClick={onBack} type="button">
              Back to review
            </button>
            <button className="primary-action" onClick={onSubmit} type="button">
              Submit proposal
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

interface SuccessScreenProps {
  draft: MarketDraft;
  onStudio: () => void;
}

function SuccessScreen({ draft, onStudio }: SuccessScreenProps) {
  return (
    <section className="success-screen screen-panel">
      <div className="success-mark">✓</div>
      <p className="eyebrow">Submitted for review</p>
      <h1>{draft.title}</h1>
      <p>
        Your candidate market is now in the proposal queue. Review status, votes, and comments
        will appear in Market Studio.
      </p>
      <div className="success-stats">
        <Metric label="Status" value="Proposed" />
        <Metric label="Initial clarity" value="96" />
        <Metric label="Queue" value="#18" />
      </div>
      <button className="primary-action large" onClick={onStudio} type="button">
        Back to Market Studio
      </button>
    </section>
  );
}

interface DraftFieldsProps {
  compact?: boolean;
  draft: MarketDraft;
  onDraft: (draft: MarketDraft) => void;
}

function DraftFields({ compact = false, draft, onDraft }: DraftFieldsProps) {
  const updateDraft = (patch: Partial<MarketDraft>) => {
    onDraft({ ...draft, ...patch });
  };

  return (
    <div className={compact ? "field-stack compact" : "field-stack"}>
      <label>
        <span>Title</span>
        <input
          onChange={(event) => updateDraft({ title: event.target.value })}
          value={draft.title}
        />
      </label>
      <div className="field-row">
        <label>
          <span>Category</span>
          <select
            onChange={(event) => updateDraft({ category: event.target.value })}
            value={draft.category}
          >
            <option>Public companies</option>
            <option>Crypto</option>
            <option>Macro</option>
            <option>Sports</option>
            <option>Politics</option>
            <option>Culture</option>
            <option>Custom</option>
          </select>
        </label>
        <label>
          <span>Format</span>
          <select
            onChange={(event) => updateDraft({ format: event.target.value })}
            value={draft.format}
          >
            <option>Binary Yes/No</option>
            <option>Multiple choice</option>
          </select>
        </label>
      </div>
      <div className="field-row">
        <label>
          <span>Resolution date</span>
          <input
            onChange={(event) => updateDraft({ resolutionDate: event.target.value })}
            value={draft.resolutionDate}
          />
        </label>
        <label>
          <span>Resolution time</span>
          <input
            onChange={(event) => updateDraft({ resolutionTime: event.target.value })}
            value={draft.resolutionTime}
          />
        </label>
      </div>
      <label>
        <span>Resolution source</span>
        <textarea
          onChange={(event) => updateDraft({ source: event.target.value })}
          rows={compact ? 3 : 4}
          value={draft.source}
        />
      </label>
      <label>
        <span>Draft criteria</span>
        <textarea
          onChange={(event) => updateDraft({ criteria: event.target.value })}
          rows={compact ? 4 : 6}
          value={draft.criteria}
        />
      </label>
    </div>
  );
}

interface SuggestionCardProps {
  applied: boolean;
  body: string;
  label: string;
  onApply: () => void;
}

function SuggestionCard({ applied, body, label, onApply }: SuggestionCardProps) {
  return (
    <article className={applied ? "suggestion-card applied" : "suggestion-card"}>
      <div>
        <span>{label}</span>
        <p>{body}</p>
      </div>
      <button className="secondary" disabled={applied} onClick={onApply} type="button">
        {applied ? "Applied" : "Apply"}
      </button>
    </article>
  );
}

interface ChecklistRowProps {
  checked: boolean;
  label: string;
}

function ChecklistRow({ checked, label }: ChecklistRowProps) {
  return (
    <div className="check-row">
      <span className={checked ? "check-dot checked" : "check-dot"}>{checked ? "✓" : "!"}</span>
      <span>{label}</span>
    </div>
  );
}

interface PreviewMiniProps {
  draft: MarketDraft;
}

function PreviewMini({ draft }: PreviewMiniProps) {
  return (
    <div className="mini-preview">
      <div className="card-topline">
        <span>{draft.category} / {draft.subcategory}</span>
        <span className="status-pill">Candidate market</span>
      </div>
      <h3>{draft.title}</h3>
      <p>{draft.criteria}</p>
    </div>
  );
}

interface ScreenKickerProps {
  label: string;
  title: string;
}

function ScreenKicker({ label, title }: ScreenKickerProps) {
  return (
    <div className="screen-kicker">
      <p className="eyebrow">{label}</p>
      <h1>{title}</h1>
    </div>
  );
}

export { App };
