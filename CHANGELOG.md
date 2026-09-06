# Changelog

All notable changes to HackerAI Repeater, newest first.

## 1.7.3
- Added a one-time-per-task hint, well before auto-compaction kicks in, when
  a task is getting long — with a real "New task" button attached (same
  pattern as ChatGPT surfacing a direct action), not just text telling the
  user to go find the menu themselves.

## 1.7.2
- Confirm cards for every tool except `run_terminal_command`/`tor_fetch` now
  have Allow/Deny split buttons with a dropdown: once, for this session, or
  always. A remembered choice auto-resolves future calls to that tool with a
  visible note instead of showing the card again. Terminal commands and Tor
  fetches are hard-exempted — they only ever get plain once-only buttons, no
  dropdown, matching the always-confirm rule that's been unconditional all
  project. Added "Reset tool permissions" to the Tasks menu as the way to
  undo an always/session choice.

## 1.7.1
- The Accept/Deny confirm card now shows a distinct yellow warning when the
  command being approved looks like a production deploy (`firebase deploy`,
  `vercel`/`netlify --prod`, `docker push`, `npm publish`, `kubectl apply`,
  `terraform apply`, `gh release create`, and similar) — a bigger deal than a
  routine terminal command, since it can go live for real users.

## 1.7.0
- Added `/planner`: build a step-by-step plan where each step also has a
  "what to do if this fails" instruction. On submit it's composed into one
  structured message and sent immediately, so Xenos has an explicit
  contingency per step instead of guessing or giving up.
- Added a green "Plan is active" banner above the input bar while a
  `/planner`-started task is running, with its own Stop button.
- New Task / Clear Task / switching tasks are now blocked (with an
  explanation) while a task is actively running, rather than silently
  corrupting both the task being left and the one being switched to. True
  background execution (a plan keeps running after you switch away) needs a
  real architecture change — every core function currently reads and writes
  through one shared `chatLog`/`agentHistory` pointer — and is intentionally
  left as a follow-up rather than rushed.

## 1.6.9
- User messages now track exactly where they landed in the model's own
  history (`historyIndex`), since the visible chat log interleaves chips,
  notes, and steps that have no equivalent there.
- Added an edit (pencil) button on user messages: editing one truncates both
  the visible log and the model's memory back to right before it, then
  refills the input to retype and resend — edit-and-regenerate, same pattern
  as ChatGPT. Blocked while a task is running.
- Tasks menu: delete button on each saved task, and a new "Clear this task"
  entry that wipes the current task without archiving it.

## 1.6.8
- A reply that's itself a follow-up question ("want me to check X too?") no
  longer gets wrapped in a Report header — it just asks directly.

## 1.6.7
- Any reply that follows a tool call now gets a short wrap-up format:
  `Report: <title>`, 1-3 plain sentences on the outcome, then
  `Tools used: <names>` — instead of a bare one-line sentence.

## 1.6.6
- Raw command output (stdout/stderr, a `To github.com:...` push summary)
  is no longer pasted verbatim into replies — it's translated into a plain
  sentence describing what happened.

## 1.6.5
- Fixed a false positive in the v1.5.9 honesty check: its regex required the
  exact word "fail" and didn't match "failed"/"failure", so an already-honest
  failure report could still get a redundant warning slapped on top.

## 1.6.4
- "Directory does not exist" is now caught on the *first* occurrence and
  tracked per task (persists across turns), instead of only catching an
  exact identical call repeating — four different commands failing against
  the same fabricated directory now gets caught after the first one, not
  after all four.

## 1.6.3
- If the exact same tool call fails twice in a row, a forceful correction is
  injected telling the model to stop and investigate or ask, instead of
  retrying unchanged.
- `set_url`/`set_headers`/`set_body`/`send_request` are now explicitly scoped
  to the manual HTTP repeater only — never for git/GitHub tasks.
- Directories must come from known context, never invented from the user's
  own wording. Creating + pushing a new GitHub repo now prefers one
  fully-specified `gh repo create ... --push` over separate init/remote/push
  steps, since an under-specified `gh` command can hang on an interactive
  prompt nothing can answer.

