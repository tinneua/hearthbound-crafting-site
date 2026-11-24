# Hearthbound Guild Ledger

This repository publishes the [Hearthbound Guild Ledger](https://tinneua.github.io/hearthbound-crafting-site/) on GitHub Pages. It contains the website and its refresh workflow. The Blizzard catalog is generated for each deployment.

The publish workflow runs daily at 06:23 UTC and supports manual dispatch. It reads its Blizzard client credentials from GitHub Actions secrets. A deployment contains the site files and the latest catalog. After a failed refresh, a still-current catalog stays online. The workflow removes the catalog from the site when it finds that the existing snapshot has expired.

The development repository is the source for site changes. Copy the updated site files or refresh script here before running the publish workflow. GitHub may disable schedules in a public repository after 60 days of inactivity.
