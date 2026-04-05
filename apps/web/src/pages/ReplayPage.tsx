import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchReplay, type ReplayResponse } from "@/lib/api";
import { useApiConfig } from "@/lib/api-config";

function formatIso(value: number): string {
  return new Date(value).toISOString();
}

type StreamItem = {
  id: string;
  kind: "step" | "event" | "artifact";
  label: string;
  timestamp: number;
};

export function ReplayPage(): JSX.Element {
  const { apiBaseUrl, apiKey } = useApiConfig();
  const { runId: runIdParam } = useParams<{ runId: string }>();
  const [runId, setRunId] = useState(runIdParam ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReplayResponse | null>(null);

  async function load(): Promise<void> {
    if (!runId.trim()) {
      setError("run id required");
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetchReplay({ apiBaseUrl, apiKey, runId });
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (runIdParam) {
      setRunId(runIdParam);
      void load();
    }
  }, [runIdParam]);

  const stream = useMemo<StreamItem[]>(() => {
    if (!data) return [];
    const stepItems: StreamItem[] = data.steps.map((step) => ({
      id: `step:${step.id}`,
      kind: "step",
      label: `${step.title} (${step.kind})`,
      timestamp: step.created_at,
    }));
    const eventItems: StreamItem[] = data.events.map((event) => ({
      id: `event:${event.id}`,
      kind: "event",
      label: event.event_type,
      timestamp: event.created_at,
    }));
    const artifactItems: StreamItem[] = data.artifacts.map((artifact) => ({
      id: `artifact:${artifact.id}`,
      kind: "artifact",
      label: artifact.title ? `${artifact.kind}: ${artifact.title}` : artifact.kind,
      timestamp: artifact.retrieved_at,
    }));
    return [...stepItems, ...eventItems, ...artifactItems].sort((a, b) => a.timestamp - b.timestamp);
  }, [data]);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Research Replay</CardTitle>
          <CardDescription>Read-only narrative from run steps, events, and artifacts.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Input placeholder="run id" value={runId} onChange={(event) => setRunId(event.target.value)} />
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? "Loading..." : "Load Replay"}
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <Alert className="border-red-200 bg-red-50">
          <AlertTitle>Failed to load replay</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">run: {data?.run.id ?? "n/a"}</Badge>
            <Badge variant="secondary">status: {data?.run.status ?? "n/a"}</Badge>
            <Badge variant="secondary">steps: {data?.steps.length ?? 0}</Badge>
            <Badge variant="secondary">artifacts: {data?.artifacts.length ?? 0}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="narrative">
            <TabsList>
              <TabsTrigger value="narrative">Narrative</TabsTrigger>
              <TabsTrigger value="raw">Raw Counts</TabsTrigger>
            </TabsList>
            <TabsContent value="narrative">
              <ScrollArea className="max-h-[540px] pr-2">
                <ol className="space-y-2">
                  {stream.map((item) => (
                    <li key={item.id} className="rounded-md border border-border bg-white p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>{item.kind}</Badge>
                        <span className="text-sm">{item.label}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted">{formatIso(item.timestamp)}</p>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="raw">
              <p className="text-sm text-muted">{JSON.stringify({ steps: data?.steps.length ?? 0, events: data?.events.length ?? 0, artifacts: data?.artifacts.length ?? 0 })}</p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
