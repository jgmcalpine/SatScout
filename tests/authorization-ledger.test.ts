import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SpendController } from "../src/application/spend-controller.js";
import { digestResolvedAction } from "../src/domain/economy/resolved-action.js";
import { AuthorizationLifecycleError } from "../src/domain/economy/lifecycle.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { SatScoutStore } from "../src/persistence/store.js";
import {
  fixedNow,
  validInstrumentResolved,
  validMerchantResolved,
  validMission,
  validPermitV2,
  validTransferResolved,
} from "./fixtures.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-auth-"));
  return { directory, path: join(directory, "state.sqlite") };
}

function openStore(path: string): SatScoutStore {
  const store = new SatScoutStore(path, { clock: () => fixedNow });
  store.initialize();
  return store;
}

function activatedController(path: string): {
  readonly store: SatScoutStore;
  readonly controller: SpendController;
} {
  const store = openStore(path);
  store.createMission(validMission());
  store.createPermit(validPermitV2());
  store.activatePermit("permit-v2-1");
  return {
    store,
    controller: new SpendController(store, { allowSimulatedSpend: true }),
  };
}

describe("atomic Authorization and ledger usage", () => {
  it("does not reserve authority during preview", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const preview = controller.preview(validMerchantResolved());
      expect(preview.outcome).toBe("ALLOW");
      expect(store.listAuthorizationsForPermit("permit-v2-1")).toHaveLength(0);
      const usage = controller.usage("permit-v2-1");
      expect(usage.grants.find((grant) => grant.grantId === "grant-merchant")?.executionsReserved).toBe(
        0,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("reserves authority only when authorize succeeds", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const result = controller.authorize(validMerchantResolved());
      expect(result.decision.outcome).toBe("ALLOW");
      expect(result.authorization?.status).toBe("AUTHORIZED");
      expect(result.authorization?.resolvedActionDigest).toBe(
        digestResolvedAction(validMerchantResolved()),
      );
      expect(result.authorization?.externalActionAttempted).toBe(false);
      const usage = controller.usage("permit-v2-1");
      expect(usage.grants.find((grant) => grant.grantId === "grant-merchant")?.executionsReserved).toBe(
        1,
      );
      expect(usage.grants.find((grant) => grant.grantId === "grant-merchant")?.amountReserved).toBe(
        6_842,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("denies a second execution when maxExecutions is 1", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      expect(controller.authorize(validMerchantResolved()).authorization).toBeDefined();
      const second = controller.authorize(validMerchantResolved({ amount: 1_000 }));
      expect(second.authorization).toBeUndefined();
      expect(second.decision.outcome).toBe("DENY");
      expect(second.decision.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.executionLimitReached,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("binds an Authorization to one exact resolved action", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const result = controller.authorize(validMerchantResolved(), { idempotencyKey: "same" });
      const digest = result.authorization?.resolvedActionDigest;
      expect(digest).not.toBe(digestResolvedAction(validMerchantResolved({ amount: 1 })));
      const replay = controller.authorize(validMerchantResolved(), { idempotencyKey: "same" });
      const conflict = controller.authorize(validMerchantResolved({ amount: 1 }), {
        idempotencyKey: "same",
      });
      expect(replay.authorization?.id).toBe(result.authorization?.id);
      expect(replay.decision.outcome).toBe("ALLOW");
      expect(conflict.authorization).toBeUndefined();
      expect(conflict.decision.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.idempotencyConflict,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("releases AUTHORIZED authority and keeps EXECUTING/AMBIGUOUS reserved across restart", () => {
    const temporary = temporaryDatabase();
    let { store, controller } = activatedController(temporary.path);
    try {
      const first = controller.authorize(validMerchantResolved());
      const authorizationId = first.authorization?.id;
      if (authorizationId === undefined) {
        throw new Error("expected authorization");
      }
      controller.release(authorizationId);
      expect(controller.usage("permit-v2-1").grants[0]?.executionsReserved).toBe(0);

      const second = controller.authorize(validMerchantResolved());
      const secondId = second.authorization?.id;
      if (secondId === undefined) {
        throw new Error("expected second authorization");
      }
      controller.markExecuting(secondId);
      expect(() => controller.release(secondId)).toThrow(AuthorizationLifecycleError);
      controller.markAmbiguous(secondId);
      expect(controller.getAuthorization(secondId).status).toBe("AMBIGUOUS");
      expect(controller.usage("permit-v2-1").grants[0]?.executionsReserved).toBe(1);
      store.close();

      store = openStore(temporary.path);
      controller = new SpendController(store, { allowSimulatedSpend: true });
      expect(controller.getAuthorization(secondId).status).toBe("AMBIGUOUS");
      expect(controller.usage("permit-v2-1").grants[0]?.executionsReserved).toBe(1);
      const retry = controller.authorize(validMerchantResolved({ amount: 10 }));
      expect(retry.decision.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.executionLimitReached,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("keeps FAILED_SAFE reserved until explicit release", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const created = controller.authorize(validMerchantResolved());
      const authorizationId = created.authorization?.id;
      if (authorizationId === undefined) {
        throw new Error("expected authorization");
      }
      controller.markExecuting(authorizationId);
      controller.markFailedSafe(authorizationId);
      expect(controller.usage("permit-v2-1").grants[0]?.executionsReserved).toBe(1);
      controller.release(authorizationId);
      expect(controller.usage("permit-v2-1").grants[0]?.executionsReserved).toBe(0);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("treats SUCCEEDED as consumed and forbids release", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const created = controller.authorize(validInstrumentResolved());
      const authorizationId = created.authorization?.id;
      if (authorizationId === undefined) {
        throw new Error("expected instrument authorization");
      }
      controller.markExecuting(authorizationId);
      controller.markSucceeded(authorizationId);
      expect(
        controller.usage("permit-v2-1").grants.find((grant) => grant.grantId === "grant-instrument")
          ?.executionsReserved,
      ).toBe(1);
      expect(() => controller.release(authorizationId)).toThrow(AuthorizationLifecycleError);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("validates parent authorization linkage", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const missing = controller.preview(validTransferResolved({ parentAuthorizationId: undefined }));
      expect(missing.outcome).toBe("INDETERMINATE");
      expect(missing.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.missingParentAuthorization,
      );

      const missingId = controller.preview(
        validTransferResolved({ parentAuthorizationId: "does-not-exist" }),
      );
      expect(missingId.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.parentAuthorizationNotFound,
      );

      const instrument = controller.authorize(validInstrumentResolved());
      const parentId = instrument.authorization?.id;
      if (parentId === undefined) {
        throw new Error("expected parent");
      }
      const allowed = controller.preview(validTransferResolved({ parentAuthorizationId: parentId }));
      expect(allowed.outcome).toBe("ALLOW");

      const merchant = controller.authorize(validMerchantResolved());
      const merchantId = merchant.authorization?.id;
      if (merchantId === undefined) {
        throw new Error("expected merchant parent");
      }
      const wrongKind = controller.preview(
        validTransferResolved({ parentAuthorizationId: merchantId }),
      );
      expect(wrongKind.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.parentActionKindMismatch,
      );

      controller.release(parentId);
      const released = controller.preview(validTransferResolved({ parentAuthorizationId: parentId }));
      expect(released.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.parentAuthorizationReleased,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("rejects Permit mutation after activation and keeps historical Authorizations after revoke", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const created = controller.authorize(validMerchantResolved());
      const authorizationId = created.authorization?.id;
      if (authorizationId === undefined) {
        throw new Error("expected authorization");
      }
      expect(() =>
        store.replaceDraftPermit(validPermitV2({ grants: validPermitV2().grants })),
      ).toThrow(/cannot be modified/iu);
      store.revokePermit("permit-v2-1");
      expect(store.getAuthorization(authorizationId)?.status).toBe("AUTHORIZED");
      store.createPermit(validPermitV2({ id: "permit-v2-replacement" }));
      store.activatePermit("permit-v2-replacement");
      expect(store.getActivePermitForMission("mission-1")?.id).toBe("permit-v2-replacement");
      expect(store.getPermitRecord("permit-v2-1")?.status).toBe("REVOKED");
      expect(controller.authorize(validMerchantResolved()).authorization).toBeDefined();
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("audits Permit and Authorization mutations without secrets", () => {
    const temporary = temporaryDatabase();
    const { store, controller } = activatedController(temporary.path);
    try {
      const result = controller.authorize(
        validMerchantResolved({
          externalReference: "ok-ref",
        }),
      );
      const authorizationId = result.authorization?.id;
      if (authorizationId === undefined) {
        throw new Error("expected authorization");
      }
      controller.release(authorizationId);
      const types = store.getAuditEvents("mission-1").map((event) => event.type);
      expect(types).toEqual([
        "MISSION_CREATED",
        "PERMIT_CREATED",
        "PERMIT_ACTIVATED",
        "AUTHORIZATION_CREATED",
        "AUTHORIZATION_RELEASED",
      ]);
      const serialized = JSON.stringify(store.getAuditEvents("mission-1"));
      expect(serialized).not.toMatch(/bolt11|preimage|cardNumber/iu);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});
