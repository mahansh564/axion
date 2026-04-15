import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchCuriositySuggestions, type CuriositySuggestion } from "@/lib/api";
import { useApiConfig } from "@/lib/api-config";

function formatIso(value: number): string {
  return new Date(value).toISOString();
}

function signalLabel(signalType: string): string {
  const labels: Record<string, string> = {
    dormant_open_question: "Dormant Question",
    recurring_topic: "Recurring Topic",
    repeated_confusion_phrase: "Confusion Pattern",
    conversation_gap: "Conversation Gap",
    unanswered_question: "Unanswered Q",
    follow_up_needed: "Follow-up Needed",
  };
  return labels[signalType] || signalType;
}

function suggestionLabel(type: string): string {
  return type === "research_task" ? "Research" : "Reflect";
}

function scoreColor(score: number): string {
  if (score >= 0.8) return "bg-red-100 text-red-800 border-red-200";
  if (score >= 0.6) return "bg-yellow-100 text-yellow-800 border-yellow-200";
  return "bg-blue-100 text-blue-800 border-blue-200";
}

export function CuriosityPage(): JSX.Element {
  const { apiBaseUrl, apiKey } = useApiConfig();
  const [topic, setTopic] = useState("");
  const [minScore, setMinScore] = useState("0.3");
  const [dormantDays, setDormantDays] = useState("7");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CuriositySuggestion[]>([]);

  const stats = useMemo(
    () => ({
      total: data.length,
      research: data.filter((s) => s.suggestion_type === "research_task").length,
      reflection: data.filter((s) => s.suggestion_type === "reflection_prompt").length,
      highScore: data.filter((s) => s.score >= 0.8).length,
    }),
    [data],
  );

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchCuriositySuggestions({
        apiBaseUrl,
        apiKey,
        topic: topic || undefined,
        minScore: minScore ? Number(minScore) : undefined,
        dormantDays: dormantDays ? Number(dormantDays) : undefined,
      });
      setData(response.suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Curiosity Engine</CardTitle>
          <CardDescription>Suggestions for research and reflection based on conversation patterns.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-5">
          <Input placeholder="topic filter" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <Input placeholder="min score" value={minScore} onChange={(e) => setMinScore(e.target.value)} />
          <Input placeholder="dormant days" value={dormantDays} onChange={(e) => setDormantDays(e.target.value)} />
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? "Loading..." : "Get Suggestions"}
          </Button>
        </CardContent>
      </Card>

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
            <Badge className="bg-purple-100 text-purple-800 border-purple-200">research: {stats.research}</Badge>
            <Badge className="bg-teal-100 text-teal-800 border-teal-200">reflection: {stats.reflection}</Badge>
            <Badge className={scoreColor(0.9)}>high score: {stats.highScore}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="all">
            <TabsList>
              <TabsTrigger value="all">All ({stats.total})</TabsTrigger>
              <TabsTrigger value="research">Research ({stats.research})</TabsTrigger>
              <TabsTrigger value="reflection">Reflection ({stats.reflection})</TabsTrigger>
            </TabsList>
            <TabsContent value="all">
              <SuggestionList suggestions={data} />
            </TabsContent>
            <TabsContent value="research">
              <SuggestionList suggestions={data.filter((s) => s.suggestion_type === "research_task")} />
            </TabsContent>
            <TabsContent value="reflection">
              <SuggestionList suggestions={data.filter((s) => s.suggestion_type === "reflection_prompt")} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function SuggestionList({ suggestions }: { suggestions: CuriositySuggestion[] }): JSX.Element {
  if (suggestions.length === 0) {
    return <p className="text-sm text-muted">No curiosity suggestions found.</p>;
  }

  return (
    <ScrollArea className="max-h-[540px] pr-2">
      <div className="space-y-3">
        {suggestions.map((suggestion) => (
          <Card key={suggestion.id} className="border-l-4 border-l-purple-400">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={scoreColor(suggestion.score)}>score: {suggestion.score.toFixed(2)}</Badge>
                <Badge variant="outline">{suggestionLabel(suggestion.suggestion_type)}</Badge>
                <Badge variant="secondary">{signalLabel(suggestion.signal_type)}</Badge>
                <span className="text-xs text-muted">{formatIso(suggestion.detected_at)}</span>
              </div>
              <p className="mt-2 text-sm font-medium">{suggestion.topic}</p>
              <p className="text-sm text-muted">{suggestion.prompt}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}
