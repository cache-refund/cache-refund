# Security Policy

## What this tool touches

`cache-cash` is deliberately narrow: it reads the `usage` token counts and
timestamps from your local Claude Code transcripts, does arithmetic, and — only
with your explicit confirmation — writes one env line to `~/.claude/settings.json`
(with a backup). It has **zero runtime dependencies** and makes **no network
requests**. Anything that violates one of those properties is a security bug,
not a feature request.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability") rather than a public issue, for
anything that:

- causes conversation content (not just token counts/timestamps) to be read,
- causes any network request,
- writes anywhere other than the documented settings edit, baseline file, and backup,
- or could make the confirmed settings edit corrupt or lose data.

You'll get an acknowledgment within a few days. Once fixed, we credit reporters
in the release notes unless you prefer otherwise.

## Supported versions

Only the latest published version is supported. The tool is a read-mostly CLI —
just update: `npx @m8t-labs/cache-cash@latest`.
