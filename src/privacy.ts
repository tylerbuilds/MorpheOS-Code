export type EgressClass =
  | "non_sensitive_bulk"
  | "local_private"
  | "personal_sensitive"
  | "client_sensitive"
  | "health_genetics"
  | "secrets_or_credentials";

export interface PrivacyFinding {
  item_id: string;
  category: EgressClass;
  signal: string;
  severity: "warning" | "blocker";
}

export interface PrivacyReport {
  schema_version: "deepseek-harness.privacy-report.v1";
  recommended_egress_class: EgressClass;
  external_deepseek_allowed: boolean;
  findings: PrivacyFinding[];
}

interface ManifestLike {
  items: Array<{
    id: string;
    prompt?: string;
    messages?: Array<{ content: string }>;
    metadata?: Record<string, unknown>;
  }>;
}

const CLASS_RANK: Record<EgressClass, number> = {
  non_sensitive_bulk: 0,
  local_private: 1,
  personal_sensitive: 2,
  client_sensitive: 3,
  health_genetics: 4,
  secrets_or_credentials: 5
};

const SECRET_SIGNALS: Array<[RegExp, string]> = [
  [/\b(api[\s_-]?key|secret|password|passwd|private[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token)\b/i, "credential_label"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, "bearer_token"],
  [/\b(sk|ghp|gho|github_pat)_[A-Za-z0-9_]{16,}/i, "token_prefix"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/i, "private_key_block"]
];

const HEALTH_SIGNALS: Array<[RegExp, string]> = [
  [/\bnhs\s*(number|no\.?|id)\b/i, "nhs_identifier"],
  [/\b(patient|medical)\s*(id|record|number|file)\b/i, "medical_identifier"],
  [/\b(date of birth|dob)\b/i, "date_of_birth"],
  [/\b(genetic|genome|dna|biopsy|diagnosis|prescription)\b/i, "health_record_indicator"]
];

const PERSONAL_SIGNALS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, "email_address"],
  [/\b(\+44|0)7\d{9}\b/i, "uk_mobile_number"],
  [/\b(postcode|home address|passport|driving licence|national insurance)\b/i, "personal_identifier"]
];

const CLIENT_SIGNALS: Array<[RegExp, string]> = [
  [/\b(client confidential|customer data|nda|commercially sensitive)\b/i, "client_confidentiality_marker"],
  [/\b(stripe customer|hubspot contact|salesforce account)\b/i, "customer_system_record"]
];

export function classifyManifestPrivacy(manifest: ManifestLike): PrivacyReport {
  const findings = manifest.items.flatMap((item) => classifyText(item.id, itemText(item)));
  const recommended = findings.reduce<EgressClass>((current, finding) => {
    return CLASS_RANK[finding.category] > CLASS_RANK[current] ? finding.category : current;
  }, "non_sensitive_bulk");

  return {
    schema_version: "deepseek-harness.privacy-report.v1",
    recommended_egress_class: recommended,
    external_deepseek_allowed: recommended === "non_sensitive_bulk",
    findings
  };
}

function classifyText(itemId: string, text: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  pushMatches(findings, itemId, text, SECRET_SIGNALS, "secrets_or_credentials", "blocker");
  pushMatches(findings, itemId, text, HEALTH_SIGNALS, "health_genetics", "blocker");
  pushMatches(findings, itemId, text, CLIENT_SIGNALS, "client_sensitive", "blocker");
  pushMatches(findings, itemId, text, PERSONAL_SIGNALS, "personal_sensitive", "blocker");
  return findings;
}

function pushMatches(
  findings: PrivacyFinding[],
  itemId: string,
  text: string,
  signals: Array<[RegExp, string]>,
  category: EgressClass,
  severity: PrivacyFinding["severity"]
): void {
  for (const [pattern, signal] of signals) {
    if (pattern.test(text)) {
      findings.push({ item_id: itemId, category, signal, severity });
    }
  }
}

function itemText(item: ManifestLike["items"][number]): string {
  const prompt = item.prompt ?? "";
  const messages = item.messages?.map((message) => message.content).join("\n") ?? "";
  const metadata = item.metadata ? JSON.stringify(item.metadata) : "";
  return [prompt, messages, metadata].filter(Boolean).join("\n");
}
