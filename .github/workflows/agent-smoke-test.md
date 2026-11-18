---
name: Agent Smoke Test
description: Manually verify Copilot inference without accessing application code.
on:
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: none
engine: copilot
runs-on: ubuntu-latest
runs-on-slim: ubuntu-latest
timeout-minutes: 10
checkout: false
tools:
  github: false
safe-outputs:
  create-issue: false
  report-failure-as-issue: false
  noop:
    report-as-issue: false
---

# Agent Smoke Test

This task only verifies that Copilot inference and safe-output reporting work.
Do not read repository files, execute shell commands, access external data,
modify files, or create issues, comments, pull requests, or releases.

Call the `noop` safe-output tool exactly once with this message:

AGENT_SMOKE_TEST_OK: Copilot received the prompt and returned this response.

Then finish with the same message as your final response.