type ClassValue = string | undefined | null | false;

export function cn(...values: ClassValue[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
}
