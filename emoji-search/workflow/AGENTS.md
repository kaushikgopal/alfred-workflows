# Emoji Search: local Unicode additions

Alfred runs `emoji.js` for both List View and Grid View. The script returns one static list: 86 curated symbols, 1,919 original emoji entries, then the generated Unicode entries. The generated entries use the character as the copy/paste value and match its Unicode name, glyph, and code point (for example, `U+017E` or `017E`).

**Workflow updates can overwrite these edits.** Before updating or reinstalling, back up the customized workflow outside the install folder. After an update, restore the generation scripts and regenerate against the new `emoji.js`. Compare and reapply any missing curated entries and icons separately; the generator does not restore them.

## Add characters

- For a block, add its inclusive range and exact name to `BLOCKS` in `generate-unicode.py`. Check Unicode 17.0's [Blocks.txt](https://www.unicode.org/Public/17.0.0/ucd/Blocks.txt) for ranges, and [UnicodeData.txt](https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt) for names and categories. Keep the scope to common blocks: every addition adds a result and an SVG.
- For a custom label or tags, add a curated row before the generated suffix in `emoji.js`. Use a unique `symbol-XXXX` ID and the corresponding PNG path. If the character is already in the generated suffix, move its row into the curated section rather than duplicating it. Update the ID and icon path when you move it.
- Run these commands from the workflow folder. Python must report `17.0.0`. Generation uses Swift and AppKit to measure SVG glyphs. Neither Alfred nor `--check` needs Swift.

```fish
python3 -c 'import unicodedata; print(unicodedata.unidata_version)'
python3 generate-unicode.py
python3 generate-unicode.py --check
```

The generator preserves curated and original emoji rows in place. It skips exact character matches, whitespace, nonprinting characters, and all mark categories (`Mn`, `Mc`, `Me`). Each generated icon is an SVG with one XML-escaped character. It uses the macOS system font stack, centers the visible glyph, and checks that the glyph fits before changing result paths.

The generator leaves unused icons in place. Before removing any generated icon, check that neither `emoji.js` nor `info.plist` references it. Keep the original PNGs for curated symbols and emoji.

To render an icon for a custom row, pass its ID and glyph separated by a tab. Pick an unused ID; calling the Swift renderer directly writes to that filename.

```fish
printf 'symbol-XXXX\t%s\n' 'YOUR_GLYPH' | swift render-symbol-icons.swift icons
```

## Test in Alfred

`--check` verifies the expected rows, unique IDs and character values, and that each generated path contains a valid SVG with the expected character. Run `./emoji.js` to confirm Alfred's script returns JSON with an `items` array.

In Alfred, try `emoji U+017E`, `emoji box drawings light horizontal`, `emoji U+0026`, and `emoji grinning face`. Check the previews and copy/paste output in both List View and Grid View. SVGs use the fonts installed on the Mac, so preview shape and coverage may vary. A missing-glyph box does not affect the character you copy.
