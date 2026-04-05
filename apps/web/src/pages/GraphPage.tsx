import { useEffect, useMemo, useState } from "react";

import { MetricChips } from "@/components/MetricChips";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchBeliefSubgraph, type BeliefSubgraphResponse } from "@/lib/api";
import { useApiConfig } from "@/lib/api-config";

function formatIso(value: number): string {
  return new Date(value).toISOString();
}

export function GraphPage(): JSX.Element {
  const { apiBaseUrl, apiKey } = useApiConfig();
  const [topic, setTopic] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [confidenceMin, setConfidenceMin] = useState("0.3");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BeliefSubgraphResponse | null>(null);

  const stats = useMemo(
    () => [
      { label: "nodes", value: data?.stats.node_count ?? 0 },
      { label: "edges", value: data?.stats.edge_count ?? 0 },
      { label: "topic", value: data?.filters.topic ?? "all" },
    ],
    [data],
  );

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchBeliefSubgraph({
        apiBaseUrl,
        apiKey,
        topic: topic || undefined,
        timeFrom: timeFrom ? Number(timeFrom) : undefined,
        timeTo: timeTo ? Number(timeTo) : undefined,
        confidenceMin: confidenceMin ? Number(confidenceMin) : undefined,
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
          <CardTitle>Graph Explorer</CardTitle>
          <CardDescription>Subgraph with shadcn-style components and explicit node/edge cues.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-5">
          <Input placeholder="topic" value={topic} onChange={(event) => setTopic(event.target.value)} />
          <Input
            placeholder="time from (ms)"
            value={timeFrom}
            onChange={(event) => setTimeFrom(event.target.value)}
          />
          <Input placeholder="time to (ms)" value={timeTo} onChange={(event) => setTimeTo(event.target.value)} />
          <Input
            placeholder="confidence min"
            value={confidenceMin}
            onChange={(event) => setConfidenceMin(event.target.value)}
          />
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? "Loading..." : "Load Subgraph"}
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <Alert className="border-red-200 bg-red-50">
          <AlertTitle>Failed to load graph</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <MetricChips items={stats} />
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Nodes</h3>
            <ScrollArea>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Label</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Recency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.nodes ?? []).map((node) => (
                    <TableRow key={node.id}>
                      <TableCell>{node.label}</TableCell>
                      <TableCell>
                        <Badge>{node.node_type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{node.kind}</Badge>
                      </TableCell>
                      <TableCell className="mono text-xs">{formatIso(node.valid_from)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">Edges</h3>
            <ScrollArea>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Link</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Predicate</TableHead>
                    <TableHead>Confidence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.edges ?? []).map((edge) => (
                    <TableRow key={edge.id}>
                      <TableCell className="mono text-xs">
                        {edge.src_id.slice(0, 10)} → {edge.dst_id.slice(0, 10)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{edge.edge_type}</Badge>
                      </TableCell>
                      <TableCell>{edge.predicate}</TableCell>
                      <TableCell>{typeof edge.confidence === "number" ? edge.confidence.toFixed(2) : "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
