# GitHub publication

Target: **hayate-agent/webui**, public, default branch main.

The `hayate-publisher` GitHub App needs contents, pull-request and workflow write
permissions scoped to this repository.

One-time organization-owner setup:

1. Create the public repository `hayate-agent/webui` (empty or README-only).
2. Add **webui** to the selected repositories of the installed **hayate-publisher**
   App. Existing App permissions are sufficient for source/workflow publication;
   repository-administration permission does not need to be added permanently.

## Automatic publication

The trusted deployment automation schedules the standalone WebUI publisher every
five minutes. It requires the exact protected source revision's native CI, audits
the public export and tests it in a separate credential-free container, including
browser and real backend integration tests. An unchanged complete public tree is
a no-op, not a new pull request.

Changed snapshots are proposed on `publish/webui`. The independent maintainer
verifies the immutable successful producer receipt and every public file before
merging; the real GitHub Actions `check` remains required. No operator token is
passed to builds and no private source history is pushed. A publication watchdog
reports persistent source/public lag through an assigned GitHub incident and
closes it after recovery. Product deployment and GHCR release remain separate.

## Manual recovery

The following existing manual helper is only an operator recovery path; it is not
the scheduled publisher and does not waive automated checks or repository rules.
Mint a token restricted to this repository with contents/PR/workflow write, run
the standalone build/tests, and publish:

```sh
npm ci --include=dev --ignore-scripts
npm run build
npm test
npm run test:browser
GH_TOKEN='<provided securely by publisher custody>' python3 scripts/publish_github.py
```

The example names the environment variable, not a recommendation to paste secrets
into shell history. CI must inject it in a secret-scoped publishing step. Tokens
must never appear in a Git URL, stored Git config, command-line argument or log.

The publisher initializes an empty GitHub main with only a public README, exports
tracked standalone source on a public-main parent, and opens/updates a publication
PR. It does not merge, alter branch protection or import private parent history.
Review the GitHub CI result and merge normally. A subsequent v* tag invokes the
separate GHCR release workflow; the stable image channel is a deployment choice,
not a required Core or agent revision pin.
