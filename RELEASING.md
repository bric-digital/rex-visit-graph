# Releasing rex-visit-graph

## Why this exists

This module is installed straight from GitHub, not from a registry:

```json
"@bric/rex-visit-graph": "github:bric-digital/rex-visit-graph"
```

A reference like that floats on the default branch. Two installs a week apart can resolve to different code while the `package.json` line looks identical, and a lockfile records the sha it happened to get rather than a version anyone chose. That is fine while a module is being built and wrong once a study depends on it.

Tagging fixes it. A release **is** a tag, and consumers pin to it:

```json
"@bric/rex-visit-graph": "github:bric-digital/rex-visit-graph#v1.0.0"
```

Now the version a study runs is a decision, upgrading is a visible edit, and a build from six months ago rebuilds identically.

## How to release

The version in `package.json` is the source of truth.

1. Make sure `main` is clean and CI is green.
2. Set `package.json` to the version you are releasing, if it is not already there, and commit.
3. Run:

   ```
   npm run release:tag -- 1.0.0
   ```

   The script refuses unless `package.json` already says `1.0.0`, then creates an annotated tag `v1.0.0` and bumps `package.json` to `1.0.1`, committing that as "start v1.0.1 development".
4. Push the branch and the tag together:

   ```
   git push origin main --follow-tags
   ```

## Then update consumers

Pinning is a separate, deliberate act in each extension that uses the module:

```
cd ../AI-Extension
# edit package.json to "github:bric-digital/rex-visit-graph#v1.0.0"
npm install --allow-git=all
npm run build
```

Check the lockfile resolved to the tag's sha, and that the change reached the bundle, before trusting it.

## What the numbers mean

Ordinary semver, read from the perspective of an extension that installs this module.

- **Major** — a consumer has to do something. The emitted point shape changed, a config key was removed or its meaning inverted, or a default now collects differently.
- **Minor** — new capability that an existing consumer can ignore. A new config key with a safe default, a new message.
- **Patch** — a fix with no config or data-shape change.

The 1.0.0 line is drawn where capture inverted from "rules enable" to "rules narrow". Anything before it was pre-release, so 1.0.0 is the first version worth pinning.

2.0.0 replaces the boolean `include_url` with `url_detail` (`none` / `path` / `full`) and adds `debug`. A consumer setting `include_url` gets the default instead of what it asked for, which is why this is a major rather than a minor.

## No published artifact

There is nothing to zip or upload. Unlike a client extension, the tag alone is the release, because npm resolves the GitHub ref directly. That is why this repo has no publish job in CI.
