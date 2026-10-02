# nco-config (`nco`)

Configuration as code for [Norce Checkout](https://docs.norce.io) channels.

A merchant's checkout is many *channels* (storefront × market × b2c/b2b) in several *environments* (stage, prod, qa…),
each a handful of JSON documents — one per adapter — edited in Admin today. This tool keeps them in git instead:

- channels are **generated** from the dimensions you declare, not copied
- documents are the **same JSON the API stores**, written as YAML and validated against the adapters' own JSON schemas
- credentials are **`${secret:NAME}` placeholders** resolved at apply time from CI secrets or a gitignored `.env` file — never written to disk by the tool
- `plan` shows exactly what would change on the server; `apply` writes it; `drift` catches edits made elsewhere

```
npx @norce/nco-config export --env stage      # pull what you have today into layers
npx @norce/nco-config plan   --env stage      # nothing to change — the repo now describes your channels
npx @norce/nco-config apply  --env prod       # after editing: review the plan, confirm, done
```

Requires Node ≥ 20. Works on Windows, macOS and Linux.

## How a project looks

```
nco.yaml                  what channels exist, which environments, in what order layers merge
lookups.yaml               tables: store ids per market, application ids per channel, locales…
layers/
  base/                    every channel gets these documents
    norce_adapter.yaml
    walley_checkout_adapter.yaml
  segment/b2b/             merged when segment = b2b
  market/no/               merged when market = no
  features/recurring/      merged for channels that have the feature
  target/stage/            merged for everything deployed to stage (stage itself and qa): PSP test endpoints…
  env/qa/                  merged for the qa environment only
channels/acme-se-b2b/      one channel's exceptions
.env.stage, .env.prod      secrets (gitignored) — in CI they come from the pipeline's secret store
```

`nco.yaml` for a merchant with two brands, three markets and b2c/b2b in prod, stage and a qa copy on stage:

```yaml
merchant: acme
environments:
  prod:  { target: prod }
  stage: { target: stage }
  qa:    { target: stage, channelSuffix: "-qa", vars: { frontend: "https://qa.acme.example" } }
vars:
  frontend: "https://www.acme.example"
dimensions:
  brand:   [acme, outlet]
  market:  [se, no, dk]
  segment: [b2c, b2b]
channelName: "${brand}-${market}${segment}"        # acme-se, acme-se-b2b, outlet-no, …
channelNameParts:
  segment: { b2c: "", b2b: "-b2b" }               # b2c has no suffix
exclude:
  - { brand: outlet, segment: b2b }
features:
  recurring: { brand: acme, market: se }
layers:                                            # later wins; a value of null removes a key
  - layers/base
  - layers/segment/${segment}
  - layers/market/${market}
  - layers/features/${feature}
  - layers/target/${target}                        # prod | stage: PSP endpoints, identity scope…
  - layers/env/${env}                              # prod | stage | qa: what only this environment needs
  - channels/${channel}
  - channels/${channel}/${env}
```

A layer file is a partial document. Only `id` (the file name) is required; `$schema`, `adapter.internalUrl` and
`adapter.publicUrl` are filled in by convention from the catalog, so you never type platform URLs.

```yaml
# layers/base/walley_checkout_adapter.yaml
active: true
apiSettings:
  clientId:  "${secret:WALLEY_CLIENT_ID}"
  apiSecret: "${secret:WALLEY_API_SECRET}"
  storeId-${MARKET}-${SEGMENT}: "${lookup:walley.storeId.${target}.${brand}.${market}.${segment}}"
redirectUrls:
  redirectPageUri:  "${var:frontend}/${lookup:locale.${market}}/checkout/confirmation"
  merchantTermsUri: "${var:frontend}/${lookup:locale.${market}}/terms"
```

### Placeholders

| syntax | resolved | from |
|---|---|---|
| `${market}`, `${MARKET}`, `${Market}` | at build | the channel's dimension values (upper / capitalised variants); also `${env}`, `${target}`, `${channel}`, `${deployedChannel}`, `${merchant}`, `${slug}`, and per document `${publicUrl}`, `${internalUrl}` |
| `${var:name}` | at build | `vars:` in `nco.yaml`, per environment overrides global |
| `${lookup:a.b.${market}}` | at build | `lookups.yaml`; a value that is exactly one lookup may be a number or object |
| `${secret:NAME}` | at apply, in memory | process environment, then `.env.<env>`, then `.env` |

Plain `{…}` is never touched — the platform's own templates (`{orderId}`, `{productId}`, `{merchant}`) pass through.

### Which documents a channel has

Any layer that mentions a document id creates it for the channels the layer applies to. Put documents every channel
needs in `layers/base`; documents only some channels need go in a feature (`layers/features/<name>/`) enabled by a
selector in `features:`. Documents owned by Admin (`admin_*`, `checkout_layout_*`, `checkout_meta_*`, `checkout_form_*`,
`checkout_application`) are excluded by default and never touched; override with `managedConfigurations`.

## Commands

| command | what it does | exit code |
|---|---|---|
| `nco init --merchant acme` | create `nco.yaml`, `.gitignore`, `.env.*.example`, folders | |
| `nco export --env stage` | pull live channels and factor them into layers; secrets → `.env.stage`; records channels/features in `nco.yaml` | |
| `nco build` | render final documents to `.nco/build/<env>/<channel>/<id>.json` (secrets still placeholders) | |
| `nco validate` | JSON Schema + naming rules + placeholder resolution | 1 on errors |
| `nco plan --env prod` | field-level diff against the server; secrets shown as `<redacted> #hash` | 0 none · 2 changes · 1 error |
| `nco apply --env prod [--yes] [--allow-delete]` | PUT changed documents; deletions only with `--allow-delete` | |
| `nco drift --env prod` | `plan` for scheduled runs | 2 = drift |
| `nco secrets check` | every `${secret:}` resolvable, no credential-shaped strings in tracked files | 1 on problems |
| `nco schema` | refresh cached schemas | |

`--json` on `plan`/`drift` prints a machine-readable plan for PR comments. `plan` lists but never touches documents
outside `managedConfigurations` and channels the repository does not produce.

## Secrets

- Names are yours; `export` proposes `<ADAPTER>_<PATH>` (e.g. `WALLEY_CHECKOUT_ADAPTER_API_SETTINGS_API_SECRET`) and
  suffixes with the channel when values differ between channels.
- Locally: `.env.<env>` (must be gitignored — `export` refuses otherwise). In CI: pipeline secrets as environment variables.
- The merchant token for the configuration API is `${secret:NCO_TOKEN_<ENV>}` by default (`NCO_TOKEN_PROD`, `NCO_TOKEN_STAGE`).
- Which fields are secrets: the adapter schema (`format: password`), then `catalog/adapters.yaml`, then key-name heuristics.
  Add paths to your own catalog copy if an adapter is missing.

## CI

`templates/github-actions.yml` and `templates/azure-pipelines.yml` implement: PR → validate + plan comment; merge to
main → apply stage; approval → apply prod; nightly drift. Copy one into your repository and add the secrets.

## Adopting an existing merchant

1. `npx @norce/nco-config init --merchant <merchant> --env stage --env prod`
2. Put the merchant token in `.env.stage` as `NCO_TOKEN_STAGE=…`
3. `npx @norce/nco-config export --env stage` — one file per document that differs, common fields in `layers/base`
4. `npx @norce/nco-config plan --env stage` → "0 to create, 0 to update"
5. Declare `dimensions` + `channelName` matching your naming, `export --force` again: per-market/per-segment values move
   into dimension layers; what is left in `channels/<name>/` is the real per-channel exception list
6. Replace repeated values with `${lookup:}` tables and `${var:}` as you see fit — `plan` tells you when the result stops matching

## Development

```
npm install
npm test            # unit tests (set NCO_LIVE_FIXTURES=<dir> to also run round-trips over exported merchant configs)
npm run lint        # tsc
npx tsx src/cli/index.ts -C examples/acme build
```

`catalog/adapters.yaml` is the only Norce-specific knowledge: URL conventions per environment, adapter host names,
schema versions and credential paths. Everything else is generic.

MIT © Norce
