import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchStaleEdgeCandidates,
  resolveStaleEdge,
  type RefreshDecision,
  type StaleEdgeCandidate,
} from "@/lib/api";
import { useApiConfig } from "@/lib/api-config";

function formatIso(value: number): string {
  return new Date(value).toISOString();
}

function severityColor(severity: string): string {
  switch (severity) {
    case "high":
      return "bg-red-100 text-red-800 border-red-200";
    case "medium":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    default:
      return "bg-blue-100 text-blue-800 border-blue-200";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "expired_belief":
      return "Expired";
    case "unsuperseded_expired":
      return "No Successor";
    case "research_contradiction":
      return "Contradiction";
    case "stale_edge":
      return "Stale Edge";
    default:
      return type;
  }
}

export function StaleEdgePage(): JSX.Element {
  const { apiBaseUrl, apiKey } = useApiConfig();
  const [topic, setTopic] = useState("");
  const [minConfidence, setMinConfidence] = useState("0.3");
  const [staleDays, setStaleDays] = useState("90");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StaleEdgeCandidate[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      total: data.length,
      high: data.filter((c) => c.severity === "high").length,
      medium: data.filter((c) => c.severity === "medium").length,
      low: data.filter((c) => c.severity === "low").length,
    }),
    [data],
  );

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    setResolutionMessage(null);
    try {
      const response = await fetchStaleEdgeCandidates({
        apiBaseUrl,
        apiKey,
        topic: topic || undefined,
        minConfidence: minConfidence ? Number(minConfidence) : undefined,
        staleDays: staleDays ? Number(staleDays) : undefined,
      });
      setData(response.stale_candidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData([]);
    } finally {
      setLoading(false);
    }
  }

  async function resolve(candidateId: string, decision: RefreshDecision): Promise<void> {
    setResolvingId(candidateId);
    setResolutionMessage(null);
    try {
      const result = await resolveStaleEdge({
        apiBaseUrl,
        apiKey,
        candidateId,
        decision,
      });
      setResolutionMessage(`Resolved: ${result.actions_taken.join(", ") || "no action"}`);
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
          <CardTitle>Stale Edge Detection</CardTitle>
          <CardDescription>Identify and resolve stale beliefs, edges, and research contradictions.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-5">
          <Input placeholder="topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <Input
            placeholder="min confidence"
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value)}
          />
          <Input placeholder="stale days" value={staleDays} onChange={(e) => setStaleDays(e.target.value)} />
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? "Loading..." : "Detect Stale"}
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
            <Badge className={severityColor("high")}>high: {stats.high}</Badge>
            <Badge className={severityColor("medium")}>medium: {stats.medium}</Badge>
            <Badge className={severityColor("low")}>low: {stats.low}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="all">
            <TabsList>
              <TabsTrigger value="all">All ({stats.total})</TabsTrigger>
              <TabsTrigger value="high">High ({stats.high})</TabsTrigger>
              <TabsTrigger value="medium">Medium ({stats.medium})</TabsTrigger>
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
                candidates={data.filter((c) => c.severity === "high")}
                resolvingId={resolvingId}
                onResolve={resolve}
              />
            </TabsContent>
            <TabsContent value="medium">
              <CandidateList
                candidates={data.filter((c) => c.severity === "medium")}
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
  candidates: StaleEdgeCandidate[];
  resolvingId: string | null;
  onResolve: (id: string, decision: RefreshDecision) => void;
}): JSX.Element {
  const [selectedDecision, setSelectedDecision] = useState<Record<string, RefreshDecision>>({});

  if (candidates.length === 0) {
    return <p className="text-sm text-muted">No stale edge candidates found.</p>;
  }

  return (
    <ScrollArea className="max-h-[540px] pr-2">
      <div className="space-y-3">
        {candidates.map((candidate) => (
          <Card key={candidate.id} className="border-l-4 border-l-yellow-400">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-start gap-2">
                <Badge className={severityColor(candidate.severity)}>{candidate.severity}</Badge>
                <Badge variant="outline">{typeLabel(candidate.candidate_type)}</Badge>
                <span className="text-xs text-muted">{formatIso(candidate.detected_at)}</span>
              </div>
              <p className="mt-2 text-sm font-medium">{candidate.summary}</p>
              {candidate.topic ? <p className="text-xs text-muted">topic: {candidate.topic}</p> : null}
              <p className="text-xs text-muted">confidence: {candidate.confidence.toFixed(2)}</p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  className="flex h-10 w-40 items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={selectedDecision[candidate.id] || "ignore"}
                  onChange={(e) =>
                    setSelectedDecision((prev) => ({ ...prev, [candidate.id]: e.target.value as RefreshDecision }))
                  }
                  disabled={resolvingId === candidate.id}
                >
                  <option value="ignore">Ignore</option>
                  <option value="refresh_belief">Refresh Belief</option>
                  <option value="archive_belief">Archive</option>
                  <option value="schedule_research">Schedule Research</option>
                </select>
                <Button
                  className="h-8 px-3 text-xs"
                  onClick={() => onResolve(candidate.id, selectedDecision[candidate.id] || "ignore")}
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
