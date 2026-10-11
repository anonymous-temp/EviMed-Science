## Summary

<!-- What changes, and why. Describe the behavior, not the diff. Link the issue if there is one. -->

## Checks run

<!-- Tick what you ran from OpenScience/ and say what you could not run. See CONTRIBUTING.md. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck` (and `typecheck:server` / `typecheck:domain` / `typecheck:port` / `typecheck:socket` where relevant)
- [ ] `pnpm test` (web) and `pnpm test:server`
- [ ] `pnpm test:packages` and `pnpm test:mcp`, if I touched packages or `runtime/mcp`
- [ ] `pnpm check:capabilities` and the other `check:*` generators, if I touched capabilities, skills or tokens
- [ ] `pnpm audit:source-secrets`
- [ ] A Python engine's own tests, if I touched `项目代码/`
- [ ] A conversation change was verified on a real DSH + DeepSeek session (or I say below why not)

Not run, and why:

## If this adds a rule, route or validation

<!-- Delete this section if it does not. Answer briefly. See CONTRIBUTING.md and CLAUDE.md, principle 20. -->

- [ ] Language understanding or an exact engineering operation? (state which)
- [ ] Could better data, tool results or a short instruction solve it instead?
- [ ] Does it stop a question native DSH + DeepSeek could answer?
- [ ] Does it touch only the operation that needs it, not the whole conversation?
- [ ] Is there a real reproduction and a control result? (link it)

## Screenshots

<!-- For UI changes: before and after. Delete this section otherwise. -->

## Notes

- [ ] Code, comments and commit messages are in English; UI copy is Simplified Chinese and uses design tokens.
- [ ] No secrets, credentials, `.env` files or real patient or personal data.
