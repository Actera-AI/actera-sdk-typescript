# Contributing

Open a pull request with the problem, the resulting behavior, and the checks you
ran. Keep unrelated changes separate. Run the development commands in the
[README](README.md) and let CI pass before merging.

Use synthetic fixtures. Do not commit credentials, customer data, captured
sessions, local configuration, or build caches. The distribution check reviews
tracked paths; the secret scan checks Git history. Neither replaces review of
new examples, fixtures, and release contents.

API changes originate in the backend repository. Maintainers export a reviewed
contract to `actera-api`, release it, and import that exact tag with
`node scripts/update-contract.mjs <actera-api-checkout>`. Do not edit the SDK's
contract snapshot independently. The pinned snapshot is included here so
contributors can build and test without access to the contract repository.
Review handwritten client behavior as well as generated types when the contract
changes.

Describe user-visible changes in `CHANGELOG.md`. Release tags are immutable;
publish a new version for corrections. Never add customer data or credentials to
make an example work. Participation is governed by the
[code of conduct](CODE_OF_CONDUCT.md).
