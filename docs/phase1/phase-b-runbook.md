# Phase B Runbook -- Irreversible Actions

**Status:** WAITING FOR FOUNDER SIGN-OFF
**Prerequisite:** PR #171 must be merged to `dev` first.
**Execution order:** Strictly sequential. Each step depends on the previous.

---

## Pre-flight checklist

- [ ] PR #171 merged to `dev`
- [ ] CI green on `dev` after merge
- [ ] Founder has reviewed README rendering on GitHub
- [ ] Founder has reviewed all launch collateral drafts
- [ ] `gh auth status` confirms `admin:org`, `workflow`, `write:packages` scopes

---

## Step 1: Merge `dev` to `main` (pre-public)

Before making the repo public, ensure `main` has all the launch-ready content.

```bash
cd /Users/simon/Documents/localGIT/compendiq-ee/ce
git checkout main && git pull origin main
git merge origin/dev --no-ff -m "merge: dev into main for v1.0 launch prep"
git push origin main
```

---

## Step 2: A4 -- Make repo public (IRREVERSIBLE)

```bash
gh repo edit Compendiq/compendiq-ce --visibility public
```

**Verification:**
```bash
# From a clean session or incognito:
gh api repos/Compendiq/compendiq-ce --jq '.visibility'
# Expected: "public"
```

---

## Step 3: A5 -- Branch protection on `main` and `dev`

```bash
# Protect main
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/Compendiq/compendiq-ce/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test-and-lint"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

# Protect dev
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/Compendiq/compendiq-ce/branches/dev/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["test-and-lint"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

**Verification:**
```bash
gh api repos/Compendiq/compendiq-ce/branches/main/protection --jq '.required_status_checks'
gh api repos/Compendiq/compendiq-ce/branches/dev/protection --jq '.required_status_checks'
```

---

## Step 4: A6 -- Verify GHCR images are pullable unauthenticated

After the repo is public, the GHCR packages may need their visibility set to public separately.

```bash
# Check current package visibility
gh api /orgs/Compendiq/packages/container/compendiq-ce-backend --jq '.visibility'
gh api /orgs/Compendiq/packages/container/compendiq-ce-frontend --jq '.visibility'

# If not public, set them public:
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /orgs/Compendiq/packages/container/compendiq-ce-backend/visibility \
  -f visibility=public

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /orgs/Compendiq/packages/container/compendiq-ce-frontend/visibility \
  -f visibility=public
```

**Verification (from a machine without GHCR auth):**
```bash
docker pull ghcr.io/compendiq/compendiq-ce-backend:latest
docker pull ghcr.io/compendiq/compendiq-ce-frontend:latest
```

---

## Step 5: A15 -- Enable GitHub Discussions and post seeds

### 5a. Enable Discussions

```bash
gh api \
  --method PATCH \
  -H "Accept: application/vnd.github+json" \
  /repos/Compendiq/compendiq-ce \
  -f has_discussions=true
```

### 5b. Create Discussion Categories

This requires the GraphQL API. First, get the repository ID:

```bash
REPO_ID=$(gh api graphql -f query='
  query {
    repository(owner: "Compendiq", name: "compendiq-ce") {
      id
    }
  }
' --jq '.data.repository.id')
echo "Repository ID: $REPO_ID"
```

Then create categories:

```bash
# Announcements (announcement format)
gh api graphql -f query="
  mutation {
    createDiscussionCategory(input: {
      repositoryId: \"$REPO_ID\",
      name: \"Announcements\",
      description: \"Official announcements and release notes\",
      emoji: \":mega:\",
      isAnswerable: false
    }) {
      discussionCategory { id name }
    }
  }
"

# Q&A (answerable format)
gh api graphql -f query="
  mutation {
    createDiscussionCategory(input: {
      repositoryId: \"$REPO_ID\",
      name: \"Q&A\",
      description: \"Ask questions and get help from the community\",
      emoji: \":question:\",
      isAnswerable: true
    }) {
      discussionCategory { id name }
    }
  }
"

# Show & Tell
gh api graphql -f query="
  mutation {
    createDiscussionCategory(input: {
      repositoryId: \"$REPO_ID\",
      name: \"Show & Tell\",
      description: \"Share your Compendiq setup, customizations, and screenshots\",
      emoji: \":raised_hands:\",
      isAnswerable: false
    }) {
      discussionCategory { id name }
    }
  }
"

# Ideas
gh api graphql -f query="
  mutation {
    createDiscussionCategory(input: {
      repositoryId: \"$REPO_ID\",
      name: \"Ideas\",
      description: \"Suggest new features and improvements\",
      emoji: \":bulb:\",
      isAnswerable: false
    }) {
      discussionCategory { id name }
    }
  }
"
```

### 5c. Post seed discussions

Get category IDs:

```bash
gh api graphql -f query='
  query {
    repository(owner: "Compendiq", name: "compendiq-ce") {
      discussionCategories(first: 10) {
        nodes { id name }
      }
    }
  }
' --jq '.data.repository.discussionCategories.nodes[]'
```

Then post each seed (content from `docs/phase1/discussions-seed-posts.md` -- replace `{{FOUNDER_NAME}}` and `{{ISSUE_NUMBER}}` before posting):

```bash
# Example for Announcements seed:
ANNOUNCEMENTS_CAT_ID="<from above>"
gh api graphql -f query="
  mutation {
    createDiscussion(input: {
      repositoryId: \"$REPO_ID\",
      categoryId: \"$ANNOUNCEMENTS_CAT_ID\",
      title: \"Welcome to Compendiq — v1.0 is live\",
      body: \"<paste seed body here>\"
    }) {
      discussion { url }
    }
  }
"
```

Repeat for Q&A, Show & Tell, and Ideas seeds.

---

## Step 6: A16 -- CHANGELOG finalization and GitHub release

### 6a. Bump version to 1.0.0

```bash
cd /Users/simon/Documents/localGIT/compendiq-ee/ce

# Update version in all package.json files
npm version 1.0.0 --no-git-tag-version --workspaces --include-workspace-root
```

### 6b. Finalize CHANGELOG

In `CHANGELOG.md`, rename `[Unreleased]` to `[1.0.0] - 2026-05-05` and remove the HTML comment block.

### 6c. Commit, merge to main, tag, release

```bash
git checkout dev
git add -A
git commit -m "chore: bump version to 1.0.0 and finalize CHANGELOG"
git push origin dev

# Merge dev to main
git checkout main && git pull origin main
git merge origin/dev --no-ff -m "release: v1.0.0"
git push origin main

# Tag and release
git tag v1.0.0
git push origin v1.0.0

# Create GitHub release
gh release create v1.0.0 \
  --target main \
  --title "v1.0.0 — Public Launch" \
  --notes-file /tmp/release-notes-v1.0.0.md
```

The release notes file should be a condensed version of the CHANGELOG.

---

## Rollback plan

**A4 (visibility) cannot be rolled back.** Once public, the repo stays public. Git history is exposed. This is why A1 (audit) must be verified clean before A4.

**A5 (branch protection):** Can be removed via `gh api --method DELETE /repos/Compendiq/compendiq-ce/branches/main/protection`.

**A6 (package visibility):** Can be reverted to private via `gh api --method PUT ... -f visibility=private`.

**A15 (Discussions):** Can be disabled and re-enabled. Seed posts can be edited or deleted.

**A16 (release):** The tag and release can be deleted with `gh release delete v1.0.0 --yes && git push origin :v1.0.0`. However, anyone who cloned between tag creation and deletion will have the tag locally.
