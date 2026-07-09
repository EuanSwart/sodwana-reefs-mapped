# Deploying the Sodwana Bay site to GitHub Pages

Written 2026-07-09. This is Euan's copy-paste runbook — nothing in this file was executed by
the agent; there is no `gh` CLI or GitHub credential available in the build sandbox, so every
step below is something you run yourself, from your own machine, in your own terminal, in the
existing local repo at `C:\Projects\SodwanaBathymetry\Fable`.

## 0. Why GitHub Pages (not Cloudflare Pages / Netlify)

Short version: GitHub Pages is the right call here and there's no compelling reason to use
anything else.

- The repo already exists locally (3 commits, `main` branch) and already has a working
  deploy workflow (`.github/workflows/pages.yml`) that pushes `site/` to Pages on every
  `git push` — zero extra setup beyond creating the remote and flipping one Settings toggle.
- Site size is ~50–70 MB (mostly the committed tile pyramid under `site/`). GitHub's Pages
  soft limit is 1 GB per site and the repo recommendation is to keep repos under a few GB —
  you are nowhere near either limit, and there's no build step (`site/` is dependency-free
  HTML/JS/vendored MapLibre), so there's no Actions build-minutes cost either.
- "Keep building and updating it regularly" is exactly the workflow GitHub Pages +
  Actions rewards: `git push` and the site redeploys, no dashboard clicking, no separate
  deploy tool to learn.
- Cloudflare Pages and Netlify's free tiers are also viable (both keyless, both fine for a
  static site this size) but neither buys you anything extra here — you'd be maintaining a
  second account/CLI and a second deploy config for no functional gain, since you don't need
  their edge-function or preview-deploy features. Only reason to reconsider: if you ever want
  a **private** repo with a public site (see the caution note below) — Cloudflare Pages and
  Netlify can serve a public site from a private source repo on their free tiers; GitHub
  Pages cannot (Pages on a private repo needs GitHub Pro). Not a concern today since this
  project is meant to be shared with dive buddies anyway.

## 1. Create the GitHub repo (web UI)

1. Go to https://github.com/new
2. **Repository name:** something like `sodwana-bathymetry` (this becomes part of the live
   URL — see step 4).
3. **Visibility:** Public (see the caution note at the bottom — Pages on GitHub Free requires
   this).
4. Do **NOT** check "Add a README", "Add .gitignore", or "Choose a license" — the local repo
   already has all its history and files; an initialized remote repo would conflict on push.
5. Click **Create repository**. GitHub will show you a page with setup instructions — ignore
   it and use the commands below instead (they're the "push an existing repository" case).

## 2. Push the existing local repo

Run these from inside `C:\Projects\SodwanaBathymetry\Fable`, substituting your actual GitHub
username and the repo name you chose above:

```bash
cd C:\Projects\SodwanaBathymetry\Fable
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

- `git remote add origin ...` — points your local repo at the new empty GitHub repo.
- `git branch -M main` — no-op if you're already on `main` (you are), but harmless to run.
- `git push -u origin main` — pushes all 3 existing commits and sets `origin/main` as the
  default upstream for future plain `git push` calls.

If prompted for credentials, use a GitHub personal access token as the password (GitHub no
longer accepts account passwords over HTTPS git), or push over SSH if you already have an SSH
key registered with GitHub (`git remote add origin git@github.com:<user>/<repo>.git` instead).

## 3. Enable GitHub Pages with the Actions source

The repo's `.github/workflows/pages.yml` deploys via `permissions: pages: write` +
`id-token: write` and the `actions/deploy-pages` action — this is the **"GitHub Actions"**
Pages source, not the older "Deploy from a branch" source. You must select it explicitly:

1. On the repo page, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions** (not "Deploy from a
   branch").
3. That's it — no branch/folder picker needed; the workflow file already declares what to
   publish (`site/`).

The very next push to `main` that touches `site/**` or the workflow file itself will trigger
the `Deploy site to GitHub Pages` Action (visible under the repo's **Actions** tab). You can
also trigger it manually via **Actions → Deploy site to GitHub Pages → Run workflow**
(`workflow_dispatch` is already enabled in the workflow).

## 4. Live URL

Once the first deployment succeeds, the site will be live at:

```
https://<your-username>.github.io/<repo-name>/
```

Example: if your GitHub username is `euanswart` and you named the repo
`sodwana-bathymetry`, the site is at `https://euanswart.github.io/sodwana-bathymetry/`.
Substitute your actual username/repo name — this is not a placeholder you can copy verbatim.

The URL also appears in the Actions run summary (the `deployment` step's `page_url` output)
and under **Settings → Pages** once the first deploy completes.

## 5. Keep updating it

Normal day-to-day workflow going forward is just:

```bash
git add -A
git commit -m "..."
git push
```

The Action re-runs automatically on every push to `main` that touches `site/**`, rebuilds
nothing (no build step needed), and redeploys within roughly a minute.

Two safety nets are already wired in from `CLAUDE.md`'s hook setup, both of which run
*before* the push leaves your machine:

- The pre-push hook runs `pipeline/validate.py` (full accuracy/data gates) and
  `pipeline/smoke_site.py` (static site sanity checks: `index.html` references its JS,
  `style.json` is valid, no accidental API keys committed) — if either fails, the push is
  blocked locally, before GitHub ever sees a broken commit.
- `pipeline/smoke_site.py` also runs a second time inside the Action itself (see the
  workflow's "Smoke-test site" step) as a server-side backstop in case the local hook was
  ever bypassed.

So in practice: if `git push` succeeds locally, the deploy is very likely to succeed too.

## 6. Caution: the repo will be public

GitHub Pages on a personal **GitHub Free** account (unlimited public repos, the plan this
project is on) only serves sites from **public** repositories — private-repo Pages requires
GitHub Pro or higher. This is current GitHub policy as of 2026, confirmed against GitHub's
own docs ("GitHub Pages is available in public repositories with GitHub Free... and in
public and private repositories with GitHub Pro, Team, Enterprise Cloud, and Enterprise
Server").

Practical implication for this project: the repo — including `data/ground_truth/`,
dive-site coordinates, and everything else under version control — is visible to **anyone
with the link**, not just people you personally share it with. That's fine and expected for
the goal here (sharing the map with dive buddies), but it's worth being deliberate about: this
is not a "share with specific people" link, it's a fully public GitHub repo and a fully public
website. If Euan's GPS points or any other file should stay private, it needs to be kept out
of git entirely (it already is — `data/ground_truth/gps_points.csv` is tracked, so double-
check before making the repo public that nothing in it is sensitive beyond "dive buddies can
see our reef spots," which per the project's own goals is acceptable).
