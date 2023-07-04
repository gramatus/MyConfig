if vim.g.vscode then
    -- VSCode extension
else
    -- ordinary Neovim
    local lsp = require("lsp-zero")

    lsp.preset("recommended")

    lsp.ensure_installed({
        'tsserver',
        'omnisharp',
        'volar', -- Currently does not add semantic tokens (as far as I can tell, but lets keep it as it might come soon)
        -- 'vuels', --https://github.com/vuejs/vetur/tree/master/server
        'eslint',
        'tailwindcss',
        'lua_ls',
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
    require('lspconfig').lua_ls.setup(lsp.nvim_lua_ls());

    lsp.configure('omnisharp', {
        handlers = {
            ["textDocument/definition"] = require('omnisharp_extended').handler,
        }
    })

    local cmp = require('cmp')
    local cmp_select = { behavior = cmp.SelectBehavior.Select }
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
        local opts = { buffer = bufnr, remap = false }

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

        if client.name == 'vuels' then
            client.handlers["textDocument/publishDiagnostics"] = function(...)
                local result = select(2, ...)
                result.diagnostics = {}
            end
        end

        -- if client.server_capabilities.documentHighlightProvider then
        --   vim.cmd [[
        --     hi! LspReferenceRead cterm=bold ctermbg=235 guibg=LightYellow
        --     hi! LspReferenceText cterm=bold ctermbg=235 guibg=LightYellow
        --     hi! LspReferenceWrite cterm=bold ctermbg=235 guibg=LightYellow
        --   ]]
        --   vim.api.nvim_create_augroup('lsp_document_highlight', {})
        --   vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
        --     group = 'lsp_document_highlight',
        --     buffer = 0,
        --     callback = vim.lsp.buf.document_highlight,
        --   })
        --   vim.api.nvim_create_autocmd('CursorMoved', {
        --     group = 'lsp_document_highlight',
        --     buffer = 0,
        --     callback = vim.lsp.buf.clear_references,
        --   })
        -- end
    end)

    local lspconfig = require 'lspconfig'
    local lspconfig_configs = require 'lspconfig.configs'
    local lspconfig_util = require 'lspconfig.util'

    local function on_new_config(new_config, new_root_dir)
        local function get_typescript_server_path(root_dir)
            local project_root = lspconfig_util.find_node_modules_ancestor(root_dir)
            return project_root and
                (lspconfig_util.path.join(project_root, 'node_modules', 'typescript', 'lib', 'tsserverlibrary.js'))
                or ''
        end

        if
            new_config.init_options
            and new_config.init_options.typescript
            and new_config.init_options.typescript.tsdk == ''
        then
            new_config.init_options.typescript.tsdk = get_typescript_server_path(new_root_dir)
        end
    end

    local volar_cmd = { 'vue-language-server', '--stdio' }
    local volar_root_dir = lspconfig_util.root_pattern 'package.json'

    -- lspconfig_configs.volar_api = {
    --     default_config = {
    --         cmd = volar_cmd,
    --         root_dir = volar_root_dir,
    --         on_new_config = on_new_config,
    --         filetypes = { 'typescript', 'javascript', 'javascriptreact', 'typescriptreact', 'vue', 'json' },
    --         init_options = {
    --             typescript = {
    --                 tsdk = ''
    --             },
    --             languageFeatures = {
    --                 implementation = true,
    --                 references = true,
    --                 definition = true,
    --                 typeDefinition = true,
    --                 callHierarchy = true,
    --                 hover = true,
    --                 rename = true,
    --                 renameFileRefactoring = true,
    --                 signatureHelp = true,
    --                 codeAction = true,
    --                 workspaceSymbol = true,
    --                 completion = {
    --                     defaultTagNameCase = 'both',
    --                     defaultAttrNameCase = 'kebabCase',
    --                     getDocumentNameCasesRequest = false,
    --                     getDocumentSelectionRequest = false,
    --                 },
    --             }
    --         },
    --     }
    -- }
    -- lspconfig.volar_api.setup {}

    -- lspconfig_configs.volar_doc = {
    --     default_config = {
    --         cmd = volar_cmd,
    --         root_dir = volar_root_dir,
    --         on_new_config = on_new_config,
    --         filetypes = { 'typescript', 'javascript', 'javascriptreact', 'typescriptreact', 'vue', 'json' },
    --         init_options = {
    --             typescript = {
    --                 tsdk = ''
    --             },
    --             languageFeatures = {
    --                 implementation = true,
    --                 documentHighlight = true,
    --                 documentLink = true,
    --                 codeLens = { showReferencesNotification = true },
    --                 semanticTokens = true,
    --                 diagnostics = true,
    --                 schemaRequestService = true,
    --             }
    --         },
    --     }
    -- }
    -- lspconfig.volar_doc.setup {}

    -- lspconfig_configs.volar_html = {
    --     default_config = {
    --         cmd = volar_cmd,
    --         root_dir = volar_root_dir,
    --         on_new_config = on_new_config,
    --         filetypes = { 'typescript', 'javascript', 'javascriptreact', 'typescriptreact', 'vue', 'json' },
    --         init_options = {
    --             typescript = {
    --                 tsdk = ''
    --             },
    --             documentFeatures = {
    --                 selectionRange = true,
    --                 foldingRange = true,
    --                 linkedEditingRange = true,
    --                 documentSymbol = true,
    --                 documentColor = true, -- not supported - https://github.com/neovim/neovim/pull/13654
    --                 documentFormatting = {
    --                     defaultPrintWidth = 100,
    --                 },
    --             }
    --         },
    --     }
    -- }
    -- lspconfig.volar_html.setup {}

    require 'lspconfig'.volar.setup {}

    -- require('lspconfig').omnisharp.setup {
    --   cmd = { "dotnet", "/usr/bin/omnisharp/OmniSharp.dll" },

    --   -- Enables support for reading code style, naming convention and analyzer
    --   -- settings from .editorconfig.
    --   enable_editorconfig_support = true,

    --   -- If true, MSBuild project system will only load projects for files that
    --   -- were opened in the editor. This setting is useful for big C# codebases
    --   -- and allows for faster initialization of code navigation features only
    --   -- for projects that are relevant to code that is being edited. With this
    --   -- setting enabled OmniSharp may load fewer projects and may thus display
    --   -- incomplete reference lists for symbols.
    --   enable_ms_build_load_projects_on_demand = false,

    --   -- Enables support for roslyn analyzers, code fixes and rulesets.
    --   enable_roslyn_analyzers = false,

    --   -- Specifies whether 'using' directives should be grouped and sorted during
    --   -- document formatting.
    --   organize_imports_on_format = false,

    --   -- Enables support for showing unimported types and unimported extension
    --   -- methods in completion lists. When committed, the appropriate using
    --   -- directive will be added at the top of the current file. This option can
    --   -- have a negative impact on initial completion responsiveness,
    --   -- particularly for the first few completion sessions after opening a
    --   -- solution.
    --   enable_import_completion = false,

    --   -- Specifies whether to include preview versions of the .NET SDK when
    --   -- determining which version to use for project loading.
    --   sdk_include_prereleases = true,

    --   -- Only run analyzers against open files when 'enableRoslynAnalyzers' is
    --   -- true
    --   analyze_open_documents_only = false,
    -- }

    lspconfig.terraformls.setup {
        cmd = { 'terraform-ls', 'serve' },
        filetypes = { 'terraform', 'tf' }
    }

    lsp.setup()

    vim.diagnostic.config({
        virtual_text = true
    })
end

-- Input on C# setup
--https://github.com/WhiteBlackGoose/dotfiles
--https://nicolaiarocci.com/making-csharp-and-omnisharp-play-well-with-neovim/
