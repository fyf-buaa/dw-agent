export class ExecutorError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
		super(message);
		this.name = "ExecutorError";
		this.code = code;
		this.retryable = retryable;
		this.details = details;
	}
}

export function errorPayload(error: unknown): {
	code: string;
	message: string;
	retryable: boolean;
	details?: Record<string, unknown>;
} {
	if (error instanceof ExecutorError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
			...(error.details ? { details: error.details } : {}),
		};
	}
	return { code: "INTERNAL_ERROR", message: "The executor could not complete the operation", retryable: false };
}
