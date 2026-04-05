import { Badge } from "@/components/ui/badge";

export function MetricChips({ items }: { items: Array<{ label: string; value: string | number }> }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={item.label} variant="secondary">
          {item.label}: {item.value}
        </Badge>
      ))}
    </div>
  );
}
