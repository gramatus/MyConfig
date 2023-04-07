if vim.g.vscode then
  -- VSCode extension
else
  -- ordinary Neovim
local lsp = require("lsp-zero")

lsp.preset("recommended")

lsp.ensure_installed({
  'tsserver',
  'omnisharp',
  'volar',
})

-- Fix Undefined global 'vim'
-- lsp.configure('lua-language-server', {
--   settings = {
--       Lua = {
--           diagnostics = {
--               globals = { 'vim' }
--           }
--       }
--   }
-- })
lsp.nvim_lua_ls();

local cmp = require('cmp')
local cmp_select = {behavior = cmp.SelectBehavior.Select}
local cmp_mappings = lsp.defaults.cmp_mappings({
['<C-p>'] = cmp.mapping.select_prev_item(cmp_select),
['<C-n>'] = cmp.mapping.select_next_item(cmp_select),
['<C-y>'] = cmp.mapping.confirm({ select = true }),
["<C-Space>"] = cmp.mapping.complete(),
})

cmp_mappings['<Tab>'] = nil
cmp_mappings['<S-Tab>'] = nil

lsp.setup_nvim_cmp({
mapping = cmp_mappings
})

lsp.set_preferences({
  suggest_lsp_servers = false,
  sign_icons = {
      error = 'E',
      warn = 'W',
      hint = 'H',
      info = 'I'
  }
})

lsp.on_attach(function(client, bufnr)
  local opts = {buffer = bufnr, remap = false}

  vim.keymap.set("n", "gd", function() vim.lsp.buf.definition() end, opts)
  vim.keymap.set("n", "K", function() vim.lsp.buf.hover() end, opts)
  vim.keymap.set("n", "<leader>vws", function() vim.lsp.buf.workspace_symbol() end, opts)
  vim.keymap.set("n", "<leader>vd", function() vim.diagnostic.open_float() end, opts)
  vim.keymap.set("n", "[d", function() vim.diagnostic.goto_next() end, opts)
  vim.keymap.set("n", "]d", function() vim.diagnostic.goto_prev() end, opts)
  vim.keymap.set("n", "<leader>vca", function() vim.lsp.buf.code_action() end, opts)
  vim.keymap.set("n", "<leader>vrr", function() vim.lsp.buf.references() end, opts)
  vim.keymap.set("n", "<leader>vrn", function() vim.lsp.buf.rename() end, opts)
  vim.keymap.set("i", "<C-h>", function() vim.lsp.buf.signature_help() end, opts)

  -- Fix broken Roslyn semantics (see https://nicolaiarocci.com/making-csharp-and-omnisharp-play-well-with-neovim/)
  -- https://github.com/OmniSharp/omnisharp-roslyn/issues/2483
  -- https://github.com/neovim/neovim/issues/21391
  -- https://github.com/neovim/neovim/blob/master/runtime/lua/vim/lsp/semantic_tokens.lua
  -- :lua =vim.lsp.get_active_clients()[1]
  if client.name == 'omnisharp' then
    local tokenModifiers = client.server_capabilities.semanticTokensProvider.legend.tokenModifiers
    for i, v in ipairs(tokenModifiers) do
      tokenModifiers[i] = v:gsub(' ', '_'):gsub('-', '_')
    end
    local tokenTypes = client.server_capabilities.semanticTokensProvider.legend.tokenTypes
    for i, v in ipairs(tokenTypes) do
      tokenTypes[i] = v:gsub(' ', '_'):gsub('-', '_')
    end
  end

  if client.server_capabilities.documentHighlightProvider then
    vim.cmd [[
      hi! LspReferenceRead cterm=bold ctermbg=235 guibg=LightYellow
      hi! LspReferenceText cterm=bold ctermbg=235 guibg=LightYellow
      hi! LspReferenceWrite cterm=bold ctermbg=235 guibg=LightYellow
    ]]
    vim.api.nvim_create_augroup('lsp_document_highlight', {})
    vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
      group = 'lsp_document_highlight',
      buffer = 0,
      callback = vim.lsp.buf.document_highlight,
    })
    vim.api.nvim_create_autocmd('CursorMoved', {
      group = 'lsp_document_highlight',
      buffer = 0,
      callback = vim.lsp.buf.clear_references,
    })
  end
end)

lsp.setup()

vim.diagnostic.config({
  virtual_text = true
})
end

-- Input on C# setup
--https://github.com/WhiteBlackGoose/dotfiles
--https://nicolaiarocci.com/making-csharp-and-omnisharp-play-well-with-neovim/
