# Board Validation Skill Acceptance

- [ ] explicit artifact digest and active lease owner required before deploy
- [ ] deploy precedes boot; boot precedes validate
- [ ] operation ID is preserved for retries
- [ ] each phase records digested evidence
- [ ] validation failure keeps deploy/boot/validation evidence
- [ ] timeout, cancellation and cleanup tested
- [ ] cleanup failure quarantines resource
- [ ] no raw board serial, secret or internal endpoint in output
- [ ] actual result saved to `actual-golden-run/board-validation-result.json`
