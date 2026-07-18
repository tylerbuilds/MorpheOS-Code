export type CorpusWorkloadType =
  | "book_reading"
  | "ocr"
  | "translation"
  | "dataset_transform"
  | "longform_generation"
  | "media_catalogue"
  | "mixed"
  | (string & {});

export interface CorpusValidationRecordLike {
  id?: unknown;
  shard_id?: unknown;
  bounds?: unknown;
  [key: string]: unknown;
}

export interface CorpusWorkloadValidationInput {
  workload_type: CorpusWorkloadType;
  shards?: readonly CorpusValidationRecordLike[];
  ledgerShards?: readonly CorpusValidationRecordLike[];
}

type ValidationSource = "manifest" | "ledger";

interface ValidationRecord {
  source: ValidationSource;
  index: number;
  record: CorpusValidationRecordLike;
}

export function validateCorpusWorkload(input: CorpusWorkloadValidationInput): string[] {
  const records = [
    ...(input.shards ?? []).map((record, index) => ({ source: "manifest" as const, index, record })),
    ...(input.ledgerShards ?? []).map((record, index) => ({ source: "ledger" as const, index, record }))
  ];

  switch (input.workload_type) {
    case "book_reading":
      return records.flatMap(validateBookReadingRecord);
    case "dataset_transform":
      return records.flatMap(validateDatasetTransformRecord);
    case "media_catalogue":
      return records.flatMap(validateMediaCatalogueRecord);
    case "translation":
      return records.flatMap(validateTranslationRecord);
    default:
      return [];
  }
}

function validateBookReadingRecord(record: ValidationRecord): string[] {
  const bounds = asRecord(record.record.bounds);
  if (!bounds || (!hasKnownValue(bounds, "chapter") && !hasPageBounds(bounds))) {
    return [`book_reading_missing_chapter_or_page_bounds:${recordLabel(record)}`];
  }
  return [];
}

function validateDatasetTransformRecord(record: ValidationRecord): string[] {
  const fields = mergedFieldView(record.record);
  const blockers: string[] = [];
  const hasRowStart = hasKnownValue(fields, "row_start");
  const hasRowEnd = hasKnownValue(fields, "row_end");

  if (!hasRowStart || !hasRowEnd) {
    blockers.push(`dataset_transform_missing_row_bounds:${recordLabel(record)}`);
  }

  const rowStart = numberField(fields, "row_start");
  const rowEnd = numberField(fields, "row_end");
  const rowCount = numberField(fields, "row_count");
  if (rowStart !== undefined && rowEnd !== undefined && rowCount !== undefined) {
    const expectedRowCount = rowEnd - rowStart + 1;
    if (expectedRowCount !== rowCount) {
      blockers.push(`dataset_transform_row_count_mismatch:${recordLabel(record)}:expected:${expectedRowCount}:actual:${rowCount}`);
    }
  }

  return blockers;
}

function validateMediaCatalogueRecord(record: ValidationRecord): string[] {
  if (!hasMediaSidecar(record.record)) {
    return [];
  }

  const fields = mergedFieldView(record.record);
  const blockers: string[] = [];
  if (!hasAnyKnownValue(fields, ["duration", "duration_seconds", "duration_ms"])) {
    blockers.push(`media_catalogue_missing_duration:${recordLabel(record)}`);
  }
  if (!hasAnyKnownValue(fields, ["hash", "sha256", "content_hash", "sidecar_hash", "sidecar_sha256"])) {
    blockers.push(`media_catalogue_missing_hash:${recordLabel(record)}`);
  }
  return blockers;
}

function validateTranslationRecord(record: ValidationRecord): string[] {
  if (!hasTranslationBounds(record.record)) {
    return [];
  }

  const fields = mergedFieldView(record.record);
  const blockers: string[] = [];
  if (!hasKnownValue(fields, "source_lang")) {
    blockers.push(`translation_missing_source_lang:${recordLabel(record)}`);
  }
  if (!hasKnownValue(fields, "target_lang")) {
    blockers.push(`translation_missing_target_lang:${recordLabel(record)}`);
  }
  return blockers;
}

function hasPageBounds(bounds: Record<string, unknown>): boolean {
  return (
    hasKnownValue(bounds, "page") ||
    hasKnownValue(bounds, "page_number") ||
    (hasKnownValue(bounds, "page_start") && hasKnownValue(bounds, "page_end"))
  );
}

function hasMediaSidecar(record: CorpusValidationRecordLike): boolean {
  const fields = mergedFieldView(record);
  if (asRecord(record.sidecar)) {
    return true;
  }
  return hasAnyKnownValue(fields, ["sidecar_path", "sidecar", "duration", "duration_seconds", "duration_ms", "hash", "sidecar_hash"]);
}

function hasTranslationBounds(record: CorpusValidationRecordLike): boolean {
  const fields = mergedFieldView(record);
  return Boolean(asRecord(record.bounds)) || hasAnyKnownValue(fields, ["source_lang", "target_lang"]);
}

function mergedFieldView(record: CorpusValidationRecordLike): Record<string, unknown> {
  const bounds = asRecord(record.bounds);
  const sidecar = asRecord(record.sidecar);
  return { ...record, ...(bounds ?? {}), ...(sidecar ?? {}) };
}

function recordLabel(record: ValidationRecord): string {
  const id = stringField(record.record, "id") ?? stringField(record.record, "shard_id");
  return id ?? `${record.source}[${record.index}]`;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasAnyKnownValue(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => hasKnownValue(record, key));
}

function hasKnownValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value !== undefined && value !== null && value !== "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
