# Cluster caches for role pods

Status: Phase 3 of [agent-roles-plan.md](agent-roles-plan.md), future exploration, not scheduled. Depends on [agent-roles.md](agent-roles.md): role agents in pi-web run as short-lived Kubernetes Jobs that clone repos and install tools on every run.

## Problem

Each role pod starts empty. It clones its repos from GitHub, then mise downloads and unpacks every tool, then npm or pip fetch packages. Baking common tools into worker images covers the most common case. Everything else repeats on every run.

## Idea

One scheduled job keeps shared caches on cluster volumes. Role pods mount them **read-only**, so one role can never change what another role runs. Anything missing from a cache falls back to the normal path inside the pod.

The caches chain: git comes first, and each repo's `mise.toml` and lockfiles then say which tools and packages to cache. So one job on one schedule refreshes all three.

## Caches

### Git

- **What:** bare copies of repos (history only, no files) on a volume.
- **Refresh:** `git fetch` in each copy.
- **Use:** `git clone --reference /cache/<repo>.git <github-url>`. Git copies what it has locally and fetches only commits since the last refresh. Pushes go straight to GitHub.
- **Access:** the refresh job holds its own read-only GitHub credential. Each role pod mounts only the repos its role may use.

### mise tools

- **What:** installed mise tools (unpacked, ready to run) on a volume.
- **Refresh:** `mise install` for each cached repo's `mise.toml`, into the shared folder.
- **Use:** mount read-only and set `MISE_SHARED_INSTALL_DIRS` to it. mise finds installed tools there and installs anything missing into the pod's own folder as usual. The setting exists in mise 2026.8.5; its system default is `/usr/local/share/mise/installs`.
- **Relation to images:** baking tools into an image fills the same kind of folder at image build time. The cache fills it on a schedule, without rebuilding images.

### Language packages

- **What:** npm and pip package caches on a volume.
- **Refresh:** install from each repo's lockfiles into the cache.
- **Use:** point the package manager's cache directory at the read-only mount (npm `cache`, pip `--find-links` or a wheel directory). Exact settings per manager are unverified.

## Not planned

- **Download cache:** a caching proxy for tool archives, redirected with mise `url_replacements`. It saves bandwidth but tools still unpack each run. Only worth it if GitHub rate limits become a problem.
- **Registry mirror for images:** nodes already cache images after the first pull.

## Open questions

- **Volume type:** the caches need one writer and many readers across nodes. Check what storage the cluster offers (a ReadWriteMany volume, or a per-node copy).
- **Refresh trigger:** a fixed schedule, or a push webhook.
- **Size and pruning:** old tool versions and package caches grow without bound.
- **Trust:** the refresh job runs repo-declared installs. It should run with no role credentials, only the read-only git key.
