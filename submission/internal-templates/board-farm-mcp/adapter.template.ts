import type {
  BoardFarmAdapter,
  BoardFarmAdapterOperation,
  BoardFarmAdapterResult,
  BoardFarmCleanupOperation,
  BoardFarmDeployOperation,
  BoardFarmEvidenceInput,
} from "../../../packages/platformclaw-control-plane/src/board-farm/contracts.js";

export type InternalBoardFarmClient = {
  call(params: {
    tool: "deploy" | "boot" | "validate" | "cleanup";
    idempotencyKey: string;
    boardAlias: string;
    input: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    failureCode?: string;
    evidence: BoardFarmEvidenceInput[];
  }>;
};

/** Replace only the transport client; Control Plane retains lease and owner policy. */
export class InternalBoardFarmAdapterTemplate implements BoardFarmAdapter {
  constructor(private readonly client: InternalBoardFarmClient) {}

  deploy(operation: BoardFarmDeployOperation): Promise<BoardFarmAdapterResult> {
    return this.call("deploy", operation, {
      artifactId: operation.artifact.id,
      artifactDigest: operation.artifact.digest,
      artifactLocator: operation.artifact.locator,
    });
  }

  boot(operation: BoardFarmAdapterOperation): Promise<BoardFarmAdapterResult> {
    return this.call("boot", operation, {});
  }

  validate(operation: BoardFarmAdapterOperation): Promise<BoardFarmAdapterResult> {
    return this.call("validate", operation, {});
  }

  cleanup(operation: BoardFarmCleanupOperation): Promise<BoardFarmAdapterResult> {
    return this.call("cleanup", operation, { reason: operation.reason });
  }

  private async call(
    tool: "deploy" | "boot" | "validate" | "cleanup",
    operation: BoardFarmAdapterOperation,
    input: Record<string, unknown>,
  ): Promise<BoardFarmAdapterResult> {
    const response = await this.client.call({
      tool,
      idempotencyKey: operation.operationId,
      boardAlias: operation.boardId,
      input,
    });
    return response.ok
      ? { status: "passed", evidence: response.evidence }
      : {
          status: "failed",
          failureCode: response.failureCode ?? "internal_adapter_failed",
          evidence: response.evidence,
        };
  }
}
