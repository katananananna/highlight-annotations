# Highlight Annotations

An Obsidian plugin for annotating any text in your notes: essays, poems, textbooks, language study, research.

- **Select text** → a small toolbar appears. Pick a colour to highlight, or choose **Note** to attach one or more notes.
- **Several notes per passage.** Add a line for each point. Click a note to edit it, × to delete it.
- **Hover** a highlight to read its notes. A small number shows how many notes it has.
- **Sidebar** (highlighter icon in the ribbon) lists every annotation in the current note, in reading order. Click one to jump to it.
- **Search all annotations** across every note, filter by colour.
- **Export** the current note's annotations to a new Markdown note.
- **Six colours**, fill or underline style, adjustable strength.

Works in Live Preview and Source mode of the desktop editor.

## Install

### From a release (recommended)

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/highlight-annotations/`.
3. Restart Obsidian (or reload), then enable **Highlight Annotations** under Settings → Community plugins.

### From source

Plain JavaScript, no build step. Copy the three files above into the plugin folder.

## Where your data lives

Annotations are stored in `.obsidian/plugins/highlight-annotations/data.json` inside your vault. Back up or sync that file along with your notes. The plugin makes no network requests.

Annotations are anchored to the exact text, plus a little context before and after it. If you edit the highlighted text itself, the annotation moves to the sidebar's *Text no longer found* section, where you can still read and edit it.

## Limitations

- Desktop only. Live Preview and Source mode; not Reading view, PDF or canvas.
- Highlights are single passages within one paragraph or line range; they cannot overlap each other.
- No merge across devices: if you edit `data.json` on two machines at once, one set of changes can be lost.

## Old highlight cleanup

Earlier versions wrote `==highlight==` markup into notes. The command **Review old highlight cleanup** previews the removal of those markers, backs up the note into `data.json`, and only then removes them. Nothing changes until you confirm.

## Licence

No licence chosen yet. All rights reserved until one is added.
