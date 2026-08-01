export function skillProposalInspectResult(agentId: string) {
  return {
    record: {
      schema: "openclaw.skill-workshop.proposal.v1",
      id: "proposal-1",
      kind: "create",
      status: "pending",
      title: "Calendar reports",
      description: "Create calendar reports",
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
      createdBy: "skill-workshop",
      origin: {
        agentId,
        sessionKey: `agent:${agentId}:main`,
        runId: "run-private",
        messageId: "message-private",
      },
      proposedVersion: "1.0.0",
      draftFile: "PROPOSAL.md",
      draftHash: "hash-private",
      target: {
        skillName: "Calendar Reports",
        skillKey: "calendar-reports",
        skillDir: "C:/private/workspace/skills/calendar-reports",
        skillFile: "C:/private/workspace/skills/calendar-reports/SKILL.md",
        binding: {
          backendId: "platformclaw-execution-private",
          targetId: "allocation-private",
          targetLabel: "Development VM",
        },
      },
      scan: {
        state: "clean",
        scannedAt: 1_000_000,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
    },
    revisionHash: "revision-private",
    content: "# Calendar Reports",
    supportFiles: [],
  };
}

export function skillProposalListResult() {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-07-27T00:00:00.000Z",
    proposals: [
      {
        id: "proposal-1",
        kind: "create",
        status: "pending",
        title: "Calendar reports",
        description: "Create calendar reports",
        skillName: "Calendar Reports",
        skillKey: "calendar-reports",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
        scanState: "clean",
        targetLabel: "Development VM",
        skillDir: "C:/private/workspace/skills/calendar-reports",
        runId: "run-private",
      },
    ],
  };
}
