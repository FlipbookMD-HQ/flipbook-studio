import type { ApiError, ErrorCode } from "../shared/api.js";

type Status = 400 | 403 | 404 | 409 | 413 | 422 | 500;

/** A typed error the API maps to `{ error: { code, message, path?, details? } }`. */
export class StudioError extends Error {
  readonly status: Status;
  readonly code: ErrorCode;
  readonly path?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: Status,
    code: ErrorCode,
    message: string,
    extra: { path?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.path = extra.path;
    this.details = extra.details;
  }

  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.path ? { path: this.path } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
