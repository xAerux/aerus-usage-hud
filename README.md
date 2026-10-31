Part of the Aeru Creations toolset — see EZ AI for the full hub.
<img width="1692" height="1359" alt="image" src="https://github.com/user-attachments/assets/5a94c987-2b11-4c87-9609-35bc86dbc61e" />


# ⚡ Aerus AI Usage HUD
![Version](https://img.shields.io/badge/Version-1.0.2-00CED1?style=for-the-badge)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=for-the-badge&logo=windows)
![License](https://img.shields.io/badge/License-MIT-gold?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Released-brightgreen?style=for-the-badge)

### One dashboard. Multiple AI tools. Your usage at a glance.

**Aerus AI Usage HUD** is a lightweight Windows desktop application that brings usage information from **OpenAI Codex, Claude Code, and local Ollama** together in one convenient dashboard.

Built for developers, AI enthusiasts, and power users who regularly work across multiple AI environments.

Stop jumping between tools just to understand your activity. Keep the information you need in one place.

**Developed by Aeru Creations**

---

## 🖥️ Preview

*Application screenshot coming soon.*

The HUD is designed to provide a clean, convenient view of supported AI usage information without interrupting your development workflow.

---

## ✨ Features

### 🤖 Multiple AI Environments

View available usage information from:

- **OpenAI Codex** — Monitor supported Codex usage and activity.
- **Claude Code** — Keep track of available Claude Code usage information.
- **Ollama** — Include local AI model activity in your workflow overview.

### 📊 Unified Usage Dashboard

Keep supported usage totals together in a single interface, making it easier to understand how you're using your AI tools.

### 🪟 Windows Desktop Experience

Run the HUD as a dedicated Windows application rather than keeping another browser tab open.

### ⚡ Lightweight Workflow Companion

Designed to complement your existing AI development tools and remain conveniently accessible while you work.

### 🛠️ Built for Real AI Workflows

Whether you're writing code, building applications, experimenting with local models, or switching between AI coding assistants, Aerus AI Usage HUD helps you stay informed.

---

## 📥 Download & Installation

### Windows

**Current installer: v1.0.2**

Download:

[Aerus AI Usage HUD — Windows Installer](./AerusAIUsageHUD-Setup-v1.0.2.exe)

**Installation steps:**

1. Download the installer from this repository.
2. Run `AerusAIUsageHUD-Setup-v1.0.2.exe`.
3. Follow the installation prompts.
4. Launch Aerus AI Usage HUD.
5. Use your supported AI tools and review available activity in the HUD.

Windows may display a security warning for software without a recognized code-signing certificate. Verify that your installer came from the intended repository before running it.

---

## 🚀 Getting Started

Aerus AI Usage HUD is intended to work alongside your existing AI development environment.

**Using Codex?** Review supported Codex usage information from the HUD.

**Using Claude Code?** Keep your Claude Code activity visible alongside your other tools.

**Running Ollama locally?** Only usage captured by a specific adapter is recognized:

- Set `AERU_OLLAMA_CAPTURE_DIR` to a folder of captures, or place captures at
  `${CODEX_HOME}/local14b-tool-adapter/captures/` (default `~/.codex/local14b-tool-adapter/captures/`).
- Filenames must end in `RAW-UPSTREAM-SSE.txt`; each must contain `data:` JSON events with
  `type: response.completed` and a `response.usage` object.
- This repository does **not** ship the producer of these capture files. An ordinary Ollama
  installation is not automatically measured by the HUD. Other local workflows are unmeasured.

**About the dollar amounts:** They are estimated API-equivalent costs, **not**
subscription bills or remaining allowance. When a model is not in the HUD's price list, a
substitute rate is used and the HUD shows a warning naming the model. Cached token reads are
counted as token usage, with their separate price factors.

**If saved history is damaged:** The HUD keeps a few small files in its data folder (the desktop app
uses `%LOCALAPPDATA%\Aerus\AI Usage HUD\data`; `node server.js` uses `data/` next to `server.js`, or
`AERUS_DATA_DIR`). It never overwrites one it cannot read:

- `claude-ledger.json` (Claude Code history kept after Claude Code prunes old transcripts): the HUD
  shows a warning, leaves it untouched, and shows Claude figures from the transcripts Claude Code still
  has (older usage is missing). Restore the file from a backup, or move it away to start a new one.
- `account-snapshots.json` (verified Codex account total and Ollama total): the HUD copies the damaged
  file to `account-snapshots.json.corrupt-<id>` (or `.unsupported-<id>`), shows a warning, and starts a
  new one. The Codex total is restored by the next successful online lookup.

**Local access:** The server listens on `127.0.0.1` only and answers only requests addressed to
`127.0.0.1` or `localhost` on its own port, from its own pages. Another website open in your browser cannot
read the data. If you deliberately reach it under another name (a local reverse proxy, say), list that name in
`AERUS_ALLOWED_HOSTS` (comma separated, `name` or `name:port`). This is not a login: other programs running as
your Windows user can still call it.

Available totals depend on the data that each tool makes accessible. The HUD should not be treated as an official billing statement or guaranteed real-time account usage meter.

---

## 💡 Why I Built This

Modern AI development often means working with more than one assistant.

One tool might be excellent for coding. Another might be useful for reasoning, research, or troubleshooting. Local models add even more flexibility.

But monitoring activity across all these environments can quickly become inconvenient.

**Aerus AI Usage HUD was created to make that experience simpler.**

One application. A cleaner workspace. Better visibility into your AI workflow.

No unnecessary complexity.

---

## 🧰 Technology

The project includes technologies and tooling such as:

- JavaScript
- CSS and HTML
- Windows desktop application components
- PowerShell and batch scripting
- Node.js tooling

The repository contains the application source, desktop integration, assets, scripts, tests, and packaging resources.

---

## 🔧 Development

Interested in exploring the code?

The repository is organized into the following main directories:

| Directory | Purpose |
|---|---|
| `src/` | Application source code |
| `desktop/` | Windows desktop integration |
| `public/` | Public application resources |
| `assets/` | Visual and application assets |
| `scripts/` | Development and utility scripts |
| `test/` | Project tests |
| `packaging/` | Packaging resources |

Run the tests with `npm run check` (it needs no network access and writes only to your temp folder).

---

## 📋 Compatibility Notes

- Designed for Windows desktop use.
- Supported usage information depends on installed tools, accessible local data, and provider changes.
- Tool updates may affect usage-data compatibility.
- Reported values may differ from official provider dashboards.

Aerus AI Usage HUD is an independent project and is not an official product of OpenAI, Anthropic, or Ollama.

---

## 📜 License

Released under the **MIT License**.

See [LICENSE](./LICENSE) for details.

### Third-Party Branding & Disclaimer

Aerus AI Usage HUD is an independent software project developed by Aeru Creations.

Third-party software names, trademarks, logos, icons, and associated branding remain the property of their respective owners.

Aerus AI Usage HUD is not affiliated with, sponsored by, or endorsed by OpenAI, Anthropic, Ollama, Microsoft, or other third-party software providers unless explicitly stated otherwise.

References to Codex, Claude Code, Ollama, and other supported products are made to identify compatibility and available usage sources.

The project's MIT License applies to the material covered by that license. Third-party software, trademarks, artwork, and dependencies remain subject to their applicable terms and permissions.

This disclaimer does not itself grant redistribution rights to third-party assets.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the bundled components and their notices.

---

## ❤️ Aeru Creations

**Built by Aeru Creations.**

Creating practical tools that make AI, local computing, and software development easier to use.

*Local tools. Real utility. Made for creators.*

**Aerus AI Usage HUD — Keep your AI workflow in view.**
