# Firmware Build Skill Acceptance

- [ ] name/version/source commit/digest recorded
- [ ] pinned source revision and target enforced
- [ ] success returns artifact ID, SHA-256 and sanitized locator
- [ ] failure returns stable code and evidence references
- [ ] failure invokes Board Farm zero times
- [ ] timeout/cancellation cleans subprocesses
- [ ] retry is deterministic and does not confuse artifacts
- [ ] logs contain no secret, personal identity or internal hostname
- [ ] actual result saved to `actual-golden-run/build-result.json`
