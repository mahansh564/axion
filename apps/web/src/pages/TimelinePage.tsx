import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchTimelineEvents, type TimelineEventsResponse } from "@/lib/api";
import { useApiConfig } from "@/lib/api-config";

function formatIso(value: number): string {
  return new Date(value).toISOString();
}

export function TimelinePage(): JSX.Element {
  const { apiBaseUrl, apiKey } = useApiConfig();
  const [topic, setTopic] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TimelineEventsResponse | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchTimelineEvents({
        apiBaseUrl,
        apiKey,
        topic: topic || undefined,
        timeFrom: timeFrom ? Number(timeFrom) : undefined,
        timeTo: timeTo ? Number(timeTo) : undefined,
      });
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
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
          <CardTitle>Belief + Activity Timeline</CardTitle>
          <CardDescription>Beliefs and major ingest/research markers.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <Input placeholder="topic" value={topic} onChange={(event) => setTopic(event.target.value)} />
          <Input
            placeholder="time from (ms)"
            value={timeFrom}
            onChange={(event) => setTimeFrom(event.target.value)}
          />
          <Input placeholder="time to (ms)" value={timeTo} onChange={(event) => setTimeTo(event.target.value)} />
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? "Loading..." : "Load Timeline"}
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <Alert className="border-red-200 bg-red-50">
          <AlertTitle>Failed to load timeline</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="pt-4">
          <ScrollArea className="max-h-[540px] pr-2">
            <ol className="space-y-3">
              {(data?.events ?? []).map((event) => (
                <li key={event.id} className="rounded-lg border border-border bg-white p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{event.title}</p>
                    <Badge variant={event.kind === "belief_record" ? "default" : "secondary"}>{event.kind}</Badge>
                    <Badge variant="outline">{event.event_type}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted">{formatIso(event.occurred_at)}</p>
                  <p className="mt-1 text-xs text-muted">
                    {event.topic ? `topic: ${event.topic}` : "topic: n/a"}
                    {typeof event.confidence === "number" ? ` · confidence: ${event.confidence.toFixed(2)}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
