require('telescope').setup {
    file_ignore_patterns = { "^./.git/" },
}
local builtin = require('telescope.builtin')
if vim.g.vscode then
    vim.keymap.set('n', '<leader>pf', "<Cmd>call VSCodeNotify('workbench.action.quickOpen')<CR>")
else
    vim.keymap.set('n', '<leader>pf', builtin.find_files, {})
end
vim.keymap.set('n', '<C-p>', builtin.git_files, {})
vim.keymap.set('n', '<leader>ps', function()
    builtin.grep_string({ search = vim.fn.input("Grep > ") })
end)
vim.keymap.set('n', '<leader>vh', builtin.help_tags, {})

