import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchContradictionCandidates,
  resolveContradiction,
  type ContradictionCandidate,
} from "@/lib/api";
import { useApiConfig } from "@/lib/api-config";

function formatIso(value: number): string {
  return new Date(value).toISOString();
}

function confidenceBadge(confidence: number): string {
  if (confidence >= 0.8) return "bg-red-100 text-red-800 border-red-200";
  if (confidence >= 0.6) return "bg-yellow-100 text-yellow-800 border-yellow-200";
  return "bg-blue-100 text-blue-800 border-blue-200";
}

function typeLabel(type: string): string {
  return type === "belief_conflict" ? "Belief Conflict" : "Observer Flag";
}

export function ContradictionsPage(): JSX.Element {
  const { apiBaseUrl, apiKey } = useApiConfig();
  const [topic, setTopic] = useState("");
  const [confidenceMin, setConfidenceMin] = useState("0.3");
  const [limit, setLimit] = useState("25");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ContradictionCandidate[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      total: data.length,
      high: data.filter((c) => c.confidence >= 0.8).length,
      medium: data.filter((c) => c.confidence >= 0.5 && c.confidence < 0.8).length,
      low: data.filter((c) => c.confidence < 0.5).length,
      beliefConflicts: data.filter((c) => c.candidate_type === "belief_conflict").length,
    }),
    [data],
  );

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    setResolutionMessage(null);
    try {
      const response = await fetchContradictionCandidates({
        apiBaseUrl,
        apiKey,
        topic: topic || undefined,
        confidenceMin: confidenceMin ? Number(confidenceMin) : undefined,
        limit: limit ? Number(limit) : undefined,
      });
      setData(response.contradiction_candidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData([]);
    } finally {
      setLoading(false);
    }
  }

  async function resolve(
    candidateId: string,
    decision: "invalidate_belief" | "supersede_belief" | "keep_both",
  ): Promise<void> {
    setResolvingId(candidateId);
    setResolutionMessage(null);
    try {
      const result = await resolveContradiction({
        apiBaseUrl,
        apiKey,
        candidateId,
        decision,
      });
      setResolutionMessage(`Resolved: ${result.decision} (belief: ${result.target_belief_id ?? "n/a"})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingId(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Contradiction Resolution</CardTitle>
          <CardDescription>Review and resolve belief conflicts and observer flags.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-5">
          <Input placeholder="topic filter" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <Input
            placeholder="min confidence"
            value={confidenceMin}
            onChange={(e) => setConfidenceMin(e.target.value)}
          />
          <Input placeholder="limit" value={limit} onChange={(e) => setLimit(e.target.value)} />
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? "Loading..." : "Find Conflicts"}
          </Button>
        </CardContent>
      </Card>

      {resolutionMessage ? (
        <Alert className="border-green-200 bg-green-50">
          <AlertTitle>Resolution complete</AlertTitle>
          <AlertDescription>{resolutionMessage}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert className="border-red-200 bg-red-50">
          <AlertTitle>Failed to load</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">total: {stats.total}</Badge>
            <Badge className={confidenceBadge(0.9)}>high: {stats.high}</Badge>
            <Badge className={confidenceBadge(0.6)}>medium: {stats.medium}</Badge>
            <Badge className={confidenceBadge(0.3)}>low: {stats.low}</Badge>
            <Badge variant="outline">belief conflicts: {stats.beliefConflicts}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="all">
            <TabsList>
              <TabsTrigger value="all">All ({stats.total})</TabsTrigger>
              <TabsTrigger value="high">High ({stats.high})</TabsTrigger>
              <TabsTrigger value="belief">Belief Conflicts ({stats.beliefConflicts})</TabsTrigger>
            </TabsList>
            <TabsContent value="all">
              <CandidateList
                candidates={data}
                resolvingId={resolvingId}
                onResolve={resolve}
              />
            </TabsContent>
            <TabsContent value="high">
              <CandidateList
                candidates={data.filter((c) => c.confidence >= 0.8)}
                resolvingId={resolvingId}
                onResolve={resolve}
              />
            </TabsContent>
            <TabsContent value="belief">
              <CandidateList
                candidates={data.filter((c) => c.candidate_type === "belief_conflict")}
                resolvingId={resolvingId}
                onResolve={resolve}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function CandidateList({
  candidates,
  resolvingId,
  onResolve,
}: {
  candidates: ContradictionCandidate[];
  resolvingId: string | null;
  onResolve: (id: string, decision: "invalidate_belief" | "supersede_belief" | "keep_both") => void;
}): JSX.Element {
  const [selectedDecision, setSelectedDecision] = useState<
    Record<string, "invalidate_belief" | "supersede_belief" | "keep_both">
  >({});

  if (candidates.length === 0) {
    return <p className="text-sm text-muted">No contradiction candidates found.</p>;
  }

  return (
    <ScrollArea className="max-h-[540px] pr-2">
      <div className="space-y-3">
        {candidates.map((candidate) => (
          <Card key={candidate.id} className="border-l-4 border-l-red-400">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={confidenceBadge(candidate.confidence)}>
                  conf: {candidate.confidence.toFixed(2)}
                </Badge>
                <Badge variant="outline">{typeLabel(candidate.candidate_type)}</Badge>
                <span className="text-xs text-muted">{formatIso(candidate.detected_at)}</span>
              </div>
              <p className="mt-2 text-sm font-medium">{candidate.summary}</p>
              {candidate.topic ? <p className="text-xs text-muted">topic: {candidate.topic}</p> : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  className="flex h-10 w-44 items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={selectedDecision[candidate.id] || "keep_both"}
                  onChange={(e) =>
                    setSelectedDecision((prev) => ({
                      ...prev,
                      [candidate.id]: e.target.value as "invalidate_belief" | "supersede_belief" | "keep_both",
                    }))
                  }
                  disabled={resolvingId === candidate.id}
                >
                  <option value="keep_both">Keep Both</option>
                  <option value="invalidate_belief">Invalidate Belief</option>
                  <option value="supersede_belief">Supersede Belief</option>
                </select>
                <Button
                  className="h-8 px-3 text-xs"
                  onClick={() => onResolve(candidate.id, selectedDecision[candidate.id] || "keep_both")}
                  disabled={resolvingId === candidate.id}
                >
                  {resolvingId === candidate.id ? "Resolving..." : "Resolve"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}
