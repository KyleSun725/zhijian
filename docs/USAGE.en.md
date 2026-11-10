# Zhijian user guide

[中文](USAGE.md) · **English** · [Project overview](../README.en.md)

## Start the app

On Windows with Node.js 18+ and Microsoft Edge, double-click `启动纸间.vbs` to open the app without a console window. Use `启动纸间.bat` to see logs, or run `npm start` from the project folder.

The local service normally uses `http://127.0.0.1:8720`. Reusing the same browser profile and address lets the app find your saved reading data.

## Choose a language

Open **设置 → 界面语言 → English**. Switch back with **Settings → Interface language → 中文**.

Changes apply immediately and are remembered on this device. Menus, help, notifications, annotations controls, page organizer, and chat controls follow the selection. New AI requests default to the selected language. PDF content, your notes, and existing chat messages are preserved as written.

## Read and annotate

- Open a PDF, drop one into the window, or try the built-in sample.
- Use Contents, Thumbnails, or the page input to navigate.
- Select text for four highlight colors, underline, notes, or Ask AI.
- Click a note's dot to edit it, delete it, or ask about the passage.
- The Notes tab groups annotations by page. Click an entry to return to its source.
- Annotations and the last-read page are saved automatically, keyed by the file name, size, and modification time.

Annotations are app overlays, not embedded PDF comments. Editing a file elsewhere can change its identity and prevent saved annotations from being matched.

## Organize pages

Choose **Organize pages** in the top toolbar.

- Insert a blank page before or after any page.
- Mark a page for deletion; restore it before saving if needed.
- **Insert another PDF** appends all pages from another file.
- **Save to file** overwrites the original if a writable file handle is available; otherwise a save dialog opens.
- **Save as** keeps a separate copy.

Saving rebuilds the PDF with pdf-lib. Bookmarks, forms, signatures, and encryption may be lost. Keep the original when these matter. Retained annotations are remapped inside the app.

## Set up the assistant

In Settings, choose DeepSeek, OpenAI, or Custom. Enter the API URL, model name, and API key. **Fetch model list** asks the endpoint for its available models; you can also type a model name. Keys are stored per provider in the local configuration file.

Use an OpenAI-compatible endpoint for a gateway or a local model service. The current app requires a nonempty API key field; a local server that ignores authentication can use a placeholder value.

**Test connection** makes a small real model request. **Compatibility mode** omits optional reasoning controls when an endpoint does not support them.

### Context and reasoning

| Control | What it sends |
| --- | --- |
| Full | All extracted text within the app's estimated model budget |
| Smart | Relevant pages selected using keyword overlap, including the current page and neighbors |
| This page | The current page and adjacent pages |
| Off / Low / High / Max | The supported reasoning setting, depending on provider and compatibility mode |

The answer's context label shows what was included. If Full exceeds the app's estimated character budget, it falls back to relevant pages and says so. These are app estimates, not a live check of a provider's token limits.

The model receives page labels and is instructed to cite the supplied document. Click references such as `[p.12]` to navigate. Verify the explanation against the source.

### Chats and selection

- Quick actions summarize the document, summarize the current page, explain a selection, or make five review questions.
- Each PDF has separate chat history. Use **New chat** or **Chat history** to manage conversations.
- **Edit and resend** removes the selected question and any following messages, and returns the question to the input.
- **Branch from here** keeps the original conversation and starts another with the preceding messages.
- Requests include the current question and up to seven preceding messages. Saved history remains available in the UI.
- Drag the assistant's left edge to resize it; double-click to reset.
- AI answers support Markdown tables and KaTeX formulas.

## Appearance

Choose Parchment, Ivory, Ink blue, Moss, Dark gold, or Midnight in Settings. The sun/moon button switches between your light and dark themes.

PDF night display applies in dark themes: **Smart invert** detects light pages, **Dim** lowers brightness, and **Off** preserves page colors.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl + O | Open a PDF |
| ← / → or PageUp / PageDown | Previous / next page |
| + / − | Zoom in / out |
| Click the zoom percentage | Fit to width |
| H | Highlight selected text |
| Esc | Close a toolbar, menu, or dialog |
| Enter | Send a question |
| Shift + Enter | New line in a question |
| Ctrl + Enter | Save a note |

## Storage and document limits

Annotations, conversations, and reading position are stored in IndexedDB in the current browser profile. Appearance and interface language are stored in localStorage. Model settings and API keys are stored as plaintext in `data/config.json`.

PDF reading and editing happen locally. Using a remote AI sends the selected text context and chat request to your configured provider. Scans require OCR before text extraction works; images and charts are not sent as visual input. Large PDFs take longer to load and extract.

## Development

The frontend uses plain HTML/CSS/JavaScript, PDF.js, pdf-lib, and KaTeX. `server.js` is a local Node.js server with no runtime npm dependencies. Vendored browser libraries are included.

```bash
npm start
npm run start:no-open
npm install
npm run build:demo
node --test tools/i18n.test.mjs
```

`npm install` is needed for rebuilding the sample or updating dependencies, not normal startup. `tools/scene.mjs` and the `verify-*.mjs` scripts exercise UI flows with a mock model. Run the PowerShell 7 script `tools/render-readme.ps1` to rebuild the offline bilingual README previews.
