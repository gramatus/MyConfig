# Neovim Custom Keymaps

This document lists custom keymaps added to the kickstart neovim config.
Leader key is `<Space>`.

**Source column:**

- `Explicit` - Defined via `vim.keymap.set()` or `keys = {}` in config
- `Plugin default` - Plugin's default keymaps (no explicit config)
- `Kickstart` - Came with kickstart base (not user-added)

## General

Basic keymaps not tied to a specific plugin.

| Key          | Mode  | Desc                       | Comment                                         | Source    |
| ------------ | ----- | -------------------------- | ----------------------------------------------- | --------- |
| `<Esc>`      | n     | -                          | Clear search highlights                         | Kickstart |
| `<leader>q`  | n     | Open diagnostic [Q]uickfix | Opens list of all diagnostics in current buffer | Kickstart |
| `<C-k><C-d>` | n     | Format buffer              | VS Code-style format shortcut                   | Explicit  |
| `<C-]>`      | n/v/i | Toggle comment             | Ctrl+¨ on Norwegian keyboard                    | Explicit  |
| `<Esc><Esc>` | t     | Exit terminal mode         | Double-tap Esc to get out of terminal mode      | Kickstart |

## Window Navigation

Built-in neovim windows (splits), not buffers or tabs.

| Key     | Mode | Desc                       | Comment                    | Source    |
| ------- | ---- | -------------------------- | -------------------------- | --------- |
| `<C-h>` | n    | Move focus to left window  | Navigate between splits    | Kickstart |
| `<C-l>` | n    | Move focus to right window |                            | Kickstart |
| `<C-j>` | n    | Move focus to lower window |                            | Kickstart |
| `<C-k>` | n    | Move focus to upper window | Also used for format chord | Kickstart |

## Buffer Navigation

**bufferline.nvim** - Adds a VS Code-like tab bar showing open buffers at the top of the screen.

| Key                | Mode | Desc                      | Comment                                | Source    |
| ------------------ | ---- | ------------------------- | -------------------------------------- | --------- |
| `<leader><leader>` | n    | [ ] Find existing buffers | Fuzzy find with Telescope, MRU order   | Kickstart |
| `<leader><Tab>`    | n    | Switch to last buffer     | Toggle between two most recent buffers | Explicit  |
| `<C-PageDown>`     | n    | Next buffer               | Cycle through buffers in tab bar order | Explicit  |
| `<C-PageUp>`       | n    | Prev buffer               | Cycle through buffers in tab bar order | Explicit  |
| `<leader>bn`       | n    | [B]uffer [N]ext           | Alternative to Ctrl+PageDown           | Explicit  |
| `<leader>bp`       | n    | [B]uffer [P]rev           | Alternative to Ctrl+PageUp             | Explicit  |
| `<leader>bx`       | n    | [B]uffer [X] (close)      | Close current buffer                   | Explicit  |

## Harpoon

**harpoon** - Mark files you're actively working on and jump to them instantly with number keys.
Unlike MRU (automatic), you explicitly mark files. Great for jumping between 3-4 files in a feature.

| Key          | Mode | Desc                    | Comment                                      | Source   |
| ------------ | ---- | ----------------------- | -------------------------------------------- | -------- |
| `<leader>ha` | n    | [H]arpoon [A]dd file    | Mark current file                            | Explicit |
| `<leader>hh` | n    | [H]arpoon menu          | View/reorder marks (edit like normal buffer) | Explicit |
| `<leader>hr` | n    | [H]arpoon [R]emove file | Unmark current file                          | Explicit |
| `<leader>hc` | n    | [H]arpoon [C]lear all   | Remove all marks                             | Explicit |
| `<leader>1`  | n    | Harpoon file 1          | Instant jump to first marked file            | Explicit |
| `<leader>2`  | n    | Harpoon file 2          |                                              | Explicit |
| `<leader>3`  | n    | Harpoon file 3          |                                              | Explicit |
| `<leader>4`  | n    | Harpoon file 4          |                                              | Explicit |

## Search (Telescope)

**telescope.nvim** - Fuzzy finder for files, buffers, grep, and more. The Swiss army knife of neovim navigation.

| Key          | Mode | Desc                         | Comment                           | Source    |
| ------------ | ---- | ---------------------------- | --------------------------------- | --------- |
| `<leader>sh` | n    | [S]earch [H]elp              | Search neovim help tags           | Kickstart |
| `<leader>sk` | n    | [S]earch [K]eymaps           | Find any keymap interactively     | Kickstart |
| `<leader>sf` | n    | [S]earch [F]iles             | Find files by name                | Kickstart |
| `<leader>sa` | n    | [S]earch [A]ll files         | Including hidden files (dotfiles) | Explicit  |
| `<leader>ss` | n    | [S]earch [S]elect Telescope  | Pick a Telescope picker           | Kickstart |
| `<leader>sw` | n    | [S]earch current [W]ord      | Grep for word under cursor        | Kickstart |
| `<leader>sg` | n    | [S]earch by [G]rep           | Live grep across project          | Kickstart |
| `<leader>sd` | n    | [S]earch [D]iagnostics       | Find errors/warnings              | Kickstart |
| `<leader>sr` | n    | [S]earch [R]esume            | Re-open last Telescope search     | Kickstart |
| `<leader>s.` | n    | [S]earch Recent Files (".")  | Recently opened files             | Kickstart |
| `<leader>/`  | n    | [/] Fuzzily search in buffer | Like Ctrl+F but fuzzy             | Kickstart |
| `<leader>s/` | n    | [S]earch [/] in Open Files   | Grep only in open buffers         | Kickstart |
| `<leader>sn` | n    | [S]earch [N]eovim files      | Search your neovim config         | Kickstart |

