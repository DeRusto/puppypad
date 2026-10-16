# @puppypad/cli

Upload a folder to your [PuppyPad](https://puppypad.org) site from the command line. Edit your site in any
editor, then push the changes.

```sh
npx @puppypad/cli login      # paste the API key from your dashboard's API key page
npx @puppypad/cli push       # upload new and changed files from this folder
```

Or install it once with `npm install -g @puppypad/cli` and run `puppypad push`. Needs Node 20 or newer.

| Command | What it does |
| --- | --- |
| `puppypad login` | Saves your API key (in `~/.config/puppypad/config.json`) |
| `puppypad logout` | Forgets the saved key |
| `puppypad info` | Your site's address, space used and limits |
| `puppypad list` | Every file on your site |
| `puppypad push [folder]` | Uploads new and changed files. Unchanged files are skipped |
| `puppypad push --delete` | Also deletes files on your site that are not in the folder |
| `puppypad push --dry-run` | Shows what would change without changing anything |
| `puppypad pull [folder]` | Downloads your site's files. Never deletes anything on your computer |
| `puppypad delete <path>...` | Deletes files from your site |

Files and folders whose names start with a dot (like `.git`) and `node_modules` are never uploaded,
and neither are file types PuppyPad doesn't host.

`--delete` removes every file on your site that the folder doesn't have, including ones you made on
the dashboard, such as `puppypad.css` from the style editor. Try it with `--dry-run` first.

On your own PuppyPad server, add `--url https://your.domain` to `login`, or set `PUPPYPAD_URL`.
In scripts and CI, set `PUPPYPAD_API_KEY` instead of logging in.

## Deploy from GitHub

To upload your site on every push to your repository, add the key as a repository secret named
`PUPPYPAD_API_KEY`, then add `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeRusto/puppypad@main
        with:
          api_key: ${{ secrets.PUPPYPAD_API_KEY }}
          dir: public       # optional: the folder to upload (default: the whole repository)
          delete: true      # optional: mirror the folder, deleting files it doesn't have
          # url: https://your.domain   # optional: your own PuppyPad server
```
