# Deus Ex Machina

A local, Trello-style task board that coding agents work through on their own: Claude Code, and also Antigravity CLI and Codex CLI. You create a card, drag it to the agent queue, and the Board runs the CLI installed on your machine (`claude` by default), in a git worktree of its own for that card. Progress shows up live, and the card comes back to you when the agent asks something or finishes.

The command is `dexm`. The project had another name until November 2026; the old command (`claude-board`), MCP server name, `CLAUDE_BOARD_*` variables and `~/.claude-board` folder keep working (see "Renamed from the previous name").

Everything runs on `127.0.0.1`, with no login and no cloud: one process serves the API, the web UI, the runner and an MCP server.

> **Language:** the UI speaks Brazilian Portuguese, English and Spanish: pick one with the globe button in the header (by default, the browser's language). The prompts the runner sends to the agent, the CLI messages and the texts the server writes (system comments, error messages) stay in Brazilian Portuguese. The list names below are given in English with the Portuguese label the UI shows.

## Requirements

- Node.js 22.13 or newer (the database is `node:sqlite`, which ships with Node).
- Claude Code installed and logged in, with the `claude` command on the PATH.
- git, for cards that work in a repository.

## Install

```bash
git clone https://github.com/fabriciopf/deus-ex-machina.git
cd deus-ex-machina
npm install
npm run build
npm link          # puts the dexm command on the PATH
dexm doctor
dexm start
```

Without `npm link`, use `node bin/dexm.mjs <command>`.

On Windows, to start the Board in a window of its own that does not close with your terminal:

```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command','dexm start'
```

The Board must run on the same machine where you use Claude Code, because it reads that machine's `~/.claude`. If you use Claude Code on two machines, run one Board on each.

## First run

1. `dexm doctor` lists what is missing (Node, `claude` on the PATH, git, a free port, transcript retention).
2. `dexm start` and open <http://127.0.0.1:4317>.
3. Under **Importação** (Import), click **Manter 365 dias** (keep 365 days). By default Claude Code deletes transcripts older than 30 days, and the import reads its history from them. The Board backs up `settings.json` before changing it.
4. Under **Importação**, click **Ler o histórico** (read history). Sessions with signs of unfinished work become cards in Triage.
5. Under **Configurações** (Settings), install the hooks if you want the sessions you open yourself to show up on the board.
6. Register the Board's MCP server in Claude Code, so you can say "turn this into a card" in any session:

```bash
claude mcp add --scope user --transport http dexm http://127.0.0.1:4317/mcp
```

## How the board works

| List (UI label) | Meaning | Who puts a card there |
| --- | --- | --- |
| Triage (Triagem) | Import suggestions not accepted yet | System |
| Not started (Não iniciada) | Backlog, outside the agent's queue | You |
| Ready for the agent (Pronta para o agente) | The runner's queue | You or the agent |
| In progress (Em andamento) | A run is going on now | Runner |
| Waiting for you (Aguardando você) | The agent asked something, or the run failed | Runner or MCP |
| Waiting for a third party (Aguardando terceiro) | Depends on someone else, a deploy or access, or on the tasks of a split card | You or the agent |
| In review (Em revisão) | The agent finished; you still have to check | Runner or MCP |
| Done (Concluída) | Approved by you | Only you |

- **Send to the agent:** drag the card to "Ready for the agent" or use the button on the card. A card you own does not enter the queue; the Board asks whether to hand it to the agent.
- **Answer:** when the agent asks, the card goes to "Waiting for you" with the question highlighted and the options as buttons. Answering puts the card back in the queue, and the runner resumes the same session (`claude --resume`).
- **Review:** in "In review", **Approve** moves the card to "Done", and **Request changes** sends it back to the agent with your comment. By default it starts a new session with a handoff package (last summary, the branch's git, new and older comments) instead of rereading the previous session; the card's "Resuming" field or the `resumeMode` setting can keep `claude --resume` (D129).
- **Stop:** kills the agent's process and everything it started. The card goes to "Waiting for you", and **Try again** resumes where it stopped.
- **Continue in the terminal:** copies `cd "<folder>"; claude --resume <session>`.
- **Project:** the product or project the task is about. A card has at most one project, shown on its cover and filterable on the board. Projects are registered under Settings › Projects and labels, with a name, a color and an optional folder; the panel suggests the repositories of the workspace and their `apps/*` folders (monorepos), skipping worktrees. The run gets the project's name and folder in its prompt. On import, a session gets the project whose folder holds most of the files it edited. In the code, the API and the MCP the field is still called `app`.

### Shortcuts

| Key | Action |
| --- | --- |
| `n` | New card in "Not started" |
| `/` | Search |
| Arrows | Move between cards |
| `Enter` | Open the card |
| `e` | Edit the description (card open) |
| `a` | Approve (card open and in review) |
| `Esc` | Close |

## The runner

Every 30 seconds (and right away when a card enters the queue), the runner takes the next card from "Ready for the agent", by priority and then by position, and runs:

```text
claude -p --output-format stream-json --verbose [--max-turns N] [--model M] [--effort E] [--name <name>]
       --append-system-prompt <Board rules>
       --mcp-config <the Board's MCP over HTTP>
       --allowedTools mcp__dexm --permission-prompts none
       [--permission-mode M] [--add-dir <worktree>] --disallowedTools <git push…>
       (--session-id UUID | --resume ID)
```

- **Same setup as your editor:** with `workspaceDir` set, every run starts at the workspace root and loads the same `CLAUDE.md`, skills, project `settings.json` and memory. With no permission mode on the card, the one in your Claude Code `settings.json` applies.
- **Where it works:** a card with a repository gets its own worktree next to the repo (`../<repo>-cb-<id>`), on branch `cb/<id>-<title>`, created from the base branch. The main branch is never touched. The worktree joins the session through `--add-dir`. A card with no repository works in the workspace (or in `~/.dexm/work/<id>/` when there is no `workspaceDir`).
- **Transcript:** each run is stored in `~/.dexm/transcripts/<id>.jsonl` and shown on the card, with messages, collapsed tool calls and highlighted errors.
- **No limits by default:** a run goes until the agent finishes, like an interactive session. A card can set its own maximum turns. "Pausar runner" in the header holds the whole queue.
- **Session name:** on the first run, Claude gives the task a short name (`card_rename`), which becomes the card title and the Claude Code session name. The original title and description stay on the card.
- **Sound:** when the agent or the runner moves a card to "Waiting for you", "Waiting for a third party" or "In review", the Board plays a short chime. Moves you make yourself are silent. The header toggle turns it off for that browser; with several tabs open, only one plays.
- **No automatic retry:** whatever fails comes back to you.
- **Git remotes:** by default the agent neither pushes nor opens PRs (`prPolicy = "none"`). Settings can allow pushing the `cb/*` branch, or pushing and opening a draft PR, when the card asks for it. Force pushes and pushes to the branches in `protectedBranches` are always blocked, by the agent's rules and by a `pre-push` hook the Board sets for every run (through `core.hooksPath` in the run's environment) and in each card's worktree.
- **Dangerous mode:** only with the "Perigoso: rodar sem permissões" checkbox ticked on the card, which asks for confirmation.

Runs use the same Claude Code login you use interactively, so they draw on the same plan quota.

### Antigravity CLI as the agent

A card can run in [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`, Google) instead of Claude Code: pick "Antigravity CLI" in the card's "Agent" field, or make it the default in Settings › Antigravity CLI. Install it (on Windows, `irm https://antigravity.google/cli/install.ps1 | iex`) and sign in once in a terminal. The Board drives it through its Agent Client Protocol mode, with a small client of its own:

```text
node bin/agy-acp.mjs runs/<id>/agy-run.json
  └─ agy acp [--add-dir <worktree>]
       initialize → session/new (or session/load) with the Board's MCP server
         → session/set_model, session/set_mode plan (when the card asks) → session/prompt
```

- **Same card flow:** each session gets the Board's MCP server with the card's headers (over HTTP, or over stdio through `dexm mcp` when agy offers no HTTP MCP). The Board's rules go at the top of the prompt. Questions, deliveries, splits, retries and "Continue in terminal" (`agy --conversation <id>`) work as with Claude Code. The client writes the run in Claude Code's stream format, so the transcript, turns and tokens show the same way.
- **Permissions:** the client answers every permission request agy makes: it allows them, except the shell commands the `prPolicy` and `protectedBranches` rules forbid, which it refuses (a compound command is checked part by part).
- **Sessions:** agy picks the session id; the Board learns it from the run. A reply loads the same session. A card moved from one agent to the other starts a new session, with the card history in the prompt.
- **Turn limit:** the card's maximum turns cancels the session when it is reached.
- **What only Claude Code has:** your `CLAUDE.md`, skills, plugins, claude.ai connectors and the Artifact tool. Antigravity CLI reads `GEMINI.md`, `AGENTS.md` and its own plugins.
- **Automatic concurrency for Antigravity:** set its limit to `auto` and the Board paces Antigravity runs by the Google quota, the same way it paces Claude Code by the 5-hour window. Neither ACP nor `agy -p` report that quota, so the Board reads it from agy's own `swarm` tool (`swarm{action:"models"}`, opened by a `/swarm` prompt in `agy -p --output-format stream-json`), never from agy's credentials. Each reading is one turn of the cheapest model, paid from that quota, so it happens at most every 20 minutes: after each Antigravity run, and every 20 minutes while Antigravity is in use. It is the default since the review of card #198. With the quota at zero no Antigravity run starts until it renews, unless AI credits pay for it.

### Codex CLI as the agent

A card can also run in [Codex CLI](https://github.com/openai/codex) (`codex`, OpenAI): pick "Codex CLI" in the card's "Agent" field, or make it the default on the Runs tab. Install it with `npm i -g @openai/codex` and run `codex login` once in a terminal. The Board drives `codex exec --json` through a small client of its own (D125):

```text
node bin/codex-exec.mjs runs/<id>/codex-run.json
  └─ codex exec --json --skip-git-repo-check -c model=… -c sandbox_mode=… -c mcp_servers.dexm.url=… [resume <id>] -
```

- **Same card flow:** every option goes as a `-c` override of your `config.toml`, including the Board's MCP server over HTTP with the card's headers. The Board's rules go at the top of the prompt, which codex reads on stdin. The client writes the run in Claude Code's stream format.
- **Sandbox:** `workspace-write` by default, `read-only` for a card in plan mode, `danger-full-access` when the card allows everything. `codexNetworkAccess` decides whether its commands reach the network.
- **Push rules:** codex takes no list of forbidden commands, so the client stops the run when a shell command the `prPolicy` forbids starts, and resumes the session telling codex why. The worktree's pre-push hook is the lock that does not race.
- **Sessions, effort and limits:** codex picks the session id (`thread_id`); a reply resumes it. The card effort goes as `model_reasoning_effort` (xhigh and max become `xhigh`). Codex runs have their own fixed limit, `codexConcurrency`; there is no automatic mode, since codex reports no quota.

### Cards with several items

When a card's description is a list (with or without surrounding context), the first run starts by asking the agent whether the items are independent tasks or steps of a single task.

- **Independent tasks:** the agent calls `card_split` and stops. The Board creates one card per task, already in "Ready for the agent", with that task's description, the shared context and the original card's settings (project, labels, priority, due date, repository, permissions, links). Each task has its own session and follows its own path. They run in parallel up to "Execuções simultâneas" (concurrent runs).
- **A single task:** the agent goes on with the card as usual.

The original card waits in "Waiting for a third party", with its tasks and their status on the cover, and moves to "Done" by itself when you approve the last one. To keep a card whole, say so in its description; to turn the question off for every card, untick "Dividir card com lista em tarefas" in Settings.

### Working on the Board itself

With `autoPublish` on, a card whose branch lives in the Board's own repository is merged into `publishBranch`, tested, built and hot-restarted when it reaches "In review". This is meant for developing the Board with the Board; it is off by default.

## Automations

**Automations**, in the header menu (☰), holds recurring tasks. You describe one in plain words, such as "every Monday at 9am, list the open PRs that have been idle for 3 days" or "when an e-mail from Omar arrives, summarize it and turn the requests into a checklist". Claude Code (the `classificationModel`, with no tools) reads the text into a name, a trigger and an instruction. The list shows what it understood. To change an automation, rewrite its text.

Each firing creates a card in "Ready for the agent" with the instruction as its description. The rest is the same as for any other card: the runner, the questions, the review.

| Trigger | How it fires |
| --- | --- |
| Schedule | A 5-field cron in the Board's local time. While the previous card is still queued and has not started, the next turn is skipped. A turn missed while the Board was off fires once when it comes back. |
| Watch | Every few minutes (15 by default, 5 at least), a short `claude -p` session looks for new items in a claude.ai connector: Gmail, Slack, Google Calendar, Google Drive, Jira or Notion. Each new item becomes a card, and an item already seen never comes back. The session may only call the read tools of those connectors, so an e-mail cannot make it send or delete anything. |
| URL | `POST /api/automations/hook/<token>` from n8n, a script or a Slack workflow. The request body goes into the card. Off the local machine this needs `--insecure-lan` (the API has no authentication). |

You can also turn each automation on and off, or run it now. An automation stays on the list after it runs until you delete it. Below the list, **Últimas execuções** shows the latest 50 runs: when, which automation, why (schedule, by hand, URL, watch), how it ended (card created, skipped, failed, nothing new) and the card with its current list. A watch that keeps finding nothing updates one line with a count.

## MCP server

| Tool | Use |
| --- | --- |
| `board_list_cards` | List by status, project (`app`), label, owner or text |
| `card_get` | Full card: comments, checklist, links, runs |
| `card_create` | Create a card ("turn this into a card") |
| `card_update` | Edit title, description, priority, due date, project, repository, labels (`labels` replaces; `addLabels`/`removeLabels` adjust) |
| `card_rename` | Give the task the session name (keeps the original request) |
| `card_move` | Change list; never to "Done" |
| `card_comment` | Progress comment |
| `card_checklist_add`, `card_checklist_check`, `card_checklist_update` | Checklist (o `update` troca o texto de um item pelo id ou pelo texto atual) |
| `card_link` | Attach a PR, Jira key, file or URL |
| `card_ask_user` | Question: card goes to "Waiting for you" |
| `card_wait_third_party` | Card goes to "Waiting for a third party" |
| `card_submit_for_review` | Delivery: card goes to "In review" |
| `card_split` | Split the card into independent tasks, each a queued card |
| `automation_list`, `automation_create`, `automation_update` | Recurring tasks: the agent reads the request itself and passes the trigger and the instruction |

The rules are enforced by the server, not only by the UI: the MCP refuses to move a card to "Done". The agent can queue cards, even from inside a run, but not the card it is running nor a card you own. `card_split` only splits the card of its own run, once.

There are two transports: HTTP at `http://127.0.0.1:4317/mcp`, which the runner uses, and stdio (`dexm mcp`), which forwards to HTTP. The server is named `dexm`, so its tools reach Claude Code as `mcp__dexm__card_*`.

## Hooks

`dexm hooks install` adds three hooks (`SessionStart`, `Stop`, `SessionEnd`) to `~/.claude/settings.json`, backing the file up first. They never call an LLM:

- a session opened in a card's worktree gets a summary of the card in its context;
- a session with no card is recorded and shows up in the incremental import;
- with the Board down, the hook exits in under a second, without error.

`dexm hooks uninstall` removes only the Board's hooks (also the ones installed under the previous name).

## Importing your history

1. `dexm import scan` (or the button in the UI) reads `~/.claude/projects` and `history.jsonl`, without an LLM. It looks for four signals: open todos, unanswered questions, a question at the end of the conversation, and errors. Sessions with a signal become cards in Triage. It can run any number of times and only rereads what changed.
2. `dexm import classify` sends each session's summary, in batches, to a cheap model that suggests a title, a list and a confidence. It shows the token estimate and only runs after you confirm.

In Triage you accept, adjust or ignore suggestions, one by one or in bulk by minimum confidence.

## Updates

A Board installed with `git clone` keeps itself up to date: every new commit on the branch it was cloned from (`origin/main`) counts as a new version. The Board checks 30 seconds after it starts and every 6 hours.

- **Notify** (default): a strip at the foot of the window shows how many changes are new, with **Novidades** (the commits), **Atualizar** and **Depois** (hide until the next version).
- **Automatic**: the update starts on its own as soon as a check finds a new version.
- **Off**: the Board never checks.

Updating takes the same path as a publication of the Board's own cards: the new version is merged and built in a throwaway worktree, `npm install` runs when the lockfile changed, the database is backed up, and the server restarts only when its code changed. Runs in progress keep going through the restart. If anything fails, nothing changes and the strip turns red with the reason.

Changes you made to your own Board stay: when your branch has commits the remote does not, the update merges the two and runs the tests first. A conflict stops the update and names the files.

Settings › Workspace e Git has the mode, the branch to follow and a **Verificar agora** button. The update is off only in the Board that generates the public copy: its `mirrorRepoPath` checkout is another repository whose `origin` is the remote it would update from.

When a check cannot reach the remote (no network, DNS, proxy, credentials), the panel says why and the Board checks again in 15 minutes.

### Automatic updates need signed commits

**Automatic** runs code from the remote with nobody watching, so it only applies a version when every new commit can be trusted. A commit is trusted when it has one of these:

- a good signature from a key this machine trusts (`git log --format=%G?` prints `G`);
- an author e-mail listed in **Autores aceitos na atualização automática** (`selfUpdateAuthors`). This is weaker, because an author e-mail can be forged;
- two parents and exactly the tree git produces by merging them, as GitHub's "Create a merge commit" does. A merge like that brings no code of its own, and its parents are checked like any other commit.

If one commit fails, that version behaves as in **Notify**: the strip says the automatic update is waiting, the panel names the commit, and **Atualizar** applies it once you have looked.

**On each machine that runs the Board in Automatic**, trust the maintainer's SSH signing key once (PowerShell):

```powershell
$signers = "$HOME\.ssh\allowed_signers"
$key = gh api users/fabriciopf/ssh_signing_keys --jq '.[0].key'
Add-Content -Encoding ascii $signers "maintainer namespaces=`"git`" $key"
git -C <Board folder> config gpg.ssh.allowedSignersFile $signers
git -C <Board folder> fetch origin
git -C <Board folder> log --no-merges -1 --format=%G? origin/main   # G = trusted
```

Then pick **Automática** in Settings › Workspace e Git.

**On the maintainer's machine** (the Board that generates the public copy), sign the commits it pushes:

```powershell
ssh-keygen -t ed25519 -C "dexm signing" -N '""' -f "$HOME\.ssh\dexm_signing"
git -C <mirrorRepoPath> config gpg.format ssh
git -C <mirrorRepoPath> config user.signingkey "$HOME\.ssh\dexm_signing"
git -C <mirrorRepoPath> config commit.gpgsign true
gh ssh-key add "$HOME\.ssh\dexm_signing.pub" --type signing --title "dexm signing"
```

The Board signs each public commit when that checkout has `commit.gpgsign`. The key has no passphrase because the Board pushes on its own; keep it on that machine only. Publishing it as a signing key on GitHub gives the commits the Verified badge and lets other machines fetch it with the command above. Only the commits an install does not have yet are checked. An install that is behind on commits pushed before the key existed waits for one **Atualizar**; after that, Automatic runs on its own. GitHub must merge the PRs with a merge commit: a squash or rebase merge makes a new commit that only GitHub signs, and Automatic waits for it.

## Configuration

Stored in `~/.dexm/config.json` and editable in Settings.

| Key | Default | What it does |
| --- | --- | --- |
| `port` | 4317 | Board port |
| `claudeBin` | `claude` | Claude Code executable |
| `claudeHome` | `~/.claude` | Claude Code folder |
| `defaultAgent` | `claude` | Agent of runs when the card does not choose: `claude` (Claude Code), `antigravity` (Antigravity CLI) or `codex` (Codex CLI) |
| `antigravityBin` | `agy` | Antigravity CLI executable |
| `antigravityModel` | empty | Model of Antigravity runs when the card does not choose; empty = Antigravity CLI's default (`agy models` lists them) |
| `antigravityEffort` | empty | Effort of Antigravity runs when the card does not choose: `low`, `medium` or `high`, swapped into the `-low/-medium/-high` suffix of the model id; empty = the model's own suffix |
| `codexBin` | `codex` | Codex CLI executable |
| `codexModel` | empty | Model of Codex runs when the card does not choose; empty = Codex CLI's default |
| `codexEffort` | `high` | Effort of Codex runs (`model_reasoning_effort`) when the card does not choose: `low`, `medium`, `high` or `xhigh`; empty = Codex CLI's default |
| `codexNetworkAccess` | `true` | Whether Codex commands reach the network inside its `workspace-write` sandbox |
| `codexConcurrency` | 2 | Concurrent Codex CLI runs, apart from the other agents: 0 to 20 or `"unlimited"` |
| `heartbeatSeconds` | 30 | Runner interval |
| `maxConcurrency` | `"auto"` | Concurrent runs: `"auto"` (paces runs so the 5-hour usage tracks the window, and only opens a run when what is left until the reset pays for the runs in progress plus one more with slack) or 1 to 20 |
| `resumeMode` | `"handoff"` | How an adjustment, comment or requeue takes a delivered card back: `"handoff"` = new session with a handoff package, `"resume"` = the previous session (`--resume`). A reply and a retry always resume. A card can choose its own |
| `autoSplit` | `true` | On a card's first run, the agent decides whether a list description becomes separate tasks |
| `runTimeoutMinutes` | 0 | Maximum run time; 0 = no limit |
| `defaultMaxTurns` | 0 | Turns per run; 0 = no limit |
| `workspaceDir` | empty | Folder where runs start (your editor workspace) |
| `defaultPermissionMode` | empty | Permission mode; empty = the one in your settings.json |
| `defaultBaseBranch` | `main` | Base branch of the worktrees (falls back to the repo's default branch when missing) |
| `worktreeRoot` | empty | Worktree folder; empty = next to the repo |
| `prPolicy` | `none` | `none`, `push_branch` or `open_pr` |
| `protectedBranches` | `main, master, production, preproduction*` | Branches no run ever pushes to; comma-separated, a trailing `*` matches any suffix |
| `jiraBaseUrl` | empty | Jira site (e.g. `https://acme.atlassian.net`); a Jira link holding an issue key opens there, and a key written in a card text becomes a link |
| `jiraProjectKeys` | empty | Jira project keys that become links in card texts (e.g. `PROD, STAYS2`); empty = any `ABC-123` key |
| `defaultModel` | `claude-opus-5-5` | Model of runs (`--model`) when the card does not choose; empty = Claude Code's default |
| `defaultEffort` | `high` | Effort of Claude Code runs (`--effort`) when the card does not choose; empty = Claude Code's default |
| `classificationModel` | `haiku` | Model used by the import and by the agenda reading |
| `agendaRefreshMinutes` | 30 | Interval of the agenda reading shown in the header; 0 = off |
| `transcriptRetentionDays` | 90 | Retention of the Board's transcripts |
| `userProfile` | empty | A line about you that goes into every run's prompt (language, tone, conventions) |
| `runnerEntrypoint` | `claude-vscode` | `CLAUDE_CODE_ENTRYPOINT` of every run, so headless runs get the same tools as an editor session; empty = inherit the Board's own |
| `autoPublish` | `false` | Merge, test, build and restart the Board's own cards (see "Working on the Board itself") |
| `publishBranch` | `main` | Branch of the Board's repository that receives those cards |
| `selfUpdate` | `notify` | Update from the remote the Board was cloned from: `off`, `notify` (strip with a button) or `auto` (see "Updates") |
| `selfUpdateSource` | empty | Remote branch to follow, as `remote/branch`; empty = the branch the checkout tracks |

The Board's folder is `~/.dexm`; `DEXM_HOME` changes it.

## Security

- The Board listens only on `127.0.0.1` and refuses any other host (`0.0.0.0`, a LAN address) unless started with `--insecure-lan`, which prints a warning on every start; the old `--allow-remote` still works as an alias. `dexm doctor` warns when `host` is not loopback. Requests whose `Host` header is not local get a 403, which blocks DNS rebinding.
- There is no login: any process on your machine can call the API.
- Transcripts may contain sensitive data. They live in `~/.dexm/transcripts` and are deleted after `transcriptRetentionDays`.
- The push rules are best effort: they block the common `git push` forms (also behind `git -C`, `git -c`, `sh -c`, and `gh pr merge` or `gh api` writes that merge or move a branch), not every way a shell could reach a remote. Every run also gets a `pre-push` hook through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` in its environment, with or without a worktree (the repository's own hooks still run), which checks what the push actually sends. `git push --no-verify` and `git -c core.hooksPath=…` skip it, and the agent rules refuse those forms. Neither lock is the real one: protect `main` and the other release branches on GitHub (required PR, no force push, no bypass for admins) and give the agents a credential without push to them.

## Renamed from the previous name

The project had another name until November 2026. A machine set up under the old name keeps working after the update, with nothing to do:

| Old | New | What happens with the old one |
| --- | --- | --- |
| `claude-board` command | `dexm` | Still installed by `npm link` as an alias |
| `~/.claude-board` folder | `~/.dexm` | Used while `~/.dexm` does not exist, so no card is lost. To move it, stop the Board and rename the folder |
| `CLAUDE_BOARD_*` variables | `DEXM_*` | Read when the new one is unset; runs get both |
| MCP server `claude-board` | `dexm` | The same endpoint answers both registrations; runs get `dexm` |
| Hooks marked `claude-board-hook` | `dexm-hook` | Keep working; `dexm hooks install` replaces them |

To finish the switch on a machine: run `npm link` again (for the `dexm` command), `dexm hooks install`, and register the MCP server as `dexm` (the old registration can stay, or go with `claude mcp remove --scope user claude-board`).

## Development

```bash
npm test          # Vitest: the whole suite (what the publication runs)
npm run test:unit # the suite without the 15 files that build git repositories or process trees (~40 s against ~17 min on Windows)
npm run test:integration
npx vitest run test/runner.test.ts   # one file
npm run typecheck
npm run dev:ui    # Vite on http://127.0.0.1:5317, proxying the API on 4317 (open 4317 once first: the API needs its session cookie, D112)
```

The runner tests use `test/fake-claude.mjs`, which accepts the same arguments as Claude Code, emits `stream-json` and calls the real MCP, without spending tokens. History fixtures live in `test/fixtures/claude-home` and are generated by `node test/fixtures/make-fixtures.mjs`.

## License

[MIT](LICENSE)