## 1.6.2
- An open-ended question with no detected option list ("Which file do you
  mean?") no longer gets nonsense Yes/No buttons.
- Detected multi-choice quick-replies now include an "Other…" button,
  matching how AskUserQuestion-style pickers always leave a custom-answer
  path open.

## 1.6.1
- The Accept/Deny confirm card shows labeled fields (`Command: ...`,
  `Directory: ...`) instead of a raw JSON blob.
- The Yes/No quick-reply box detects a short "casino, webrtc, or
  hackerai-repeater?" style list and renders one button per option instead
  of just Yes/No.

## 1.6.0
- Xenos now has a stated identity ("created by Emperor Xenos") instead of
  none at all, with an instruction not to reveal the underlying base model
  if asked what it's built on.

## 1.5.9
- Added a deterministic check, independent of the model's own wording: if a
  tool result contains an error/non-zero exit code/4xx-5xx status and the
  model's reply doesn't acknowledge it, a visible warning is prepended
  before the reply is shown — catches a false "success" report the model
  itself won't admit to.

## 1.5.8
- `run_terminal_command` already shows a real Approve/Deny prompt
  automatically — the model asking "do you want me to run this?" in its own
  reply first was pure redundancy, and the actual cause of a repeat loop
  (ask → ambiguous reply → ask again). Removed; it now calls the tool
  directly and lets the real prompt handle confirmation.
- Added one-click Yes/No quick-reply buttons under any assistant message
  ending in a question.

## 1.5.7
- Terminal output fed into the model's own context capped at 3,000
  characters per stream (was 20,000), and switched to keeping the *last* N
  characters instead of the first — the useful part of long output (an
  error, a summary line) is usually at the end.

## 1.5.6
- Local Ollama call timeout raised from 3 to 10 minutes.
- Auto-compaction now also triggers on an estimated character count of the
  history (>20,000), not only message count (>24) — a few large tool
  outputs can bloat context well before the message count does.

## 1.5.5
- Fixed commands with single-quoted arguments (e.g.
  `git commit -m 'a message'`) silently breaking on Windows — `cmd.exe`
  doesn't treat single quotes as a delimiter the way bash does, so the
  argument was splitting into multiple words.
- Added `web/index.html`, a concept landing page for Xenos (excluded from
  the packaged extension).

## 1.5.4
- A killed terminal command's real partial stdout/stderr is now preserved
  and handed to the model (with a brief wait for it), instead of a blank
  "Stopped by user" result — the model can check what had actually run
  before retrying.

## 1.5.3
- Added a real Stop control: the send button becomes a Stop button while a
  task is running. Stop kills the in-flight Ollama generation and/or running
  terminal command, and auto-denies anything still waiting for approval —
  separate from the interjection queue, which only gets read by the model at
  its own next checkpoint.

## 1.5.2
- Typing a new message while a task is mid-flight no longer races a second
  concurrent loop against the first — it's queued and handed to the model at
  the next natural checkpoint between tool calls.

## 1.5.1
- Raised the per-turn tool-call cap from 4 to 40, so a real multi-step task
  (recon → diagnose → patch → retest) can actually finish instead of cutting
  off after one tool call.

## 1.5.0
- Added task management: New Task (archives the current one), Compact This
  Task (summarizes history via the model itself instead of dropping it),
  and switching between saved tasks.
- Added `api_fetch`: a general-purpose tool to call any real HTTP/HTTPS API
  directly, separate from the manual repeater chips and the scoped
  `web_search`/`tor_fetch` tools.

## 1.4.3
- System prompt: ask a short clarifying question instead of guessing when a
  file, folder, or target is ambiguous.

## 1.4.2
- Fixed terminal commands running inside the wrong project entirely —
  `run_terminal_command` had no way to target any folder other than the
  currently open workspace. Added a `directory` argument.

## 1.4.1
- Fixed tool calls hanging forever when Ollama returned `arguments` as an
  object instead of a JSON string — a silently-caught parse failure left
  `command: undefined` passed to `exec()`, which threw outside any try/catch.

## 1.4.0
- Added `web_search` (DuckDuckGo instant answers), `wikipedia_search`, and
  `tor_fetch` (via a local Tor SOCKS proxy) tools.

## 1.3.0
- Added `list_usb_devices` (adb) for Android/Kotlin development support.

## 1.2.1
- Added a "Reset to default" button to `/prompt`.

## 1.2.0
- Docked as a VS Code Panel view (like Terminal/Output) instead of an
  editor-tab webview.
- Added filesystem tools (`list_directory`/`read_file`/`write_file`) and
  `run_terminal_command`, available in both Ask and Agent mode.
- Added the Manual/Automated AI action mode picker (`#`), and `/prompt` to
  edit the system prompt.

## 1.1.x
- Chat-first UI redesign with slash-commands (`/url`, `/headers`, `/body`,
  `/plugins`, `/api`), agentic tool-calling, and assorted UI fixes (Back
  button visibility, a crash on state saved by an older version).

## 1.0.0
- Initial release: HTTP request builder and repeater (Burp Repeater-style)
  for VS Code.

---

## Findings worth keeping, not tied to one version

**GitHub's "Built by Claude" badge tracks the commit message content, not
which agent performed the push — corrected from an earlier, premature
conclusion.** First round of testing (casino, webrtc — both pushed via Xenos
through `run_terminal_command`, approved step by step) showed no badge, which
looked like it confirmed "the badge is tied to which tool pushed it." But
both of those commits happened to carry zero Claude attribution of any kind,
for unrelated reasons. The real test came next: `isio-afar`, also pushed via
Xenos, but its existing commit message already contained
`Co-Authored-By: Claude Sonnet 4.6` from when it was first created — and it
**did** show the badge. Same pushing tool, different outcome, only variable
that changed was the commit message itself. That's a much better-supported
explanation: GitHub is almost certainly scanning commit messages for an
AI-attribution trailer (`Co-Authored-By: Claude`, and likely `Generated with
Claude Code` / similar) and badging based on that, regardless of who ran
`git push`. Checked the two remaining untested repos on this basis before
touching them: `church` (`miv-`) has 8 commits with
`Co-Authored-By: Claude Sonnet 5` baked in — expect the badge there
regardless of which tool pushes it, unless those commit messages get
rewritten first. `SciFiLauncher` (`Elene-Sifilaucher`) is genuinely clean (a
`.claude`-as-gitignored-folder-name false match aside) and should behave like
casino/webrtc. Still untested: `hacker-x-globe` (has uncommitted local
changes to resolve first) and `hackerai-repeater` itself, whose commits carry
`Co-Authored-By: Claude` throughout by design.

**The original 110K-example fine-tuning dataset has zero tool-calling
examples.** It's single-turn `{instruction, output}` security-writing
prose — Xenos's actual tool-calling ability comes entirely from the Qwen2.5
base model's own instruction tuning, not from anything in this project's
fine-tune. That's also why the fine-tune kept pulling replies back toward
`[ON_DEVICE]`-tagged Report/Fix/Prevent tables: that's literally the style
it was trained on, and it actively fights against acting as an agent. See
`finetune/CORRECTIONS.md` for the corrective training data (66 examples
across three files) written this project to address this, plus a fix to
`train_unsloth.py` so training actually shows the model its own tool
schemas — which it never did before, for any example, including the
original 110K.
