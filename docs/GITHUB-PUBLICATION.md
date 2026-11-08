# GitHub publication

Target: **hayate-agent/webui**, public, default branch main.

The `hayate-publisher` GitHub App needs contents, pull-request and workflow write
permissions scoped to this repository.

One-time organization-owner setup:

1. Create the public repository `hayate-agent/webui` (empty or README-only).
2. Add **webui** to the selected repositories of the installed **hayate-publisher**
   App. Existing App permissions are sufficient for source/workflow publication;
   repository-administration permission does not need to be added permanently.

After that, mint a token restricted to this repository with contents/PR/workflow
write, run the standalone build/tests, and publish:

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
