/** Host authorization runs after extension handlers for direct and nested calls. */
export interface HostToolCall {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	parentToolCallId?: string;
}

export type HostToolGuard = (
	call: HostToolCall,
	signal?: AbortSignal,
) => Promise<{ block: true; reason: string } | undefined>;

/** A host-owned request budget shared by the loop, session continuations and model runtime. */
export class ExecutionPolicy {
	mode: "chat" | "agent";
	active = false;
	modelCalls = 0;
	maxModelCalls = 1;
	pauseRequested = false;
	stopped = false;
	pausedReason: "mode_switch" | "budget_exhausted" | undefined;
	authorizeToolCall?: HostToolGuard;

	constructor(mode: "chat" | "agent" = "chat") {
		this.mode = mode;
	}

	begin(mode: "chat" | "agent", maxModelCalls = 32): void {
		if (this.active) throw new Error("An execution policy is already active");
		if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1) throw new Error("Invalid model call budget");
		this.mode = mode;
		this.maxModelCalls = mode === "chat" ? 1 : maxModelCalls;
		this.modelCalls = 0;
		this.pauseRequested = false;
		this.pausedReason = undefined;
		this.stopped = false;
		this.active = true;
	}

	beforeModelRequest(): void {
		if (!this.active || this.stopped || this.modelCalls >= this.maxModelCalls) {
			throw new Error("LLM_CALL_BUDGET_EXCEEDED: no model request is permitted in this execution scope");
		}
		this.modelCalls++;
	}

	/** Called only after the assistant and its complete tool batch have been persisted. */
	finishTurn(hasContinuation: boolean): boolean {
		if (this.mode !== "chat" && !this.pauseRequested && this.modelCalls < this.maxModelCalls) return false;
		this.stopped = true;
		if (this.mode === "agent" && hasContinuation) {
			this.pausedReason = this.pauseRequested ? "mode_switch" : "budget_exhausted";
		}
		return true;
	}

	end(): void {
		this.active = false;
		this.stopped = true;
	}
}
