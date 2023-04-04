--print("Humm")
--require('rose-pine').setup({
--	-- Change specific vim highlight groups
--	-- https://github.com/rose-pine/neovim/wiki/Recipes
--	highlight_groups = {
--        method = { bg = "#99740f" }
--	}
--})
vim.cmd[[
        " Important!!
        if has('termguicolors')
          set termguicolors
        endif
        " The configuration options should be placed before `colorscheme edge`.
        let g:edge_style = 'aura'
        let g:edge_better_performance = 1
        colorscheme one-nvim
]]

vim.api.nvim_create_user_command(
    'LoadColors',
    function()
        vim.api.nvim_set_hl(0, "Normal", { bg = "#FFFFFF" })
        vim.api.nvim_set_hl(0, "@method", { fg = "#99740f", italic=false  })
        vim.api.nvim_set_hl(0, "@type.builtin", { fg = "#0000ff", italic=false  })
        vim.api.nvim_set_hl(0, "@type", { fg = "#5590B7", italic=false  })
        vim.api.nvim_set_hl(0, "@label", { fg = "#0451A5", italic=false  })
        vim.api.nvim_set_hl(0, "@parameter", { fg = "#000000", italic=false  })
        vim.api.nvim_set_hl(0, "@type.qualifier", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@storageClass", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@keyword", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@keyword.operator", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@operator", { fg = "#000000", italic=false  })
        vim.api.nvim_set_hl(0, "@modifier", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@boolean", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@variable", { fg = "#000000", italic=false  })
        vim.api.nvim_set_hl(0, "@string", { fg = "#a31515", italic=false  })
        --vim.api.nvim_set_hl(0, "@field", { fg = "#471ac4", italic=false  })
        vim.api.nvim_set_hl(0, "@field", { fg = "#000000", italic=false  })
        vim.api.nvim_set_hl(0, "@property", { fg = "#000000", italic=false  })
        vim.api.nvim_set_hl(0, "@tag", { fg = "#800000", italic=false  })
        vim.api.nvim_set_hl(0, "@tag.attribute", { fg = "#E50000", italic=false  })
        vim.api.nvim_set_hl(0, "@conditional", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@comment", { fg = "#008000", italic=false  })
        vim.api.nvim_set_hl(0, "@constant.builtin", { fg = "#0000FF", italic=false  })
        vim.api.nvim_set_hl(0, "@constant.macro", { fg = "#0000FF", italic=false  })
        -- Set colorscheme after options
        --require("vim.treesitter.query").set_query("test", "test", "(member_access_expression expression: (identifier) @initialIdentifier)")
            end,
    { nargs = 0 }
)
local augroup = vim.api.nvim_create_augroup
local colorGroup = augroup('colors', {})
local autocmd = vim.api.nvim_create_autocmd

autocmd({"ColorScheme"}, {
    group = colorGroup,
    command = "LoadColors",
})
