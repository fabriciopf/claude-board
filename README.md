# Claude Board

A local, Trello-style task board that Claude Code works through on its own. You create a card, drag it to the Claude queue, and the Board runs the `claude` CLI installed on your machine, in a git worktree of its own for that card. Progress shows up live, and the card comes back to you when Claude asks something or finishes.

Everything runs on `127.0.0.1`, with no login and no cloud: one process serves the API, the web UI, the runner and an MCP server.

> **Language:** the UI speaks Brazilian Portuguese, English and Spanish: pick one with the globe button in the header (by default, the browser's language). The prompts the runner sends to Claude, the CLI messages and the texts the server writes (system comments, error messages) stay in Brazilian Portuguese. The list names below are given in English with the Portuguese label the UI shows.

## Requirements

- Node.js 22.13 or newer (the database is `node:sqlite`, which ships with Node).
- Claude Code installed and logged in, with the `claude` command on the PATH.
- git, for cards that work in a repository.

## Install

```bash
git clone https://github.com/fabriciopf/claude-board.git
cd claude-board
npm install
npm run build
npm link          # puts the claude-board command on the PATH
claude-board doctor
claude-board start
```

Without `npm link`, use `node bin/claude-board.mjs <command>`.

On Windows, to start the Board in a window of its own that does not close with your terminal:

```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command','claude-board start'
```

The Board must run on the same machine where you use Claude Code, because it reads that machine's `~/.claude`. If you use Claude Code on two machines, run one Board on each.

## First run

1. `claude-board doctor` lists what is missing (Node, `claude` on the PATH, git, a free port, transcript retention).
2. `claude-board start` and open <http://127.0.0.1:4317>.
3. Under **Importação** (Import), click **Manter 365 dias** (keep 365 days). By default Claude Code deletes transcripts older than 30 days, and the import reads its history from them. The Board backs up `settings.json` before changing it.
4. Under **Importação**, click **Ler o histórico** (read history). Sessions with signs of unfinished work become cards in Triage.
5. Under **Configurações** (Settings), install the hooks if you want the sessions you open yourself to show up on the board.
6. Register the Board's MCP server in Claude Code, so you can say "turn this into a card" in any session:

```bash
claude mcp add --scope user --transport http claude-board http://127.0.0.1:4317/mcp
```

## How the board works

| List (UI label) | Meaning | Who puts a card there |
| --- | --- | --- |
| Triage (Triagem) | Import suggestions not accepted yet | System |
| Not started (Não iniciada) | Backlog, outside Claude's queue | You |
| Ready for Claude (Pronta para o Claude) | The runner's queue | You or Claude |
| In progress (Em andamento) | A run is going on now | Runner |
| Waiting for you (Aguardando você) | Claude asked something, or the run failed | Runner or MCP |
| Waiting for a third party (Aguardando terceiro) | Depends on someone else, a deploy or access, or on the tasks of a split card | You or Claude |
| In review (Em revisão) | Claude finished; you still have to check | Runner or MCP |
| Done (Concluída) | Approved by you | Only you |

- **Send to Claude:** drag the card to "Ready for Claude" or use the button on the card. A card you own does not enter the queue; the Board asks whether to hand it to Claude.
- **Answer:** when Claude asks, the card goes to "Waiting for you" with the question highlighted and the options as buttons. Answering puts the card back in the queue, and the runner resumes the same session (`claude --resume`).
- **Review:** in "In review", **Approve** moves the card to "Done", and **Request changes** sends it back to Claude with your comment, in the same session.
- **Stop:** kills the Claude process and everything it started. The card goes to "Waiting for you", and **Try again** resumes where it stopped.
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

Every 30 seconds (and right away when a card enters the queue), the runner takes the next card from "Ready for Claude", by priority and then by position, and runs:

```text
claude -p --output-format stream-json --verbose [--max-turns N] [--model M] [--effort E] [--name <name>]
       --append-system-prompt <Board rules>
       --mcp-config <the Board's MCP over HTTP>
       --allowedTools mcp__claude-board --permission-prompts none
       [--permission-mode M] [--add-dir <worktree>] --disallowedTools <git push…>
       (--session-id UUID | --resume ID)
```

- **Same setup as your editor:** with `workspaceDir` set, every run starts at the workspace root and loads the same `CLAUDE.md`, skills, project `settings.json` and memory. With no permission mode on the card, the one in your Claude Code `settings.json` applies.
- **Where it works:** a card with a repository gets its own worktree next to the repo (`../<repo>-cb-<id>`), on branch `cb/<id>-<title>`, created from the base branch. The main branch is never touched. The worktree joins the session through `--add-dir`. A card with no repository works in the workspace (or in `~/.claude-board/work/<id>/` when there is no `workspaceDir`).
- **Transcript:** each run is stored in `~/.claude-board/transcripts/<id>.jsonl` and shown on the card, with messages, collapsed tool calls and highlighted errors.
- **No limits by default:** a run goes until Claude finishes, like an interactive session. A card can set its own maximum turns. "Pausar runner" in the header holds the whole queue.
- **Session name:** on the first run, Claude gives the task a short name (`card_rename`), which becomes the card title and the Claude Code session name. The original title and description stay on the card.
- **Sound:** when Claude or the runner moves a card to "Waiting for you", "Waiting for a third party" or "In review", the Board plays a short chime. Moves you make yourself are silent. The header toggle turns it off for that browser; with several tabs open, only one plays.
- **No automatic retry:** whatever fails comes back to you.
- **Git remotes:** by default Claude neither pushes nor opens PRs (`prPolicy = "none"`). Settings can allow pushing the `cb/*` branch, or pushing and opening a draft PR, when the card asks for it. Force pushes and pushes to the branches in `protectedBranches` are always blocked.
- **Dangerous mode:** only with the "Perigoso: rodar sem permissões" checkbox ticked on the card, which asks for confirmation.

Runs use the same Claude Code login you use interactively, so they draw on the same plan quota.

### Cards with several items

When a card's description is a list (with or without surrounding context), the first run starts by asking Claude whether the items are independent tasks or steps of a single task.

- **Independent tasks:** Claude calls `card_split` and stops. The Board creates one card per task, already in "Ready for Claude", with that task's description, the shared context and the original card's settings (project, labels, priority, due date, repository, permissions, links). Each task has its own session and follows its own path. They run in parallel up to "Execuções simultâneas" (concurrent runs).
- **A single task:** Claude goes on with the card as usual.

The original card waits in "Waiting for a third party", with its tasks and their status on the cover, and moves to "Done" by itself when you approve the last one. To keep a card whole, say so in its description; to turn the question off for every card, untick "Dividir card com lista em tarefas" in Settings.

### Working on the Board itself

With `autoPublish` on, a card whose branch lives in the Board's own repository is merged into `publishBranch`, tested, built and hot-restarted when it reaches "In review". This is meant for developing the Board with the Board; it is off by default.

## Automations

**Automations**, in the header menu (☰), holds recurring tasks. You describe one in plain words, such as "every Monday at 9am, list the open PRs that have been idle for 3 days" or "when an e-mail from Omar arrives, summarize it and turn the requests into a checklist". Claude Code (the `classificationModel`, with no tools) reads the text into a name, a trigger and an instruction. The list shows what it understood. To change an automation, rewrite its text.

Each firing creates a card in "Ready for Claude" with the instruction as its description. The rest is the same as for any other card: the runner, the questions, the review.

| Trigger | How it fires |
| --- | --- |
| Schedule | A 5-field cron in the Board's local time. While the previous card is still queued and has not started, the next turn is skipped. A turn missed while the Board was off fires once when it comes back. |
| Watch | Every few minutes (15 by default, 5 at least), a short `claude -p` session looks for new items in a claude.ai connector: Gmail, Slack, Google Calendar, Google Drive, Jira or Notion. Each new item becomes a card, and an item already seen never comes back. The session may only call the read tools of those connectors, so an e-mail cannot make it send or delete anything. |
| URL | `POST /api/automations/hook/<token>` from n8n, a script or a Slack workflow. The request body goes into the card. Off the local machine this needs `--allow-remote`. |

You can also turn each automation on and off, or run it now. An automation stays on the list after it runs until you delete it. Below the list, **Últimas execuções** shows the latest 50 runs: when, which automation, why (schedule, by hand, URL, watch), how it ended (card created, skipped, failed, nothing new) and the card with its current list. A watch that keeps finding nothing updates one line with a count.

## MCP server

| Tool | Use |
| --- | --- |
| `board_list_cards` | List by status, project (`app`), label, owner or text |
| `card_get` | Full card: comments, checklist, links, runs |
| `card_create` | Create a card ("turn this into a card") |
| `card_update` | Edit title, description, priority, due date, project, repository, owner |
| `card_rename` | Give the task the session name (keeps the original request) |
| `card_move` | Change list; never to "Done" |
| `card_comment` | Progress comment |
| `card_checklist_add`, `card_checklist_check` | Checklist |
| `card_link` | Attach a PR, Jira key, file or URL |
| `card_ask_user` | Question: card goes to "Waiting for you" |
| `card_wait_third_party` | Card goes to "Waiting for a third party" |
| `card_submit_for_review` | Delivery: card goes to "In review" |
| `card_split` | Split the card into independent tasks, each a queued card |
| `automation_list`, `automation_create`, `automation_update` | Recurring tasks: Claude reads the request itself and passes the trigger and the instruction |

The rules are enforced by the server, not only by the UI: the MCP refuses to move a card to "Done". Claude can queue cards, even from inside a run, but not the card it is running nor a card you own. `card_split` only splits the card of its own run, once.

There are two transports: HTTP at `http://127.0.0.1:4317/mcp`, which the runner uses, and stdio (`claude-board mcp`), which forwards to HTTP.

## Hooks

`claude-board hooks install` adds three hooks (`SessionStart`, `Stop`, `SessionEnd`) to `~/.claude/settings.json`, backing the file up first. They never call an LLM:

- a session opened in a card's worktree gets a summary of the card in its context;
- a session with no card is recorded and shows up in the incremental import;
- with the Board down, the hook exits in under a second, without error.

`claude-board hooks uninstall` removes only the Board's hooks.

## Importing your history

1. `claude-board import scan` (or the button in the UI) reads `~/.claude/projects` and `history.jsonl`, without an LLM. It looks for four signals: open todos, unanswered questions, a question at the end of the conversation, and errors. Sessions with a signal become cards in Triage. It can run any number of times and only rereads what changed.
2. `claude-board import classify` sends each session's summary, in batches, to a cheap model that suggests a title, a list and a confidence. It shows the token estimate and only runs after you confirm.

In Triage you accept, adjust or ignore suggestions, one by one or in bulk by minimum confidence.

## Updates

A Board installed with `git clone` keeps itself up to date: every new commit on the branch it was cloned from (`origin/main`) counts as a new version. The Board checks 30 seconds after it starts and every 6 hours.

- **Notify** (default): a strip at the foot of the window shows how many changes are new, with **Novidades** (the commits), **Atualizar** and **Depois** (hide until the next version).
- **Automatic**: the update starts on its own as soon as a check finds a new version.
- **Off**: the Board never checks.

Updating takes the same path as a publication of the Board's own cards: the new version is merged and built in a throwaway worktree, `npm install` runs when the lockfile changed, the database is backed up, and the server restarts only when its code changed. Runs in progress keep going through the restart. If anything fails, nothing changes and the strip turns red with the reason.

Changes you made to your own Board stay: when your branch has commits the remote does not, the update merges the two and runs the tests first. A conflict stops the update and names the files.

Settings › Workspace e Git has the mode, the branch to follow and a **Verificar agora** button. The update is off in a Board that has `mirrorRepoPath` set, because that Board is the source of the public copy.

## Configuration

Stored in `~/.claude-board/config.json` and editable in Settings.

| Key | Default | What it does |
| --- | --- | --- |
| `port` | 4317 | Board port |
| `claudeBin` | `claude` | Claude Code executable |
| `claudeHome` | `~/.claude` | Claude Code folder |
| `heartbeatSeconds` | 30 | Runner interval |
| `maxConcurrency` | `"auto"` | Concurrent runs: `"auto"` (paces runs so the 5-hour usage tracks the window, and only opens a run when what is left until the reset pays for the runs in progress plus one more with slack) or 1 to 20 |
| `autoSplit` | `true` | On a card's first run, Claude decides whether a list description becomes separate tasks |
| `runTimeoutMinutes` | 0 | Maximum run time; 0 = no limit |
| `defaultMaxTurns` | 0 | Turns per run; 0 = no limit |
| `workspaceDir` | empty | Folder where runs start (your editor workspace) |
| `defaultPermissionMode` | empty | Permission mode; empty = the one in your settings.json |
| `defaultBaseBranch` | `main` | Base branch of the worktrees (falls back to the repo's default branch when missing) |
| `worktreeRoot` | empty | Worktree folder; empty = next to the repo |
| `prPolicy` | `none` | `none`, `push_branch` or `open_pr` |
| `protectedBranches` | `main, master, production, preproduction*` | Branches no run ever pushes to; comma-separated, a trailing `*` matches any suffix |
| `jiraBaseUrl` | empty | Jira site (e.g. `https://acme.atlassian.net`); a Jira link holding an issue key opens there |
| `defaultModel` | `claude-opus-5-5` | Model of runs (`--model`) when the card does not choose; empty = Claude Code's default |
| `defaultEffort` | `high` | Effort of runs (`--effort`) when the card does not choose; empty = Claude Code's default |
| `classificationModel` | `haiku` | Model used by the import and by the agenda reading |
| `agendaRefreshMinutes` | 30 | Interval of the agenda reading shown in the header; 0 = off |
| `transcriptRetentionDays` | 90 | Retention of the Board's transcripts |
| `userProfile` | empty | A line about you that goes into every run's prompt (language, tone, conventions) |
| `runnerEntrypoint` | `claude-vscode` | `CLAUDE_CODE_ENTRYPOINT` of every run, so headless runs get the same tools as an editor session; empty = inherit the Board's own |
| `autoPublish` | `false` | Merge, test, build and restart the Board's own cards (see "Working on the Board itself") |
| `publishBranch` | `main` | Branch of the Board's repository that receives those cards |
| `selfUpdate` | `notify` | Update from the remote the Board was cloned from: `off`, `notify` (strip with a button) or `auto` (see "Updates") |
| `selfUpdateSource` | empty | Remote branch to follow, as `remote/branch`; empty = the branch the checkout tracks |

The Board's folder is `~/.claude-board`; `CLAUDE_BOARD_HOME` changes it.

## Security

- The Board listens only on `127.0.0.1` and refuses other hosts without `--allow-remote`. Requests whose `Host` header is not local get a 403, which blocks DNS rebinding.
- There is no login: any process on your machine can call the API.
- Transcripts may contain sensitive data. They live in `~/.claude-board/transcripts` and are deleted after `transcriptRetentionDays`.
- The push rules are best effort: they block the common `git push` forms through `--disallowedTools`, not every way a shell could reach a remote.

## Development

```bash
npm test          # Vitest: rules, MCP, runner with a fake claude, hooks, import
npm run typecheck
npm run dev:ui    # Vite on http://127.0.0.1:5317, proxying the API on 4317
```

The runner tests use `test/fake-claude.mjs`, which accepts the same arguments as Claude Code, emits `stream-json` and calls the real MCP, without spending tokens. History fixtures live in `test/fixtures/claude-home` and are generated by `node test/fixtures/make-fixtures.mjs`.

## License

[MIT](LICENSE)
