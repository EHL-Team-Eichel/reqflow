# Coding-agent model routing

All delegated coding agents use **`google/gemini-3.8-flash`**. This follows the operator's latest
instruction and account-specific no-cost access; it is not a claim that Gemini API usage is
universally free. The application's Anthropic/OpenAI/Gemini provider configuration is separate.

| Profile         | Model                     | Reasoning | Use                                                                                |
| --------------- | ------------------------- | --------- | ---------------------------------------------------------------------------------- |
| `gemini-low`    | `google/gemini-3.8-flash` | low       | Known-file lookup, small established-cause edits, documentation and routine checks |
| `gemini-medium` | `google/gemini-3.8-flash` | medium    | Bounded UI/helper work, meaningful tests and focused correctness review            |
| `gemini-high`   | `google/gemini-3.8-flash` | high      | Integration, persistence migration, races and adversarial security review          |

Assess actual ambiguity, affected layers, unfamiliar APIs, migration/reversibility, concurrency
and security before each invocation. Reassess after the slice: a difficult task does not make its
established-cause follow-up difficult. Use the lowest appropriate reasoning level; escalate only
for an observed need. Do not route by file count, role name or keywords alone.

Installed file-defined agents can override inline role defaults. The project plugin
`.opencode/plugins/gemini-subagents.ts` enforces Gemini after configuration merging for delegated
roles and `subagent`/`all` profiles, preserving their prompts and permissions. Resolved configuration
was checked for every delegated role. Choose the explicit profiles and model flag to set reasoning
for the actual task:

```sh
opencode run --agent gemini-low --model google/gemini-3.8-flash --variant low "<small bounded task>"
opencode run --agent gemini-medium --model google/gemini-3.8-flash --variant medium "<focused review>"
opencode run --agent gemini-high --model google/gemini-3.8-flash --variant high "<complex integration>"
```

No OpenAI-backed subagent is started. An in-flight OpenAI delegation was stopped and its existing
work resumed using Gemini after the operator changed the policy. The primary session's model
is independent of this subagent policy.

Configuration loads at startup. **Quit and restart OpenCode** to apply project changes in an
already-running interactive session. Fresh processes use them immediately. Do not use auto-approval
flags, copy credentials into configuration, or modify generated Entire hooks.

The model and `low`/`medium`/`high` variants were verified through
`opencode models google --verbose`. Validate configuration with `opencode debug config` and
`opencode debug agent gemini-high`; those commands do not run inference. Actual delegated-session
model/variant metadata is checked as well.
