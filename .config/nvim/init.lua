require("torgst")
-- Create a "fake clipboard", this will allow copying internally in codespaces running in the web using VIM copy mode
vim.cmd[[
  if getenv("CODESPACES")==?"true"
      echo "Setting fake clipboard for Codespaces"
      let g:clipboard = {
    \   'name': 'FileClipboard',
    \   'copy': {
    \      '+': ['tee', '/tmp/clipboard_plus.txt'],
    \      '*': ['tee', '/tmp/clipboard_star.txt'],
    \    },
    \   'paste': {
    \      '+': 'cat /tmp/clipboard_plus.txt',
    \      '*': 'cat /tmp/clipboard_star.txt',
    \   },
    \   'cache_enabled': 0,
    \ }
  else
    echo "NOT CS"
  endif
]]
