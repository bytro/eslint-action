# ESLint Action

This is a GitHub Action that runs ESLint for `.js`, `.jsx`, and `.tsx` files using your `.eslintrc` rules. It's free to run and it'll annotate the diffs of your pull requests with lint errors and warnings.

![](screenshots/annotation.png)

Neat! Bet your CI doesn't do that.

## Usage

`.github/main.workflow`:

```hcl
workflow "Pull Request" {
  on = "pull_request"
  resolves = ["ESLint"]
}

action "ESLint" {
  uses = "hallee/eslint-action@master"
  secrets = ["GITHUB_TOKEN"]
}
```