## LSP

**nvim-lspconfig** - Language Server Protocol support. Provides IDE features like go-to-definition,
refactoring, and diagnostics. These keymaps are only active in buffers with an LSP attached.

| Key          | Mode | Desc                    | Comment                                 | Source    |
| ------------ | ---- | ----------------------- | --------------------------------------- | --------- |
| `gd`         | n    | [G]oto [D]efinition     | Jump to where symbol is defined         | Kickstart |
| `gr`         | n    | [G]oto [R]eferences     | Find all usages of symbol               | Kickstart |
| `gI`         | n    | [G]oto [I]mplementation | Jump to implementation (interfaces)     | Kickstart |
| `gD`         | n    | [G]oto [D]eclaration    | Jump to declaration (e.g., C headers)   | Kickstart |
| `<leader>D`  | n    | Type [D]efinition       | Jump to type definition                 | Kickstart |
| `<leader>ds` | n    | [D]ocument [S]ymbols    | List functions/classes in current file  | Kickstart |
| `<leader>ws` | n    | [W]orkspace [S]ymbols   | Search symbols across project           | Kickstart |
| `<leader>rn` | n    | [R]e[n]ame              | Rename symbol across project            | Kickstart |
| `<leader>ca` | n/x  | [C]ode [A]ction         | Quick fixes, auto-imports, refactorings | Kickstart |
| `<leader>f`  | n    | [F]ormat buffer         | Format with LSP or formatter            | Kickstart |
| `<C-s>`      | i    | Signature help          | Show function parameters while typing   | Explicit  |

## Git

### Gitsigns

**gitsigns.nvim** - Shows git diff in the sign column (left margin). Lets you stage/reset
individual hunks without leaving neovim.

| Key          | Mode | Desc                | Comment                               | Source   |
| ------------ | ---- | ------------------- | ------------------------------------- | -------- |
| `]h`         | n    | Next [H]unk         | Jump to next changed block            | Explicit |
| `[h`         | n    | Prev [H]unk         | Jump to previous changed block        | Explicit |
| `<leader>hs` | n/v  | [H]unk [S]tage      | Stage this hunk (or visual selection) | Explicit |
| `<leader>hr` | n/v  | [H]unk [R]eset      | Discard changes in hunk               | Explicit |
| `<leader>hu` | n    | [H]unk [U]ndo stage | Unstage a staged hunk                 | Explicit |
| `<leader>hp` | n    | [H]unk [P]review    | Show hunk diff in popup               | Explicit |
| `<leader>hb` | n    | [H]unk [B]lame      | Show git blame for current line       | Explicit |

### Diffview

**diffview.nvim** - VS Code-like diff view with side-by-side comparison.
Supports staging hunks directly from the diff view.

| Key          | Mode | Desc                 | Comment                  | Source   |
| ------------ | ---- | -------------------- | ------------------------ | -------- |
| `<leader>gd` | n    | [G]it [D]iff view    | Open diff of all changes | Explicit |
| `<leader>gh` | n    | [G]it file [H]istory | History of current file  | Explicit |
| `<leader>gH` | n    | [G]it repo [H]istory | Full commit history      | Explicit |
| `<leader>gq` | n    | [G]it diff [Q]uit    | Close diffview           | Explicit |

## Formatting

**conform.nvim** - Formatter plugin that runs prettier, stylua, etc.
Format-on-save is disabled by default; use manual formatting.

| Key          | Mode | Desc          | Comment                           | Source    |
| ------------ | ---- | ------------- | --------------------------------- | --------- |
| `<C-k><C-d>` | n    | Format buffer | VS Code chord (Ctrl+K, Ctrl+D)    | Explicit  |
| `<leader>f`  | n    | Format buffer | Alternative single-key formatting | Kickstart |

## Mini.surround

**mini.surround** - Add, delete, replace surrounding characters (quotes, brackets, tags).
All commands start with `s` (surround).

| Key  | Mode | Desc                         | Comment                                  | Source         |
| ---- | ---- | ---------------------------- | ---------------------------------------- | -------------- |
| `sa` | n/v  | [S]urround [A]dd             | e.g., `saiw"` surrounds word with quotes | Plugin default |
| `sd` | n    | [S]urround [D]elete          | e.g., `sd"` deletes surrounding quotes   | Plugin default |
| `sf` | n    | [S]urround [F]ind (right)    | Jump to next surrounding char            | Plugin default |
| `sF` | n    | [S]urround [F]ind (left)     | Jump to previous surrounding char        | Plugin default |
| `sh` | n    | [S]urround [H]ighlight       | Highlight the surrounding chars          | Plugin default |
| `sr` | n    | [S]urround [R]eplace         | e.g., `sr"'` changes " to '              | Plugin default |
| `sn` | n    | [S]urround update [N]\_lines | Change search scope                      | Plugin default |

## Tmux Integration

Custom keymap for running code in a tmux pane.

| Key          | Mode | Desc                 | Comment                                          | Source   |
| ------------ | ---- | -------------------- | ------------------------------------------------ | -------- |
| `<leader>tr` | n    | [T]rigger code [R]un | Runs current .ts file as .js in bottom-left pane | Explicit |

---

_Tip: Use `<leader>sk` to search all keymaps interactively._
