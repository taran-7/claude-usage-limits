# usage-limits

A Claude Code mod that draws one row above the prompt: how full the context window of the current session is, the five-hour subscription limit and the weekly limit, each with a bar and the time left until it resets.

```
🗜️ Контекст ███░░░░░ 34% 68k/200k · Сесія ██░░░░░░ 23% 2 год 20 хв · Тиждень ███░░░░░ 41% 3 дн 5 год
```

The labels and toasts are in Ukrainian: `Контекст` is Context, `Сесія` is Session, `Тиждень` is Week, and `дн`, `год`, `хв` are days, hours, minutes. They live in `hooks/register.tsx` and are easy to change.

## What it shows

- **Compact button**: a small icon (a clamp) at the left. It runs the real `/compact` command, so the command and its result show up in the chat as if you had typed it. Pressed while a model turn is running, it waits and runs as soon as the chat is free. While it runs, the button is replaced by an hourglass.
- **After any compaction** (the button, a typed `/compact` or the automatic one) the context bar updates at once, from a local estimate of the new conversation. The engine reports its own figure only with the next response, and the bar switches to it then.
- **Context**: how full the context window is, as a percentage, and `tokens/window`.
- **Close button**: a small `×` at the right edge hides the band in the current chat. It shows again in a new chat, or at once with the `/limits` command, which switches the band off and on and works also while a model turn is running.
- **Session**: how much of the five-hour subscription limit is used, and how long until it resets.
- **Week**: how much of the weekly limit is used, and how long until it resets.
- The context bar and percentage are green up to 40%, yellow from 41% to 60% and dark red from 61%. The session and week bars are green below 70%, yellow from 70% and red from 90%.
- The countdown refreshes on its own every 30 seconds. The numbers themselves arrive after each model response.
- Subscription limits exist only for accounts with a subscription, and only after the first response in a session. Without them, only the context is shown.
- When a limit window has already reset, the time is replaced by `щойно скинуто` ("just reset").
- On a narrow window the row is cut off at the end instead of wrapping.

## Install

In the desktop app, where `/plugin` does not run: click `+` next to the prompt box, then Plugins, Add marketplace with `taran-7/claude-usage-limits`, then Add plugin and pick `usage-limits`.

In a terminal session of Claude Code:

```
/plugin install usage-limits --marketplace taran-7/claude-usage-limits
```

From a shell:

```
claude plugin install usage-limits --marketplace taran-7/claude-usage-limits
```

Claude Code asks `Add marketplace?`. Answer `y`, then pick a scope (user scope is listed first). After that the mod runs in every new session.

Tested on Claude Code 2.1.299.

## Development

```
claude plugin validate .
claude plugin test .
```

The `claude` on your PATH can be older than the one bundled with the desktop app. If `plugin test` is an unknown command, or the validator does not know the `session.measure` event, run the bundled binary instead: `~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`.

The labels (`Контекст`, `Сесія`, `Тиждень`, `дн`, `год`, `хв`) are in `hooks/register.tsx`.

Changes to `main` go through pull requests only.
