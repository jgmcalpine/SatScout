import { z } from "zod";

export const WorkflowStateSchema = z.enum([
  "WAITING",
  "AVAILABLE",
  "CARTING",
  "CART_HELD",
  "PAYMENT_REQUESTED",
  "PAYMENT_AUTHORIZED",
  "CARD_ACQUIRED",
  "CHECKOUT",
  "CONFIRMED",
  "PAUSED",
  "FAILED",
  "EXPIRED",
  "ABORTED",
]);

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

const terminalStates = new Set<WorkflowState>(["CONFIRMED", "FAILED", "EXPIRED", "ABORTED"]);

const allowedTransitions: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  WAITING: ["AVAILABLE", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  AVAILABLE: ["WAITING", "CARTING", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  CARTING: ["CART_HELD", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  CART_HELD: ["PAYMENT_REQUESTED", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  PAYMENT_REQUESTED: ["PAYMENT_AUTHORIZED", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  PAYMENT_AUTHORIZED: ["CARD_ACQUIRED", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  CARD_ACQUIRED: ["CHECKOUT", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  CHECKOUT: ["CONFIRMED", "PAUSED", "FAILED", "EXPIRED", "ABORTED"],
  PAUSED: ["WAITING", "FAILED", "EXPIRED", "ABORTED"],
  CONFIRMED: [],
  FAILED: [],
  EXPIRED: [],
  ABORTED: [],
};

export type WorkflowTransitionResult =
  | {
      readonly outcome: "transitioned";
      readonly previousState: WorkflowState;
      readonly newState: WorkflowState;
    }
  | {
      readonly outcome: "idempotent";
      readonly previousState: WorkflowState;
      readonly newState: WorkflowState;
      readonly reason: string;
    }
  | {
      readonly outcome: "rejected";
      readonly previousState: WorkflowState;
      readonly requestedState: WorkflowState;
      readonly code: "ILLEGAL_TRANSITION" | "TERMINAL_STATE";
      readonly reason: string;
    };

export function transitionWorkflow(
  currentState: WorkflowState,
  requestedState: WorkflowState,
): WorkflowTransitionResult {
  if (currentState === requestedState) {
    return {
      outcome: "idempotent",
      previousState: currentState,
      newState: currentState,
      reason: `Workflow is already in ${currentState}`,
    };
  }

  if (terminalStates.has(currentState)) {
    return {
      outcome: "rejected",
      previousState: currentState,
      requestedState,
      code: "TERMINAL_STATE",
      reason: `${currentState} is terminal and cannot transition to ${requestedState}`,
    };
  }

  if (!allowedTransitions[currentState].includes(requestedState)) {
    return {
      outcome: "rejected",
      previousState: currentState,
      requestedState,
      code: "ILLEGAL_TRANSITION",
      reason: `Transition from ${currentState} to ${requestedState} is not allowed`,
    };
  }

  return {
    outcome: "transitioned",
    previousState: currentState,
    newState: requestedState,
  };
}

export function isTerminalWorkflowState(state: WorkflowState): boolean {
  return terminalStates.has(state);
}

export function getAllowedTransitions(state: WorkflowState): readonly WorkflowState[] {
  return allowedTransitions[state];
}
