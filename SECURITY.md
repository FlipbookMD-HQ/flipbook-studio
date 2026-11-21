# Security policy

## Supported versions

Only the latest release of Flipbook Studio gets security fixes.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub instead:
**Security → Report a vulnerability** on this repository
(https://github.com/FlipbookMD-HQ/flipbook-studio/security/advisories/new).

Include what's affected, how to reproduce it, and the impact you expect. You'll get an answer
within a week, and a fix or a plan within 30 days for confirmed issues. Reporters are credited
in the advisory unless they ask not to be.

## Scope

Studio is meant to run on your own machine and listens on `127.0.0.1` only. API keys for
paid providers are stored in Studio's settings file (mode 0600) and never in deck files.
Reports about reaching Studio from another machine or website, or about keys leaking, are
especially welcome.
