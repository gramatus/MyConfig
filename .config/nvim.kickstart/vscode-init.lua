-- Neovim config for VS Code, loaded by vscode-neovim via `-u`.
-- VS Code owns the UI, so this file carries editing behaviour only: no plugins,
-- no display options, no LSP setup. Editor features go through VS Code commands.

if not vim.g.vscode then
  return
end

local vscode = require 'vscode'

local function action(name)
  return function()
    vscode.action(name)
  end
end

local function map(mode, lhs, rhs, desc)
  vim.keymap.set(mode, lhs, rhs, { desc = desc })
end

vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.timeoutlen = 300

map('n', '<Esc>', '<Cmd>nohlsearch<CR>', 'Clear search highlight')

-- LSP-ish, mapped to the VS Code equivalents. gd/gD/gF/gH/K/z= come from the
-- extension itself, so they are not repeated here.
map('n', 'gr', action 'editor.action.goToReferences', 'Goto references')
map('n', 'gI', action 'editor.action.goToImplementation', 'Goto implementation')
map('n', '<leader>D', action 'editor.action.goToTypeDefinition', 'Type definition')
map('n', '<leader>ds', action 'workbench.action.gotoSymbol', 'Document symbols')
map('n', '<leader>ws', action 'workbench.action.showAllSymbols', 'Workspace symbols')
map('n', '<leader>rn', action 'editor.action.rename', 'Rename')
map({ 'n', 'x' }, '<leader>ca', action 'editor.action.quickFix', 'Code action')
map('n', '<C-k><C-d>', action 'editor.action.formatDocument', 'Format buffer')

-- Diagnostics
map('n', '<leader>q', action 'workbench.actions.view.problems', 'Problems panel')
map('n', ']d', action 'editor.action.marker.next', 'Next diagnostic')
map('n', '[d', action 'editor.action.marker.prev', 'Previous diagnostic')

-- Pickers, keeping the kickstart <leader>s prefix
map('n', '<leader>sf', action 'workbench.action.quickOpen', 'Search files')
map('n', '<leader>sg', action 'workbench.action.findInFiles', 'Search by grep')
map('n', '<leader>sd', action 'workbench.actions.view.problems', 'Search diagnostics')
map('n', '<leader>s.', action 'workbench.action.openRecent', 'Recent files')
map('n', '<leader><leader>', action 'workbench.action.showAllEditors', 'Open editors')
map('n', '<leader>e', action 'workbench.view.explorer', 'Explorer')

-- Editor group navigation, replacing the <C-w> window moves
map('n', '<C-h>', action 'workbench.action.navigateLeft', 'Focus left group')
map('n', '<C-l>', action 'workbench.action.navigateRight', 'Focus right group')
map('n', '<C-j>', action 'workbench.action.navigateDown', 'Focus group below')
map('n', '<C-k>', action 'workbench.action.navigateUp', 'Focus group above')

-- Toggle comment with Ctrl+¨ (sends <C-]> on a Norwegian keyboard).
-- Overrides the extension's <C-]> goto-definition; gd still does that.
vim.keymap.set('n', '<C-]>', 'gcc', { remap = true, desc = 'Toggle comment' })
vim.keymap.set('x', '<C-]>', 'gc', { remap = true, desc = 'Toggle comment' })

-- Norwegian keyboard: ø/æ/Ø/Æ as brackets, plus Alt+ø style chords.
-- Insert mode is VS Code's, so the insert-mode variants live in keybindings.json.
vim.opt.langmap = 'ø[,æ],Ø{,Æ}'
vim.keymap.set({ 'n', 'v', 'o' }, '<M-ø>', '[', { remap = true, desc = 'Norwegian [' })
vim.keymap.set({ 'n', 'v', 'o' }, '<M-æ>', ']', { remap = true, desc = 'Norwegian ]' })
vim.keymap.set({ 'n', 'v', 'o' }, '<M-Ø>', '{', { remap = true, desc = 'Norwegian {' })
vim.keymap.set({ 'n', 'v', 'o' }, '<M-Æ>', '}', { remap = true, desc = 'Norwegian }' })

-- langmap has a multibyte bug for f/t/r, so those get explicit mappings.
for _, char in ipairs { 'ø', 'æ', 'Ø', 'Æ' } do
  local target = ({ ['ø'] = '[', ['æ'] = ']', ['Ø'] = '{', ['Æ'] = '}' })[char]
  for _, key in ipairs { 'f', 'F', 't', 'T' } do
    vim.keymap.set({ 'n', 'v', 'o' }, key .. char, key .. target)
  end
  vim.keymap.set('n', 'r' .. char, 'r' .. target)
end

-- Swap ; and , for f/t repeat
vim.keymap.set({ 'n', 'v', 'o' }, ',', ';', { desc = 'Repeat f/t forward' })
vim.keymap.set({ 'n', 'v', 'o' }, ';', ',', { desc = 'Repeat f/t backward' })
