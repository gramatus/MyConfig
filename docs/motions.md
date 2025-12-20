# Vim Motions & Text Objects

## Quick summary

### Word Motions

|              | Beginning | End  |
| ------------ | --------- | ---- |
| **Forward**  | `w`       | `e`  |
| **Backward** | `b`       | `ge` |

- Lowercase = word (letters/digits/underscores OR punctuation sequences)
- Uppercase (`W`, `E`, `B`, `gE`) = WORD (whitespace-delimited only)

### Character Find (line-scoped)

- `f{char}` / `F{char}` — jump to next/previous occurrence
- `t{char}` / `T{char}` — jump to just before/after
- `;` / `,` — repeat forward/backward

### Sentence & Paragraph

- **Motions:** `(` `)` sentence, `{` `}` paragraph
- **Text objects:** `s` sentence, `p` paragraph

### Text Objects (`i` = inner, `a` = around)

Used with operators: `c`, `d`, `y`, `v`

**Delimited** (a = includes delimiters):
`"`, `'`, `` ` ``, `(`, `[`, `{`, `<`, `t` (tag)

**Non-delimited** (a = includes surrounding whitespace):
`w`, `W`, `s`, `p`

### Key Distinction

- **Motions** = from cursor to target (position-relative)
- **Text objects** = the whole thing (position-independent)

Example: `ce` changes to end of word; `ciw` changes entire word regardless of cursor position.

### Bonus

- `%` — jump to matching bracket
- `*` / `#` — search word under cursor forward/backward
- `.` — repeat last change

Here's the updated narrative summary:

---

## A Learning Summary

### The Repeatable Motion Principle

Vim motions search **from** the current position, not including it. This means if you're already at a word boundary, `b` jumps to the previous word and `e` jumps to the next. Motions never get "stuck"—they're always repeatable.

### Word Movement

There are four directions for word movement: forward to beginning (`w`), forward to end (`e`), backward to beginning (`b`), and backward to end (`ge`). The last one uses the `g` prefix because it's less common—Vim reserves single keys for frequent operations and uses `g` as an escape hatch for related-but-rarer commands.

Each has an uppercase variant (`W`, `E`, `B`, `gE`) that uses a different definition of "word":

- **word** (lowercase) — sequences of letters/digits/underscores, OR sequences of punctuation. So `some_func(arg)` contains multiple words: `some_func`, `(`, `arg`, `)`.
- **WORD** (uppercase) — anything separated by whitespace. So `some_func(arg)` is one WORD.

Use lowercase for precise movement, uppercase for quickly skipping chunks.

### Character Finding

`f{char}` jumps to the next occurrence of a character on the current line. `t{char}` does the same but stops just before it (useful for operations like `ct)` — change up to but not including the parenthesis).

`F` and `T` do the same backward. After any of these, `;` repeats the search forward and `,` repeats it backward—so you can tap `;` to hop through all occurrences.

These are **line-scoped**—they won't cross to another line.

### Sentence and Paragraph Navigation

For moving by sentence, use `(` and `)`. For paragraph, use `{` and `}`. Note that these are different from the text objects `s` and `p`, which are only used with operators.

A sentence ends at `.`, `!`, or `?` followed by whitespace. A paragraph is separated by blank lines.

One quirk: Vim traditionally expects two spaces after sentence-ending punctuation. With single spaces, sentence detection can be inconsistent.

### Text Objects: The `i`/`a` System

Text objects let you operate on structured chunks of text using `i` (inner) or `a` (around) after an operator like `c`, `d`, or `y`.

The cursor can be **anywhere inside** the object—you don't need to navigate to its boundary first. This is what makes `ciw` so convenient: it changes the whole word no matter where your cursor is within it.

**What `a` adds depends on the object type:**

For **delimited objects** (quotes, brackets, tags), `a` includes the delimiters themselves:

- `ci"` on `"hello"` → changes `hello`, leaves the quotes
- `ca"` on `"hello"` → changes `"hello"` entirely, quotes included

For **non-delimited objects** (word, sentence, paragraph), `a` includes surrounding whitespace. Vim is smart about this: it prefers trailing whitespace, but falls back to leading whitespace if there's nothing trailing (like at end of line). It never grabs both sides—the goal is to leave properly spaced text without double spaces.

**Available text objects:**

- `w`, `W` — word, WORD
- `s` — sentence
- `p` — paragraph
- `"`, `'`, `` ` `` — quoted strings
- `(`, `[`, `{`, `<` — bracket pairs
- `t` — HTML/XML tags

**Finding the target for delimited objects:**

For quoted strings and brackets, if you're not currently inside one, Vim looks **forward on the current line** for the next match and operates on that. So with your cursor at the beginning of `let x = "hello"`, typing `ci"` will jump into the quoted string and change its contents.

This doesn't apply to `w`, `s`, `p`—you're always "in" some word/sentence/paragraph. But for delimited objects it's a nice convenience. Note that it's line-scoped; it won't search across lines.

### Motions vs Text Objects

This is the key conceptual distinction:

- **Motions** are destinations. They describe where to go, or (with an operator) where an operation reaches _to_ from the cursor.
- **Text objects** are regions. They describe a _thing_ to select or operate on.

Some keys like `w` are both: `w` as a motion means "go to next word start," while `iw` as a text object means "this word."

Others are only one. `e` is only a motion (end of word is a position, not a thing). `s` is only a text object (for movement, you use `(` and `)`).

This is why `de` and `diw` behave differently:

- `de` deletes from cursor to end of word (motion: from here to there)
- `diw` deletes the entire word (text object: the whole thing)

### Counts

Counts go before the motion or operator. `3w` moves three words; `d3w` or `3dw` deletes three words (these are equivalent).

Counts with text objects expand forward: `c3iw` changes current word plus the next two. But this is rarely used—if you're thinking in terms of "3 words forward," a motion like `c3w` is more natural. Text objects shine for "this thing I'm in."

### The Dot Command

The `.` command repeats your last change—but it's important to understand that it repeats the **complete edit**, not just the command. This includes the operator, the motion/object, _and_ any text you inserted.

So if you do `ciw` and type "foo", then `.` elsewhere means "change this word to foo." Movement doesn't clear the last change, so you can navigate freely between uses of `.`:

`ciw` → type "foo" → `Esc` → `www` → `.` → `}` → `.`

This is like an automatic single-edit macro—no `q` to start recording, no `q` to stop, no nervousness about messing up. Experienced Vim users think about "repeatable changes"—structuring edits so `.` can do the heavy lifting.

### Search and Repeat: The `*` + `.` Combo

A powerful pattern combines `*` (search for word under cursor) with `.`:

1. Position cursor on a variable name
2. `*` to search for it (jumps to next occurrence)
3. `ciw` and type the new name, then `Esc`
4. `n` to go to next occurrence
5. `.` to apply the same change
6. Repeat `n` and `.` as needed—or just `n` to skip occurrences you don't want to change

This is sometimes called "the poor man's search-and-replace" but it's often _better_ than `:%s/old/new/g` because you see each change happening and can make decisions along the way.

### Bonus Commands

- `%` — jump to matching bracket (works with `()`, `[]`, `{}`)
- `*` / `#` — search for the word under cursor forward/backward, then use `n`/`N` to continue
- `.` — repeat last change (pairs beautifully with text objects)
