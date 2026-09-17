# Browser credential configuration

ParQueen requires one intentionally public browser mapping credential. Never commit its value. Production `vite build` fails closed if `VITE_MAPBOX_TOKEN` is missing, empty, or whitespace-only.

## Local development

Copy `.env.example` to `.env.local` and supply development-only credentials:

```env
VITE_MAPBOX_TOKEN=
```

Use separate development and production credentials. Vite exposes every `VITE_` value to the browser, so these credentials must be restricted at their providers rather than treated as server secrets.

## Mapbox

- Create a custom public token for web development and a separate custom public token for production.
- Grant only the public token scopes required by the web app: `styles:read`, `styles:tiles`, and `fonts:read`.
- Verify geocoding and directions requests with that restricted token before production rollout.
- Restrict the development token to approved localhost origins.
- Restrict the production token to `parqueen.app`, approved subdomains, and the active Firebase Hosting domains.
- Use separate tokens for future native iOS and Android apps.
- Configure `VITE_MAPBOX_TOKEN` in the target environment. Never log it.

## Nearby-garage discovery backlog

If nearby-garage discovery is approved later, use Mapbox POI search or first-party ParQueen listings. Do not add a second browser mapping provider without a product, privacy, attribution, and security review.

## Local secret scan

Install [Gitleaks](https://github.com/gitleaks/gitleaks), then run:

```bash
gitleaks git --redact
```

The CI secret scan runs locally inside the GitHub-hosted runner and does not upload repository contents to an external scanning service.
