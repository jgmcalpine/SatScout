import { describe, expect, it } from "vitest";

import type { WorkflowState } from "../src/domain/workflow/workflow.js";
import { transitionWorkflow } from "../src/domain/workflow/workflow.js";

describe("workflow state machine", () => {
  it("accepts every happy-path transition", () => {
    const path: readonly WorkflowState[] = [
      "WAITING",
      "AVAILABLE",
      "CARTING",
      "CART_HELD",
      "PAYMENT_REQUESTED",
      "PAYMENT_AUTHORIZED",
      "CARD_ACQUIRED",
      "CHECKOUT",
      "CONFIRMED",
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      const current = path[index];
      const next = path[index + 1];
      expect(current).toBeDefined();
      expect(next).toBeDefined();
      expect(transitionWorkflow(current as WorkflowState, next as WorkflowState).outcome).toBe(
        "transitioned",
      );
    }
  });

  it("rejects an illegal state skip", () => {
    const result = transitionWorkflow("WAITING", "CART_HELD");
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it.each<WorkflowState>(["CONFIRMED", "FAILED", "EXPIRED", "ABORTED"])(
    "treats %s as terminal",
    (state) => {
      const result = transitionWorkflow(state, "WAITING");
      expect(result.outcome).toBe("rejected");
      if (result.outcome === "rejected") {
        expect(result.code).toBe("TERMINAL_STATE");
      }
    },
  );

  it("handles duplicate events as an idempotent no-op", () => {
    expect(transitionWorkflow("AVAILABLE", "AVAILABLE")).toEqual({
      outcome: "idempotent",
      previousState: "AVAILABLE",
      newState: "AVAILABLE",
      reason: "Workflow is already in AVAILABLE",
    });
  });
});
