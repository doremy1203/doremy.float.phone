# Security Policy

## Supported versions

Security fixes are made against the latest code on the `main` branch. Older APKs and self-hosted deployments may contain issues fixed in later commits; update the web application and rebuild the Android shell when native code or permissions change.

## Reporting a vulnerability

Please do **not** publish API keys, access tokens, private URLs, personal data, exploit details, or an unpatched vulnerability in a public issue.

Use GitHub's **Report a vulnerability** / private vulnerability reporting feature for this repository when it is available. If that feature is unavailable, contact the maintainer privately through the maintainer's GitHub profile and include only the minimum information needed to reproduce the issue.

Please include:
- affected commit, release, platform and device / Android / WebView versions;
- a concise impact description and reproducible steps;
- sanitized logs or screenshots, with tokens, cookies, user IDs and private conversation content removed;
- whether the issue requires a particular permission, cloud configuration or third-party service.

Please allow time for investigation and a fix before public disclosure. Do not test against other people's deployments or data without permission.

## Secret exposure

If a credential is accidentally committed, deleting the file is not enough: revoke or rotate the credential with its provider immediately, then review repository history and deployment logs. Never send secrets in issues or pull requests.
