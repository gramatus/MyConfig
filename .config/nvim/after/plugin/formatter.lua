-- https://github.com/mhartington/formatter.nvim
require('formatter').setup({
  logging = false,
  filetype = {
    lua={ require("formatter.filetypes.lua").stylua },
    javascript = { require("formatter.filetypes.javascript").prettierd },
    typescript = { require("formatter.filetypes.javascript").prettierd },
    vue = { require("formatter.defaults.prettierd") },
    cs = { require("formatter.filetypes.cs").dotnetformat },
    css = { require("formatter.filetypes.css").prettierd },
    json = { require("formatter.filetypes.json").prettierd },
    -- other formatters ...
  }
})
