vim.g.mapleader = " "
if vim.g.vscode then
    vim.keymap.set('n', '<leader>pv', "<Cmd>call VSCodeNotify('workbench.action.files.openFile')<CR>")
else
    -- vim.keymap.set("n", "<leader>pv", vim.cmd.Ex)
    vim.keymap.set("n", "<leader>pv", "<cmd>NvimTreeFocus<CR>")
end


vim.keymap.set("n", "<leader>cl", "<cmd>so ~/.config/nvim/after/plugin/colors.lua<CR>") -- For use while setting up my own colors
vim.keymap.set("n", "<leader>ph", "<cmd>Telescope find_files hidden=true<cr>")

-- vim.keymap.set("x", "cc", "<Cmd>call VSCodeNotifyVisual('editor.action.clipboardCopyAction', 1)<CR>")

vim.keymap.set("n", "<leader>p", "<nop>")
local lsp_formatting = function(bufnr)
    vim.lsp.buf.format({
        filter = function(client)
            if client.name == "tsserver" then do return false end end
            if client.name == "eslint" then do return false end end
            if string.find(client.name, "volar") then do return false end end
            if client.name == "vuels" then do return false end end
            -- if client.name == "tailwindcss" then do return false end end
            return true
        end,
        bufnr = bufnr,
    })
end
vim.keymap.set("n", "<C-k><C-d>", lsp_formatting)
-- TODO: Look at these suggestions: https://alpha2phi.medium.com/neovim-for-beginners-key-mappings-and-whichkey-31dbf58f9f87

vim.keymap.set("n", "<leader>bg", ':exec &bg=="light"? "set bg=dark" : "set bg=light"<CR>',
    { noremap = true, silent = true })

-- -- TESTING: Move "arrows" one key to the right
-- vim.keymap.set("", "ø", "l")
-- vim.keymap.set("", "l", "k")
-- vim.keymap.set("", "k", "j")
-- vim.keymap.set("", "j", "h")

vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv")

vim.keymap.set("n", "J", "mzJ`z")
if vim.g.vscode then
    vim.keymap.set("n", "<C-d>", "<C-d><Cmd>call VSCodeExtensionNotify('reveal', 'center', 0)<CR>")
    vim.keymap.set("n", "<C-u>", "<C-u><Cmd>call VSCodeExtensionNotify('reveal', 'center', 0)<CR>")
else
    vim.keymap.set("n", "<C-d>", "<C-d>zz")
    vim.keymap.set("n", "<C-u>", "<C-u>zz")
end
vim.keymap.set("n", "n", "nzzzv")
vim.keymap.set("n", "N", "Nzzzv")

vim.keymap.set("n", "<leader>vwm", function()
    require("vim-with-me").StartVimWithMe()
end)
vim.keymap.set("n", "<leader>svwm", function()
    require("vim-with-me").StopVimWithMe()
end)

-- greatest remap ever
vim.keymap.set("x", "<leader>p", [["_dP]])

-- next greatest remap ever : asbjornHaland
vim.keymap.set({ "n", "v" }, "<leader>y", [["+y]])
vim.keymap.set("n", "<leader>Y", [["+Y]])

vim.keymap.set({ "n", "v" }, "<leader>d", [["_d]])

-- This is going to get me cancelled
vim.keymap.set("i", "<C-c>", "<Esc>")

vim.keymap.set("n", "Q", "<nop>")
vim.keymap.set("n", "<C-f>", "<cmd>silent !tmux neww tmux-sessionizer<CR>")
vim.keymap.set("n", "<leader>f", vim.lsp.buf.format)

vim.keymap.set("n", "<C-k>", "<cmd>cnext<CR>zz")
vim.keymap.set("n", "<C-j>", "<cmd>cprev<CR>zz")
vim.keymap.set("n", "<leader>k", "<cmd>lnext<CR>zz")
vim.keymap.set("n", "<leader>j", "<cmd>lprev<CR>zz")

vim.keymap.set("n", "<leader>s", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]])
vim.keymap.set("n", "<leader>x", "<cmd>!chmod +x %<CR>", { silent = true })

vim.keymap.set("n", "<leader>vpp", "<cmd>e ~/.dotfiles/nvim/.config/nvim/lua/torgst/packer.lua<CR>");
vim.keymap.set("n", "<leader>mr", "<cmd>CellularAutomaton make_it_rain<CR>");

-- vim-commaentary doesn't seem to add keymaps by itself (or perhaps it will later), anyway I try adding my own
-- vim.keymap.set("x", "C-'", "<cmd>Commentary<CR>")
-- vim.keymap.set("x", "gc", "<cmd>Commentary<CR>")

-- Switch buffer
vim.keymap.set("n", "<S-h>", ":bprevious<CR>", default_opts)
vim.keymap.set("n", "<S-l>", ":bnext<CR>", default_opts)

vim.keymap.set("n", "<leader><leader>", function()
    vim.cmd("so")
end)
