# Compendiq Demo Video -- Script and Shot List

**Duration:** 5 minutes (max)
**Format:** 1080p screen recording with voiceover, captions enabled
**Host:** YouTube (unlisted), linked from README
**Tone:** Calm, technical, no hype. Show the product working, not a pitch deck.

---

## Shot List

### Scene 1: Install (0:00 -- 0:45)

**Goal:** Show that going from nothing to a running instance takes one command.

| # | Shot | Duration | Notes |
|---|------|----------|-------|
| 1.1 | Terminal, clean machine. Run `curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh \| bash` | 10s | Show the full command, then time-lapse the pull + setup. Add a timer overlay showing real elapsed time. |
| 1.2 | Installer output scrolling: secrets generated, compose written, images pulled, containers started | 15s | Speed up 4x. Highlight key lines: "Generating secrets...", "Pulling images...", "All services healthy". |
| 1.3 | Browser auto-opens to `http://localhost:8081` showing the setup wizard | 5s | Pause briefly on the wizard. |
| 1.4 | Walk through the 5-step wizard: admin account, LLM provider (select Ollama), Confluence URL + PAT, space selection, trigger first sync | 15s | Show each step. Real Confluence instance with real data. |

**Voiceover script:**
> "Install Compendiq with a single command. The installer generates secrets, pulls Docker images, and starts the stack. In about two minutes, you get the setup wizard. Register an admin account, point it at your Confluence Data Center instance, select the spaces you want to sync, and hit Start Sync."

---

### Scene 2: Confluence Sync (0:45 -- 1:15)

**Goal:** Show pages appearing in real-time as they sync from Confluence.

| # | Shot | Duration | Notes |
|---|------|----------|-------|
| 2.1 | Dashboard showing sync progress bar, page count incrementing | 15s | If sync is fast, show the counter climbing. If slow, time-lapse. |
| 2.2 | Navigate to a synced space, show the page tree with hierarchy intact | 10s | Expand a parent page to show children. |
| 2.3 | Open a synced page -- show the TipTap editor rendering Confluence macros (code block, task list, panel) | 5s | Pick a visually rich page. |

**Voiceover script:**
> "Pages sync over the Confluence REST API. Compendiq converts the XHTML storage format into HTML for the editor and Markdown for the LLM. Everything stays in your local PostgreSQL database. Let me open a page -- notice the code blocks, task lists, and panels render natively."

---

### Scene 3: RAG Q&A (1:15 -- 2:30)

**Goal:** This is the hero feature. Show asking a question and getting a sourced answer.

| # | Shot | Duration | Notes |
|---|------|----------|-------|
| 3.1 | Click the AI Assistant sidebar (or use keyboard shortcut) | 5s | |
| 3.2 | Type a real question about the synced content, e.g., "How do I configure the VPN for remote developers?" | 10s | Use a question that a real team would ask. |
| 3.3 | Show the SSE stream in real-time -- answer appearing word by word | 20s | Let the answer stream naturally. Do not speed this up. |
| 3.4 | Highlight the source citations at the bottom of the answer -- click one to jump to the source page | 10s | Show that the answer is grounded in actual Confluence content. |
| 3.5 | Ask a follow-up question to demonstrate multi-turn conversation | 15s | E.g., "What ports need to be open for this?" |
| 3.6 | Briefly show the search panel: switch between keyword, semantic, and hybrid modes | 15s | Quick demonstration, no deep dive. |

**Voiceover script:**
> "Ask the AI anything about your knowledge base. It uses hybrid search -- combining vector similarity with keyword matching -- to find relevant pages, then answers your question with inline citations. Click a citation to jump straight to the source page. Answers stream in real-time. You can ask follow-up questions and the AI maintains context across the conversation."

---

### Scene 4: Article Improvement (2:30 -- 3:30)

**Goal:** Show the AI improving an existing article.

| # | Shot | Duration | Notes |
|---|------|----------|-------|
| 4.1 | Open a page that has some quality issues (poor structure, missing sections) | 5s | Pick or create a deliberately rough page. |
| 4.2 | Click "Improve" in the article actions panel, select "Structure" mode | 5s | |
| 4.3 | Show the AI's suggestions streaming in -- restructured headings, added sections | 20s | Let it run. |
| 4.4 | Accept the improvement, show the before/after in the version diff viewer | 15s | Emphasize the diff highlighting. |
| 4.5 | Briefly show article generation: click "Generate", select "Runbook" template, type a topic, show the generated article | 15s | Quick demonstration. |

**Voiceover script:**
> "Found a rough article? Select an improvement mode -- grammar, structure, clarity, technical accuracy, or completeness -- and the AI rewrites it. Every change is versioned, so you can always see what changed and revert if needed. You can also generate new articles from templates. Here I am creating a runbook from a one-line prompt."

---

### Scene 5: More Features (3:30 -- 4:30)

**Goal:** Quick montage of other capabilities.

| # | Shot | Duration | Notes |
|---|------|----------|-------|
| 5.1 | Auto-tagging: show the suggested tags appearing on a page | 8s | |
| 5.2 | Knowledge graph: show the visual relationship map, click a node to navigate | 8s | |
| 5.3 | Dark mode toggle | 3s | Quick visual flash. |
| 5.4 | Editor features: Vim mode enabled, drag-and-drop a block, use find-and-replace | 10s | |
| 5.5 | PDF export: click export, show the downloaded PDF | 5s | |
| 5.6 | Admin panel: show RBAC roles, audit log, LLM settings | 10s | Quick scroll through. |
| 5.7 | Settings: show LLM provider switch from Ollama to OpenAI-compatible API | 8s | Demonstrate the flexibility. |
| 5.8 | Content analytics dashboard: page views, search patterns | 8s | |

**Voiceover script:**
> "There is more: automatic tag suggestions, a knowledge graph showing how pages relate, dark mode, Vim keybindings in the editor, PDF export, role-based access control, audit logging, and content analytics. You can switch LLM providers at any time -- from a local Ollama model to OpenAI, Azure, or any compatible API."

---

### Scene 6: Closing (4:30 -- 5:00)

**Goal:** Call to action.

| # | Shot | Duration | Notes |
|---|------|----------|-------|
| 6.1 | Terminal showing the install command one more time | 5s | |
| 6.2 | GitHub repo page showing the README, star count, Discussions link | 10s | |
| 6.3 | Text overlay: `github.com/Compendiq/compendiq-ce` with the logo | 15s | Clean end card. |

**Voiceover script:**
> "Compendiq is open-source under AGPL-3.0. Install it in three minutes. Your data stays on your hardware. Find us on GitHub -- star the repo, join the discussion, and let me know what you build with it."

---

## Production Notes

- **Recording software:** OBS Studio or similar. 1080p, 30fps minimum.
- **Terminal font:** Use a clean monospace font (JetBrains Mono, Fira Code) at a size readable in 1080p.
- **Browser:** Use a clean browser profile with no bookmarks bar, no extensions visible.
- **Confluence instance:** Use a real Confluence DC instance with realistic content (not lorem ipsum). Blur or redact any sensitive page titles if needed.
- **Captions:** Add closed captions (YouTube auto-generate, then review for accuracy). Many viewers watch without sound.
- **Music:** None, or very subtle ambient. The voiceover carries the video.
- **Editing:** Minimal cuts. The product should feel effortless. Speed up only the waiting parts (install pull, sync). Never speed up the AI streaming -- viewers need to see it is real-time.
- **Thumbnail:** Screenshot of the RAG Q&A with a question and answer visible, Compendiq logo in the corner. No "SHOCKED FACE" thumbnails.
