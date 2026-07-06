export class HarnessError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}

export function toErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof HarnessError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      details: error.details ?? null
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      code: "unexpected_error",
      message: error.message
    };
  }

  return {
    ok: false,
    code: "unexpected_error",
    message: String(error)
  };
}
