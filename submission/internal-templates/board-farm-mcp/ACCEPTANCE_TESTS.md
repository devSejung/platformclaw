# Board Farm Adapter Acceptance Tests

- [ ] adapter implements every `BoardFarmAdapter` method
- [ ] exact approved Tool mapping is asserted
- [ ] `operationId` is the MCP idempotency key
- [ ] lease authorization is independent of build status and follows owner/resource policy
- [ ] deploy requires an explicit artifact digest/ref
- [ ] approved control action requires an active owned lease
- [ ] same user/key/fingerprint returns the same Run
- [ ] changed fingerprint with same key is rejected
- [ ] User B cannot use User A lease token
- [ ] concurrent requests cannot lease one board twice
- [ ] timeout and maximum lifetime are bounded
- [ ] renew/heartbeat, release, cancel and expiry are tested
- [ ] stale restart reconciliation does not leak a board
- [ ] cleanup failure quarantines the resource
- [ ] deploy/boot/validation failure preserves evidence
- [ ] result does not contain endpoint, secret or raw board serial
- [ ] actual result is stored only under `actual-golden-run/`
- [ ] exact MCP Tool names and schemas replace every `TODO(INTERNAL)` without committing private endpoints or secrets

Focused domain command:

```bash
node scripts/run-vitest.mjs packages/platformclaw-control-plane/src/board-farm
```

사내 adapter test command는 승인된 source 위치에 추가하고 `IR-001`에 기록한다.
