# Licensing

Duct is made by Tensflare Ltd. It is licensed in two parts.

## The app and the library: Apache 2.0

Everything outside `src/team/` and `deploy/` is under the [Apache License 2.0](LICENSE): the desktop app, the
search engine, the `@docfide/duct` library and CLI, the web interface, the developer API, notebooks, the privacy
ledger and everything else a person needs to search their own documents. Use it, change it, build on it and ship
it, commercially or not.

## Team features: Elastic License 2.0

The code in [`src/team/`](src/team/LICENSE) and [`deploy/`](deploy/LICENSE) is under the
[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license). It is what turns Duct into a server for a
team:

- sign-in with your identity provider (OpenID Connect),
- permission-aware search that follows each file's sharing,
- connectors for Google Drive, Microsoft 365 and S3,
- the audit log,
- sharing notebooks with people, and public notebook links,
- the licence check that unlocks them, and the kit for running Duct in your cloud.

You can read, run and change this code too. The Elastic License adds three limits: you may not offer it to others
as a hosted or managed service; you may not move, change, disable or get around the licence check, or remove what
it protects; and you must keep the licence and copyright notices.

In practice: a team server can be evaluated for 30 days. After that, its team features need a Team or Enterprise
plan on the Tensflare account the server is signed in to (Settings › Account). Without them, Duct keeps working as
a search app; the team features stop.

## Contributions

Duct is developed by the Tensflare team. If you'd like to contribute, write to duct@tensflare.com first: we'll
ask you to agree that Tensflare may license your contribution under both licences.

## Trademarks

"Duct", the Duct logo and the mascot are trademarks of Tensflare Ltd. Neither licence grants rights to use them,
except to describe the software truthfully. See [the press kit](https://duct.tensflare.com/press/) for how to use
the mascot and logo when you write about Duct.
